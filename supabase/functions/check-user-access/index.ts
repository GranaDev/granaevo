import { createClient }         from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { CURRENT_TERMS_VERSION } from '../_shared/terms.ts'

// ---------------------------------------------------------------------------
// checkNeedsTermsAcceptance — verifica se o usuário aceitou a versão corrente
// dos Termos de Uso. Fail-open: erro de banco não bloqueia acesso.
// ---------------------------------------------------------------------------
async function checkNeedsTermsAcceptance(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  try {
    const { data } = await admin
      .from('terms_acceptance')
      .select('id')
      .eq('user_id', userId)
      .eq('terms_version', CURRENT_TERMS_VERSION)
      .maybeSingle()
    return !data // true = ainda precisa aceitar
  } catch {
    return false // fail-open: não bloqueia acesso em caso de erro de DB
  }
}

// ---------------------------------------------------------------------------
// timing-safe compare (prevents timing oracle on proxy secret)
// [GOD-TSE] Sem early-return em length — codifica divergência via XOR
// ---------------------------------------------------------------------------
function timingSafeEqual(a: string, b: string): boolean {
  const enc  = new TextEncoder()
  const aB   = enc.encode(a)
  const bB   = enc.encode(b)
  const len  = Math.max(aB.length, bB.length)
  let diff   = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

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

function json(body: unknown, status = 200, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const deny = (status = 200) => json({ hasAccess: false }, status, corsHeaders)

  try {
    // ── 1. Verificar proxy secret ────────────────────────────────────────────
    // [SEC-FIX] Impede chamadas diretas à Edge Function que bypassam o proxy Vercel.
    // Sem esta proteção, qualquer pessoa pode chamar o endpoint com JWT forjado
    // para enumerar quais user_ids têm subscriptions ativas.
    const proxySecret = Deno.env.get('PROXY_SECRET')
    if (!proxySecret) {
      console.error('[check-user-access] PROXY_SECRET não configurada — requisição bloqueada')
      return json({ hasAccess: false }, 500, corsHeaders)
    }
    const receivedSecret = req.headers.get('x-proxy-secret') ?? ''
    if (!timingSafeEqual(receivedSecret, proxySecret)) {
      console.warn('[check-user-access] Proxy secret inválido — acesso direto bloqueado')
      return deny(401)
    }

    // ── 2. Extrair JWT do header Authorization ───────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[check-user-access] Authorization header ausente')
      return deny(401)
    }

    const token = authHeader.slice(7).trim()
    if (!token || token.length < 20) return deny(401)

    // ── 3. Cliente admin para verificação de JWT e consulta de subscriptions ──
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
    )

    // ── 4. Verificar JWT com validação real de assinatura (ES256/HS256) ───────
    // [SEC-FIX] CRÍTICO: substitui decode manual (sem verificação de assinatura)
    // por supabaseAdmin.auth.getUser(token) que valida contra o servidor Auth.
    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)

    if (userErr || !user?.id) {
      console.warn('[check-user-access] JWT inválido ou expirado:', userErr?.message ?? 'user null')
      return deny(401)
    }

    const userId    = user.id
    const userEmail = (user.email ?? '').toLowerCase().trim()
    console.log('[check-user-access] Verificando acesso para user_id:', userId.slice(0, 8))

    // ── 5. Verificar lockout progressivo ─────────────────────────────────────
    // Verifica se o email está em lockout por tentativas falhas anteriores.
    // O IP é extraído do header x-forwarded-for (injetado pelo proxy Vercel).
    const clientIp = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'

    if (userEmail) {
      const { data: lockData } = await supabaseAdmin.rpc('check_login_lockout', {
        p_identifier:      userEmail,
        p_identifier_type: 'email',
      })
      const lockEntry = lockData?.[0]
      if (lockEntry?.is_locked) {
        const until    = lockEntry.locked_until ? new Date(lockEntry.locked_until).toISOString() : 'unknown'
        const levelMap = ['', '15 minutos', '1 hora', '24 horas']
        const level    = lockEntry.lockout_level ?? 1
        console.warn(`[check-user-access] Conta em lockout nível ${level} para: ${userId.slice(0, 8)} até ${until}`)
        return json({
          hasAccess:    false,
          locked:       true,
          locked_until: lockEntry.locked_until,
          lockout_level: level,
          message:      `Conta bloqueada temporariamente por ${levelMap[level] ?? 'tempo determinado'} devido a múltiplas tentativas.`,
        }, 429, corsHeaders)
      }
    }

    // ── 6. Verificar subscription ativa (stripe_subscriptions) ──────────────
    // Cakto users foram migrados para stripe_subscriptions com status='active'
    // e current_period_end='2099-12-31'. Não há mais tabela `subscriptions`.
    const { data: stripeSub, error: stripeErr } = await supabaseAdmin
      .from('stripe_subscriptions')
      .select('id, status, current_period_end, plan_name')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (stripeErr) {
      console.error('[check-user-access] Erro ao consultar stripe_subscriptions:', stripeErr.message)
      return deny()
    }

    if (!stripeSub) {
      // ── 9. Auto-vinculação por email (compra anônima → criou conta depois) ──
      // Usuário pagou sem estar logado → subscription tem user_id=null + user_email.
      // Na primeira autenticação, vinculamos automaticamente pelo email.
      if (userEmail) {
        const { data: emailSub, error: emailErr } = await supabaseAdmin
          .from('stripe_subscriptions')
          .select('id, status, current_period_end, plan_name')
          .eq('user_email', userEmail)
          .is('user_id', null)
          .in('status', ['active', 'trialing'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!emailErr && emailSub) {
          if (!emailSub.current_period_end || new Date(emailSub.current_period_end) >= new Date()) {
            // Vincula user_id à subscription
            await supabaseAdmin
              .from('stripe_subscriptions')
              .update({ user_id: userId, updated_at: new Date().toISOString() })
              .eq('id', emailSub.id)
            console.log('[check-user-access] Auto-vinculação Stripe por email para:', userId.slice(0, 8))
            // Concede acesso
            if (userEmail) {
              try { await supabaseAdmin.rpc('clear_login_lockout', { p_identifier: userEmail, p_identifier_type: 'email' }) }
              catch { /* silencioso */ }
            }
            const needsTerms1 = await checkNeedsTermsAcceptance(supabaseAdmin, userId)
            return json({
              hasAccess:            true,
              needsTermsAcceptance: needsTerms1,
              planName:             emailSub.plan_name ?? 'individual',
            }, 200, corsHeaders)
          }
        }
      }

      // ── 10. Verificar se é usuário convidado (account_members) ──────────────
      // Convidados não têm subscription própria — o acesso deles depende de
      // estarem ativos em account_members E o dono ter subscription vigente.
      const { data: memberEntry } = await supabaseAdmin
        .from('account_members')
        .select('id, owner_user_id, owner_email')
        .eq('member_user_id', userId)
        .eq('is_active', true)
        .maybeSingle()

      if (memberEntry?.owner_user_id) {
        const ownerUserId = memberEntry.owner_user_id

        // Verifica subscription do dono (todos os planos agora em stripe_subscriptions)
        const { data: ownerStripe } = await supabaseAdmin
          .from('stripe_subscriptions')
          .select('id, status, current_period_end, plan_name')
          .eq('user_id', ownerUserId)
          .in('status', ['active', 'trialing'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        const ownerStripeOk = ownerStripe
          ? (!ownerStripe.current_period_end || new Date(ownerStripe.current_period_end) >= new Date())
          : false

        if (ownerStripeOk) {
          console.log('[check-user-access] Acesso concedido (convidado) para:', userId.slice(0, 8))
          const needsTerms2 = await checkNeedsTermsAcceptance(supabaseAdmin, userId)
          return json({
            hasAccess:            true,
            needsTermsAcceptance: needsTerms2,
            isGuest:              true,
            ownerId:              ownerUserId,
            planName:             ownerStripe?.plan_name ?? 'individual',
            ownerEmail:           memberEntry.owner_email ?? null,
          }, 200, corsHeaders)
        }

        console.log('[check-user-access] Convidado bloqueado — dono sem subscription ativa:', userId.slice(0, 8))
        return deny()
      }

      console.log('[check-user-access] Sem subscription ativa para:', userId.slice(0, 8))
      return deny()
    }

    // Proteção extra: valida current_period_end mesmo com status 'active'
    // (o webhook pode ter atrasado a atualização do status)
    if (stripeSub.current_period_end && new Date(stripeSub.current_period_end) < new Date()) {
      console.log('[check-user-access] Período Stripe expirado para:', userId.slice(0, 8))
      return deny()
    }

    // Acesso concedido via Stripe
    if (userEmail) {
      try {
        await supabaseAdmin.rpc('clear_login_lockout', {
          p_identifier:      userEmail,
          p_identifier_type: 'email',
        })
      } catch { /* falha silenciosa */ }
    }

    console.log('[check-user-access] Acesso concedido (Stripe) para:', userId.slice(0, 8))
    const needsTerms3 = await checkNeedsTermsAcceptance(supabaseAdmin, userId)
    // Retorna o plano do TITULAR (raw) — o frontend normaliza. Sem isto, o dono
    // cairia em 'Individual' e o convite/2º perfil de planos Casal/Família travaria.
    return json({
      hasAccess:            true,
      needsTermsAcceptance: needsTerms3,
      planName:             stripeSub.plan_name ?? 'individual',
    }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[check-user-access] Erro inesperado:', error?.message)
    return deny(500)
  }
})
