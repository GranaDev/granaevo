// supabase/functions/stripe-subscription-details/index.ts
// Busca detalhes reais da assinatura + histórico de faturas direto da API Stripe.
// Chamada via /api/stripe (proxy Vercel). Requer proxy secret + JWT válido.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

const STRIPE_ID_REGEX = /^[a-zA-Z0-9_]{4,100}$/

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin  = req.headers.get('origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')   return json({ error: 'Método não permitido' }, 405)

  // ── 1. Proxy secret ──────────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) return json({ error: 'Serviço indisponível' }, 503)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret))
    return json({ error: 'Não autorizado' }, 401)

  // ── 2. JWT ────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Não autorizado' }, 401)
  const token = authHeader.slice(7).trim()

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')              ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
  )

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) return json({ error: 'Sessão inválida' }, 401)

  // ── 3. IDs do Stripe salvos no nosso banco ───────────────────────────────────
  // [GOD6-M01] Queries separadas em vez de .or() com email interpolado —
  // evita PostgREST filter injection se o email contiver vírgula ou parêntese.
  const STATUSES = ['active', 'trialing', 'past_due', 'canceled']

  // Primeira tentativa: por user_id (mais específico)
  let { data: row, error: rowErr } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('user_id', user.id)
    .in('status', STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (rowErr) return json({ error: 'Erro interno' }, 500)

  // Fallback: por email (anônimos ainda não vinculados por user_id)
  if (!row?.stripe_customer_id && user.email) {
    const { data: rowByEmail, error: rowEmailErr } = await supabaseAdmin
      .from('stripe_subscriptions')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('user_email', user.email.toLowerCase().trim())
      .in('status', STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (rowEmailErr) return json({ error: 'Erro interno' }, 500)
    row = rowByEmail
  }

  if (!row?.stripe_customer_id) return json({ error: 'Nenhuma assinatura encontrada' }, 404)

  const customerId     = row.stripe_customer_id
  const subscriptionId = row.stripe_subscription_id ?? ''

  if (!STRIPE_ID_REGEX.test(customerId)) return json({ error: 'Erro interno' }, 500)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) return json({ error: 'Configuração indisponível' }, 503)

  const stripeHeaders = {
    'Authorization': `Bearer ${stripeKey}`,
    'Stripe-Version': '2024-06-20',
  }

  // ── 4. Detalhes da assinatura (data real de criação, valor, etc.) ─────────────
  let subscription: Record<string, unknown> | null = null

  if (subscriptionId && STRIPE_ID_REGEX.test(subscriptionId)) {
    try {
      const res = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { headers: stripeHeaders, signal: AbortSignal.timeout(10_000) },
      )
      if (res.ok) {
        const raw = await res.json() as Record<string, unknown>
        // Extrai apenas o que precisamos — não expõe dados sensíveis
        const items   = (raw.items as { data: Record<string, unknown>[] })?.data ?? []
        const priceRaw = items[0]?.price as Record<string, unknown> | undefined
        subscription = {
          id:                   raw.id,
          status:               raw.status,
          created:              raw.created,        // Unix timestamp — data real de assinatura
          start_date:           raw.start_date,     // Unix timestamp — início do primeiro ciclo
          current_period_start: raw.current_period_start,
          current_period_end:   raw.current_period_end,
          cancel_at_period_end: raw.cancel_at_period_end,
          canceled_at:          raw.canceled_at,
          trial_start:          raw.trial_start,
          trial_end:            raw.trial_end,
          price: priceRaw ? {
            unit_amount: priceRaw.unit_amount,
            currency:    priceRaw.currency,
            interval:    (priceRaw.recurring as Record<string, unknown>)?.interval ?? 'month',
          } : null,
        }
      } else {
        console.warn('[stripe-sub-details] Stripe subscription fetch falhou:', res.status)
      }
    } catch (e) {
      console.error('[stripe-sub-details] Erro ao buscar subscription:', (e as Error).message)
    }
  }

  // ── 5. Histórico de faturas (pagas + abertas) ─────────────────────────────────
  let invoices: unknown[] = []
  try {
    const params = new URLSearchParams({
      customer: customerId,
      limit:    '24',
    })
    if (subscriptionId && STRIPE_ID_REGEX.test(subscriptionId)) {
      params.set('subscription', subscriptionId)
    }

    const res = await fetch(
      `https://api.stripe.com/v1/invoices?${params.toString()}`,
      { headers: stripeHeaders, signal: AbortSignal.timeout(10_000) },
    )

    if (res.ok) {
      const body = await res.json() as { data: Record<string, unknown>[] }
      invoices = (body.data ?? []).map(inv => ({
        id:           inv.id,
        number:       inv.number,
        status:       inv.status,         // 'paid' | 'open' | 'uncollectible' | 'void'
        amount_paid:  inv.amount_paid,    // centavos
        amount_due:   inv.amount_due,
        currency:     inv.currency,
        created:      inv.created,        // Unix timestamp — data da fatura
        period_start: inv.period_start,   // Unix timestamp
        period_end:   inv.period_end,     // Unix timestamp
        invoice_pdf:  inv.invoice_pdf,    // URL pre-assinada do PDF
        hosted_invoice_url: inv.hosted_invoice_url,
      }))
    } else {
      console.warn('[stripe-sub-details] Stripe invoices fetch falhou:', res.status)
    }
  } catch (e) {
    console.error('[stripe-sub-details] Erro ao buscar invoices:', (e as Error).message)
  }

  console.log('[stripe-sub-details] OK — user:', user.id.slice(0, 8), '— invoices:', invoices.length)
  return json({ subscription, invoices })
})
