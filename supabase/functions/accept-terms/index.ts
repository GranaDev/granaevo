// supabase/functions/accept-terms/index.ts
// Registra o aceite dos Termos de Uso (LGPD). user_id SEMPRE derivado do JWT
// validado — nunca do body (padrão anti-mass-assignment do projeto).

import { createClient }         from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { CURRENT_TERMS_VERSION } from '../_shared/terms.ts'

// ─── timing-safe compare ──────────────────────────────────────────────────────
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
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

function json(body: unknown, status = 200, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')   return json({ error: 'Método não permitido' }, 405, cors)

  // ── 1. Proxy secret ───────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[accept-terms] PROXY_SECRET não configurada')
    return json({ error: 'Configuração interna inválida' }, 500, cors)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[accept-terms] Proxy secret inválido — acesso direto bloqueado')
    return json({ error: 'Não autorizado' }, 401, cors)
  }

  // ── 2. JWT → userId (assinatura validada pelo servidor Auth) ──────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Não autorizado' }, 401, cors)
  }
  const token = authHeader.slice(7).trim()
  if (!token || token.length < 20) return json({ error: 'Não autorizado' }, 401, cors)

  // ── 3. Admin client ───────────────────────────────────────────────────────
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
  )

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) {
    console.warn('[accept-terms] JWT inválido:', userErr?.message ?? 'user null')
    return json({ error: 'Não autorizado' }, 401, cors)
  }

  const userId    = user.id
  const userEmail = (user.email ?? '').toLowerCase().trim()

  // ── 4. Registrar aceite (idempotente via ON CONFLICT) ─────────────────────
  // user_id vem do JWT validado — nunca do body (anti-mass-assignment)
  const clientIp = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  const userAgent = req.headers.get('user-agent') ?? ''

  const { error: insertErr } = await supabaseAdmin
    .from('terms_acceptance')
    .insert({
      user_id:       userId,
      email:         userEmail,
      accepted:      true,
      ip_address:    clientIp,
      user_agent:    userAgent || null,
      terms_version: CURRENT_TERMS_VERSION,
    })

  // 23505 = unique_violation → aceite já registrado para esta versão (idempotente)
  if (insertErr && insertErr.code !== '23505') {
    console.error('[accept-terms] Erro ao inserir aceite:', insertErr.message)
    return json({ error: 'Erro interno ao registrar aceite. Tente novamente.' }, 500, cors)
  }

  console.log(
    `[accept-terms] Aceite registrado: user=${userId.slice(0, 8)} versão=${CURRENT_TERMS_VERSION}`,
    insertErr?.code === '23505' ? '(idempotente)' : ''
  )

  return json({ accepted: true, termsVersion: CURRENT_TERMS_VERSION }, 200, cors)
})
