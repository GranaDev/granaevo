/**
 * GranaEvo — check-email-status/index.ts (v4)
 *
 * ============================================================
 * NEUTRALIZADO — ANTI-ENUMERAÇÃO (auditoria 2026-07-12, achado F2)
 * ============================================================
 *
 * Este endpoint distinguia entre `not_found` / `password_exists` / `ready`,
 * o que o tornava um ORÁCULO DE ENUMERAÇÃO de clientes pagantes (revelava,
 * pré-autenticação, se um e-mail tinha assinatura ativa e/ou conta criada).
 *
 * Verificado em 2026-07-12: NÃO há nenhum consumidor deste endpoint em src/,
 * public/ ou nas demais Edge Functions — o pré-check do fluxo de reset foi
 * removido (ver api/reset-password.js) e o "Primeiro Acesso" não o utiliza.
 *
 * Como é código órfão, a função agora responde SEMPRE de forma neutra e
 * idêntica, independentemente de o e-mail existir ou ter assinatura. Isso
 * elimina o oráculo sem quebrar nada. Se o fluxo de "Primeiro Acesso" for
 * reconstruído no futuro, ele deve ser feito atrás de autenticação (JWT do
 * próprio usuário) e não como um lookup público por e-mail.
 *
 * Mantém o gate por PROXY_SECRET (defesa em profundidade) e o CORS restrito.
 */

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

// Resposta neutra e ÚNICA — não revela existência de e-mail/assinatura/conta.
function neutral(corsHeaders: Record<string, string>, status = 200): Response {
  return new Response(
    JSON.stringify({ status: 'not_found' }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status }
  )
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
    return neutral(corsHeaders)
  }

  // Apenas POST aceito
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ status: 'error', message: 'Método não permitido' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 405 }
    )
  }

  // Consome o body (compat com clientes que enviam corpo) mas NÃO o usa para
  // diferenciar a resposta — anti-enumeração. Toda requisição válida recebe
  // exatamente a mesma resposta neutra.
  try { await req.json() } catch { /* ignora — resposta é sempre neutra */ }

  return neutral(corsHeaders)
})
