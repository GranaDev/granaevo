import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// ---------------------------------------------------------------------------
// timing-safe compare (prevents timing oracle on proxy secret)
// ---------------------------------------------------------------------------
function timingSafeEqual(a: string, b: string): boolean {
  const enc    = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
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

    // ── 6. Verificar subscription ativa ─────────────────────────────────────
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, is_active, payment_status, expires_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('payment_status', 'approved')
      .maybeSingle()

    if (subError) {
      console.error('[check-user-access] Erro ao consultar subscriptions:', subError.message)
      return deny()
    }

    if (!subscription) {
      console.log('[check-user-access] Sem subscription ativa para:', userId.slice(0, 8))
      // Registra como falha de acesso para lockout progressivo
      if (userEmail) {
        await supabaseAdmin.rpc('record_failed_login', {
          p_identifier:      userEmail,
          p_identifier_type: 'email',
        }).catch(() => {})
      }
      return deny()
    }

    // ── 7. Verificar expiração ────────────────────────────────────────────────
    if (subscription.expires_at) {
      const expired = new Date(subscription.expires_at) < new Date()
      if (expired) {
        console.log('[check-user-access] Subscription expirada para:', userId.slice(0, 8))
        return deny()
      }
    }

    // Login bem-sucedido — limpa lockout acumulado
    if (userEmail) {
      await supabaseAdmin.rpc('clear_login_lockout', {
        p_identifier:      userEmail,
        p_identifier_type: 'email',
      }).catch(() => {})
    }

    console.log('[check-user-access] Acesso concedido para:', userId.slice(0, 8))
    return json({ hasAccess: true }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[check-user-access] Erro inesperado:', error?.message)
    return deny(500)
  }
})
