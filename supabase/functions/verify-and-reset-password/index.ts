import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ═══════════════════════════════════════════════════════════════
//  verify-and-reset-password — v4
//
//  Unifica verificação de código e reset de senha em uma única
//  Edge Function, controlada pelo parâmetro `action`.
//
//  Ações disponíveis:
//    "verify_code"     — verifica o código sem alterar senha.
//                        Incrementa tentativas se errado.
//                        Exige CAPTCHA após 3 tentativas erradas.
//    "reset_password"  — verifica o código + altera a senha.
//                        Marca o código como usado.
//
//  [FIX-v4-1] Adicionado suporte a action parameter.
//  [FIX-v4-2] CAPTCHA obrigatório após CAPTCHA_REQUIRED_AFTER
//             tentativas erradas — validado diretamente aqui,
//             sem depender da Edge Function verify-recaptcha.
//  [FIX-v4-3] verify_code NÃO marca o código como usado,
//             reset_password re-verifica e então marca.
//  [FIX-v4-4] Resposta inclui captcha_required e attempts
//             para que o frontend saiba quando exibir o widget.
//  [FIX-v4-5] Mensagem genérica em todos os ramos de erro —
//             sem vazar detalhes de infraestrutura.
// ═══════════════════════════════════════════════════════════════

// ── CORS ──────────────────────────────────────────────────────
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

// ── CONSTANTES ────────────────────────────────────────────────
const MAX_VERIFY_ATTEMPTS      = 5   // bloqueio total após N tentativas
const CAPTCHA_REQUIRED_AFTER   = 3   // exige CAPTCHA após N tentativas erradas
const CAPTCHA_TOKEN_MIN_LENGTH = 50

// ── HELPERS ───────────────────────────────────────────────────

/** SHA-256 do código numérico recebido. */
async function hashCode(code: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(code),
  )
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Valida o token reCAPTCHA direto na API do Google. */
async function verifyCaptchaToken(token: string): Promise<boolean> {
  try {
    const secretKey = Deno.env.get('RECAPTCHA_SECRET_KEY')
    if (!secretKey) {
      console.error('[verify-reset] RECAPTCHA_SECRET_KEY não configurada')
      return false
    }
    const res  = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ secret: secretKey, response: token.trim() }),
    })
    const data = await res.json()
    return data.success === true
  } catch (e) {
    console.error('[verify-reset] Erro ao verificar CAPTCHA:', e)
    return false
  }
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  // Só POST
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
    // ── Cliente admin ──────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')              ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    // ── Parse do body ──────────────────────────────────────────
    let body: {
      action?:       unknown
      email?:        unknown
      code?:         unknown
      newPassword?:  unknown
      captchaToken?: unknown
    }

    try {
      body = await req.json()
    } catch {
      return json({ status: 'error', message: 'Body inválido.' }, 400)
    }

    const { action, email, code, newPassword, captchaToken } = body

    // ── Validação de action ────────────────────────────────────
    if (action !== 'verify_code' && action !== 'reset_password') {
      return json({ status: 'error', message: 'Ação inválida.' }, 400)
    }

    // ── Validação de email ─────────────────────────────────────
    if (typeof email !== 'string' || !email.trim()) {
      return json({ status: 'error', message: 'Email inválido.' }, 400)
    }

    // ── Validação de código ────────────────────────────────────
    if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      return json({ status: 'error', message: 'Código deve ter 6 dígitos numéricos.' }, 400)
    }

    // ── Validação de nova senha (somente reset_password) ───────
    if (action === 'reset_password') {
      if (
        typeof newPassword !== 'string' ||
        newPassword.length < 8           ||
        newPassword.length > 128
      ) {
        return json({ status: 'error', message: 'Senha inválida.' }, 400)
      }
    }

    const normalizedEmail = email.toLowerCase().trim()
    const normalizedCode  = code.trim()

    console.log(`[verify-reset] action=${action} email=${normalizedEmail}`)

    // ── 1. Buscar entrada de reset válida ──────────────────────
    //  Filtra: mesmo email, não usado, não expirado.
    //  Retorna o mais recente.
    const { data: resetEntry, error: fetchError } = await supabase
      .from('password_reset_codes')
      .select('id, code_hash, verification_attempts')
      .eq('email', normalizedEmail)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (fetchError) {
      console.error('[verify-reset] Erro ao buscar entry:', fetchError.message)
      return json({ status: 'error', message: 'Erro interno. Tente novamente.' }, 500)
    }

    // Nenhuma entrada válida — expirado, já usado ou email inexistente
    if (!resetEntry) {
      console.log('[verify-reset] Nenhuma entrada válida para:', normalizedEmail)
      return json({
        status:  'invalid_code',
        message: 'Código inválido, expirado ou já utilizado.',
      })
    }

    const attempts = resetEntry.verification_attempts

    // ── 2. Limite máximo de tentativas ─────────────────────────
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      console.log('[verify-reset] Limite máximo atingido para:', normalizedEmail)
      return json({
        status:  'invalid_code',
        message: 'Código bloqueado por excesso de tentativas. Solicite um novo código.',
      })
    }

    // ── 3. CAPTCHA obrigatório após CAPTCHA_REQUIRED_AFTER ─────
    //  [FIX-v4-2] Se já houve N tentativas erradas, o frontend
    //  DEVE enviar um captchaToken válido junto com a requisição.
    if (attempts >= CAPTCHA_REQUIRED_AFTER) {
      const tokenStr = typeof captchaToken === 'string' ? captchaToken.trim() : ''

      if (!tokenStr || tokenStr.length < CAPTCHA_TOKEN_MIN_LENGTH) {
        console.log('[verify-reset] CAPTCHA ausente ou inválido (tentativas=' + attempts + ')')
        return json({
          status:           'captcha_required',
          captcha_required: true,
          attempts,
          message:          'Verificação de segurança necessária.',
        })
      }

      const captchaOk = await verifyCaptchaToken(tokenStr)
      if (!captchaOk) {
        console.log('[verify-reset] CAPTCHA inválido para:', normalizedEmail)
        return json({
          status:           'captcha_required',
          captcha_required: true,
          attempts,
          message:          'Falha na verificação de segurança. Tente novamente.',
        })
      }
    }

    // ── 4. Verificar hash do código ────────────────────────────
    const incomingHash = await hashCode(normalizedCode)
    const hashMatch    = incomingHash === resetEntry.code_hash

    if (!hashMatch) {
      const newAttempts = attempts + 1

      await supabase
        .from('password_reset_codes')
        .update({ verification_attempts: newAttempts })
        .eq('id', resetEntry.id)

      const captchaRequiredNow = newAttempts >= CAPTCHA_REQUIRED_AFTER

      console.log('[verify-reset] Código incorreto. Tentativas:', newAttempts, '/', MAX_VERIFY_ATTEMPTS)

      return json({
        status:           'invalid_code',
        captcha_required: captchaRequiredNow,
        attempts:         newAttempts,
        message:          'Código incorreto. Verifique e tente novamente.',
      })
    }

    console.log('[verify-reset] Código correto para:', normalizedEmail)

    // ── 5a. verify_code — confirma sem alterar senha ───────────
    //  [FIX-v4-3] NÃO marca como usado — reset_password fará isso.
    if (action === 'verify_code') {
      return json({ status: 'code_valid' })
    }

    // ── 5b. reset_password — altera senha e marca como usado ───

    // Obtém user_id via subscriptions ativas
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('user_email', normalizedEmail)
      .eq('is_active', true)
      .maybeSingle()

    if (subError || !subscription?.user_id) {
      console.error('[verify-reset] user_id não encontrado:', normalizedEmail, subError?.message ?? '')

      // Invalida o código para evitar reuso
      await supabase
        .from('password_reset_codes')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('id', resetEntry.id)

      return json({ status: 'error', message: 'Erro interno. Tente novamente.' }, 500)
    }

    // Atualiza a senha via Admin API
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      subscription.user_id,
      { password: newPassword as string },
    )

    if (updateError) {
      console.error('[verify-reset] Erro ao atualizar senha:', updateError.message)
      return json({ status: 'error', message: 'Erro interno. Tente novamente.' }, 500)
    }

    // Marca código como usado
    await supabase
      .from('password_reset_codes')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('id', resetEntry.id)

    console.log('[verify-reset] Senha alterada com sucesso para:', normalizedEmail)

    return json({ status: 'success' })

  } catch (error) {
    // [FIX-v4-5] Catch genérico — sem vazar detalhes internos
    console.error('[verify-reset] Erro não tratado:', error)
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})