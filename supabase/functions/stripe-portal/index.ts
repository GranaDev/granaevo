// supabase/functions/stripe-portal/index.ts
// Cria uma sessão no Stripe Customer Portal para o usuário gerenciar
// sua assinatura (cancelar, mudar plano, atualizar cartão).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

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

  // ── 1. Proxy secret ───────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[stripe-portal] PROXY_SECRET não configurada')
    return json({ error: 'Serviço indisponível' }, 503)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[stripe-portal] Proxy secret inválido — acesso direto bloqueado')
    return json({ error: 'Não autorizado' }, 401)
  }

  // ── 2. Verificar JWT ───────────────────────────────────────────────────────
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
    console.warn('[stripe-portal] JWT inválido:', userErr?.message)
    return json({ error: 'Sessão inválida' }, 401)
  }

  // ── 3. Buscar stripe_customer_id do usuário ───────────────────────────────
  const { data: stripeSub, error: subErr } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr) {
    console.error('[stripe-portal] Erro ao buscar stripe_subscriptions:', subErr.message)
    return json({ error: 'Erro interno' }, 500)
  }
  if (!stripeSub?.stripe_customer_id) {
    return json({ error: 'Nenhuma assinatura Stripe encontrada para este usuário' }, 404)
  }

  // ── 4. Criar sessão no Stripe Customer Portal ─────────────────────────────
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) {
    console.error('[stripe-portal] STRIPE_SECRET_KEY não configurada')
    return json({ error: 'Serviço indisponível' }, 503)
  }

  const params = new URLSearchParams()
  params.set('customer',   stripeSub.stripe_customer_id)
  params.set('return_url', 'https://granaevo.com/dashboard.html')

  let portalRes: Response
  try {
    portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${stripeKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body:   params.toString(),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[stripe-portal] Timeout/rede ao chamar Stripe:', err)
    return json({ error: 'Erro de conexão com gateway de pagamento' }, 502)
  }

  if (!portalRes.ok) {
    const errText = await portalRes.text()
    console.error('[stripe-portal] Stripe API error:', portalRes.status, errText)
    return json({ error: 'Erro ao criar portal de gerenciamento' }, 502)
  }

  const portal = await portalRes.json()
  if (!portal.url) return json({ error: 'URL do portal não retornada' }, 502)

  console.log('[stripe-portal] Portal criado para user:', user.id.slice(0, 8))
  return json({ url: portal.url })
})
