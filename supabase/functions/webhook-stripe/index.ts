// supabase/functions/webhook-stripe/index.ts
// Recebe eventos do Stripe e atualiza stripe_subscriptions.
// Servidor→servidor: sem CORS. Autenticado via assinatura HMAC-SHA256.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const MAX_BODY_BYTES = 1_048_576 // 1 MB

// ── Utilitários ──────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  if (aB.length !== bB.length) return false
  let diff = 0
  for (let i = 0; i < aB.length; i++) diff |= aB[i] ^ bB[i]
  return diff === 0
}

async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = req.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done || !value) break
    total += value.byteLength
    if (total > maxBytes) {
      reader.cancel().catch(() => {})
      throw Object.assign(new Error('TOO_LARGE'), { status: 413 })
    }
    chunks.push(value)
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { combined.set(c, offset); offset += c.byteLength }
  return combined
}

// Stripe signature format: "t=1234,v1=abc,v1=def"
// Verifica HMAC-SHA256 do payload `timestamp.rawBody` contra todas as v1 signatures.
async function verifyStripeSignature(
  rawBytes: Uint8Array,
  sigHeader: string,
  secret: string,
  toleranceSecs = 300,
): Promise<boolean> {
  let timestamp = ''
  const v1Sigs: string[] = []
  for (const part of sigHeader.split(',')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx < 0) continue
    const k = part.slice(0, eqIdx)
    const v = part.slice(eqIdx + 1)
    if (k === 't')  timestamp = v
    if (k === 'v1') v1Sigs.push(v)
  }
  if (!timestamp || v1Sigs.length === 0) return false

  const t = parseInt(timestamp, 10)
  if (isNaN(t)) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSecs) return false

  const enc    = new TextEncoder()
  const prefix = enc.encode(`${timestamp}.`)
  const signed = new Uint8Array(prefix.byteLength + rawBytes.byteLength)
  signed.set(prefix, 0)
  signed.set(rawBytes, prefix.byteLength)

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sigBuf   = await crypto.subtle.sign('HMAC', key, signed)
  const expected = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  return v1Sigs.some(sig => timingSafeEqual(sig, expected))
}

const ok  = () => new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const okQ = () => new Response('ok', { status: 200 }) // silent — não revela motivo de rejeição

// ── Handler principal ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return okQ()
  if (req.method !== 'POST')   return okQ()

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('[webhook-stripe] STRIPE_WEBHOOK_SECRET não configurada')
    return okQ()
  }

  let rawBytes: Uint8Array
  try {
    rawBytes = await readBodyWithLimit(req, MAX_BODY_BYTES)
  } catch {
    console.warn('[webhook-stripe] Body excede limite de 1MB')
    return okQ()
  }

  const sigHeader = req.headers.get('stripe-signature') ?? ''
  if (!await verifyStripeSignature(rawBytes, sigHeader, webhookSecret)) {
    console.warn('[webhook-stripe] Assinatura inválida — [GHOST-001] rejeitando silenciosamente')
    return okQ()
  }

  let event: Record<string, unknown>
  try {
    event = JSON.parse(new TextDecoder().decode(rawBytes))
  } catch {
    console.warn('[webhook-stripe] JSON inválido após verificação de assinatura')
    return okQ()
  }

  const eventId   = event.id   as string
  const eventType = event.type as string

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  )

  // ── Idempotência ───────────────────────────────────────────────────────────
  const { error: insertEventErr } = await supabaseAdmin
    .from('stripe_events')
    .insert({ id: eventId })

  if (insertEventErr?.code === '23505') {
    // Violação de UNIQUE → evento já processado → Stripe está retentando
    console.log('[webhook-stripe] Evento duplicado ignorado:', eventId)
    return ok()
  }

  console.log('[webhook-stripe] Processando:', eventType, eventId)

  try {
    const data = event.data as Record<string, unknown>
    switch (eventType) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(supabaseAdmin, data)
        break
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(supabaseAdmin, data)
        break
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(supabaseAdmin, data)
        break
      case 'invoice.payment_failed':
        await handlePaymentFailed(supabaseAdmin, data)
        break
      default:
        console.log('[webhook-stripe] Evento ignorado (não mapeado):', eventType)
    }
  } catch (err) {
    console.error('[webhook-stripe] Erro ao processar evento:', eventType, err)
    // Remove da tabela de idempotência para permitir que Stripe tente novamente
    await supabaseAdmin.from('stripe_events').delete().eq('id', eventId).catch(() => {})
    return new Response('Internal Error', { status: 500 })
  }

  return ok()
})

// ── Handlers de eventos ───────────────────────────────────────────────────────

type DB = ReturnType<typeof createClient>

async function fetchStripeSubscription(subId: string): Promise<Record<string, unknown>> {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` },
    signal:  AbortSignal.timeout(10_000),
  })
  return res.ok ? await res.json() : {}
}

function tsToISO(unix: unknown): string | null {
  if (typeof unix !== 'number') return null
  return new Date(unix * 1000).toISOString()
}

async function handleCheckoutCompleted(db: DB, data: Record<string, unknown>) {
  const session        = data.object as Record<string, unknown>
  const metadata       = (session.metadata as Record<string, string>) ?? {}
  const subscriptionId = session.subscription as string
  const customerId     = session.customer     as string
  const userId         = metadata.user_id    ?? (session.client_reference_id as string ?? '')
  const userEmail      = metadata.user_email ?? (session.customer_email as string ?? '')
  const planName       = metadata.plan_name  ?? 'individual'

  if (!subscriptionId || !customerId) {
    console.warn('[webhook-stripe] checkout.session.completed sem subscription/customer ID')
    return
  }

  // Busca detalhes da subscription para obter price_id, datas e status
  const sub           = await fetchStripeSubscription(subscriptionId)
  const priceId       = (sub?.items as any)?.data?.[0]?.price?.id ?? ''
  const periodStart   = tsToISO(sub.current_period_start)
  const periodEnd     = tsToISO(sub.current_period_end)
  const subStatus     = (sub.status as string) ?? 'active'
  const cancelAtPeriod = (sub.cancel_at_period_end as boolean) ?? false

  const { error } = await db.from('stripe_subscriptions').upsert({
    user_id:                userId || null,
    user_email:             userEmail,
    stripe_customer_id:     customerId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id:        priceId,
    plan_name:              planName,
    status:                 subStatus,
    current_period_start:   periodStart,
    current_period_end:     periodEnd,
    cancel_at_period_end:   cancelAtPeriod,
    updated_at:             new Date().toISOString(),
  }, { onConflict: 'stripe_customer_id' })

  if (error) console.error('[webhook-stripe] Erro ao upsert stripe_subscriptions:', error.message)
  else console.log('[webhook-stripe] Subscription criada — customer:', customerId, 'user:', userId.slice(0, 8))
}

async function handleSubscriptionUpdated(db: DB, data: Record<string, unknown>) {
  const sub            = data.object as Record<string, unknown>
  const customerId     = sub.customer as string
  const subscriptionId = sub.id       as string
  const status         = sub.status   as string
  const priceId        = (sub?.items as any)?.data?.[0]?.price?.id ?? ''
  const metadata       = (sub.metadata as Record<string, string>) ?? {}

  const updates: Record<string, unknown> = {
    stripe_subscription_id: subscriptionId,
    status,
    current_period_start:  tsToISO(sub.current_period_start),
    current_period_end:    tsToISO(sub.current_period_end),
    cancel_at_period_end:  (sub.cancel_at_period_end as boolean) ?? false,
    canceled_at:           tsToISO(sub.canceled_at),
    updated_at:            new Date().toISOString(),
  }
  if (priceId)            updates.stripe_price_id = priceId
  if (metadata.plan_name) updates.plan_name       = metadata.plan_name

  const { error } = await db.from('stripe_subscriptions')
    .update(updates)
    .eq('stripe_customer_id', customerId)

  if (error) console.error('[webhook-stripe] Erro ao atualizar subscription:', error.message)
  else console.log('[webhook-stripe] Subscription atualizada:', subscriptionId, status)
}

async function handleSubscriptionDeleted(db: DB, data: Record<string, unknown>) {
  const sub        = data.object as Record<string, unknown>
  const customerId = sub.customer as string
  const canceledAt = tsToISO(sub.canceled_at) ?? new Date().toISOString()

  const { error } = await db.from('stripe_subscriptions')
    .update({ status: 'canceled', canceled_at: canceledAt, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId)

  if (error) console.error('[webhook-stripe] Erro ao cancelar subscription:', error.message)
  else console.log('[webhook-stripe] Subscription cancelada — customer:', customerId)
}

async function handlePaymentFailed(db: DB, data: Record<string, unknown>) {
  const invoice    = data.object as Record<string, unknown>
  const customerId = invoice.customer as string

  const { error } = await db.from('stripe_subscriptions')
    .update({ status: 'past_due', updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId)
    .neq('status', 'canceled')

  if (error) console.error('[webhook-stripe] Erro ao marcar past_due:', error.message)
  else console.log('[webhook-stripe] Invoice falhou — customer marcado past_due:', customerId)
}
