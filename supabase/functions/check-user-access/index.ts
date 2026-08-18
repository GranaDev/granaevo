import { createClient }         from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { CURRENT_TERMS_VERSION } from '../_shared/terms.ts'

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS).
// SEM fallback na legada: as chaves antigas (anon e service_role) foram
// DESATIVADAS em 2026-07-23 e devolvem 401 "Legacy API keys are disabled".
// Um fallback para uma chave morta não é rede de segurança — é um 401 confuso
// no lugar de um erro de configuração legível. Se a env sumir, falhe alto.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
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
      getSecretKey(),
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

    // ── 5. Decisão de acesso: UMA ida ao banco ───────────────────────────────
    //
    // Este bloco fazia até 6 idas SEQUENCIAIS — check_login_lockout,
    // stripe_subscriptions, account_members, stripe_subscriptions do dono,
    // terms_acceptance e clear_login_lockout — uma esperando a outra. Os logs de
    // produção mediam 2,0–2,9s nesta função em TODAS as amostras, enquanto as
    // outras Edge Functions ficam em 70–120ms. Era o maior custo isolado do login.
    //
    // `acesso_do_usuario` faz o mesmo numa ida. Ela NÃO é a `get_user_access_data`:
    // aquela filtra `current_period_end` dentro do WHERE e concederia onde este
    // caminho nega. A nova replica a semântica DESTE arquivo, literalmente, e a
    // equivalência foi provada contra todos os usuários reais (7/7) antes da troca.
    //
    // O que NÃO desceu para o banco: `auth.getUser` acima — é a fronteira de
    // identidade. O banco recebe um user_id já provado e nunca decide quem chama.
    const clientIp = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'

    const { data: acesso, error: acessoErr } = await supabaseAdmin.rpc('acesso_do_usuario', {
      p_user_id:       userId,
      p_email:         userEmail,
      p_terms_version: CURRENT_TERMS_VERSION,
    })

    // ⚠️ O `error` É CONFERIDO. A versão anterior fazia
    // `const { data: lockData } = await ...rpc('check_login_lockout')` e descartava
    // o erro — e como aquela função levantava 42702 em toda chamada (ambiguidade
    // de `locked_until`, corrigida na migration 20260818020000), o gate de lockout
    // nunca aplicou, em silêncio, por meses. Falha de decisão de acesso nega.
    if (acessoErr) {
      console.error('[check-user-access] acesso_do_usuario falhou:', acessoErr.message)
      return deny(500)
    }

    if (acesso?.estado === 'locked') {
      const levelMap = ['', '15 minutos', '1 hora', '24 horas']
      const level    = acesso.lockout_level ?? 1
      console.warn(`[check-user-access] Conta em lockout nível ${level} para: ${userId.slice(0, 8)}`)
      return json({
        hasAccess:     false,
        locked:        true,
        locked_until:  acesso.locked_until,
        lockout_level: level,
        message:       `Conta bloqueada temporariamente por ${levelMap[level] ?? 'tempo determinado'} devido a múltiplas tentativas.`,
      }, 429, corsHeaders)
    }

    if (acesso?.estado !== 'ok') {
      console.log('[check-user-access] Sem acesso para:', userId.slice(0, 8))
      return deny()
    }

    // Limpeza do lockout é EFEITO, não decisão: dispara sem await para não somar
    // um round-trip ao caminho feliz.
    if (userEmail) {
      supabaseAdmin
        .rpc('clear_login_lockout', { p_identifier: userEmail, p_identifier_type: 'email' })
        .then(() => {}, () => {})
    }

    if (acesso.isGuest === true) {
      console.log('[check-user-access] Acesso concedido (convidado) para:', userId.slice(0, 8))
      return json({
        hasAccess:            true,
        needsTermsAcceptance: acesso.needsTerms,
        isGuest:              true,
        ownerId:              acesso.ownerId,
        planName:             acesso.planName,
        ownerEmail:           acesso.ownerEmail ?? null,
      }, 200, corsHeaders)
    }

    console.log('[check-user-access] Acesso concedido (Stripe) para:', userId.slice(0, 8))
    // Plano do TITULAR (raw) — o frontend normaliza. Sem isto, o dono cairia em
    // 'Individual' e o convite/2º perfil de Casal/Família travaria.
    return json({
      hasAccess:            true,
      needsTermsAcceptance: acesso.needsTerms,
      planName:             acesso.planName,
    }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[check-user-access] Erro inesperado:', error?.message)
    return deny(500)
  }
})
