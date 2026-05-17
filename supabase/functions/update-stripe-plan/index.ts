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

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

const STRIPE_ID_REGEX = /^[a-zA-Z0-9_]{4,100}$/
const UUID_RE         = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_PLANS     = new Set(['individual', 'casal', 'familia'])
const PLAN_RANK:   Record<string, number> = { individual: 1, casal: 2, familia: 3 }
const PLAN_LIMITS: Record<string, number> = { individual: 1, casal: 2, familia: 5 }

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

  // Busca dados completos dos membros para o snapshot
  const { data: members, error } = await db
    .from('account_members')
    .select('*')
    .in('id', profileIds)
    .eq('owner_user_id', ownerUserId)
    .eq('is_active', true)

  if (error || !members?.length) {
    console.error('[update-stripe-plan] Erro ao buscar membros para backup:', error?.message)
    return
  }

  const backups = members.map((m: Record<string, unknown>) => ({
    owner_user_id:          ownerUserId,
    original_member_id:     m.id as string,
    member_name:            (m.member_name as string) || null,
    member_email:           (m.member_email as string) || null,
    member_data:            m,  // snapshot completo
    scheduled_removal_at:   scheduledAt,
    status:                 'pending',
    original_plan:          currentPlan,
    target_plan:            targetPlan,
    stripe_subscription_id: subscriptionId,
  }))

  // upsert: se já existe pending/active para este membro, sobrescreve (changeRemovalList)
  const { error: backupErr } = await db
    .from('profile_backups')
    .upsert(backups, { onConflict: 'owner_user_id,original_member_id' })

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
  // Busca backups ativos deste usuário
  const { data: activeBackups, error: fetchErr } = await db
    .from('profile_backups')
    .select('id, original_member_id')
    .eq('owner_user_id', ownerUserId)
    .eq('status', 'active')

  if (fetchErr || !activeBackups?.length) return 0

  const memberIds = activeBackups.map((b: Record<string, unknown>) => b.original_member_id as string)

  // Reativa os membros em account_members
  const { error: reactivateErr } = await db
    .from('account_members')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .in('id', memberIds)
    .eq('owner_user_id', ownerUserId)

  if (reactivateErr) {
    console.error('[update-stripe-plan] Erro ao reativar membros:', reactivateErr.message)
    return 0
  }

  // Marca backups como restaurados
  const backupIds = activeBackups.map((b: Record<string, unknown>) => b.id as string)
  const { error: restoreErr } = await db
    .from('profile_backups')
    .update({ status: 'restored', updated_at: new Date().toISOString() })
    .in('id', backupIds)

  if (restoreErr) {
    console.error('[update-stripe-plan] Erro ao marcar backups como restored:', restoreErr.message)
  }

  console.log(`[update-stripe-plan] ${memberIds.length} perfil(s) restaurado(s) — user: ${ownerUserId.slice(0, 8)}`)
  return memberIds.length
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

  // ── 3. Valida body ────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  // action pode ser 'changeRemovalList' (enviado pelo proxy para esta função)
  const incomingAction   = typeof body.action === 'string' ? body.action : ''
  const newPlan          = ((body.newPlan as string) ?? '').toLowerCase().trim()
  const profilesToRemove = Array.isArray(body.profilesToRemove)
    ? (body.profilesToRemove as string[]).filter(s => typeof s === 'string' && UUID_RE.test(s))
    : []

  if (profilesToRemove.length > 10)
    return json({ error: 'Número de perfis inválido' }, 400)

  // ── 4. Busca assinatura do usuário ────────────────────────────────────────
  const { data: stripeSub, error: subErr } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, plan_name, status, current_period_end, pending_plan_name, pending_profile_removals')
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

    // Conta perfis ativos do usuário
    const { count: memberCount, error: cntErr } = await supabaseAdmin
      .from('account_members')
      .select('*', { count: 'exact', head: true })
      .eq('owner_user_id', user.id)
      .eq('is_active', true)

    if (cntErr) return json({ error: 'Erro ao verificar perfis' }, 500)

    const totalProfiles  = (memberCount ?? 0) + 1
    const excessProfiles = Math.max(0, totalProfiles - newLimit)

    if (profilesToRemove.length < excessProfiles) {
      return json({
        error: `Selecione ${excessProfiles} perfil${excessProfiles > 1 ? 's' : ''} para remover.`,
        code:  'profile_removal_required',
        excessCount: excessProfiles,
      }, 400)
    }

    // Valida propriedade de cada perfil (anti-fraude: não pode remover perfis de outros)
    const { data: validMembers, error: memberErr } = await supabaseAdmin
      .from('account_members')
      .select('id')
      .eq('owner_user_id', user.id)
      .eq('is_active', true)
      .in('id', profilesToRemove)

    if (memberErr || !validMembers) return json({ error: 'Erro ao validar perfis' }, 500)
    if (validMembers.length !== profilesToRemove.length)
      return json({ error: 'Um ou mais perfis selecionados são inválidos' }, 400)

    const remainingAfter = totalProfiles - profilesToRemove.length
    if (remainingAfter > newLimit)
      return json({ error: 'Remova mais perfis para compatibilidade com o novo plano' }, 400)

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
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

    console.log(`[update-stripe-plan] changeRemovalList — user: ${user.id.slice(0, 8)} ${profilesToRemove.length} perfis`)
    return json({ success: true, action: 'removal_list_updated', profilesToRemove })
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
    let paymentFailed = false
    let latestInvoiceId = ''
    try {
      const updatedSub = await updateRes.json() as Record<string, unknown>
      latestInvoiceId  = (updatedSub.latest_invoice as string) ?? ''

      if (latestInvoiceId && STRIPE_ID_REGEX.test(latestInvoiceId)) {
        const invRes = await fetch(
          `https://api.stripe.com/v1/invoices/${encodeURIComponent(latestInvoiceId)}?expand%5B%5D=payment_intent`,
          { headers: { 'Authorization': `Bearer ${stripeKey}` }, signal: AbortSignal.timeout(10_000) }
        )
        if (invRes.ok) {
          const invoice  = await invRes.json() as Record<string, unknown>
          const invStatus = invoice.status as string
          const pi        = invoice.payment_intent as Record<string, unknown> | null | undefined
          const piStatus  = pi?.status as string | undefined
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
    // Fire-and-forget: não bloqueia a resposta. Falha silenciosa é aceitável
    // pois o webhook pode tentar de novo, e os dados do membro não são perdidos.
    restoreActiveBackups(supabaseAdmin, user.id).catch(e =>
      console.error('[update-stripe-plan] Erro ao restaurar backups:', (e as Error).message)
    )

    console.log(`[update-stripe-plan] Upgrade concluído — user: ${user.id.slice(0, 8)} ${currentPlan}→${newPlan}`)
    return json({ success: true, newPlan, action: 'upgraded' })
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7c. Downgrade: agendado para fim do ciclo + cria backups dos perfis
  // ══════════════════════════════════════════════════════════════════════════
  if (isDowngrade) {
    const newLimit     = PLAN_LIMITS[newPlan] ?? 1
    let validatedRemovals: string[] = []

    try {
      const { count: memberCount } = await supabaseAdmin
        .from('account_members')
        .select('*', { count: 'exact', head: true })
        .eq('owner_user_id', user.id)
        .eq('is_active', true)

      const totalProfiles  = (memberCount ?? 0) + 1
      const excessProfiles = Math.max(0, totalProfiles - newLimit)

      if (excessProfiles > 0) {
        if (profilesToRemove.length < excessProfiles) {
          return json({
            error: `Selecione ${excessProfiles} perfil${excessProfiles > 1 ? 's' : ''} para remover antes de fazer o downgrade.`,
            code:  'profile_removal_required',
            excessCount: excessProfiles,
          }, 400)
        }

        // Anti-fraude: valida que os IDs pertencem a membros ativos DESTA conta
        const { data: validMembers, error: memberErr } = await supabaseAdmin
          .from('account_members')
          .select('id')
          .eq('owner_user_id', user.id)
          .eq('is_active', true)
          .in('id', profilesToRemove)

        if (memberErr || !validMembers) return json({ error: 'Erro ao validar perfis' }, 500)
        if (validMembers.length !== profilesToRemove.length)
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
        updated_at:                 new Date().toISOString(),
      })
      .eq('stripe_subscription_id', stripeSub.stripe_subscription_id)

    // ── Cria backups dos perfis que serão removidos ───────────────────────
    // Cancela backups pendentes anteriores (caso esteja alterando downgrade já agendado)
    if (validatedRemovals.length > 0 && periodEndISO) {
      await cancelPendingBackups(supabaseAdmin, user.id)
      await createProfileBackups(
        supabaseAdmin, user.id, validatedRemovals,
        periodEndISO, currentPlan, newPlan,
        stripeSub.stripe_subscription_id,
      )
    }

    console.log(`[update-stripe-plan] Downgrade agendado — user: ${user.id.slice(0, 8)} ${currentPlan}→${newPlan} em ${periodEndISO} perfis: ${validatedRemovals.length}`)
    return json({
      success:                  true,
      newPlan,
      action:                   'downgrade_scheduled',
      effectiveAt:              periodEndISO,
      profileRemovalsScheduled: validatedRemovals.length,
    })
  }

  return json({ error: 'Nenhuma alteração necessária' }, 400)
})
