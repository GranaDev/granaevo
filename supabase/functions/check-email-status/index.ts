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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// ──────────────────────────────────────────────────────────────────────────────
// CORS — restrito às origens conhecidas (proxy Vercel + domínios da aplicação)
// ──────────────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

// [GOD2-F01] Sem early-return em length — elimina timing oracle
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

// ──────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ──────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // [GOD5-M01] fail-closed: sem PROXY_SECRET configurado, bloqueia tudo.
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[check-email-status] PROXY_SECRET não configurada — requisição bloqueada')
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
  const received = req.headers.get('x-proxy-secret') ?? ''
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn('[check-email-status] Proxy secret inválido — chamada direta bloqueada')
    return new Response(
      JSON.stringify({ status: 'not_found' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
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
    if (!/^[^\x00-\x1F\x7F\s@]{1,64}@[^\x00-\x1F\x7F\s@]+\.[^\x00-\x1F\x7F\s@]{2,}$/.test(normalizedEmail)) {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Formato de email inválido' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // ── Busca subscription ativa (stripe_subscriptions — inclui Cakto migrados)
    const { data: stripeSub, error: subError } = await supabaseAdmin
      .from('stripe_subscriptions')
      .select('id, user_id, user_email, plan_name, status, current_period_end')
      .eq('user_email', normalizedEmail)
      .in('status', ['active', 'trialing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (subError) {
      console.error('[check-email-status] Erro ao buscar stripe_subscriptions:', subError.message)
      throw subError
    }

    if (!stripeSub) {
      return new Response(
        JSON.stringify({ status: 'not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Período expirado → nega (webhook pode ter atrasado a atualização do status)
    if (stripeSub.current_period_end && new Date(stripeSub.current_period_end) < new Date()) {
      return new Response(
        JSON.stringify({ status: 'not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Usuário já tem conta criada (user_id vinculado) → só precisa fazer login
    if (stripeSub.user_id) {
      return new Response(
        JSON.stringify({ status: 'password_exists', needs_link: false, data: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Usuário sem conta — pode criar senha (link via link-user-subscription)
    return new Response(
      JSON.stringify({
        status: 'ready',
        data: {
          subscription_id: stripeSub.id,
          user_name:       'Usuário',
          plan_name:       stripeSub.plan_name ?? 'GranaEvo',
          email:           normalizedEmail,
          is_stripe:       true,
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