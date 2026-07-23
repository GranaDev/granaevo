// supabase/functions/create-stripe-checkout/index.ts
// JWT OPCIONAL — suporta checkout anônimo (paga antes, cria conta depois).
// Se JWT presente: vincula user_id imediatamente.
// Se ausente: subscription fica com user_id=null, vinculada por email em check-user-access.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS)
// com fallback na service_role legada — rollback = redeploy do commit anterior
// enquanto a legada existir. Migração de API keys 2026-07-23.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* env ausente/inválida → usa a legada */ }
  console.warn('[keys] SUPABASE_SECRET_KEYS indisponível — usando service_role legada (fallback)')
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

// Object.create(null): sem protótipo. Com um objeto literal, `PLAN_ENV_MAP['constructor']`
// devolve o construtor `Object` (truthy) e PASSA a validação `!PLAN_ENV_MAP[plan]` lá
// embaixo. Hoje isso morre em 503 no `Deno.env.get` seguinte (falha fechado, sem
// escalada), mas é sorte, não desenho — e some no dia em que alguém mexer na ordem.
const PLAN_ENV_MAP: Record<string, string> = Object.assign(Object.create(null), {
  individual: 'STRIPE_PRICE_INDIVIDUAL',
  casal:      'STRIPE_PRICE_CASAL',
  familia:    'STRIPE_PRICE_FAMILIA',
})

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
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  // ── 1. Proxy secret obrigatório ───────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) return json({ error: 'Serviço indisponível' }, 503)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret))
    return json({ error: 'Não autorizado' }, 401)

  // ── 2. JWT OPCIONAL — melhora rastreamento mas não bloqueia checkout ──────
  let userId    = ''
  let userEmail = ''

  const authHeader = req.headers.get('Authorization') ?? ''
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token.length > 20) {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        getSecretKey(),
        { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
      )
      const { data: { user } } = await supabaseAdmin.auth.getUser(token).catch(() => ({ data: { user: null } }))
      if (user?.id) {
        userId    = user.id
        userEmail = user.email ?? ''
      }
    }
  }

  // ── 3. Validar plano ──────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  const plan = (body.plan as string ?? '').toLowerCase().trim()
  if (!plan || !PLAN_ENV_MAP[plan]) return json({ error: 'Plano inválido' }, 400)

  // Email do body como fallback (anônimo) — VUL-003 FIX: regex em vez de raw.includes('@')
  const _EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
  if (!userEmail && typeof body.email === 'string') {
    const raw = body.email.toLowerCase().trim()
    if (raw.length <= 254 && _EMAIL_RE.test(raw)) userEmail = raw
  }

  const priceId   = Deno.env.get(PLAN_ENV_MAP[plan])
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!priceId || !stripeKey) return json({ error: 'Configuração indisponível' }, 503)

  // ── 4. Criar Checkout Session ─────────────────────────────────────────────
  // success_url: logado → dashboard; anônimo → planos com mensagem de sucesso
  const successUrl = userId
    ? 'https://granaevo.com/dashboard.html?stripe=success'
    : 'https://granaevo.com/planos.html?stripe_paid=1'

  const params = new URLSearchParams()
  params.set('mode', 'subscription')
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('success_url', successUrl)
  params.set('cancel_url',  'https://granaevo.com/planos.html')
  params.set('locale', 'pt-BR')
  params.set('allow_promotion_codes', 'true')

  if (userEmail) params.set('customer_email', userEmail)
  if (userId)    params.set('client_reference_id', userId)

  // Metadata para o webhook — user_id pode ser vazio (anônimo)
  params.set('metadata[user_id]',    userId)
  params.set('metadata[user_email]', userEmail)
  params.set('metadata[plan_name]',  plan)
  if (userId) {
    params.set('subscription_data[metadata][user_id]',    userId)
    params.set('subscription_data[metadata][user_email]', userEmail)
  }
  params.set('subscription_data[metadata][plan_name]', plan)

  let stripeRes: Response
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${stripeKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body:   params.toString(),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return json({ error: 'Erro de conexão com gateway de pagamento' }, 502)
  }

  if (!stripeRes.ok) {
    console.error('[create-stripe-checkout] Stripe error:', await stripeRes.text())
    return json({ error: 'Erro ao criar sessão de pagamento' }, 502)
  }

  const session = await stripeRes.json()
  if (!session.url) return json({ error: 'URL não retornada pelo Stripe' }, 502)

  const logCtx = userId ? `user:${userId.slice(0, 8)}` : `anon:${userEmail.slice(0, 10) || 'no-email'}`
  console.log('[create-stripe-checkout] OK —', logCtx, 'plano:', plan)
  return json({ url: session.url })
})
