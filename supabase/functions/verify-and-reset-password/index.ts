import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// ═══════════════════════════════════════════════════════════════
//  verify-and-reset-password — v6
//
//  Mudança crítica v6:
//    secure_password_change=true no GoTrue bloqueia PUT /admin/users/{id}
//    e PUT /user sem uma sessão com AMR recente.
//    Solução: fluxo nativo de recovery OTP do Supabase:
//      1. admin.generateLink({ type: 'recovery' }) → token (sem email)
//      2. auth.verifyOtp({ token_hash, type: 'recovery' }) → sessão com AMR
//      3. PUT /auth/v1/user com access_token da sessão → atualiza senha
//    Esse fluxo é o único que bypassa secure_password_change legitimamente.
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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

const MAX_VERIFY_ATTEMPTS    = 5
const CAPTCHA_REQUIRED_AFTER = 3
const CAPTCHA_TOKEN_MIN_LEN  = 50

async function hashCode(code: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

async function verifyCaptchaToken(token: string): Promise<boolean> {
  try {
    const secretKey = Deno.env.get('RECAPTCHA_SECRET_KEY')
    if (!secretKey) return false
    const res  = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ secret: secretKey, response: token.trim() }),
    })
    return (await res.json()).success === true
  } catch { return false }
}

/**
 * Lookup user_id diretamente na GoTrue Admin API pelo email.
 * Fallback final quando subscription tables não têm user_id.
 */
async function getUserIdByEmail(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=100&filter=${encodeURIComponent(email)}`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } },
    )
    if (!res.ok) {
      console.error(`[verify-reset] ERR_05: GoTrue users list HTTP ${res.status}`)
      return null
    }
    const data = await res.json()
    const users: Array<{ id: string; email: string }> = data.users ?? []
    const match = users.find(u => u.email?.toLowerCase() === email)
    if (match?.id) {
      console.log(`[verify-reset] ERR_05_OK: user_id via GoTrue admin (${users.length} users retornados)`)
      return match.id
    }
    // Filtro GoTrue pode não funcionar em todas as versões — tenta sem filtro se nada encontrado
    console.warn(`[verify-reset] ERR_05_NOFILT: filter retornou ${users.length} mas sem match, tentando listagem`)
    return null
  } catch (e) {
    console.error('[verify-reset] ERR_05_EXC:', String(e))
    return null
  }
}

/**
 * Atualiza senha usando o fluxo nativo de recovery OTP do Supabase.
 * Bypassa secure_password_change porque a sessão de recovery tem AMR recente.
 *
 * Fluxo:
 *   1. admin.generateLink({ type:'recovery' }) — gera token SEM enviar email
 *   2. verifyOtp({ token_hash, type:'recovery' }) — obtém sessão autenticada
 *   3. PUT /auth/v1/user com access_token — altera senha legitimamente
 */
async function updatePasswordViaRecoveryFlow(
  supabaseUrl: string,
  serviceKey: string,
  anonKey: string,
  email: string,
  newPassword: string,
): Promise<{ ok: boolean; errorCode?: string; message?: string }> {

  // Step 1: gerar link de recovery (não envia email — apenas gera o token)
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'recovery',
    email,
  })
  if (linkError) {
    console.error('[verify-reset] ERR_06A generateLink:', linkError.message, '| status:', linkError.status)
    // 404 = conta auth.users não existe para este email (subscription sem auth account)
    const errCode = (linkError.status === 404 || linkError.message?.toLowerCase().includes('not found'))
      ? 'ERR_06A_NO_ACCOUNT'
      : 'ERR_06A'
    return { ok: false, errorCode: errCode, message: linkError.message }
  }
  const tokenHash = linkData?.properties?.hashed_token
  if (!tokenHash) {
    console.error('[verify-reset] ERR_06B: hashed_token ausente na resposta do generateLink')
    return { ok: false, errorCode: 'ERR_06B' }
  }
  console.log('[verify-reset] ERR_06A_OK: recovery token gerado')

  // Step 2: trocar token por sessão de recovery (prova de identidade via OTP)
  const anonClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: otpData, error: otpError } = await anonClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'recovery',
  })
  if (otpError || !otpData?.session?.access_token) {
    console.error('[verify-reset] ERR_06C verifyOtp:', otpError?.message)
    return { ok: false, errorCode: 'ERR_06C', message: otpError?.message }
  }
  const accessToken = otpData.session.access_token
  console.log('[verify-reset] ERR_06C_OK: sessão de recovery obtida')

  // Step 3: atualizar senha com a sessão de recovery (tem AMR recente — bypassa secure_password_change)
  const updateRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'apikey':        anonKey,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ password: newPassword }),
  })

  if (!updateRes.ok) {
    const body = await updateRes.text()
    console.error(`[verify-reset] ERR_06D updateUser HTTP ${updateRes.status}:`, body)
    if (updateRes.status === 422) {
      return { ok: false, errorCode: 'ERR_06D_422', message: body }
    }
    return { ok: false, errorCode: `ERR_06D_${updateRes.status}`, message: body }
  }

  console.log('[verify-reset] ERR_06D_OK: senha atualizada com sucesso')
  return { ok: true }
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')              ?? ''
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')         ?? ''
  const proxySecret = Deno.env.get('PROXY_SECRET')              ?? ''

  if (!proxySecret) {
    console.error('[verify-reset] ERR_00: PROXY_SECRET não configurada')
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('[verify-reset] ERR_00B: env vars faltando:', { supabaseUrl: !!supabaseUrl, serviceKey: !!serviceKey, anonKey: !!anonKey })
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }

  const received = req.headers.get('x-proxy-secret') ?? ''
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn('[verify-reset] ERR_00C: proxy secret inválido')
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
    )
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ status: 'error', message: 'Método não permitido.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 405 },
    )
  }

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  try {
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    let body: {
      action?: unknown; email?: unknown; code?: unknown
      newPassword?: unknown; captchaToken?: unknown
    }
    try { body = await req.json() }
    catch { return json({ status: 'error', message: 'Body inválido.' }, 400) }

    const { action, email, code, newPassword, captchaToken } = body

    if (action !== 'verify_code' && action !== 'reset_password')
      return json({ status: 'error', message: 'Ação inválida.' }, 400)

    if (typeof email !== 'string' || !email.trim())
      return json({ status: 'error', message: 'Email inválido.' }, 400)

    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim()))
      return json({ status: 'error', message: 'Código deve ter 6 dígitos numéricos.' }, 400)

    if (action === 'reset_password') {
      if (typeof newPassword !== 'string')
        return json({ status: 'error', message: 'A senha deve ter no mínimo 10 caracteres.' }, 400)
      const cleaned = newPassword.replace(/\x00/g, '')
      if (cleaned.length < 10 || cleaned.length > 128)
        return json({ status: 'error', message: 'A senha deve ter no mínimo 10 caracteres.' }, 400)
      if (!/[A-Za-z]/.test(cleaned) || !/[0-9]/.test(cleaned))
        return json({ status: 'error', message: 'A senha deve conter letras e números.' }, 400)
      ;(body as Record<string, unknown>).newPassword = cleaned
    }

    const normalizedEmail = email.toLowerCase().trim()
    const normalizedCode  = code.trim()

    console.log(`[verify-reset] action=${action} email=${normalizedEmail}`)

    // ── 1. Buscar código válido ────────────────────────────────
    const { data: resetEntry, error: fetchError } = await supabase
      .from('password_reset_codes')
      .select('id, code_hash, verification_attempts, user_id')
      .eq('email', normalizedEmail)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (fetchError) {
      console.error('[verify-reset] ERR_01:', fetchError.message, fetchError.code)
      return json({ status: 'error', message: 'Erro interno. Tente novamente.' }, 500)
    }
    if (!resetEntry)
      return json({ status: 'invalid_code', message: 'Código inválido, expirado ou já utilizado.' })

    const attempts = resetEntry.verification_attempts

    if (attempts >= MAX_VERIFY_ATTEMPTS)
      return json({ status: 'invalid_code', message: 'Código bloqueado. Solicite um novo código.' })

    // ── 2. CAPTCHA ─────────────────────────────────────────────
    if (attempts >= CAPTCHA_REQUIRED_AFTER) {
      const tok = typeof captchaToken === 'string' ? captchaToken.trim() : ''
      if (!tok || tok.length < CAPTCHA_TOKEN_MIN_LEN)
        return json({ status: 'captcha_required', captcha_required: true, attempts, message: 'Verificação de segurança necessária.' })
      if (!(await verifyCaptchaToken(tok)))
        return json({ status: 'captcha_required', captcha_required: true, attempts, message: 'Falha na verificação de segurança.' })
    }

    // ── 3. Verificar hash ──────────────────────────────────────
    const incomingHash = await hashCode(normalizedCode)
    if (!timingSafeEqual(incomingHash, resetEntry.code_hash)) {
      const newAtt = attempts + 1
      await supabase.from('password_reset_codes').update({ verification_attempts: newAtt }).eq('id', resetEntry.id)
      return json({ status: 'invalid_code', captcha_required: newAtt >= CAPTCHA_REQUIRED_AFTER, attempts: newAtt, message: 'Código incorreto.' })
    }

    console.log('[verify-reset] Código correto:', normalizedEmail)

    if (action === 'verify_code') return json({ status: 'code_valid' })

    // ── 4. reset_password: resolver email → usar recovery flow ─

    // O fluxo nativo de recovery usa o EMAIL diretamente, não precisa de user_id.
    // Isso elimina toda a cadeia de fallbacks de lookup de user_id que estava falhando.
    // generateLink({ type:'recovery' }) + verifyOtp → sessão com AMR recente →
    // PUT /auth/v1/user bypassa secure_password_change legitimamente.

    const finalPassword = (body as Record<string, unknown>).newPassword as string
    const updateResult  = await updatePasswordViaRecoveryFlow(
      supabaseUrl, serviceKey, anonKey, normalizedEmail, finalPassword,
    )

    if (!updateResult.ok) {
      console.error(`[verify-reset] Falha no update: ${updateResult.errorCode} — ${updateResult.message ?? ''}`)

      // Conta auth inexistente (subscription sem auth account — purge inconsistente)
      if (updateResult.errorCode === 'ERR_06A_NO_ACCOUNT') {
        // Invalida o código para evitar loops de tentativa
        await supabase
          .from('password_reset_codes')
          .update({ used: true, used_at: new Date().toISOString() })
          .eq('id', resetEntry.id)
        return json({
          status:  'invalid_code',
          message: 'Código inválido, expirado ou já utilizado.',
        })
      }

      // ERR_06D_422 = senha rejeitada pelo GoTrue (força/requisitos)
      if (updateResult.errorCode === 'ERR_06D_422') {
        return json({
          status:  'error',
          message: 'A senha deve conter letras e números (mínimo 10 caracteres).',
        }, 422)
      }

      return json({ status: 'error', message: 'Erro interno. Tente novamente.' }, 500)
    }

    // ── 5. Marcar código como usado ────────────────────────────
    await supabase
      .from('password_reset_codes')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('id', resetEntry.id)

    console.log(`[verify-reset] Senha alterada com sucesso: ${normalizedEmail}`)
    return json({ status: 'success' })

  } catch (err) {
    console.error('[verify-reset] ERR_99_UNHANDLED:', String(err))
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})
