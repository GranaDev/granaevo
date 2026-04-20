/**
 * GranaEvo — get-cakto-order/index.ts (v2)
 *
 * Edge Function para buscar dados de um pedido na API da Cakto.
 *
 * SEGURANÇA:
 *   - [SEC-AUTH]   Exige JWT válido no header Authorization (usuário autenticado)
 *   - [SEC-AUTHZ]  Verifica que o usuário tem subscription ativa e aprovada
 *   - [SEC-INPUT]  Sanitiza orderId — apenas alfanumérico, hífen e underscore
 *   - [SEC-CREDS]  Credenciais Cakto ficam apenas no servidor (env vars)
 *   - [SEC-METHOD] Aceita apenas POST
 *   - [SEC-ERR]    Erros internos não vazam detalhes ao cliente
 *
 * v2 — CORREÇÕES:
 *   - Adicionada autenticação JWT obrigatória
 *   - Adicionada verificação de autorização (subscription ativa)
 *   - Adicionada sanitização do orderId
 *   - Adicionada validação de presença das env vars
 *   - Adicionado tratamento de erros mais robusto
 *   - Adicionada restrição ao método HTTP
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

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
    'Vary': 'Origin',
  }
}

/** Regex segura para orderId — apenas chars que a Cakto usa em IDs */
const ORDER_ID_REGEX = /^[a-zA-Z0-9_-]{1,100}$/

// ──────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ──────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // [SEC-METHOD] Apenas POST aceito
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Método não permitido' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 405 }
    )
  }

  try {
    // ── [SEC-AUTH] Verificar JWT no header Authorization ─────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Autenticação necessária' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')    ?? ''
    const supabaseAnon   = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseAdmin_ = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    if (!supabaseUrl || !supabaseAnon || !supabaseAdmin_) {
      console.error('[get-cakto-order] Variáveis de ambiente do Supabase não configuradas')
      return new Response(
        JSON.stringify({ success: false, error: 'Configuração do servidor incompleta' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    // Valida o JWT com o Supabase (usando anon key + JWT do usuário)
    const supabaseClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()

    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, error: 'Token inválido ou expirado' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // ── [SEC-AUTHZ] Verificar que o usuário tem subscription ativa ───────────
    // Impede que usuários autenticados sem plano ativo acessem dados da Cakto.
    const supabaseAdmin = createClient(supabaseUrl, supabaseAdmin_, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .eq('payment_status', 'approved')
      .single()

    if (subError || !subscription) {
      console.warn('[get-cakto-order] Usuário sem subscription ativa tentou acessar. userId:', user.id)
      return new Response(
        JSON.stringify({ success: false, error: 'Acesso não autorizado' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // ── Leitura e validação do body ─────────────────────────────────────────
    let body: { orderId?: unknown }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Body inválido' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const { orderId } = body

    if (!orderId) {
      return new Response(
        JSON.stringify({ success: false, error: 'orderId é obrigatório' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // [SEC-INPUT] Sanitiza orderId — rejeita qualquer caracter fora do padrão
    // Impede path traversal, injeção de headers e SSRF via URL interpolada
    const orderIdStr = String(orderId)
    if (!ORDER_ID_REGEX.test(orderIdStr)) {
      return new Response(
        JSON.stringify({ success: false, error: 'orderId inválido' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // ── Obter token Cakto e buscar pedido ────────────────────────────────────
    const accessToken = await getCaktoAccessToken()

    const orderResponse = await fetch(
      // encodeURIComponent como camada extra de segurança (o regex já garante,
      // mas é uma boa prática defensiva)
      `https://api.cakto.com.br/api/orders/${encodeURIComponent(orderIdStr)}/`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!orderResponse.ok) {
      console.error('[get-cakto-order] Erro ao buscar pedido na Cakto:', orderResponse.status, orderResponse.statusText)

      // Não repassa o statusText da Cakto — pode conter info sensível
      return new Response(
        JSON.stringify({ success: false, error: 'Pedido não encontrado ou erro na Cakto' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 502 }
      )
    }

    const orderData = await orderResponse.json()

    return new Response(
      JSON.stringify({ success: true, order: orderData }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('[get-cakto-order] Erro interno:', error?.message ?? error)
    return new Response(
      JSON.stringify({ success: false, error: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// HELPER: Obter access token da Cakto via client_credentials
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Obtém um access token OAuth2 da Cakto usando client_credentials.
 * As credenciais ficam apenas nas env vars do servidor — nunca expostas.
 *
 * @throws {Error} se as env vars não estiverem configuradas ou se o OAuth falhar
 * @returns {Promise<string>} access_token válido
 */
async function getCaktoAccessToken(): Promise<string> {
  const clientId     = Deno.env.get('CAKTO_CLIENT_ID')
  const clientSecret = Deno.env.get('CAKTO_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('Credenciais Cakto (CAKTO_CLIENT_ID / CAKTO_CLIENT_SECRET) não configuradas nas env vars')
  }

  const response = await fetch('https://api.cakto.com.br/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  })

  if (!response.ok) {
    throw new Error(`Falha ao obter token da Cakto: HTTP ${response.status}`)
  }

  const data = await response.json()

  if (!data?.access_token || typeof data.access_token !== 'string') {
    throw new Error('Token Cakto não retornado ou em formato inválido')
  }

  return data.access_token
}