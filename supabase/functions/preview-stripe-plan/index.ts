// supabase/functions/preview-stripe-plan/index.ts
// Calcula o preview de valor antes de alterar o plano.
//
// Upgrade: calcula proration manualmente (segundos restantes / segundos totais * diferença de preço).
//          Resultado idêntico ao que o Stripe cobrará — sem depender do upcoming invoice API.
// Downgrade: retorna a data de vigência (fim do ciclo atual) e o novo valor mensal.
//
// Somente leitura — nunca altera nada.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

const STRIPE_ID_REGEX = /^[a-zA-Z0-9_]{4,100}$/
const VALID_PLANS     = new Set(['individual', 'casal', 'familia'])
const PLAN_RANK:   Record<string, number> = { individual: 1, casal: 2, familia: 3 }
const PLAN_LIMITS: Record<string, number> = { individual: 1, casal: 2, familia: 4 }
const GUEST_LIMITS: Record<string, number> = { individual: 0, casal: 1, familia: 3 }

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

async function fetchStripePrice(priceId: string, stripeKey: string): Promise<{ unitAmount: number; currency: string } | null> {
  try {
    const r = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
      headers: { 'Authorization': `Bearer ${stripeKey}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (!r.ok) return null
    const p = await r.json()
    return { unitAmount: (p.unit_amount as number) ?? 0, currency: (p.currency as string) ?? 'brl' }
  } catch {
    return null
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

  // ── 2b. Anti-convidado: apenas o titular pode visualizar mudanças de plano ─
  const { data: guestRow } = await supabaseAdmin
    .from('account_members')
    .select('id')
    .eq('member_user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  if (guestRow) {
    console.warn(`[preview-stripe-plan] GUEST_BLOCKED — user: ${user.id.slice(0, 8)}`)
    return json({ error: 'Acesso negado. Apenas o titular da conta pode gerenciar o plano.', code: 'GUEST_BLOCKED' }, 403)
  }

  // ── 3. Valida plano ───────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  const newPlan = ((body.newPlan as string) ?? '').toLowerCase().trim()
  if (!VALID_PLANS.has(newPlan)) return json({ error: 'Plano inválido' }, 400)

  const newPriceId = Deno.env.get(PLAN_ENV_MAP[newPlan]) ?? ''
  if (!newPriceId) return json({ error: `Price ID não configurado para "${newPlan}"` }, 503)

  // ── 4. Busca assinatura no banco ──────────────────────────────────────────
  const { data: stripeSub, error: subErr } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, plan_name, stripe_price_id, current_period_start, current_period_end, pending_plan_name, pending_plan_effective_at')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr)   return json({ error: 'Erro interno' }, 500)
  if (!stripeSub?.stripe_subscription_id) return json({ error: 'Nenhuma assinatura ativa' }, 404)

  const currentPlan = (stripeSub.plan_name ?? '').toLowerCase()
  const currentRank = PLAN_RANK[currentPlan] ?? 0
  const newRank     = PLAN_RANK[newPlan]     ?? 0
  const isUpgrade   = newRank > currentRank
  const isDowngrade = newRank < currentRank
  const isSamePlan  = currentPlan === newPlan

  // Cancelar downgrade agendado: o usuário selecionou o próprio plano atual
  if (isSamePlan) {
    if (!stripeSub.pending_plan_name) return json({ error: `Você já está no plano ${newPlan}` }, 409)
    return json({
      type:               'cancel_pending',
      amountDue:          0,
      currency:           'brl',
      currentPlan,
      newPlan,
      pendingPlan:        stripeSub.pending_plan_name,
      pendingEffectiveAt: stripeSub.pending_plan_effective_at,
    })
  }

  // Plano selecionado já é o downgrade agendado
  if (newPlan === stripeSub.pending_plan_name) {
    return json({
      type:               'already_scheduled',
      amountDue:          0,
      currency:           'brl',
      currentPlan,
      newPlan,
      pendingEffectiveAt: stripeSub.pending_plan_effective_at,
    })
  }

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) return json({ error: 'Configuração indisponível' }, 503)

  const stripeHeaders = { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2024-06-20' }

  // ── Reconciliação de datas: se o banco não tem period_start/end, busca do Stripe ──
  // Garante que o cálculo de proration nunca resulte em zero por dados desatualizados.
  let periodStartIso: string | null = stripeSub.current_period_start ?? null
  let periodEndIso:   string | null = stripeSub.current_period_end   ?? null

  if (!periodEndIso || !periodStartIso) {
    try {
      const subRes = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSub.stripe_subscription_id)}`,
        { headers: stripeHeaders, signal: AbortSignal.timeout(8_000) }
      )
      if (subRes.ok) {
        const sub = await subRes.json() as Record<string, unknown>
        if (sub.current_period_start) periodStartIso = new Date((sub.current_period_start as number) * 1000).toISOString()
        if (sub.current_period_end)   periodEndIso   = new Date((sub.current_period_end   as number) * 1000).toISOString()
      }
    } catch { /* segue para fallback */ }

    // Fallback: lista subscriptions ativas do customer
    if ((!periodEndIso || !periodStartIso) && stripeSub.stripe_customer_id && STRIPE_ID_REGEX.test(stripeSub.stripe_customer_id)) {
      try {
        const listRes = await fetch(
          `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(stripeSub.stripe_customer_id)}&status=active&limit=1`,
          { headers: stripeHeaders, signal: AbortSignal.timeout(8_000) }
        )
        if (listRes.ok) {
          const list = await listRes.json() as { data: Record<string, unknown>[] }
          const found = list.data?.[0]
          if (found?.current_period_start) periodStartIso = new Date((found.current_period_start as number) * 1000).toISOString()
          if (found?.current_period_end)   periodEndIso   = new Date((found.current_period_end   as number) * 1000).toISOString()
        }
      } catch { /* sem dados */ }
    }
  }

  // Timestamp unix do fim do período atual
  const periodEnd = periodEndIso
    ? Math.floor(new Date(periodEndIso).getTime() / 1000)
    : null

  // ── Downgrade: sem cobrança imediata + verifica necessidade de remover perfis/convidados ─
  if (isDowngrade) {
    const newPrice  = await fetchStripePrice(newPriceId, stripeKey)
    const newLimit  = PLAN_LIMITS[newPlan] ?? 1
    const guestLimit = GUEST_LIMITS[newPlan] ?? 0

    // Busca perfis ativos do usuário (tabela profiles)
    let members: { id: string; name: string; email: string }[] = []
    let requiresProfileRemoval = false
    let excessCount = 0

    try {
      const { data: profileRows, error: profErr } = await supabaseAdmin
        .from('profiles')
        .select('id, name, photo_url')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .order('id', { ascending: true })

      if (profErr) throw profErr

      const activeProfiles = profileRows ?? []
      excessCount          = Math.max(0, activeProfiles.length - newLimit)
      requiresProfileRemoval = excessCount > 0
      members = activeProfiles.map(p => ({
        id:    String(p.id),
        name:  (p.name as string) || 'Perfil',
        email: (p.photo_url as string) || '',  // photo_url exibido como avatar no frontend
      }))
    } catch (e) {
      console.warn('[preview-stripe-plan] Erro ao buscar perfis:', (e as Error).message)
    }

    // Busca convidados ativos do usuário (tabela account_members)
    let guests: { id: string; memberId: string; email: string }[] = []
    let requiresGuestRemoval = false
    let excessGuestCount = 0

    try {
      const { data: guestRows, error: guestErr } = await supabaseAdmin
        .from('account_members')
        .select('id, member_user_id, member_email')
        .eq('owner_user_id', user.id)
        .eq('is_active', true)

      if (guestErr) throw guestErr

      const activeGuests = guestRows ?? []
      excessGuestCount   = Math.max(0, activeGuests.length - guestLimit)
      requiresGuestRemoval = excessGuestCount > 0
      guests = activeGuests.map(g => ({
        id:       g.id as string,
        memberId: g.member_user_id as string,
        email:    (g.member_email as string) || (g.member_user_id as string),
      }))
    } catch (e) {
      console.warn('[preview-stripe-plan] Erro ao buscar convidados:', (e as Error).message)
    }

    return json({
      type:                  'downgrade',
      amountDue:             0,
      currency:              newPrice?.currency ?? 'brl',
      currentPlan,
      newPlan,
      newPlanUnitAmount:     newPrice?.unitAmount ?? 0,
      periodEnd,
      requiresProfileRemoval,
      excessCount,
      newPlanLimit:          newLimit,
      members,
      requiresGuestRemoval,
      excessGuestCount,
      guestLimit,
      guests,
    })
  }

  // ── Upgrade: cálculo de proration por segundos (idêntico ao Stripe) ───────
  // Stripe usa: amountDue = round(fraction * newPrice) - round(fraction * oldPrice)
  // onde fraction = segundos_restantes / segundos_totais_do_ciclo
  const nowSecs    = Math.floor(Date.now() / 1000)
  const startSecs  = periodStartIso
    ? Math.floor(new Date(periodStartIso).getTime() / 1000)
    : 0
  const endSecs    = periodEnd ?? 0
  const totalSecs  = endSecs - startSecs
  const remaining  = Math.max(0, endSecs - nowSecs)
  const fraction   = totalSecs > 0 ? remaining / totalSecs : 0

  // Busca preços do plano atual e do novo em paralelo
  const currentPriceId = Deno.env.get(PLAN_ENV_MAP[currentPlan]) ?? stripeSub.stripe_price_id ?? ''
  const [currentPrice, newPrice] = await Promise.all([
    currentPriceId ? fetchStripePrice(currentPriceId, stripeKey) : Promise.resolve(null),
    fetchStripePrice(newPriceId, stripeKey),
  ])

  const currentUnitAmount = currentPrice?.unitAmount ?? 0
  const newUnitAmount     = newPrice?.unitAmount     ?? 0
  const currency          = newPrice?.currency       ?? currentPrice?.currency ?? 'brl'

  // Crédito pelo tempo não utilizado no plano atual
  const creditAmount = Math.round(currentUnitAmount * fraction)
  // Cobrança pelo tempo restante no novo plano
  const chargeAmount = Math.round(newUnitAmount * fraction)
  // Valor líquido a cobrar agora
  const amountDue    = Math.max(0, chargeAmount - creditAmount)

  console.log(`[preview-stripe-plan] user: ${user.id.slice(0, 8)} ${currentPlan}→${newPlan} fraction: ${fraction.toFixed(4)} amountDue: ${amountDue}`)

  return json({
    type:             'upgrade',
    amountDue,
    creditAmount,
    chargeAmount,
    currency,
    currentPlan,
    newPlan,
    newPlanUnitAmount: newUnitAmount,
    periodEnd,
  })
})
