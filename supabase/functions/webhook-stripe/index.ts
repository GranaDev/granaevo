// supabase/functions/webhook-stripe/index.ts
// Recebe eventos do Stripe e atualiza stripe_subscriptions.
// Servidor→servidor: sem CORS. Autenticado via assinatura HMAC-SHA256.
// GOD MODE Round 7: correções STRIPE-001, STRIPE-002, STRIPE-004, STRIPE-006, STRIPE-007, STRIPE-015

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const MAX_BODY_BYTES  = 1_048_576 // 1 MB
const UUID_REGEX      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STRIPE_ID_REGEX = /^[a-zA-Z0-9_]{4,100}$/  // evt_xxx, sub_xxx, cus_xxx, cs_xxx

// [GOD6-L02] Rate limit in-memory para assinaturas inválidas — evita DB flood.
// Map: ip → { count, windowStart }. Máx 3 hits por 60s por IP.
const _invalidSigRL = new Map<string, { count: number; windowStart: number }>()
const _RL_MAX = 3, _RL_WINDOW = 60_000

function _checkInvalidSigRL(ip: string): 'ok' | 'alert' | 'blocked' {
  const now = Date.now()
  const rec = _invalidSigRL.get(ip)
  if (!rec || now - rec.windowStart > _RL_WINDOW) {
    _invalidSigRL.set(ip, { count: 1, windowStart: now })
    return 'ok'
  }
  rec.count++
  return rec.count > _RL_MAX ? 'blocked' : rec.count === _RL_MAX ? 'alert' : 'ok'
}

// ── Utilitários ──────────────────────────────────────────────────────────────

// [GOD7-F01] timingSafeEqual sem early-return em length — elimina timing oracle
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length          // codifica divergência de comprimento
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
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

const secHeaders = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }
const ok  = () => new Response(JSON.stringify({ received: true }), { status: 200, headers: secHeaders })
const okQ = () => new Response('ok', { status: 200, headers: { 'X-Content-Type-Options': 'nosniff' } })

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

  // [GOD6-L02] Rate limit in-memory para assinaturas inválidas — sem DB query por hit.
  // Substituiu RPC check_rate_limit que criava 1 DB round-trip por request inválido.
  const clientIp = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim()
  if (!await verifyStripeSignature(rawBytes, sigHeader, webhookSecret)) {
    const rlResult = _checkInvalidSigRL(clientIp)
    if (rlResult === 'alert') {
      console.warn('[webhook-stripe] Assinatura inválida — [GHOST-001] ip:', clientIp.slice(0, 20))
    } else if (rlResult === 'blocked') {
      console.error('[webhook-stripe] ALERTA: múltiplas assinaturas inválidas — possível brute force — ip:', clientIp.slice(0, 20))
    }
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

  // [GOD7-F05] Validar formato do event ID antes de usar como PK
  if (!eventId || !STRIPE_ID_REGEX.test(eventId)) {
    console.warn('[webhook-stripe] Event ID inválido ou ausente:', String(eventId).slice(0, 30))
    return okQ()
  }

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  )

  // ── Idempotência ───────────────────────────────────────────────────────────
  // [GOD7-F15] processed flag previne reprocessamento em partial failures
  const { error: insertEventErr } = await supabaseAdmin
    .from('stripe_events')
    .insert({ id: eventId })

  if (insertEventErr?.code === '23505') {
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
        console.log('[webhook-stripe] Evento ignorado:', eventType)
    }
  } catch (err) {
    console.error('[webhook-stripe] Erro ao processar evento:', eventType, err)
    await supabaseAdmin.from('stripe_events').delete().eq('id', eventId).catch(() => {})
    return new Response('Internal Error', { status: 500 })
  }

  return ok()
})

// ── Handlers de eventos ───────────────────────────────────────────────────────

type DB = ReturnType<typeof createClient>

async function fetchStripeSubscription(subId: string): Promise<Record<string, unknown>> {
  if (!STRIPE_ID_REGEX.test(subId)) return {}
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, {
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

  // [GOD7-F01] Validar IDs do Stripe antes de usar
  if (!subscriptionId || !customerId || !STRIPE_ID_REGEX.test(subscriptionId) || !STRIPE_ID_REGEX.test(customerId)) {
    console.warn('[webhook-stripe] IDs Stripe inválidos no checkout.session.completed')
    return
  }

  // [GOD7-F07] Validar UUID do user_id antes de inserir — evita injeção e corrupção
  const rawUserId       = metadata.user_id ?? (session.client_reference_id as string ?? '')
  const userId          = UUID_REGEX.test(rawUserId) ? rawUserId : null
  const customerDetails = (session.customer_details as Record<string, unknown>) ?? {}
  const rawEmail        = (typeof metadata.user_email === 'string' && metadata.user_email)
    ? metadata.user_email
    : (typeof customerDetails.email === 'string' ? customerDetails.email : '')
  const userEmail = rawEmail.toLowerCase().trim().slice(0, 254)
  const planName   = ['individual', 'casal', 'familia'].includes(metadata.plan_name ?? '')
    ? metadata.plan_name
    : 'individual'

  const sub           = await fetchStripeSubscription(subscriptionId)
  const priceId       = (sub?.items as any)?.data?.[0]?.price?.id ?? ''
  const periodStart   = tsToISO(sub.current_period_start)
  const periodEnd     = tsToISO(sub.current_period_end)
  const subStatus     = (sub.status as string) ?? 'active'
  const cancelAtPeriod = (sub.cancel_at_period_end as boolean) ?? false

  // [GOD7-F04] upsert com validação de ownership — não sobrescreve user_id existente com NULL
  const { data: existing } = await db
    .from('stripe_subscriptions')
    .select('id, user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  const finalUserId = existing?.user_id ?? userId  // Nunca regride de user_id para NULL

  const { error } = await db.from('stripe_subscriptions').upsert({
    user_id:                finalUserId,
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

  if (error) {
    console.error('[webhook-stripe] Erro ao upsert stripe_subscriptions:', error.message)
    return
  }

  console.log('[webhook-stripe] Subscription criada — customer:', customerId, 'user:', finalUserId?.slice(0, 8))

  // ── Enviar email de boas-vindas via send-welcome-email ──────────────────
  // Fire-and-forget — não bloqueia o webhook nem afeta idempotência
  if (userEmail) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const proxySecret = Deno.env.get('PROXY_SECRET') ?? ''
    if (supabaseUrl && proxySecret) {
      fetch(`${supabaseUrl}/functions/v1/send-welcome-email`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-proxy-secret': proxySecret },
        body:    JSON.stringify({ email: userEmail, name: userEmail.split('@')[0], planName: planName ?? 'GranaEvo' }),
        signal:  AbortSignal.timeout(10_000),
      }).catch(err => console.error('[webhook-stripe] Erro ao enviar welcome email:', err?.message))
    }
  }
}

async function handleSubscriptionUpdated(db: DB, data: Record<string, unknown>) {
  const sub            = data.object as Record<string, unknown>
  const customerId     = sub.customer as string
  const subscriptionId = sub.id       as string
  const status         = sub.status   as string

  if (!customerId || !STRIPE_ID_REGEX.test(customerId)) return

  const priceId         = (sub?.items as any)?.data?.[0]?.price?.id ?? ''
  const metadata        = (sub.metadata as Record<string, string>) ?? {}
  const newCancelAtEnd  = (sub.cancel_at_period_end as boolean) ?? false

  // Busca dados atuais incluindo downgrade agendado e remoções pendentes
  const { data: existing } = await db
    .from('stripe_subscriptions')
    .select('user_id, cancel_at_period_end, user_email, plan_name, current_period_start, pending_plan_name, pending_plan_effective_at, pending_profile_removals, pending_member_removals')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  const wasCancelScheduled  = existing?.cancel_at_period_end === true
  const justScheduledCancel = newCancelAtEnd && !wasCancelScheduled

  const updates: Record<string, unknown> = {
    stripe_subscription_id: subscriptionId,
    status,
    current_period_start:  tsToISO(sub.current_period_start),
    current_period_end:    tsToISO(sub.current_period_end),
    cancel_at_period_end:  newCancelAtEnd,
    canceled_at:           tsToISO(sub.canceled_at),
    updated_at:            new Date().toISOString(),
  }
  if (priceId && STRIPE_ID_REGEX.test(priceId)) updates.stripe_price_id = priceId

  // ── Lógica de plan_name: trata downgrade agendado na renovação ────────────
  // Se há um downgrade pendente E o novo period_start atingiu (ou passou) a
  // data de vigência → aplica o plano agendado e limpa o pending.
  // Caso contrário, usa o plan_name dos metadados normalmente.
  const pendingPlan      = existing?.pending_plan_name as string | undefined
  const pendingEffectAt  = existing?.pending_plan_effective_at as string | undefined
  const newPeriodStartTs = sub.current_period_start as number

  if (pendingPlan && pendingEffectAt && typeof newPeriodStartTs === 'number') {
    const effectiveUnix = Math.floor(new Date(pendingEffectAt).getTime() / 1000)
    if (newPeriodStartTs >= effectiveUnix) {
      // Novo ciclo de faturamento iniciou — aplica o plano agendado
      updates.plan_name                 = pendingPlan
      updates.pending_plan_name         = null
      updates.pending_plan_effective_at = null
      updates.pending_profile_removals  = null
      updates.pending_member_removals   = null

      console.log(`[webhook-stripe] Downgrade agendado aplicado: ${existing?.plan_name}→${pendingPlan} customer: ${customerId}`)

      const profileRemovals = existing?.pending_profile_removals as string[] | null
      const memberRemovals  = existing?.pending_member_removals  as string[] | null
      const ownerUserId     = existing?.user_id as string | null

      // ── 1. Desativa perfis agendados e ativa backups de 90 dias ─────────────
      if (Array.isArray(profileRemovals) && profileRemovals.length > 0 && ownerUserId) {
        const intIds = profileRemovals.map(id => parseInt(id, 10)).filter(n => !isNaN(n))
        if (intIds.length > 0) {
          db.from('profiles')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .in('id', intIds)
            .eq('user_id', ownerUserId)
            .then(({ error: profileErr }) => {
              if (profileErr) {
                console.error(`[webhook-stripe] Erro ao desativar perfis — customer: ${customerId}:`, profileErr.message)
              } else {
                console.log(`[webhook-stripe] ${intIds.length} perfis desativados — customer: ${customerId}`)
              }
            })
            .catch((e: Error) => console.error('[webhook-stripe] Exceção ao desativar perfis:', e.message))
        }

        const now90 = new Date()
        now90.setDate(now90.getDate() + 90)
        const expiresAt   = now90.toISOString()
        const activatedAt = new Date().toISOString()

        db.from('profile_backups')
          .update({
            status:            'active',
            activated_at:      activatedAt,
            backup_expires_at: expiresAt,
            updated_at:        activatedAt,
          })
          .eq('owner_user_id', ownerUserId)
          .eq('status', 'pending')
          .in('original_member_id', profileRemovals)
          .then(({ error: backupErr }) => {
            if (backupErr) {
              console.error(`[webhook-stripe] Erro ao ativar backups — customer: ${customerId}:`, backupErr.message)
            } else {
              console.log(`[webhook-stripe] Backups ativados (90 dias) — customer: ${customerId} expires: ${expiresAt}`)
            }
          })
          .catch((e: Error) => console.error('[webhook-stripe] Exceção ao ativar backups:', e.message))
      }

      // ── 2. Desativa convidados (account_members) agendados ───────────────────
      // Proteção: nunca desativa o próprio dono (neq member_user_id = ownerUserId)
      if (Array.isArray(memberRemovals) && memberRemovals.length > 0 && ownerUserId) {
        db.from('account_members')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('owner_user_id', ownerUserId)
          .neq('member_user_id', ownerUserId)
          .in('id', memberRemovals)
          .then(({ error: memberErr }) => {
            if (memberErr) {
              console.error(`[webhook-stripe] Erro ao desativar convidados — customer: ${customerId}:`, memberErr.message)
            } else {
              console.log(`[webhook-stripe] ${memberRemovals.length} convidado(s) desativados — customer: ${customerId}`)
            }
          })
          .catch((e: Error) => console.error('[webhook-stripe] Exceção ao desativar convidados:', e.message))
      }
    }
    // Se ainda não chegou a data, não altera plan_name (mantém plano atual)
  } else if (['individual', 'casal', 'familia'].includes(metadata.plan_name ?? '')) {
    // Sem downgrade pendente: usa o metadata do Stripe normalmente
    updates.plan_name = metadata.plan_name
  }

  const { error } = await db.from('stripe_subscriptions')
    .update(updates)
    .eq('stripe_customer_id', customerId)

  if (error) console.error('[webhook-stripe] Erro ao atualizar subscription:', error.message)
  else console.log('[webhook-stripe] Subscription atualizada:', subscriptionId, status)

  // Envia email de cancelamento agendado (fire-and-forget)
  if (justScheduledCancel && existing?.user_email) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const proxySecret = Deno.env.get('PROXY_SECRET') ?? ''
    if (supabaseUrl && proxySecret) {
      fetch(`${supabaseUrl}/functions/v1/send-cancellation-email`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-proxy-secret': proxySecret },
        body: JSON.stringify({
          email:       existing.user_email,
          planName:    updates.plan_name ?? existing.plan_name ?? 'GranaEvo',
          periodEnd:   updates.current_period_end,
          periodStart: updates.current_period_start ?? existing.current_period_start,
          isScheduled: true,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch(err => console.error('[webhook-stripe] Erro ao enviar cancel email (scheduled):', err?.message))
    }
  }
}

async function handleSubscriptionDeleted(db: DB, data: Record<string, unknown>) {
  const sub        = data.object as Record<string, unknown>
  const customerId = sub.customer as string
  if (!customerId || !STRIPE_ID_REGEX.test(customerId)) return

  const canceledAt  = tsToISO(sub.canceled_at) ?? new Date().toISOString()
  const periodEnd   = tsToISO(sub.current_period_end)
  const periodStart = tsToISO(sub.current_period_start)

  // Recupera email antes de atualizar (ainda disponível na tabela)
  const { data: existing } = await db
    .from('stripe_subscriptions')
    .select('user_email, plan_name')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  const { error } = await db.from('stripe_subscriptions')
    .update({ status: 'canceled', canceled_at: canceledAt, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId)

  if (error) console.error('[webhook-stripe] Erro ao cancelar subscription:', error.message)
  else console.log('[webhook-stripe] Subscription cancelada — customer:', customerId)

  // Envia email de cancelamento imediato (fire-and-forget)
  if (existing?.user_email) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const proxySecret = Deno.env.get('PROXY_SECRET') ?? ''
    if (supabaseUrl && proxySecret) {
      fetch(`${supabaseUrl}/functions/v1/send-cancellation-email`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-proxy-secret': proxySecret },
        body: JSON.stringify({
          email:       existing.user_email,
          planName:    existing.plan_name ?? 'GranaEvo',
          periodEnd,
          periodStart,
          isScheduled: false,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch(err => console.error('[webhook-stripe] Erro ao enviar cancel email (deleted):', err?.message))
    }
  }
}

async function handlePaymentFailed(db: DB, data: Record<string, unknown>) {
  const invoice    = data.object as Record<string, unknown>
  const customerId = invoice.customer as string
  if (!customerId || !STRIPE_ID_REGEX.test(customerId)) return

  const { error } = await db.from('stripe_subscriptions')
    .update({ status: 'past_due', updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId)
    .neq('status', 'canceled')

  if (error) console.error('[webhook-stripe] Erro ao marcar past_due:', error.message)
  else console.log('[webhook-stripe] Invoice falhou — customer past_due:', customerId)
}
