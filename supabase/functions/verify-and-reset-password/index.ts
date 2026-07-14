import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { isPasswordPwned } from '../_shared/hibp.ts'

// ═══════════════════════════════════════════════════════════════
//  verify-and-reset-password — v7
//
//  Mudança v7:
//    Tenta admin.updateUserById primeiro (1 chamada GoTrue).
//    Fallback para recovery flow (generateLink + verifyOtp + PUT /user)
//    apenas se admin update falhar com erro de secure_password_change.
//    Isso resolve o hang no verifyOtp para contas restauradas por migration.
//    Timeouts explícitos (AbortSignal) em cada chamada GoTrue.
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

// Timeout por chamada individual ao GoTrue
const GOTRUE_CALL_TIMEOUT_MS = 8_000

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
      signal:  AbortSignal.timeout(5_000),
    })
    return (await res.json()).success === true
  } catch { return false }
}

/**
 * Abordagem primária: usa admin.updateUserById diretamente.
 * Uma única chamada GoTrue — rápida e confiável.
 * Funciona mesmo para contas restauradas por migration.
 */
async function updatePasswordViaAdmin(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  newPassword: string,
): Promise<{ ok: boolean; errorCode?: string; message?: string; isSecurePasswordChangeError?: boolean }> {
  try {
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Timeout via Promise.race — supabase-js não expõe AbortSignal diretamente
    const updatePromise = adminClient.auth.admin.updateUserById(userId, { password: newPassword })
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('ADMIN_UPDATE_TIMEOUT')), GOTRUE_CALL_TIMEOUT_MS),
    )

    const { error } = await Promise.race([updatePromise, timeoutPromise])

    if (!error) {
      console.log('[verify-reset] v7 admin update OK')
      return { ok: true }
    }

    console.warn('[verify-reset] v7 admin update falhou:', error.status, error.message)

    // Detecta se o erro é de secure_password_change (requer recovery flow)
    const msg = error.message?.toLowerCase() ?? ''
    const isSecurePasswordChangeError =
      error.status === 422 ||
      error.status === 403 ||
      msg.includes('reauthentication') ||
      msg.includes('secure_password_change') ||
      msg.includes('requires recent login') ||
      msg.includes('token is expired') ||
      msg.includes('session') ||
      msg.includes('password update requires')

    return { ok: false, errorCode: 'ERR_ADMIN', message: error.message, isSecurePasswordChangeError }
  } catch (e) {
    const msg = String(e)
    console.error('[verify-reset] v7 admin update exception:', msg)
    return { ok: false, errorCode: 'ERR_ADMIN_EXC', message: msg, isSecurePasswordChangeError: false }
  }
}

/**
 * Abordagem fallback: fluxo nativo de recovery OTP do Supabase.
 * Usado quando admin.updateUserById falha por secure_password_change.
 *
 * Fluxo:
 *   1. admin.generateLink({ type:'recovery' }) — gera token SEM enviar email
 *   2. verifyOtp({ token_hash, type:'recovery' }) — obtém sessão autenticada
 *   3. PUT /auth/v1/user com access_token — altera senha
 *
 * Cada chamada tem timeout explícito para evitar hang indefinido.
 */
async function updatePasswordViaRecoveryFlow(
  supabaseUrl: string,
  serviceKey: string,
  anonKey: string,
  email: string,
  newPassword: string,
): Promise<{ ok: boolean; errorCode?: string; message?: string }> {

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Step 1: gerar recovery token (sem email)
  let linkData: Awaited<ReturnType<typeof adminClient.auth.admin.generateLink>>['data']
  let linkError: Awaited<ReturnType<typeof adminClient.auth.admin.generateLink>>['error']
  try {
    const genPromise = adminClient.auth.admin.generateLink({ type: 'recovery', email })
    const genTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('GENERATE_LINK_TIMEOUT')), GOTRUE_CALL_TIMEOUT_MS),
    )
    const result = await Promise.race([genPromise, genTimeout])
    linkData  = result.data
    linkError = result.error
  } catch (e) {
    console.error('[verify-reset] ERR_06A_TIMEOUT generateLink:', String(e))
    return { ok: false, errorCode: 'ERR_06A_TIMEOUT', message: String(e) }
  }

  if (linkError) {
    console.error('[verify-reset] ERR_06A generateLink:', linkError.message, '| status:', linkError.status)
    const errCode = (linkError.status === 404 || linkError.message?.toLowerCase().includes('not found'))
      ? 'ERR_06A_NO_ACCOUNT'
      : 'ERR_06A'
    return { ok: false, errorCode: errCode, message: linkError.message }
  }
  const tokenHash = linkData?.properties?.hashed_token
  if (!tokenHash) {
    console.error('[verify-reset] ERR_06B: hashed_token ausente')
    return { ok: false, errorCode: 'ERR_06B' }
  }
  console.log('[verify-reset] ERR_06A_OK: recovery token gerado')

  // Step 2: trocar token por sessão de recovery
  const anonClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  let otpData: Awaited<ReturnType<typeof anonClient.auth.verifyOtp>>['data']
  let otpError: Awaited<ReturnType<typeof anonClient.auth.verifyOtp>>['error']
  try {
    const otpPromise = anonClient.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' })
    const otpTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('VERIFY_OTP_TIMEOUT')), GOTRUE_CALL_TIMEOUT_MS),
    )
    const result = await Promise.race([otpPromise, otpTimeout])
    otpData  = result.data
    otpError = result.error
  } catch (e) {
    console.error('[verify-reset] ERR_06C_TIMEOUT verifyOtp:', String(e))
    return { ok: false, errorCode: 'ERR_06C_TIMEOUT', message: String(e) }
  }

  if (otpError || !otpData?.session?.access_token) {
    console.error('[verify-reset] ERR_06C verifyOtp:', otpError?.message)
    return { ok: false, errorCode: 'ERR_06C', message: otpError?.message }
  }
  const accessToken = otpData.session.access_token
  console.log('[verify-reset] ERR_06C_OK: sessão de recovery obtida')

  // Step 3: atualizar senha com a sessão de recovery
  let updateRes: Response
  try {
    updateRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'apikey':        anonKey,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({ password: newPassword }),
      signal: AbortSignal.timeout(GOTRUE_CALL_TIMEOUT_MS),
    })
  } catch (e) {
    console.error('[verify-reset] ERR_06D_TIMEOUT PUT /user:', String(e))
    return { ok: false, errorCode: 'ERR_06D_TIMEOUT', message: String(e) }
  }

  if (!updateRes.ok) {
    const body = await updateRes.text()
    console.error(`[verify-reset] ERR_06D updateUser HTTP ${updateRes.status}:`, body)
    if (updateRes.status === 422) {
      return { ok: false, errorCode: 'ERR_06D_422', message: body }
    }
    return { ok: false, errorCode: `ERR_06D_${updateRes.status}`, message: body }
  }

  console.log('[verify-reset] ERR_06D_OK: senha atualizada via recovery flow')
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
  // Prefere a publishable key nova (SUPABASE_PUBLISHABLE_KEYS['default']) e cai
  // para a anon legada durante a transição. Usada só como `apikey` no recovery
  // flow. Ver docs/roadmap-melhorias-dev.md Passo 1, Estágio 3. (Migração 2026-07-14)
  const anonKey     = (() => {
    try {
      const pk = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')?.default
      if (pk) return pk
    } catch { /* SUPABASE_PUBLISHABLE_KEYS ausente/inválida → usa a legada */ }
    return Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  })()
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
        return json({ status: 'error', message: 'A senha deve ter entre 8 e 128 caracteres.' }, 400)
      const cleaned = newPassword.replace(/\x00/g, '')
      if (cleaned.length < 8 || cleaned.length > 128)
        return json({ status: 'error', message: 'A senha deve ter entre 8 e 128 caracteres.' }, 400)
      if (!/[A-Z]/.test(cleaned))
        return json({ status: 'error', message: 'A senha deve conter pelo menos uma letra maiúscula.' }, 400)
      if (!/[0-9]/.test(cleaned))
        return json({ status: 'error', message: 'A senha deve conter pelo menos um número.' }, 400)

      // HIBP: rejeita senha vazada (k-anonymity, grátis, fail-open). Retorna 200 com
      // campo `status` — o frontend (login.js) trata 'weak_password' com mensagem própria;
      // respostas !ok viram "erro de conexão". Checa antes de consumir o código de reset.
      if (await isPasswordPwned(cleaned)) {
        return json({ status: 'weak_password', message: 'Essa senha apareceu em vazamentos de dados. Escolha uma senha diferente.' })
      }

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

    // ── 4. reset_password ──────────────────────────────────────
    const finalPassword = (body as Record<string, unknown>).newPassword as string
    const userId        = resetEntry.user_id as string | null

    let updateResult: { ok: boolean; errorCode?: string; message?: string }

    // Abordagem primária: admin.updateUserById (rápida, 1 chamada GoTrue)
    if (userId) {
      console.log('[verify-reset] v7: tentando admin update (user_id disponível)')
      const adminResult = await updatePasswordViaAdmin(supabaseUrl, serviceKey, userId, finalPassword)

      if (adminResult.ok) {
        updateResult = { ok: true }
      } else if (adminResult.isSecurePasswordChangeError) {
        // Admin update bloqueado por secure_password_change → usa recovery flow
        console.log('[verify-reset] v7: admin bloqueado por secure_password_change, tentando recovery flow')
        updateResult = await updatePasswordViaRecoveryFlow(supabaseUrl, serviceKey, anonKey, normalizedEmail, finalPassword)
      } else {
        // Outro erro no admin update — tenta recovery flow como fallback
        console.warn('[verify-reset] v7: admin update falhou (não é secure_password_change), tentando recovery flow')
        updateResult = await updatePasswordViaRecoveryFlow(supabaseUrl, serviceKey, anonKey, normalizedEmail, finalPassword)
      }
    } else {
      // Sem user_id → vai direto para recovery flow
      console.log('[verify-reset] v7: user_id não disponível, usando recovery flow')
      updateResult = await updatePasswordViaRecoveryFlow(supabaseUrl, serviceKey, anonKey, normalizedEmail, finalPassword)
    }

    if (!updateResult.ok) {
      console.error(`[verify-reset] Falha no update: ${updateResult.errorCode} — ${updateResult.message ?? ''}`)

      if (updateResult.errorCode === 'ERR_06A_NO_ACCOUNT') {
        await supabase
          .from('password_reset_codes')
          .update({ used: true, used_at: new Date().toISOString() })
          .eq('id', resetEntry.id)
        return json({ status: 'invalid_code', message: 'Código inválido, expirado ou já utilizado.' })
      }

      if (updateResult.errorCode === 'ERR_06D_422') {
        return json({
          status:  'error',
          message: 'A senha deve ter entre 8 e 128 caracteres, com letra maiúscula e número.',
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
