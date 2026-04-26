import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ═══════════════════════════════════════════════════════════════
//  CORS
//
//  [SEC-FIX-CORS] Restrito ao domínio real.
//  '*' permitia que qualquer origem chamasse este endpoint.
//  Lista de origens permitidas — ajuste conforme seus domínios.
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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPER: HTML escape — previne injeção no template de email
//  user_name vem do banco (preenchido pelo webhook Cakto via dados
//  do pagador) — deve ser escapado antes de interpolar em HTML.
// ═══════════════════════════════════════════════════════════════
function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

// ═══════════════════════════════════════════════════════════════
//  HELPER: SHA-256
// ═══════════════════════════════════════════════════════════════
async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder()
  const data    = encoder.encode(code)
  const buffer  = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ═══════════════════════════════════════════════════════════════
//  RESPOSTA NEUTRA ANTI-ENUMERAÇÃO
//
//  Usada para não_encontrado e pagamento_não_aprovado.
//  Ambos retornam exatamente a mesma resposta que o caso de
//  sucesso, impedindo que o caller descubra se o email existe.
// ═══════════════════════════════════════════════════════════════
function neutralResponse(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      status:     'sent',
      message:    'Se o email estiver cadastrado com plano ativo, você receberá o código.',
      expires_in: '30 minutos',
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
  )
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')             ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // ── Parse e validação básica ──────────────────────────────
    let body: { email?: unknown }
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Corpo da requisição inválido.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const { email } = body

    if (typeof email !== 'string' || !email.trim()) {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Parâmetros inválidos.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Validação básica de formato (defesa em profundidade)
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      // Retorna neutro — não confirma nem nega que o email é inválido
      return neutralResponse(corsHeaders)
    }

    console.log('[send-reset-code] Solicitação para:', normalizedEmail)

    // ── 1. Verificar subscription ─────────────────────────────
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('user_id, user_name, payment_status, is_active')
      .eq('user_email', normalizedEmail)
      .eq('is_active', true)
      .maybeSingle()

    if (subError) {
      console.error('[send-reset-code] Erro ao buscar subscription:', subError.message)
      // Não vaza o erro interno — retorna neutro
      return neutralResponse(corsHeaders)
    }

    // Email não cadastrado → resposta neutra (não vaza enumeração)
    if (!subscription) {
      console.log('[send-reset-code] Email não encontrado (não exposto ao caller):', normalizedEmail)
      return neutralResponse(corsHeaders)
    }

    // Pagamento não aprovado → resposta neutra (não vaza enumeração)
    if (subscription.payment_status !== 'approved') {
      console.log('[send-reset-code] Pagamento não aprovado (não exposto ao caller):', normalizedEmail)
      return neutralResponse(corsHeaders)
    }

    // ── 2. Gerar código e calcular hash ───────────────────────
    const rnd      = new Uint32Array(1)
    crypto.getRandomValues(rnd)
    const code     = String(100_000 + (rnd[0] % 900_000)).padStart(6, '0')
    const codeHash = await hashCode(code)

    // [SEC-FIX GHOST-003] 30 minutos — tempo suficiente para o usuário completar
    // o reset, sem dar 6 horas para um atacante com acesso ao email.
    const expiresAt = new Date()
    expiresAt.setMinutes(expiresAt.getMinutes() + 30)

    console.log('[send-reset-code] Código gerado e hasheado (raw não logado)')

    // ── 3. Invalidar códigos anteriores do mesmo email ────────
    await supabase
      .from('password_reset_codes')
      .update({ used: true, used_at: new Date().toISOString() })
      .eq('email', normalizedEmail)
      .eq('used', false)

    // ── 4. Salvar hash — nunca o código em texto plano ────────
    const { error: insertError } = await supabase
      .from('password_reset_codes')
      .insert({
        email:                 normalizedEmail,
        code_hash:             codeHash,
        expires_at:            expiresAt.toISOString(),
        used:                  false,
        verification_attempts: 0,
      })

    if (insertError) {
      console.error('[send-reset-code] Erro ao salvar hash:', insertError.message)
      return new Response(
        JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    // ── 5. Montar e enviar email ──────────────────────────────
    const expiresFormatted = expiresAt.toLocaleString('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
    const codeDigits   = code.split('')
    const resendApiKey = Deno.env.get('RESEND_API_KEY')

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'GranaEvo <noreply@granaevo.com>',
        to:      [normalizedEmail],
        subject: '🔐 Seu código de verificação — GranaEvo',
        html: `<!DOCTYPE html>
<html lang="pt-BR" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Código de Verificação — GranaEvo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background-color: #060810;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      margin: 0;
      padding: 0;
      width: 100% !important;
      min-width: 100%;
    }

    .email-bg {
      background-color: #060810;
      padding: 48px 16px;
      width: 100%;
    }

    .wrapper {
      max-width: 620px;
      margin: 0 auto;
    }

    .top-wordmark {
      text-align: center;
      padding-bottom: 28px;
    }
    .top-wordmark span {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #10b981;
      opacity: 0.7;
    }

    .main-card {
      background: linear-gradient(160deg, #0d1117 0%, #111827 60%, #0a0f1a 100%);
      border: 1px solid rgba(16, 185, 129, 0.18);
      border-radius: 24px;
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(16, 185, 129, 0.06),
        0 32px 64px rgba(0, 0, 0, 0.7),
        0 0 80px rgba(16, 185, 129, 0.06) inset;
    }

    .header-strip {
      position: relative;
      padding: 52px 48px 44px;
      text-align: center;
      background: linear-gradient(135deg, #064e35 0%, #065f46 40%, #047857 100%);
      overflow: hidden;
    }

    .header-strip::before {
      content: '';
      position: absolute;
      top: -80px; left: -80px;
      width: 260px; height: 260px;
      background: radial-gradient(circle, rgba(255,255,255,0.07) 0%, transparent 70%);
      border-radius: 50%;
    }

    .header-strip::after {
      content: '';
      position: absolute;
      bottom: -60px; right: -60px;
      width: 200px; height: 200px;
      background: radial-gradient(circle, rgba(52, 211, 153, 0.12) 0%, transparent 70%);
      border-radius: 50%;
    }

    .header-lines {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
      background-size: 32px 32px;
    }

    .logo-wrap {
      position: relative;
      display: inline-block;
      margin-bottom: 24px;
      z-index: 2;
    }

    .logo-ring {
      position: absolute;
      inset: -6px;
      border-radius: 22px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.2);
    }

    .logo-img {
      position: relative;
      width: 80px;
      height: 80px;
      border-radius: 18px;
      display: block;
      object-fit: contain;
      background: #fff;
    }

    .brand-name {
      position: relative;
      z-index: 2;
      font-size: 32px;
      font-weight: 900;
      color: #ffffff;
      letter-spacing: -0.5px;
      display: block;
      margin-bottom: 8px;
    }

    .header-tagline {
      position: relative;
      z-index: 2;
      font-size: 14px;
      color: rgba(255,255,255,0.75);
      font-weight: 500;
      letter-spacing: 0.3px;
    }

    .security-banner {
      background: rgba(16, 185, 129, 0.06);
      border-bottom: 1px solid rgba(16, 185, 129, 0.12);
      padding: 12px 48px;
      text-align: center;
    }

    .security-banner span {
      font-size: 12px;
      color: #6ee7b7;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .body-content {
      padding: 48px 48px 40px;
    }

    .greeting-eyebrow {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #10b981;
      margin-bottom: 10px;
    }

    .greeting-name {
      font-size: 28px;
      font-weight: 800;
      color: #f1f5f9;
      line-height: 1.25;
      margin-bottom: 16px;
      letter-spacing: -0.3px;
    }

    .intro-text {
      font-size: 16px;
      line-height: 1.75;
      color: #94a3b8;
      margin-bottom: 0;
    }

    .intro-text strong {
      color: #e2e8f0;
      font-weight: 600;
    }

    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(16,185,129,0.25), transparent);
      margin: 36px 0;
    }

    .code-showcase {
      border-radius: 20px;
      overflow: hidden;
      border: 1px solid rgba(16, 185, 129, 0.3);
      margin: 0 0 32px;
      position: relative;
    }

    .code-showcase-top {
      background: rgba(16, 185, 129, 0.06);
      padding: 5px 20px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid rgba(16, 185, 129, 0.15);
    }

    .cs-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .cs-label {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: #10b981;
      opacity: 0.7;
    }

    .code-body {
      padding: 40px 36px 32px;
      text-align: center;
      background: rgba(16, 185, 129, 0.03);
      position: relative;
    }

    .code-body::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at 50% 30%, rgba(16,185,129,0.07) 0%, transparent 70%);
      pointer-events: none;
    }

    .code-eyebrow {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #6ee7b7;
      margin-bottom: 24px;
      display: block;
    }

    .code-digits {
      display: inline-flex;
      gap: 8px;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }

    .code-digit {
      display: inline-block;
      width: 52px;
      height: 64px;
      background: rgba(10, 11, 20, 0.8);
      border: 1px solid rgba(16, 185, 129, 0.4);
      border-radius: 10px;
      font-size: 32px;
      font-weight: 900;
      font-family: 'Courier New', Monaco, monospace;
      color: #10b981;
      text-align: center;
      line-height: 64px;
      box-shadow:
        0 0 16px rgba(16, 185, 129, 0.12) inset,
        0 4px 12px rgba(0,0,0,0.4);
      letter-spacing: 0;
    }

    .code-separator {
      display: inline-block;
      width: 8px;
      height: 64px;
      line-height: 64px;
      font-size: 20px;
      color: rgba(16, 185, 129, 0.3);
      font-weight: 300;
      vertical-align: top;
    }

    .code-hint {
      font-size: 13px;
      color: #475569;
      font-weight: 500;
      position: relative;
      z-index: 1;
    }

    .expiry-box {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 18px 20px;
      background: rgba(245, 158, 11, 0.06);
      border: 1px solid rgba(245, 158, 11, 0.2);
      border-left: 3px solid #f59e0b;
      border-radius: 12px;
      margin-bottom: 32px;
    }

    .expiry-icon {
      font-size: 22px;
      line-height: 1;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .expiry-title {
      font-size: 14px;
      font-weight: 700;
      color: #fbbf24;
      margin-bottom: 5px;
    }

    .expiry-text {
      font-size: 13px;
      color: rgba(251, 191, 36, 0.65);
      line-height: 1.5;
    }

    .expiry-time {
      color: #fcd34d;
      font-weight: 600;
    }

    .not-you-box {
      padding: 16px 20px;
      background: rgba(10, 11, 20, 0.4);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      margin-bottom: 32px;
    }

    .not-you-text {
      font-size: 14px;
      color: #475569;
      line-height: 1.6;
    }

    .not-you-text strong {
      color: #64748b;
      font-weight: 600;
    }

    .security-header {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #334155;
      margin-bottom: 16px;
    }

    .tip-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 11px 0;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    .tip-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .tip-check {
      width: 22px;
      height: 22px;
      min-width: 22px;
      background: rgba(16,185,129,0.1);
      border-radius: 6px;
      text-align: center;
      line-height: 22px;
      font-size: 11px;
      font-weight: 900;
      color: #10b981;
    }

    .tip-text {
      font-size: 13px;
      color: #475569;
      line-height: 1.4;
    }

    .email-footer {
      padding: 40px 48px 36px;
      border-top: 1px solid rgba(255,255,255,0.05);
      background: rgba(0,0,0,0.2);
      text-align: center;
    }

    .footer-brand {
      font-size: 18px;
      font-weight: 900;
      color: #10b981;
      letter-spacing: -0.3px;
      margin-bottom: 12px;
    }

    .footer-links { margin-bottom: 20px; }

    .footer-link {
      display: inline-block;
      color: #475569 !important;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      padding: 0 12px;
    }

    .footer-sep {
      color: #1e293b;
      font-size: 13px;
    }

    .footer-divider-line {
      width: 48px;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(16,185,129,0.4), transparent);
      margin: 20px auto;
    }

    .footer-copy {
      font-size: 12px;
      color: #334155;
      line-height: 1.6;
    }

    .outer-footer {
      text-align: center;
      padding-top: 28px;
    }
    .outer-footer span {
      font-size: 12px;
      color: #1e293b;
      font-weight: 500;
      letter-spacing: 0.5px;
    }

    @media only screen and (max-width: 600px) {
      .email-bg { padding: 24px 12px; }
      .header-strip { padding: 40px 28px 36px; }
      .security-banner { padding: 12px 24px; }
      .body-content { padding: 32px 24px 28px; }
      .email-footer { padding: 28px 24px 24px; }
      .brand-name { font-size: 26px; }
      .greeting-name { font-size: 22px; }
      .code-digit {
        width: 40px;
        height: 52px;
        font-size: 24px;
        line-height: 52px;
        border-radius: 8px;
      }
      .code-separator { height: 52px; line-height: 52px; }
      .code-digits { gap: 5px; }
      .code-body { padding: 32px 20px 28px; }
      .expiry-box { flex-direction: column; gap: 10px; }
    }
  </style>
</head>
<body>
<div class="email-bg">
  <div class="wrapper">

    <div class="top-wordmark">
      <span>G R A N A E V O</span>
    </div>

    <div class="main-card">

      <div class="header-strip">
        <div class="header-lines"></div>
        <div class="logo-wrap">
          <div class="logo-ring"></div>
          <img class="logo-img"
            src="https://www.granaevo.com/assets/icons/granaevo-logo.jpg"
            alt="GranaEvo">
        </div>
        <span class="brand-name">GranaEvo</span>
        <span class="header-tagline">Recuperação de Senha</span>
      </div>

      <div class="security-banner">
        <span>🔒 Solicitação autenticada · Comunicação oficial GranaEvo</span>
      </div>

      <div class="body-content">

        <span class="greeting-eyebrow">Verificação de identidade ✦</span>
        <div class="greeting-name">Olá, ${escapeHtml(subscription.user_name || 'Usuário')}! 👋</div>
        <p class="intro-text">
          Recebemos uma solicitação para <strong>redefinir a senha</strong> da sua conta GranaEvo.
          Use o código abaixo para concluir o processo.
        </p>

        <div class="divider"></div>

        <div class="code-showcase">
          <div class="code-showcase-top">
            <span class="cs-dot" style="background:#ef4444;"></span>
            <span class="cs-dot" style="background:#fbbf24;"></span>
            <span class="cs-dot" style="background:#10b981;"></span>
            <span class="cs-label">Código de uso único</span>
          </div>
          <div class="code-body">
            <span class="code-eyebrow">Seu código de verificação</span>
            <div class="code-digits">
              <span class="code-digit">${codeDigits[0]}</span>
              <span class="code-digit">${codeDigits[1]}</span>
              <span class="code-digit">${codeDigits[2]}</span>
              <span class="code-separator">·</span>
              <span class="code-digit">${codeDigits[3]}</span>
              <span class="code-digit">${codeDigits[4]}</span>
              <span class="code-digit">${codeDigits[5]}</span>
            </div>
            <div class="code-hint">Digite este código na página de recuperação</div>
          </div>
        </div>

        <div class="expiry-box">
          <div class="expiry-icon">⏱</div>
          <div class="expiry-content">
            <div class="expiry-title">Este código expira em 30 minutos</div>
            <div class="expiry-text">
              Válido até <span class="expiry-time">${expiresFormatted}</span>.
              Após este horário, solicite um novo código na tela de login.
            </div>
          </div>
        </div>

        <div class="not-you-box">
          <div class="not-you-text">
            Não solicitou esta redefinição? <strong>Ignore este email com segurança.</strong>
            Sua senha permanece inalterada e nenhuma ação é necessária.
          </div>
        </div>

        <div class="divider"></div>

        <div class="security-header">🛡 Dicas de segurança</div>

        <div class="tip-row">
          <div class="tip-check">✓</div>
          <div class="tip-text">Nunca compartilhe este código com ninguém — nem com nossa equipe de suporte</div>
        </div>
        <div class="tip-row">
          <div class="tip-check">✓</div>
          <div class="tip-text">O GranaEvo jamais solicita seu código por telefone ou mensagem</div>
        </div>
        <div class="tip-row">
          <div class="tip-check">✓</div>
          <div class="tip-text">Use uma senha forte: mínimo 8 caracteres com letras, números e símbolos</div>
        </div>
        <div class="tip-row">
          <div class="tip-check">✓</div>
          <div class="tip-text">Evite usar a mesma senha em outros serviços ou aplicativos</div>
        </div>

      </div>

      <div class="email-footer">
        <div class="footer-brand">GranaEvo</div>
        <div class="footer-links">
          <a href="https://granaevo.com" class="footer-link">Plataforma</a>
          <span class="footer-sep">·</span>
          <a href="https://granaevo.com/ajuda" class="footer-link">Ajuda</a>
          <span class="footer-sep">·</span>
          <a href="mailto:suporte@granaevo.com" class="footer-link">Suporte</a>
        </div>
        <div class="footer-divider-line"></div>
        <div class="footer-copy">
          © 2026 GranaEvo. Todos os direitos reservados.<br>
          Este email foi enviado para ${escapeHtml(normalizedEmail)} por solicitação de recuperação de senha.
        </div>
      </div>

    </div>

    <div class="outer-footer">
      <span>Sua segurança é nossa prioridade · granaevo.vercel.app</span>
    </div>

  </div>
</div>
</body>
</html>`,
      }),
    })

    if (!emailResponse.ok) {
      const errorData = await emailResponse.json()
      console.error('[send-reset-code] Erro Resend:', errorData)
      return new Response(
        JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    console.log('[send-reset-code] Email enviado com sucesso')

    return new Response(
      JSON.stringify({
        status:     'sent',
        message:    'Código enviado para seu email',
        expires_in: '30 minutos',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    // [SEC-FIX-LEAK] Catch genérico — não vaza detalhes do erro interno
    console.error('[send-reset-code] Erro não tratado:', error)
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})