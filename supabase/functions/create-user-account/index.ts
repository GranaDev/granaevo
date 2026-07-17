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
import { isPasswordPwned } from '../_shared/hibp.ts'

const corsHeaders = { 'Content-Type': 'application/json' }

// Teto de tentativas por código. 6 dígitos = 900k combinações; sem teto, força
// bruta é viável. Com 5, a chance é ~1 em 180.000 por código. Mesmo número do
// verify-guest-invite.
const MAX_TENTATIVAS_CODIGO = 5

// SHA-256 hex — o mesmo hash que send-signup-code grava. O código NUNCA é
// guardado em claro: vazar a tabela não pode entregar contas.
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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
  const code     = typeof body.code     === 'string' ? body.code.trim()                  : ''

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

  // Formato do código antes de tocar no banco. 6 dígitos, e só.
  if (!/^\d{6}$/.test(code))
    return json({ error: 'codigo_invalido' }, 400)

  // ── 2.5 HIBP: bloqueia senha que já vazou (k-anonymity, grátis, fail-open) ─────
  // O frontend (planos.js) trata { error: 'senha_vazada' } com mensagem específica.
  if (await isPasswordPwned(password)) {
    console.log(`[create-user-account] Senha vazada rejeitada: ${email.slice(0, 8)}***`)
    return json({ error: 'senha_vazada' }, 400)
  }

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

  // ── 2.6 PROVA DE POSSE DO E-MAIL ─────────────────────────────────────────────
  // Antes desta trava, `email_confirm: true` abaixo era uma MENTIRA: afirmava ao
  // banco que o e-mail fora verificado quando ninguém verificara nada. Qualquer
  // um criava conta com o e-mail de terceiro e o sistema inteiro passava a
  // confiar naquele endereço — foi o que permitiu 5 caminhos de tomada de
  // assinatura (auditoria 2026-07-16). Agora o `email_confirm: true` é VERDADE:
  // só chega aqui quem provou receber o código.
  const codeHash = await sha256Hex(code)
  const agora    = new Date().toISOString()

  const { data: reg, error: regErr } = await supabaseAdmin
    .from('signup_email_codes')
    .select('id, code_hash, verification_attempts, plan')
    .eq('email', email)
    .eq('used', false)
    .gt('expires_at', agora)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (regErr) {
    console.error('[create-user-account] Erro ao buscar código:', regErr.message)
    return json({ error: 'Erro interno.' }, 500)
  }
  if (!reg) return json({ error: 'codigo_invalido' }, 400)

  // Teto de tentativas: sem isto, 6 dígitos caem em ~500k requisições.
  if ((reg.verification_attempts ?? 0) >= MAX_TENTATIVAS_CODIGO) {
    console.warn('[create-user-account] Código esgotou tentativas:', email.slice(0, 8) + '***')
    return json({ error: 'codigo_invalido' }, 400)
  }

  if (!timingSafeEqual(reg.code_hash ?? '', codeHash)) {
    // Incrementa ANTES de responder — errar não pode sair de graça.
    await supabaseAdmin
      .from('signup_email_codes')
      .update({ verification_attempts: (reg.verification_attempts ?? 0) + 1 })
      .eq('id', reg.id)
    return json({ error: 'codigo_invalido' }, 400)
  }

  // Queima o código ANTES de criar a conta: se duas requisições chegarem juntas
  // com o mesmo código, só a que marcar `used` primeiro segue. O `.eq('used',
  // false)` faz do UPDATE um compare-and-swap — sem ele, o replay seria possível.
  const { data: queimado, error: burnErr } = await supabaseAdmin
    .from('signup_email_codes')
    .update({ used: true, used_at: agora })
    .eq('id', reg.id)
    .eq('used', false)
    .select('id')
    .maybeSingle()

  if (burnErr || !queimado) {
    console.warn('[create-user-account] Código já consumido (corrida) —', email.slice(0, 8) + '***')
    return json({ error: 'codigo_invalido' }, 400)
  }

  try {
    const { data, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      // Agora isto é VERDADE: o dono do e-mail provou posse com o código acima.
      email_confirm: true,
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
