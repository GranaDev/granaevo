// supabase/functions/update-stripe-plan/index.ts
// Altera o plano (price) de uma assinatura Stripe existente.
// Requer proxy secret + JWT válido.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

const STRIPE_ID_REGEX = /^[a-zA-Z0-9_]{4,100}$/
const VALID_PLANS     = new Set(['individual', 'casal', 'familia'])

const PLAN_ENV_MAP: Record<string, string> = {
  individual: 'STRIPE_PRICE_INDIVIDUAL',
  casal:      'STRIPE_PRICE_CASAL',
  familia:    'STRIPE_PRICE_FAMILIA',
}

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

  // ── 1. Proxy secret ───────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) return json({ error: 'Serviço indisponível' }, 503)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret))
    return json({ error: 'Não autorizado' }, 401)

  // ── 2. JWT ────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Não autorizado' }, 401)
  const token = authHeader.slice(7).trim()

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  )

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) return json({ error: 'Sessão inválida' }, 401)

  // ── 3. Valida plano ───────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  const newPlan = ((body.newPlan as string) ?? '').toLowerCase().trim()
  if (!VALID_PLANS.has(newPlan)) return json({ error: 'Plano inválido' }, 400)

  const newPriceEnvKey = PLAN_ENV_MAP[newPlan]
  const newPriceId     = Deno.env.get(newPriceEnvKey) ?? ''
  if (!newPriceId) return json({ error: `Price ID não configurado para plano "${newPlan}"` }, 503)

  // ── 4. Busca assinatura do usuário ────────────────────────────────────────
  const { data: stripeSub, error: subErr } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, plan_name, status')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr)   return json({ error: 'Erro interno' }, 500)
  if (!stripeSub?.stripe_subscription_id) return json({ error: 'Nenhuma assinatura ativa encontrada' }, 404)

  if (!STRIPE_ID_REGEX.test(stripeSub.stripe_subscription_id))
    return json({ error: 'Erro interno' }, 500)

  // Verifica se já é o mesmo plano
  if ((stripeSub.plan_name ?? '').toLowerCase() === newPlan)
    return json({ error: `Você já está no plano ${newPlan}` }, 409)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) return json({ error: 'Configuração indisponível' }, 503)

  // ── 5. Busca subscription items no Stripe ─────────────────────────────────
  let stripeSubData: Record<string, unknown>
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSub.stripe_subscription_id)}`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` }, signal: AbortSignal.timeout(10_000) }
    )
    if (!r.ok) {
      console.error('[update-stripe-plan] Erro ao buscar subscription:', await r.text())
      return json({ error: 'Erro ao buscar dados da assinatura' }, 502)
    }
    stripeSubData = await r.json()
  } catch {
    return json({ error: 'Erro de conexão com gateway de pagamento' }, 502)
  }

  const items = (stripeSubData?.items as any)?.data as any[]
  if (!items || items.length === 0) return json({ error: 'Itens da assinatura não encontrados' }, 502)

  const itemId = items[0]?.id as string
  if (!itemId || !STRIPE_ID_REGEX.test(itemId))
    return json({ error: 'Erro interno — item ID inválido' }, 500)

  // ── 6. Atualiza subscription no Stripe ────────────────────────────────────
  const params = new URLSearchParams()
  params.set(`items[0][id]`,    itemId)
  params.set(`items[0][price]`, newPriceId)
  params.set('proration_behavior', 'always_invoice')
  params.set('metadata[plan_name]', newPlan)

  let updateRes: Response
  try {
    updateRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSub.stripe_subscription_id)}`,
      {
        method:  'POST',
        headers: {
          'Authorization':  `Bearer ${stripeKey}`,
          'Content-Type':   'application/x-www-form-urlencoded',
          'Stripe-Version': '2024-06-20',
        },
        body:   params.toString(),
        signal: AbortSignal.timeout(15_000),
      }
    )
  } catch {
    return json({ error: 'Erro de conexão ao atualizar plano' }, 502)
  }

  if (!updateRes.ok) {
    const errText = await updateRes.text()
    console.error('[update-stripe-plan] Stripe error:', errText)
    return json({ error: 'Erro ao atualizar plano no Stripe' }, 502)
  }

  // ── 7. Atualiza plan_name no banco ────────────────────────────────────────
  await supabaseAdmin
    .from('stripe_subscriptions')
    .update({ plan_name: newPlan, updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

  console.log(`[update-stripe-plan] Plano atualizado — user: ${user.id.slice(0, 8)} → ${newPlan}`)
  return json({ success: true, newPlan })
})
