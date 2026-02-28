import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, name, planName } = await req.json()

    if (!email || !name) {
      throw new Error('Email e nome são obrigatórios')
    }

    console.log('📧 Enviando email de boas-vindas para:', email)

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    
    if (!resendApiKey) {
      throw new Error('RESEND_API_KEY não configurada')
    }

    // Enviar email via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'GranaEvo <noreply@granaevo.com>',
        to: [email],
        subject: '🎉 Bem-vindo ao GranaEvo — Sua jornada começa agora',
        html: `
<!DOCTYPE html>
<html lang="pt-BR" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Bem-vindo ao GranaEvo</title>
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

    /* ── TOP WORDMARK ── */
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

    /* ── HERO CARD ── */
    .hero-card {
      background: linear-gradient(160deg, #0d1117 0%, #111827 60%, #0a0f1a 100%);
      border: 1px solid rgba(16, 185, 129, 0.18);
      border-radius: 24px;
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(16, 185, 129, 0.06),
        0 32px 64px rgba(0, 0, 0, 0.7),
        0 0 80px rgba(16, 185, 129, 0.06) inset;
    }

    /* ── HEADER STRIP ── */
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

    /* ── BODY CONTENT ── */
    .body-content {
      padding: 48px 48px 40px;
    }

    .greeting-block {
      margin-bottom: 32px;
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

    .greeting-text {
      font-size: 16px;
      line-height: 1.75;
      color: #94a3b8;
      font-weight: 400;
    }

    .greeting-text strong {
      color: #e2e8f0;
      font-weight: 600;
    }

    /* ── DIVIDER ── */
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(16,185,129,0.25), transparent);
      margin: 32px 0;
    }

    /* ── PLAN SHOWCASE ── */
    .plan-showcase {
      border-radius: 18px;
      overflow: hidden;
      margin: 32px 0;
      border: 1px solid rgba(16, 185, 129, 0.25);
    }

    .plan-showcase-header {
      background: linear-gradient(135deg, #064e35, #065f46);
      padding: 6px 20px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .ps-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .plan-showcase-body {
      background: rgba(16, 185, 129, 0.04);
      padding: 32px 36px;
      text-align: center;
      position: relative;
    }

    .plan-showcase-body::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at 50% 0%, rgba(16,185,129,0.08) 0%, transparent 70%);
      pointer-events: none;
    }

    .plan-label-text {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #6ee7b7;
      margin-bottom: 8px;
    }

    .plan-title {
      font-size: 38px;
      font-weight: 900;
      letter-spacing: -1px;
      background: linear-gradient(135deg, #10b981 0%, #34d399 50%, #6ee7b7 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 14px;
      line-height: 1;
    }

    .plan-badge-active {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 18px;
      background: rgba(16,185,129,0.15);
      border: 1px solid rgba(16,185,129,0.35);
      border-radius: 50px;
      font-size: 13px;
      font-weight: 600;
      color: #10b981;
    }

    .status-dot {
      width: 7px; height: 7px;
      background: #10b981;
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 6px #10b981;
    }

    /* ── CTA ── */
    .cta-section {
      text-align: center;
      margin: 36px 0;
    }

    .cta-sub {
      font-size: 14px;
      color: #64748b;
      margin-bottom: 18px;
      font-weight: 500;
    }

    .cta-btn {
      display: inline-block;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #ffffff !important;
      text-decoration: none;
      padding: 16px 44px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 16px;
      letter-spacing: 0.2px;
      box-shadow:
        0 8px 24px rgba(16, 185, 129, 0.35),
        0 2px 6px rgba(0, 0, 0, 0.4);
    }

    .cta-note {
      font-size: 12px;
      color: #475569;
      margin-top: 14px;
      font-weight: 500;
    }

    /* ── FEATURES SECTION ── */
    .features-header {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #475569;
      margin-bottom: 20px;
    }

    .feature-row {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 14px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }

    .feature-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .feature-icon-cell {
      width: 36px;
      height: 36px;
      min-width: 36px;
      background: rgba(16,185,129,0.1);
      border: 1px solid rgba(16,185,129,0.2);
      border-radius: 10px;
      text-align: center;
      line-height: 36px;
      font-size: 16px;
    }

    .feature-text-cell { flex: 1; }

    .feature-title {
      font-size: 14px;
      font-weight: 700;
      color: #e2e8f0;
      margin-bottom: 3px;
    }

    .feature-desc {
      font-size: 13px;
      color: #64748b;
      line-height: 1.5;
    }

    /* ── CREDENTIALS BOX ── */
    .credentials-box {
      margin-top: 32px;
      background: rgba(10, 11, 20, 0.5);
      border: 1px solid rgba(16, 185, 129, 0.15);
      border-left: 3px solid #10b981;
      border-radius: 12px;
      padding: 20px 24px;
    }

    .cred-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #10b981;
      margin-bottom: 10px;
    }

    .cred-text {
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.65;
    }

    .cred-email {
      display: inline-block;
      padding: 4px 12px;
      background: rgba(16,185,129,0.12);
      border: 1px solid rgba(16,185,129,0.25);
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      color: #6ee7b7;
      font-weight: 600;
      margin: 4px 0;
    }

    /* ── FOOTER ── */
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

    .footer-links {
      margin-bottom: 20px;
    }

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

    /* ── OUTER DECORATION ── */
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

    /* ── RESPONSIVE ── */
    @media only screen and (max-width: 600px) {
      .email-bg { padding: 24px 12px; }
      .header-strip { padding: 40px 28px 36px; }
      .body-content { padding: 32px 24px 28px; }
      .email-footer { padding: 28px 24px 24px; }
      .brand-name { font-size: 26px; }
      .greeting-name { font-size: 22px; }
      .plan-title { font-size: 30px; }
      .plan-showcase-body { padding: 28px 24px; }
      .cta-btn { padding: 15px 32px; font-size: 15px; }
    }
  </style>
</head>
<body>
<div class="email-bg">
  <div class="wrapper">

    <!-- Top wordmark -->
    <div class="top-wordmark">
      <span>G R A N A E V O</span>
    </div>

    <!-- Main card -->
    <div class="hero-card">

      <!-- Header -->
      <div class="header-strip">
        <div class="header-lines"></div>
        <div class="logo-wrap">
          <div class="logo-ring"></div>
          <img class="logo-img"
            src="https://raw.githubusercontent.com/GranaDev/granaevo/main/icon/granaevo-logo.jpg"
            alt="GranaEvo">
        </div>
        <span class="brand-name">GranaEvo</span>
        <span class="header-tagline">Domine suas finanças com inteligência</span>
      </div>

      <!-- Body -->
      <div class="body-content">

        <!-- Greeting -->
        <div class="greeting-block">
          <span class="greeting-eyebrow">Conta Ativada ✦</span>
          <div class="greeting-name">Olá, ${name}! 👋</div>
          <p class="greeting-text">
            Sua conta foi ativada com <strong>sucesso</strong> e o pagamento confirmado. 
            Bem-vindo(a) à comunidade GranaEvo — o lugar onde sua relação com o dinheiro muda de verdade.
          </p>
        </div>

        <div class="divider"></div>

        <!-- Plan showcase -->
        <div class="plan-showcase">
          <div class="plan-showcase-header">
            <span class="ps-dot" style="background:#ef4444;"></span>
            <span class="ps-dot" style="background:#fbbf24;"></span>
            <span class="ps-dot" style="background:#10b981;"></span>
          </div>
          <div class="plan-showcase-body">
            <div class="plan-label-text">Plano Ativo</div>
            <div class="plan-title">${planName || 'Individual'}</div>
            <div class="plan-badge-active">
              <span class="status-dot"></span>
              Acesso vitalício ativado
            </div>
          </div>
        </div>

        <!-- CTA -->
        <div class="cta-section">
          <div class="cta-sub">Clique abaixo para configurar sua senha e entrar na plataforma</div>
          <a href="https://granaevo.com/primeiroacesso" class="cta-btn">
            Cadastrar nova senha →
          </a>
          <div class="cta-note">Leva menos de 2 minutos ✓</div>
        </div>

        <div class="divider"></div>

        <!-- Features -->
        <div class="features-header">O que está liberado para você</div>

        <div class="feature-row">
          <div class="feature-icon-cell">📊</div>
          <div class="feature-text-cell">
            <div class="feature-title">Dashboard Financeiro Completo</div>
            <div class="feature-desc">Visão total de receitas, despesas, cartões e reservas em tempo real</div>
          </div>
        </div>

        <div class="feature-row">
          <div class="feature-icon-cell">💳</div>
          <div class="feature-text-cell">
            <div class="feature-title">Controle de Cartões</div>
            <div class="feature-desc">Nunca mais seja surpreendido pela fatura — acompanhe cada lançamento</div>
          </div>
        </div>

        <div class="feature-row">
          <div class="feature-icon-cell">🎯</div>
          <div class="feature-text-cell">
            <div class="feature-title">Metas &amp; Reservas</div>
            <div class="feature-desc">Defina objetivos e monitore seu progresso com gráficos intuitivos</div>
          </div>
        </div>

        <div class="feature-row">
          <div class="feature-icon-cell">📈</div>
          <div class="feature-text-cell">
            <div class="feature-title">Relatórios &amp; Análises</div>
            <div class="feature-desc">Insights automáticos sobre seus hábitos financeiros mês a mês</div>
          </div>
        </div>

        <div class="feature-row">
          <div class="feature-icon-cell">⚡</div>
          <div class="feature-text-cell">
            <div class="feature-title">Automação Inteligente</div>
            <div class="feature-desc">Configure contas fixas e deixe o sistema trabalhar por você</div>
          </div>
        </div>

        <div class="feature-row">
          <div class="feature-icon-cell">🔒</div>
          <div class="feature-text-cell">
            <div class="feature-title">Segurança Total</div>
            <div class="feature-desc">Dados criptografados — nunca compartilhados com terceiros</div>
          </div>
        </div>

        <!-- Credentials -->
        <div class="credentials-box">
          <div class="cred-label">🔑 Seu acesso</div>
          <div class="cred-text">
            Use o email abaixo para fazer login após configurar sua senha:<br><br>
            <span class="cred-email">${email}</span><br><br>
            Guarde este email — ele é seu identificador permanente na plataforma.
          </div>
        </div>

      </div><!-- /body-content -->

      <!-- Footer inside card -->
      <div class="email-footer">
        <div class="footer-brand">GranaEvo</div>
        <div class="footer-links">
          <a href="https://granaevo.vercel.app" class="footer-link">Plataforma</a>
          <span class="footer-sep">·</span>
          <a href="https://granaevo.vercel.app/ajuda" class="footer-link">Ajuda</a>
          <span class="footer-sep">·</span>
          <a href="mailto:suporte@granaevo.com" class="footer-link">Suporte</a>
        </div>
        <div class="footer-divider-line"></div>
        <div class="footer-copy">
          © 2026 GranaEvo. Todos os direitos reservados.<br>
          Você recebeu este email porque realizou uma compra em granaevo.vercel.app
        </div>
      </div>

    </div><!-- /hero-card -->

    <!-- Outer footer -->
    <div class="outer-footer">
      <span>Evolua suas finanças com inteligência · granaevo.vercel.app</span>
    </div>

  </div><!-- /wrapper -->
</div><!-- /email-bg -->
</body>
</html>
        `,
      }),
    })

    const responseText = await emailResponse.text()
    console.log('📩 Resposta da Resend:', responseText)

    if (!emailResponse.ok) {
      throw new Error(`Erro Resend (${emailResponse.status}): ${responseText}`)
    }

    const result = JSON.parse(responseText)
    console.log('✅ Email enviado com sucesso:', result)

    return new Response(
      JSON.stringify({ success: true, email_id: result.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})