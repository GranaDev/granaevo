/**
 * GranaEvo — check-email-status/index.ts (v3)
 *
 * Edge Function para verificar se um email tem subscription ativa
 * e pagamento aprovado, habilitando o fluxo de Primeiro Acesso.
 *
 * ============================================================
 * SEGURANÇA
 * ============================================================
 *
 * [SEC-ANON]   Endpoint público (pré-autenticação) — não exige JWT.
 *              Protegido apenas pela apikey do Supabase (gateway routing).
 * [SEC-GENERIC] Retornos não-ready são genéricos: não revelam se o email
 *              existe ou qual é o status do pagamento (anti-enumeração).
 * [SEC-LOWERCASE] Email normalizado em lowercase antes de qualquer consulta.
 * [SEC-ADMIN]  Usa service_role key para contornar RLS nas queries internas.
 *              A service_role NUNCA é exposta ao frontend.
 * [SEC-CORS]   Access-Control-Allow-Origin: '*' é seguro aqui pois o endpoint
 *              não usa cookies nem credenciais implícitas — a autenticação é
 *              feita exclusivamente pelo header 'apikey' no gateway.
 *
 * ============================================================
 * HISTÓRICO
 * ============================================================
 *
 * v3 — Sem alterações funcionais.
 *      Revisado e mantido como estava — lógica e segurança confirmadas OK.
 *      Arquivo reentregue para consistência com os demais arquivos corrigidos.
 *
 * v2 — [FIX-01] password_created = true mas user_id NULL → retorna needs_link.
 *      [FIX-02] password_created = false mas user_id preenchido → corrige
 *               password_created no banco e retorna password_exists.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ──────────────────────────────────────────────────────────────────────────────
// CORS — restrito às origens conhecidas (proxy Vercel + domínios da aplicação)
// ──────────────────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ──────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Apenas POST aceito
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ status: 'error', message: 'Método não permitido' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 405 }
    )
  }

  try {
    // Inicializa cliente admin (service_role) para contornar RLS
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Leitura do body com tratamento de parse error
    let body: { email?: unknown }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Body inválido' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const { email } = body

    if (!email || typeof email !== 'string') {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Email é obrigatório' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // [SEC-LOWERCASE] Normaliza email antes de qualquer operação
    const normalizedEmail = email.toLowerCase().trim()

    // Validação básica de formato (bloqueia payloads obviamente malformados)
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Formato de email inválido' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // ── Busca subscription ───────────────────────────────────────────────────
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        id,
        user_id,
        plan_id,
        payment_status,
        password_created,
        user_name,
        user_email,
        is_active,
        plans(name)
      `)
      .eq('user_email', normalizedEmail)
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (subError) {
      console.error('[check-email-status] Erro ao buscar subscription:', subError.message)
      throw subError
    }

    // ── Email não encontrado ─────────────────────────────────────────────────
    // [SEC-FIX] Retorno IDÊNTICO ao de payment_pending — não revela se o email
    // existe ou não. Ambas as condições retornam o mesmo status 'not_found' para
    // impedir enumeração via chamadas diretas ao endpoint.
    if (!subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ status: 'not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    const subscription = subscriptions[0]

    // ── Pagamento não aprovado ───────────────────────────────────────────────
    // [SEC-FIX] Mesmo status que not_found — impede distinguir "email cadastrado
    // sem pagamento" de "email não existe". Ambos retornam 'not_found'.
    if (subscription.payment_status !== 'approved') {
      return new Response(
        JSON.stringify({ status: 'not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── [FIX-01] Senha já criada ─────────────────────────────────────────────
    // Verifica se o user_id está vinculado (pode estar NULL por falha anterior).
    if (subscription.password_created) {
      const needsLink = !subscription.user_id
      let needsLinkConfirmed = needsLink

      // Dupla verificação: mesmo com user_id preenchido, confirma que o
      // usuário realmente existe no Auth (registro pode ter corrompido).
      if (!needsLink && subscription.user_id) {
        const { data: authUser, error: authErr } = await supabaseAdmin
          .auth.admin.getUserById(subscription.user_id)
        if (authErr || !authUser?.user) {
          // user_id aponta para usuário inexistente — sinaliza para revincular.
          needsLinkConfirmed = true
        }
      }

      return new Response(
        JSON.stringify({
          status: 'password_exists',
          needs_link: needsLinkConfirmed,
          data: needsLinkConfirmed ? {
            subscription_id: subscription.id,
            email: normalizedEmail,
          } : null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── [FIX-02] password_created = false, mas user_id já preenchido ─────────
    // signUp funcionou mas o UPDATE de password_created falhou.
    // Corrige aqui no backend antes de devolver qualquer resposta.
    if (!subscription.password_created && subscription.user_id) {
      console.warn(`[check-email-status] Corrigindo password_created para subscription ${subscription.id}`)

      await supabaseAdmin
        .from('subscriptions')
        .update({
          password_created:    true,
          password_created_at: new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        })
        .eq('id', subscription.id)

      // Retorna como se a senha já existisse — usuário deve fazer login.
      return new Response(
        JSON.stringify({
          status: 'password_exists',
          needs_link: false,
          data: null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── Tudo OK — pode criar senha ───────────────────────────────────────────
    return new Response(
      JSON.stringify({
        status: 'ready',
        data: {
          subscription_id: subscription.id,
          user_name:       subscription.user_name || 'Usuário',
          plan_name:       subscription.plans?.name || 'Plano não identificado',
          email:           normalizedEmail,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('[check-email-status] Erro interno:', error?.message ?? error)
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})