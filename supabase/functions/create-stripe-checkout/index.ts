// supabase/functions/create-stripe-checkout/index.ts
// Cria uma Stripe Checkout Session para assinaturas mensais.
// Requer: PROXY_SECRET + JWT válido + STRIPE_SECRET_KEY + STRIPE_PRICE_xxx

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

// Mapeia nome do plano → variável de ambiente que contém o Price ID do Stripe
const PLAN_ENV_MAP: Record<string, string> = {
  individual: 'STRIPE_PRICE_INDIVIDUAL',
  casal:      'STRIPE_PRICE_CASAL',
  familia:    'STRIPE_PRICE_FAMILIA',
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  if (aB.length !== bB.length) return false
  let diff = 0
  for (let i = 0; i < aB.length; i++) diff |= aB[i] ^ bB[i]
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

  // ── 1. Proxy secret — bloqueia chamadas diretas que bypassam o Vercel ──────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[create-stripe-checkout] PROXY_SECRET não configurada')
    return json({ error: 'Serviço indisponível' }, 503)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[create-stripe-checkout] Proxy secret inválido — acesso direto bloqueado')
    return json({ error: 'Não autorizado' }, 401)
  }

  // ── 2. Verificar JWT via Admin client (ES256/HS256) ───────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Não autorizado' }, 401)
  const token = authHeader.slice(7).trim()
  if (!token || token.length < 20) return json({ error: 'Não autorizado' }, 401)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  )

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) {
    console.warn('[create-stripe-checkout] JWT inválido:', userErr?.message)
    return json({ error: 'Sessão inválida' }, 401)
  }

  // ── 3. Validar plano solicitado ───────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  const plan = (body.plan as string ?? '').toLowerCase().trim()
  if (!plan || !PLAN_ENV_MAP[plan]) {
    console.warn('[create-stripe-checkout] Plano inválido:', plan)
    return json({ error: 'Plano inválido. Use: individual, casal ou familia' }, 400)
  }

  const priceId   = Deno.env.get(PLAN_ENV_MAP[plan])
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')

  if (!priceId) {
    console.error('[create-stripe-checkout] Price ID não configurado para plano:', plan)
    return json({ error: 'Configuração de plano indisponível' }, 503)
  }
  if (!stripeKey) {
    console.error('[create-stripe-checkout] STRIPE_SECRET_KEY não configurada')
    return json({ error: 'Serviço indisponível' }, 503)
  }

  // ── 4. Criar Stripe Checkout Session (REST API direta — sem SDK) ──────────
  const params = new URLSearchParams()
  params.set('mode', 'subscription')
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('customer_email', user.email ?? '')
  params.set('client_reference_id', user.id)
  // metadata na session (disponível em checkout.session.completed)
  params.set('metadata[user_id]',    user.id)
  params.set('metadata[user_email]', user.email ?? '')
  params.set('metadata[plan_name]',  plan)
  // metadata na subscription (disponível em events futuros da assinatura)
  params.set('subscription_data[metadata][user_id]',    user.id)
  params.set('subscription_data[metadata][user_email]', user.email ?? '')
  params.set('subscription_data[metadata][plan_name]',  plan)
  params.set('success_url', 'https://granaevo.com/dashboard.html?stripe=success')
  params.set('cancel_url',  'https://granaevo.com/planos.html')
  params.set('locale', 'pt-BR')
  params.set('allow_promotion_codes', 'true')

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
  } catch (err) {
    console.error('[create-stripe-checkout] Timeout/rede ao chamar Stripe:', err)
    return json({ error: 'Erro de conexão com gateway de pagamento' }, 502)
  }

  if (!stripeRes.ok) {
    const errText = await stripeRes.text()
    console.error('[create-stripe-checkout] Stripe API error:', stripeRes.status, errText)
    return json({ error: 'Erro ao criar sessão de pagamento' }, 502)
  }

  const session = await stripeRes.json()
  if (!session.url) {
    console.error('[create-stripe-checkout] Stripe não retornou URL na sessão')
    return json({ error: 'URL de checkout não retornada' }, 502)
  }

  console.log('[create-stripe-checkout] Sessão criada — user:', user.id.slice(0, 8), 'plano:', plan)
  return json({ url: session.url })
})
