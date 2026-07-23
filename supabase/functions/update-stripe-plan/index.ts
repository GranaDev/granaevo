// supabase/functions/update-stripe-plan/index.ts
// Altera o plano de uma assinatura Stripe existente.
//
// Upgrade:             cobrança proporcional imediata via always_invoice
//                      + restaura backups de perfis ativos (downgrade anterior)
// Downgrade:           agendado para fim do ciclo + cria backups de perfis
// Cancel pending:      cancela downgrade agendado + cancela backups pendentes
// changeRemovalList:   altera quais perfis serão removidos no downgrade agendado
//
// Requer proxy secret + JWT válido.

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

const STRIPE_ID_REGEX  = /^[a-zA-Z0-9_]{4,100}$/
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROFILE_ID_RE    = /^\d{1,10}$/  // IDs inteiros da tabela profiles
const VALID_PLANS      = new Set(['individual', 'casal', 'familia'])
const PLAN_RANK:   Record<string, number> = { individual: 1, casal: 2, familia: 3 }
const PLAN_LIMITS: Record<string, number> = { individual: 1, casal: 2, familia: 4 }
const GUEST_LIMITS:       Record<string, number> = { individual: 0, casal: 1, familia: 3 }
const PLAN_PRICES_CENTS:  Record<string, number> = { individual: 1999, casal: 3499, familia: 5499 }

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

async function stripePost(url: string, stripeKey: string, params: URLSearchParams): Promise<Response> {
  return fetch(url, {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${stripeKey}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body:   params.toString(),
    signal: AbortSignal.timeout(15_000),
  })
}

type DB = ReturnType<typeof createClient>

// ── Cria backups para os perfis que serão removidos no downgrade ──────────────
// profileIds: strings de IDs inteiros da tabela profiles (ex: ["6", "34"])
async function createProfileBackups(
  db: DB,
  ownerUserId: string,
  profileIds: string[],
  scheduledAt: string,
  currentPlan: string,
  targetPlan: string,
  subscriptionId: string,
): Promise<void> {
  if (profileIds.length === 0) return

  const intIds = profileIds.map(id => parseInt(id, 10)).filter(n => !isNaN(n))
  if (intIds.length === 0) return

  // Busca dados completos dos perfis para o snapshot
  const { data: profiles, error } = await db
    .from('profiles')
    .select('*')
    .in('id', intIds)
    .eq('user_id', ownerUserId)
    .eq('is_active', true)

  if (error || !profiles?.length) {
    console.error('[update-stripe-plan] Erro ao buscar perfis para backup:', error?.message)
    return
  }

  const backups = profiles.map((p: Record<string, unknown>) => ({
    owner_user_id:          ownerUserId,
    original_member_id:     String(p.id),
    source_table:           'profiles',
    member_name:            (p.name as string) || null,
    member_email:           null,
    member_data:            p,  // snapshot completo
    scheduled_removal_at:   scheduledAt,
    status:                 'pending',
    original_plan:          currentPlan,
    target_plan:            targetPlan,
    stripe_subscription_id: subscriptionId,
  }))

  const { error: backupErr } = await db
    .from('profile_backups')
    .upsert(backups, { onConflict: 'owner_user_id,original_member_id,source_table' })

  if (backupErr) {
    console.error('[update-stripe-plan] Erro ao criar backups:', backupErr.message)
  } else {
    console.log(`[update-stripe-plan] ${backups.length} backup(s) criado(s) para user: ${ownerUserId.slice(0, 8)}`)
  }
}

// ── Cancela backups pendentes (quando downgrade é cancelado) ──────────────────
async function cancelPendingBackups(db: DB, ownerUserId: string): Promise<void> {
  const { error } = await db
    .from('profile_backups')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('owner_user_id', ownerUserId)
    .eq('status', 'pending')

  if (error) console.error('[update-stripe-plan] Erro ao cancelar backups pendentes:', error.message)
  else console.log(`[update-stripe-plan] Backups pendentes cancelados — user: ${ownerUserId.slice(0, 8)}`)
}

// ── Restaura perfis de backups ativos (quando usuário faz upgrade de volta) ────
async function restoreActiveBackups(db: DB, ownerUserId: string): Promise<number> {
  const { data: activeBackups, error: fetchErr } = await db
    .from('profile_backups')
    .select('id, original_member_id, source_table')
    .eq('owner_user_id', ownerUserId)
    .eq('status', 'active')

  if (fetchErr || !activeBackups?.length) return 0

  // Restaura perfis da tabela profiles (IDs inteiros)
  const profileBackups = activeBackups.filter((b: Record<string, unknown>) => b.source_table === 'profiles')
  if (profileBackups.length > 0) {
    const intIds = profileBackups.map((b: Record<string, unknown>) => parseInt(b.original_member_id as string, 10))
    await db.from('profiles')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .in('id', intIds)
      .eq('user_id', ownerUserId)
  }

  // Restaura membros da tabela account_members (UUIDs)
  const memberBackups = activeBackups.filter((b: Record<string, unknown>) => b.source_table === 'account_members')
  if (memberBackups.length > 0) {
    const uuids = memberBackups.map((b: Record<string, unknown>) => b.original_member_id as string)
    await db.from('account_members')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .in('id', uuids)
      .eq('owner_user_id', ownerUserId)
  }

  // Marca todos os backups como restaurados
  const backupIds = activeBackups.map((b: Record<string, unknown>) => b.id as string)
  await db.from('profile_backups')
    .update({ status: 'restored', updated_at: new Date().toISOString() })
    .in('id', backupIds)

  console.log(`[update-stripe-plan] ${activeBackups.length} perfil(s) restaurado(s) — user: ${ownerUserId.slice(0, 8)}`)
  return activeBackups.length
}

// ── Dispara email de confirmação de mudança de plano (fire-and-forget) ────────
// Falhas de email são silenciosas — nunca bloqueiam a resposta ao cliente.
async function _fireEmail(payload: Record<string, unknown>): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const proxySecret = Deno.env.get('PROXY_SECRET') ?? ''
    if (!supabaseUrl || !proxySecret) return
    await fetch(`${supabaseUrl}/functions/v1/send-plan-change-email`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-secret': proxySecret },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(15_000),
    })
  } catch (e) {
    console.error('[update-stripe-plan] Erro ao enviar email de mudança de plano:', (e as Error).message)
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
    getSecretKey(),
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
  )

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) return json({ error: 'Sessão inválida' }, 401)

  // ── 2b. Anti-convidado: apenas o titular pode gerenciar o plano ───────────
  // Convidados têm entrada em account_members.member_user_id mas não têm
  // stripe_subscriptions própria — bloqueio duplo, defense-in-depth.
  const { data: guestRow } = await supabaseAdmin
    .from('account_members')
    .select('id')
    .eq('member_user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  if (guestRow) {
    console.warn(`[update-stripe-plan] GUEST_BLOCKED — user: ${user.id.slice(0, 8)}`)
    return json({ error: 'Acesso negado. Apenas o titular da conta pode gerenciar o plano.', code: 'GUEST_BLOCKED' }, 403)
  }

  // ── 3. Valida body ────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  // action pode ser 'changeRemovalList' (enviado pelo proxy para esta função)
  const incomingAction = typeof body.action === 'string' ? body.action : ''
  const newPlan        = ((body.newPlan as string) ?? '').toLowerCase().trim()

  // IDs inteiros de profiles a remover — filtro defensivo (PROFILE_ID_RE)
  const profilesToRemove: string[] = Array.isArray(body.profilesToRemove)
    ? (body.profilesToRemove as unknown[]).filter(
        (s): s is string => typeof s === 'string' && PROFILE_ID_RE.test(s)
      )
    : []

  // UUIDs de account_members a remover — filtro defensivo (UUID_RE)
  const membersToRemove: string[] = Array.isArray(body.membersToRemove)
    ? (body.membersToRemove as unknown[]).filter(
        (s): s is string => typeof s === 'string' && UUID_RE.test(s)
      )
    : []

  if (profilesToRemove.length > 10 || membersToRemove.length > 10)
    return json({ error: 'Número de itens inválido' }, 400)

  // ── 4. Busca assinatura do usuário ────────────────────────────────────────
  const { data: stripeSub, error: subErr } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, plan_name, status, current_period_end, pending_plan_name, pending_profile_removals, user_email')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subErr)   return json({ error: 'Erro interno' }, 500)
  if (!stripeSub?.stripe_subscription_id) return json({ error: 'Nenhuma assinatura ativa encontrada' }, 404)
  if (!STRIPE_ID_REGEX.test(stripeSub.stripe_subscription_id))
    return json({ error: 'Erro interno' }, 500)

  const currentPlan = (stripeSub.plan_name ?? '').toLowerCase()
  const currentRank = PLAN_RANK[currentPlan] ?? 0

  // ══════════════════════════════════════════════════════════════════════════
  // AÇÃO: changeRemovalList — Altera quais perfis serão removidos no downgrade
  // ══════════════════════════════════════════════════════════════════════════
  if (incomingAction === 'changeRemovalList') {
    // Requer downgrade agendado ativo
    if (!stripeSub.pending_plan_name) {
      return json({ error: 'Nenhum downgrade agendado para alterar' }, 409)
    }

    const targetPlan = stripeSub.pending_plan_name as string
    const newLimit   = PLAN_LIMITS[targetPlan] ?? 1

    // Conta perfis ativos do usuário na tabela profiles
    const { count: profileCount, error: cntErr } = await supabaseAdmin
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_active', true)

    if (cntErr) return json({ error: 'Erro ao verificar perfis' }, 500)

    const totalProfiles  = profileCount ?? 0
    const excessProfiles = Math.max(0, totalProfiles - newLimit)

    if (profilesToRemove.length < excessProfiles) {
      return json({
        error: `Selecione ${excessProfiles} perfil${excessProfiles > 1 ? 's' : ''} para remover.`,
        code:  'profile_removal_required',
        excessCount: excessProfiles,
      }, 400)
    }

    // Anti-fraude: valida que os IDs são perfis ativos DESTE usuário
    const intIds = profilesToRemove.map(id => parseInt(id, 10))
    const { data: validProfiles, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .in('id', intIds)

    if (profileErr || !validProfiles) return json({ error: 'Erro ao validar perfis' }, 500)
    if (validProfiles.length !== profilesToRemove.length)
      return json({ error: 'Um ou mais perfis selecionados são inválidos' }, 400)

    const remainingAfter = totalProfiles - profilesToRemove.length
    if (remainingAfter > newLimit)
      return json({ error: 'Remova mais perfis para compatibilidade com o novo plano' }, 400)

    // Valida membersToRemove: UUIDs de account_members do dono, nunca o próprio dono
    let validatedMemberRemovals: string[] = []
    if (membersToRemove.length > 0) {
      const guestLimit = GUEST_LIMITS[targetPlan] ?? 0

      const { data: validMembers, error: mErr } = await supabaseAdmin
        .from('account_members')
        .select('id')
        .eq('owner_user_id', user.id)
        .eq('is_active', true)
        .neq('member_user_id', user.id)  // proteção: nunca remove o dono
        .in('id', membersToRemove)

      if (mErr || !validMembers) return json({ error: 'Erro ao validar convidados' }, 500)
      if (validMembers.length !== membersToRemove.length)
        return json({ error: 'Um ou mais convidados selecionados são inválidos' }, 400)

      const { count: guestCount } = await supabaseAdmin
        .from('account_members')
        .select('*', { count: 'exact', head: true })
        .eq('owner_user_id', user.id)
        .eq('is_active', true)

      const remainingGuests = (guestCount ?? 0) - membersToRemove.length
      if (remainingGuests > guestLimit)
        return json({ error: 'Remova mais convidados para compatibilidade com o novo plano' }, 400)

      validatedMemberRemovals = membersToRemove
    }

    const periodEndISO = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end).toISOString()
      : new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()

    // Cancela backups pendentes anteriores e cria novos
    await cancelPendingBackups(supabaseAdmin, user.id)
    await createProfileBackups(
      supabaseAdmin, user.id, profilesToRemove,
      periodEndISO, currentPlan, targetPlan,
      stripeSub.stripe_subscription_id,
    )

    // Atualiza lista de remoções no banco
    await supabaseAdmin
      .from('stripe_subscriptions')
      .update({
        pending_profile_removals: profilesToRemove.length > 0 ? profilesToRemove : null,
        pending_member_removals:  validatedMemberRemovals.length > 0 ? validatedMemberRemovals : null,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

    console.log(`[update-stripe-plan] changeRemovalList — user: ${user.id.slice(0, 8)} perfis: ${profilesToRemove.length} convidados: ${validatedMemberRemovals.length}`)
    return json({ success: true, action: 'removal_list_updated', profilesToRemove, membersToRemove: validatedMemberRemovals })
  }

  // ── Validação de plano (para as demais ações) ─────────────────────────────
  if (!VALID_PLANS.has(newPlan)) return json({ error: 'Plano inválido' }, 400)

  const newRank   = PLAN_RANK[newPlan] ?? 0
  const isUpgrade = newRank > currentRank
  const isDowngrade = newRank < currentRank
  const isSamePlan  = currentPlan === newPlan

  if (isSamePlan && !stripeSub.pending_plan_name)
    return json({ error: `Você já está no plano ${newPlan}` }, 409)

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
  if (!stripeKey) return json({ error: 'Configuração indisponível' }, 503)

  const newPriceId = Deno.env.get(PLAN_ENV_MAP[newPlan]) ?? ''
  if (!newPriceId && !isSamePlan) return json({ error: `Price ID não configurado para "${newPlan}"` }, 503)

  // ── 6. Busca subscription items no Stripe ─────────────────────────────────
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

  const items  = (stripeSubData?.items as any)?.data as any[]
  if (!items || items.length === 0) return json({ error: 'Itens da assinatura não encontrados' }, 502)

  const itemId = items[0]?.id as string
  if (!itemId || !STRIPE_ID_REGEX.test(itemId))
    return json({ error: 'Erro interno — item ID inválido' }, 500)

  const subUrl = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSub.stripe_subscription_id)}`

  // ══════════════════════════════════════════════════════════════════════════
  // 7a. Cancelar downgrade agendado
  // ══════════════════════════════════════════════════════════════════════════
  if (isSamePlan && stripeSub.pending_plan_name) {
    const currentPriceId = Deno.env.get(PLAN_ENV_MAP[currentPlan]) ?? ''
    if (!currentPriceId) return json({ error: 'Configuração indisponível' }, 503)

    const cancelParams = new URLSearchParams()
    cancelParams.set(`items[0][id]`,    itemId)
    cancelParams.set(`items[0][price]`, currentPriceId)
    cancelParams.set('proration_behavior', 'none')
    cancelParams.set('metadata[plan_name]', currentPlan)

    let revertRes: Response
    try {
      revertRes = await stripePost(subUrl, stripeKey, cancelParams)
    } catch {
      return json({ error: 'Erro de conexão ao reverter plano' }, 502)
    }

    if (!revertRes.ok) {
      console.error('[update-stripe-plan] Stripe revert error:', await revertRes.text())
      return json({ error: 'Erro ao reverter plano no Stripe' }, 502)
    }

    // Cancela os backups pendentes criados para este downgrade
    await cancelPendingBackups(supabaseAdmin, user.id)

    await supabaseAdmin
      .from('stripe_subscriptions')
      .update({
        pending_plan_name:         null,
        pending_plan_effective_at: null,
        pending_profile_removals:  null,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

    console.log(`[update-stripe-plan] Downgrade agendado cancelado — user: ${user.id.slice(0, 8)} plano: ${currentPlan}`)
    return json({ success: true, newPlan: currentPlan, action: 'cancelled_pending' })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7b. Upgrade: cobrança proporcional imediata
  // ══════════════════════════════════════════════════════════════════════════
  if (isUpgrade) {
    const params = new URLSearchParams()
    params.set(`items[0][id]`,        itemId)
    params.set(`items[0][price]`,     newPriceId)
    params.set('proration_behavior',  'always_invoice')
    params.set('metadata[plan_name]', newPlan)

    let updateRes: Response
    try {
      updateRes = await stripePost(subUrl, stripeKey, params)
    } catch {
      return json({ error: 'Erro de conexão ao atualizar plano' }, 502)
    }

    if (!updateRes.ok) {
      console.error('[update-stripe-plan] Stripe upgrade error:', await updateRes.text())
      return json({ error: 'Erro ao atualizar plano no Stripe. Verifique seu método de pagamento.' }, 502)
    }

    // ── Verifica se o pagamento foi aprovado ──────────────────────────────
    let paymentFailed   = false
    let latestInvoiceId = ''
    let amountDue       = 0   // valor cobrado agora (proporcional)
    try {
      const updatedSub = await updateRes.json() as Record<string, unknown>
      latestInvoiceId  = (updatedSub.latest_invoice as string) ?? ''

      if (latestInvoiceId && STRIPE_ID_REGEX.test(latestInvoiceId)) {
        const invRes = await fetch(
          `https://api.stripe.com/v1/invoices/${encodeURIComponent(latestInvoiceId)}?expand%5B%5D=payment_intent`,
          { headers: { 'Authorization': `Bearer ${stripeKey}` }, signal: AbortSignal.timeout(10_000) }
        )
        if (invRes.ok) {
          const invoice   = await invRes.json() as Record<string, unknown>
          const invStatus = invoice.status as string
          const pi        = invoice.payment_intent as Record<string, unknown> | null | undefined
          const piStatus  = pi?.status as string | undefined
          // Extrai valor cobrado (em centavos) — usado no email de confirmação
          amountDue = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0
          if (invStatus !== 'paid' && (piStatus === 'requires_payment_method' || piStatus === 'canceled')) {
            paymentFailed = true
          }
        }
      }
    } catch { /* segue otimisticamente */ }

    if (paymentFailed) {
      const revertPriceId = Deno.env.get(PLAN_ENV_MAP[currentPlan]) ?? ''
      if (revertPriceId) {
        const rp = new URLSearchParams()
        rp.set(`items[0][id]`,        itemId)
        rp.set(`items[0][price]`,     revertPriceId)
        rp.set('proration_behavior',  'none')
        rp.set('metadata[plan_name]', currentPlan)
        await stripePost(subUrl, stripeKey, rp).catch(() => {})
      }
      if (latestInvoiceId) {
        await fetch(`https://api.stripe.com/v1/invoices/${encodeURIComponent(latestInvoiceId)}/void`, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${stripeKey}`, 'Stripe-Version': '2024-06-20' },
          signal:  AbortSignal.timeout(8_000),
        }).catch(() => {})
      }
      console.error(`[update-stripe-plan] Pagamento recusado — user: ${user.id.slice(0, 8)}`)
      return json({ error: 'Pagamento recusado pelo seu banco. Verifique seu método de pagamento cadastrado e tente novamente.', code: 'payment_failed' }, 402)
    }

    // Pagamento aprovado — atualiza banco
    await supabaseAdmin
      .from('stripe_subscriptions')
      .update({
        plan_name:                 newPlan,
        pending_plan_name:         null,
        pending_plan_effective_at: null,
        pending_profile_removals:  null,
        updated_at:                new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

    // ── Restaura perfis de backups ativos (downgrade anterior revertido) ───
    const _upgradeRestoredCount = await restoreActiveBackups(supabaseAdmin, user.id).catch(e => {
      console.error('[update-stripe-plan] Erro ao restaurar backups:', (e as Error).message)
      return 0
    })

    console.log(`[update-stripe-plan] Upgrade concluído — user: ${user.id.slice(0, 8)} ${currentPlan}→${newPlan}`)

    // Fire-and-forget: envia email de confirmação de upgrade
    const _upgradeEmail = stripeSub.user_email ?? user.email ?? ''
    if (_upgradeEmail) {
      _fireEmail({
        action:           'upgrade',
        email:            _upgradeEmail,
        name:             (user.user_metadata?.name as string) || _upgradeEmail.split('@')[0],
        oldPlan:          currentPlan,
        newPlan,
        amountDue,
        newMonthlyAmount: PLAN_PRICES_CENTS[newPlan] ?? 0,
        profilesRestored: _upgradeRestoredCount,
        currency:         'brl',
      }).catch(() => {})
    }

    return json({ success: true, newPlan, action: 'upgraded' })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7c. Downgrade: agendado para fim do ciclo + cria backups dos perfis
  // ══════════════════════════════════════════════════════════════════════════
  if (isDowngrade) {
    const newLimit     = PLAN_LIMITS[newPlan] ?? 1
    let validatedRemovals: string[] = []

    try {
      // Conta perfis ativos do usuário na tabela profiles (perfis próprios)
      const { count: profileCount, error: countErr } = await supabaseAdmin
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_active', true)

      if (countErr) throw countErr

      const totalProfiles  = profileCount ?? 0
      const excessProfiles = Math.max(0, totalProfiles - newLimit)

      if (excessProfiles > 0) {
        if (profilesToRemove.length < excessProfiles) {
          return json({
            error: `Selecione ${excessProfiles} perfil${excessProfiles > 1 ? 's' : ''} para remover antes de fazer o downgrade.`,
            code:  'profile_removal_required',
            excessCount: excessProfiles,
          }, 400)
        }

        // Anti-fraude: valida que os IDs pertencem a perfis ativos DESTE usuário
        const intIds = profilesToRemove.map(id => parseInt(id, 10))
        const { data: validProfiles, error: profileErr } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .in('id', intIds)

        if (profileErr || !validProfiles) return json({ error: 'Erro ao validar perfis' }, 500)
        if (validProfiles.length !== profilesToRemove.length)
          return json({ error: 'Um ou mais perfis selecionados são inválidos' }, 400)

        const remainingAfter = totalProfiles - profilesToRemove.length
        if (remainingAfter > newLimit)
          return json({ error: 'Remova mais perfis para compatibilidade com o novo plano' }, 400)

        validatedRemovals = profilesToRemove
      }
    } catch (e) {
      console.error('[update-stripe-plan] Erro ao validar perfis:', (e as Error).message)
      return json({ error: 'Erro interno ao verificar perfis' }, 500)
    }

    // Valida convidados a remover (account_members) — nunca permite remover o dono
    let validatedMemberRemovals: string[] = []
    if (membersToRemove.length > 0) {
      try {
        const guestLimit = GUEST_LIMITS[newPlan] ?? 0

        const { count: guestCount } = await supabaseAdmin
          .from('account_members')
          .select('*', { count: 'exact', head: true })
          .eq('owner_user_id', user.id)
          .eq('is_active', true)

        const excessGuests = Math.max(0, (guestCount ?? 0) - guestLimit)

        if (excessGuests > 0) {
          if (membersToRemove.length < excessGuests) {
            return json({
              error: `Selecione ${excessGuests} convidado${excessGuests > 1 ? 's' : ''} para remover antes do downgrade.`,
              code:  'guest_removal_required',
              excessCount: excessGuests,
            }, 400)
          }

          // Proteção: nunca permite remover o próprio dono
          const { data: validMembers, error: mErr } = await supabaseAdmin
            .from('account_members')
            .select('id')
            .eq('owner_user_id', user.id)
            .eq('is_active', true)
            .neq('member_user_id', user.id)
            .in('id', membersToRemove)

          if (mErr || !validMembers) return json({ error: 'Erro ao validar convidados' }, 500)
          if (validMembers.length !== membersToRemove.length)
            return json({ error: 'Um ou mais convidados selecionados são inválidos' }, 400)

          const remainingGuests = (guestCount ?? 0) - membersToRemove.length
          if (remainingGuests > guestLimit)
            return json({ error: 'Remova mais convidados para compatibilidade com o novo plano' }, 400)

          validatedMemberRemovals = membersToRemove
        }
      } catch (e) {
        console.error('[update-stripe-plan] Erro ao validar convidados:', (e as Error).message)
        return json({ error: 'Erro interno ao verificar convidados' }, 500)
      }
    }

    // Atualiza plano no Stripe (adiado para renovação)
    const params = new URLSearchParams()
    params.set(`items[0][id]`,        itemId)
    params.set(`items[0][price]`,     newPriceId)
    params.set('proration_behavior',  'none')
    params.set('metadata[plan_name]', currentPlan) // mantém plano atual nos metadados

    let updateRes: Response
    try {
      updateRes = await stripePost(subUrl, stripeKey, params)
    } catch {
      return json({ error: 'Erro de conexão ao agendar downgrade' }, 502)
    }

    if (!updateRes.ok) {
      console.error('[update-stripe-plan] Stripe downgrade error:', await updateRes.text())
      return json({ error: 'Erro ao agendar alteração de plano no Stripe' }, 502)
    }

    const periodEndISO = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end).toISOString()
      : ((stripeSubData.current_period_end as number)
          ? new Date((stripeSubData.current_period_end as number) * 1000).toISOString()
          : null)

    // Persiste agendamento no banco
    await supabaseAdmin
      .from('stripe_subscriptions')
      .update({
        pending_plan_name:          newPlan,
        pending_plan_effective_at:  periodEndISO,
        pending_profile_removals:   validatedRemovals.length > 0 ? validatedRemovals : null,
        pending_member_removals:    validatedMemberRemovals.length > 0 ? validatedMemberRemovals : null,
        updated_at:                 new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

    // ── Cria backups dos perfis que serão removidos ───────────────────────
    if (validatedRemovals.length > 0 && periodEndISO) {
      await cancelPendingBackups(supabaseAdmin, user.id)
      await createProfileBackups(
        supabaseAdmin, user.id, validatedRemovals,
        periodEndISO, currentPlan, newPlan,
        stripeSub.stripe_subscription_id,
      )
    }

    console.log(`[update-stripe-plan] Downgrade agendado — user: ${user.id.slice(0, 8)} ${currentPlan}→${newPlan} em ${periodEndISO} perfis: ${validatedRemovals.length} convidados: ${validatedMemberRemovals.length}`)

    // Fire-and-forget: envia email de confirmação de downgrade com detalhes dos itens removidos
    const _downgradeEmail = stripeSub.user_email ?? user.email ?? ''
    if (_downgradeEmail && periodEndISO) {
      ;(async () => {
        try {
          // Busca nomes dos perfis agendados para remoção
          let profilesRemovedNames: string[] = []
          if (validatedRemovals.length > 0) {
            const intIds = validatedRemovals.map(id => parseInt(id, 10)).filter(n => !isNaN(n))
            const { data: profileRows } = await supabaseAdmin
              .from('profiles')
              .select('name')
              .eq('user_id', user.id)
              .in('id', intIds)
            profilesRemovedNames = (profileRows ?? []).map(p => (p.name as string) || 'Perfil')
          }

          // Busca emails dos convidados agendados para remoção
          let membersRemovedEmails: string[] = []
          if (validatedMemberRemovals.length > 0) {
            const { data: memberRows } = await supabaseAdmin
              .from('account_members')
              .select('member_email')
              .eq('owner_user_id', user.id)
              .in('id', validatedMemberRemovals)
            membersRemovedEmails = (memberRows ?? []).map(m => (m.member_email as string) || '').filter(Boolean)
          }

          await _fireEmail({
            action:           'downgrade',
            email:            _downgradeEmail,
            name:             (user.user_metadata?.name as string) || _downgradeEmail.split('@')[0],
            oldPlan:          currentPlan,
            newPlan,
            effectiveAt:      periodEndISO,
            newMonthlyAmount: PLAN_PRICES_CENTS[newPlan] ?? 0,
            profilesRemoved:  profilesRemovedNames,
            membersRemoved:   membersRemovedEmails,
            currency:         'brl',
          })
        } catch (e) {
          console.error('[update-stripe-plan] Erro ao preparar email de downgrade:', (e as Error).message)
        }
      })()
    }

    return json({
      success:                  true,
      newPlan,
      action:                   'downgrade_scheduled',
      effectiveAt:              periodEndISO,
      profileRemovalsScheduled: validatedRemovals.length,
      memberRemovalsScheduled:  validatedMemberRemovals.length,
    })
  }

  return json({ error: 'Nenhuma alteração necessária' }, 400)
})
