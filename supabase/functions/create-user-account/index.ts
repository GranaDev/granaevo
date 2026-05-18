// supabase/functions/create-user-account/index.ts
// Cria usuário via Supabase Admin API usando service_role (disponível via Supabase secrets).
//
// Chamada EXCLUSIVAMENTE pelo proxy Vercel api/create-account.js via x-proxy-secret.
// Sem CORS de browser — nunca é chamada diretamente pelo frontend.
//
// Todas as validações de negócio (email, senha, plano, honeypot, rate limit)
// são realizadas pelo proxy ANTES de chegar aqui.
// Esta função realiza revalidação defensiva (defense-in-depth) e executa a criação.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

const corsHeaders = { 'Content-Type': 'application/json' }

const VALID_PLANS = new Set(['individual', 'casal', 'familia'])
const EMAIL_RE    = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

// [GOD-TSE] timing-safe compare — sem early-return em length
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}

Deno.serve(async (req: Request) => {
  // OPTIONS não precisa de autenticação — responde imediatamente
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST')   return json({ error: 'Método não permitido' }, 405)

  // ── 1. Proxy secret — bloqueia qualquer chamada que não venha do proxy Vercel ──
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[create-user-account] PROXY_SECRET não configurada')
    return json({ error: 'Configuração interna inválida.' }, 503)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[create-user-account] Proxy secret inválido — chamada direta bloqueada')
    return json({ error: 'Não autorizado.' }, 401)
  }

  // ── 2. Lê e valida o body ─────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body inválido.' }, 400)
  }

  const email    = typeof body.email    === 'string' ? body.email.trim().toLowerCase()  : ''
  const password = typeof body.password === 'string' ? body.password                     : ''
  const plan     = typeof body.plan     === 'string' ? body.plan.trim().toLowerCase()   : ''

  // Revalidação defensiva — proxy já validou, mas defense-in-depth garante
  // que mesmo se o proxy for bypassado (ex: bug futuro), dados inválidos não chegam ao Auth
  if (!email || !EMAIL_RE.test(email))
    return json({ error: 'Email inválido.' }, 400)

  if (!password || password.length < 8 || password.length > 128)
    return json({ error: 'Senha inválida.' }, 400)

  if (!/[A-Z]/.test(password))
    return json({ error: 'Senha inválida.' }, 400)

  if (!/[0-9]/.test(password))
    return json({ error: 'Senha inválida.' }, 400)

  if (!VALID_PLANS.has(plan))
    return json({ error: 'Plano inválido.' }, 400)

  // ── 3. Cria usuário via Admin API ─────────────────────────────────────────────
  const supabaseUrl    = Deno.env.get('SUPABASE_URL')             ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[create-user-account] Variáveis de ambiente Supabase ausentes')
    return json({ error: 'Configuração interna inválida.' }, 503)
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  try {
    const { data, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,        // confirma email imediatamente (sem link de verificação)
      user_metadata: { plan },
    })

    if (createError) {
      // Email já cadastrado — retorna 409 com código específico
      // O frontend usa 'email_exists' para exibir a mensagem correta
      const isEmailExists =
        createError.message?.toLowerCase().includes('already been registered') ||
        createError.message?.toLowerCase().includes('already exists') ||
        (createError as { code?: string }).code === 'email_exists'

      if (isEmailExists) {
        console.log(`[create-user-account] Email já cadastrado: ${email.slice(0, 8)}***`)
        return json({ error: 'email_exists' }, 409)
      }

      console.error('[create-user-account] Erro ao criar usuário:', createError.message)
      return json({ error: 'Não foi possível criar a conta. Tente novamente.' }, 500)
    }

    if (!data?.user) {
      console.error('[create-user-account] Usuário não retornado após criação')
      return json({ error: 'Não foi possível criar a conta. Tente novamente.' }, 500)
    }

    console.log(`[create-user-account] Conta criada: ${data.user.id.slice(0, 8)} plano: ${plan}`)
    return json({ ok: true }, 200)

  } catch (err) {
    console.error('[create-user-account] Exceção:', (err as Error).message)
    return json({ error: 'Serviço temporariamente indisponível.' }, 502)
  }
})
