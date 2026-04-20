import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ═══════════════════════════════════════════════════════════════
//  CORS
//  [SEC-FIX-CORS] Restrito ao domínio real (era '*').
//
//  [CORS-FIX-1] OPTIONS agora retorna status 200 EXPLÍCITO.
//    O gateway do Supabase pode rejeitar preflight com 401 quando
//    "JWT verification" está ativado nas configurações da função.
//    Solução definitiva: desativar JWT verification no Dashboard
//    (a função faz sua própria verificação via getUser()).
//    Como camada extra de defesa, o status 200 é sempre explícito.
//
//  [CORS-FIX-2] Cabeçalhos CORS incluídos em TODAS as respostas,
//    incluindo erros (401, 500). Sem isso o browser não consegue
//    ler a resposta de erro e lança "CORS error" em vez do erro real.
// ═══════════════════════════════════════════════════════════════
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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  // ── Preflight CORS ────────────────────────────────────────────
  // [CORS-FIX-1] Status 200 explícito. Tratado ANTES de qualquer
  // lógica de negócio — nunca pode falhar ou lançar exceção.
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: corsHeaders,
    })
  }

  // Fail closed por padrão — qualquer erro nega acesso.
  // [CORS-FIX-2] corsHeaders em todas as respostas.
  const deny = (status = 200) =>
    new Response(
      JSON.stringify({ hasAccess: false }),
      {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  try {
    // ── 1. Extrair JWT do header ──────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[check-user-access] Authorization header ausente ou inválido')
      return deny(401)
    }

    const token = authHeader.slice(7).trim()
    if (!token) return deny(401)

    // ── 2. Validar JWT e obter usuário real ───────────────────
    // Usa getUser() — valida a assinatura do JWT junto ao Supabase Auth.
    // Não confia apenas no payload decodificado localmente.
    // [SEC] Usa SERVICE_ROLE_KEY apenas para verificar o token e
    // consultar subscriptions. O token do usuário nunca é escalado
    // para permissões de service role nas operações de dados.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)

    if (authError || !user?.id) {
      console.warn('[check-user-access] Token inválido:', authError?.message)
      return deny(401)
    }

    console.log('[check-user-access] Verificando acesso para user_id:', user.id)

    // ── 3. Verificar subscription ativa por user_id ───────────
    // user_id vem do JWT validado — nunca do body da requisição.
    // [SEC] Sem enumeração: a query filtra exclusivamente pelo
    // user_id extraído do JWT. Impossível consultar outro usuário.
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, is_active, payment_status, expires_at')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .eq('payment_status', 'approved')
      .maybeSingle()

    if (subError) {
      console.error('[check-user-access] Erro ao consultar subscriptions:', subError.message)
      return deny()
    }

    if (!subscription) {
      console.log('[check-user-access] Sem subscription ativa para:', user.id)
      return deny()
    }

    // ── 4. Verificar expiração ────────────────────────────────
    if (subscription.expires_at) {
      const expired = new Date(subscription.expires_at) < new Date()
      if (expired) {
        console.log('[check-user-access] Subscription expirada para:', user.id)
        return deny()
      }
    }

    console.log('[check-user-access] Acesso concedido para:', user.id)

    return new Response(
      JSON.stringify({ hasAccess: true }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error) {
    console.error('[check-user-access] Erro inesperado:', error.message)
    // [CORS-FIX-2] CORS em resposta de erro também
    return deny(500)
  }
})