// supabase/functions/send-cancellation-email/index.ts
// Envia email de confirmação de cancelamento ao usuário.
// Chamada server-to-server (webhook-stripe). Requer proxy secret.

const corsHeaders = { 'Content-Type': 'application/json' }

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function isValidEmail(email: string): boolean {
  return /^[^\x00-\x1F\x7F\s@]{1,64}@[^\x00-\x1F\x7F\s@]+\.[^\x00-\x1F\x7F\s@]{2,}$/.test(email)
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

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })

  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[send-cancellation-email] PROXY_SECRET não configurada')
    return new Response(JSON.stringify({ success: false, error: 'Configuração interna inválida.' }), { headers: corsHeaders, status: 500 })
  }
  const received = req.headers.get('x-proxy-secret') ?? ''
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn('[send-cancellation-email] Proxy secret inválido')
    return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), { headers: corsHeaders, status: 401 })
  }

  try {
    let body: {
      email?: unknown
      name?: unknown
      planName?: unknown
      periodEnd?: unknown
      periodStart?: unknown
      isScheduled?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Body inválido' }), { headers: corsHeaders, status: 400 })
    }

    const rawEmail     = typeof body.email     === 'string' ? body.email.toLowerCase().trim()  : ''
    const rawName      = typeof body.name      === 'string' ? body.name.trim()                  : ''
    const rawPlanName  = typeof body.planName  === 'string' ? body.planName.trim()              : 'Individual'
    const rawPeriodEnd = typeof body.periodEnd === 'string' ? body.periodEnd                    : ''
    const rawPeriodStart = typeof body.periodStart === 'string' ? body.periodStart              : ''
    const isScheduled  = body.isScheduled === true

    if (!rawEmail || !isValidEmail(rawEmail)) {
      console.warn('[send-cancellation-email] Email inválido:', rawEmail.slice(0, 30))
      return new Response(JSON.stringify({ success: false, error: 'Email inválido' }), { headers: corsHeaders, status: 400 })
    }

    const name     = rawName || rawEmail.split('@')[0]
    const planName = rawPlanName

    const safeName    = escapeHtml(name)
    const safePlan    = escapeHtml(planName)
    const periodEndFmt = rawPeriodEnd ? formatDate(rawPeriodEnd) : '—'

    // Verifica janela de 7 dias a partir do início do ciclo
    let isWithin7Days = false
    if (rawPeriodStart) {
      const start = new Date(rawPeriodStart).getTime()
      const now   = Date.now()
      isWithin7Days = (now - start) < 7 * 24 * 60 * 60 * 1000
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    if (!resendApiKey) throw new Error('RESEND_API_KEY não configurada')

    // ── Monta conteúdo do email conforme cenário ─────────────────────────────
    const subject = isScheduled
      ? 'Cancelamento agendado — GranaEvo'
      : 'Assinatura cancelada — GranaEvo'

    const headlineText = isScheduled
      ? 'Cancelamento Agendado'
      : 'Assinatura Cancelada'

    let infoBoxHtml = ''
    if (isScheduled) {
      infoBoxHtml = isWithin7Days
        ? `<div class="info-box info-orange">
             <div class="ib-icon">⚡</div>
             <div class="ib-body">
               <div class="ib-title">Dentro do período de reembolso</div>
               <p class="ib-text">Você está dentro dos primeiros 7 dias do ciclo. Se preferir ser reembolsado, entre em contato com nosso suporte em <a href="mailto:suporte@granaevo.com" class="ib-link">suporte@granaevo.com</a>.</p>
             </div>
           </div>`
        : `<div class="info-box info-green">
             <div class="ib-icon">✓</div>
             <div class="ib-body">
               <div class="ib-title">Acesso garantido até o fim do ciclo</div>
               <p class="ib-text">Sua assinatura foi agendada para cancelamento, mas você mantém acesso completo à plataforma até <strong>${periodEndFmt}</strong>. Nenhuma nova cobrança será realizada.</p>
             </div>
           </div>`
    } else {
      infoBoxHtml = isWithin7Days
        ? `<div class="info-box info-orange">
             <div class="ib-icon">💳</div>
             <div class="ib-body">
               <div class="ib-title">Reembolso em processamento</div>
               <p class="ib-text">Você está dentro dos primeiros 7 dias do ciclo. O reembolso será processado e creditado no seu cartão em até 5–10 dias úteis, dependendo da operadora.</p>
             </div>
           </div>`
        : `<div class="info-box info-green">
             <div class="ib-icon">✓</div>
             <div class="ib-body">
               <div class="ib-title">Acesso garantido até o fim do período</div>
               <p class="ib-text">Mesmo com o cancelamento, você mantém acesso completo à plataforma até <strong>${periodEndFmt}</strong>, conforme pago. Após essa data, o acesso será encerrado automaticamente.</p>
             </div>
           </div>`
    }

    const bodyText = isScheduled
      ? `Recebemos seu pedido de cancelamento do plano <strong>${safePlan}</strong>. O cancelamento está <strong>agendado</strong> para o fim do ciclo atual.`
      : `Seu plano <strong>${safePlan}</strong> foi cancelado conforme solicitado. Esperamos tê-lo(a) de volta em breve.`

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'GranaEvo <noreply@granaevo.com>',
        to:      [rawEmail],
        subject,
        html: `
<!DOCTYPE html>
<html lang="pt-BR" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${subject}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background-color: #060810;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
      margin: 0; padding: 0; width: 100% !important; min-width: 100%;
    }
    .email-bg { background-color: #060810; padding: 48px 16px; width: 100%; }
    .wrapper  { max-width: 620px; margin: 0 auto; }
    .top-wordmark { text-align: center; padding-bottom: 28px; }
    .top-wordmark span { font-size: 13px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; color: #10b981; opacity: 0.7; }

    .hero-card {
      background: linear-gradient(160deg, #0d1117 0%, #111827 60%, #0a0f1a 100%);
      border: 1px solid rgba(16, 185, 129, 0.18);
      border-radius: 24px; overflow: hidden;
      box-shadow: 0 0 0 1px rgba(16,185,129,0.06), 0 32px 64px rgba(0,0,0,0.7), 0 0 80px rgba(16,185,129,0.06) inset;
    }
    .header-strip {
      position: relative; padding: 48px 48px 40px; text-align: center;
      background: linear-gradient(135deg, #1a0a0a 0%, #2d1515 40%, #1e0e0e 100%); overflow: hidden;
    }
    .header-strip::before {
      content: ''; position: absolute; top: -80px; left: -80px;
      width: 260px; height: 260px;
      background: radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%); border-radius: 50%;
    }
    .header-strip::after {
      content: ''; position: absolute; bottom: -60px; right: -60px;
      width: 200px; height: 200px;
      background: radial-gradient(circle, rgba(239,68,68,0.1) 0%, transparent 70%); border-radius: 50%;
    }
    .header-lines {
      position: absolute; inset: 0;
      background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
      background-size: 32px 32px;
    }
    .logo-wrap { position: relative; display: inline-block; margin-bottom: 20px; z-index: 2; }
    .logo-ring { position: absolute; inset: -6px; border-radius: 22px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); }
    .logo-img  { position: relative; width: 72px; height: 72px; border-radius: 16px; display: block; object-fit: contain; background: #fff; }
    .brand-name { position: relative; z-index: 2; font-size: 28px; font-weight: 900; color: #ffffff; letter-spacing: -0.5px; display: block; margin-bottom: 8px; }
    .header-tagline { position: relative; z-index: 2; font-size: 13px; color: rgba(255,255,255,0.6); font-weight: 500; }

    .status-banner {
      display: flex; align-items: center; gap: 12px;
      margin: 0 48px 0; padding: 16px 24px;
      background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
      border-radius: 12px; margin-top: 32px;
    }
    .status-banner-icon { font-size: 22px; }
    .status-banner-text { font-size: 17px; font-weight: 700; color: #fca5a5; }

    .body-content { padding: 36px 48px 40px; }
    .greeting-eyebrow { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase; color: #6b7280; margin-bottom: 10px; }
    .greeting-name { font-size: 26px; font-weight: 800; color: #f1f5f9; line-height: 1.25; margin-bottom: 14px; letter-spacing: -0.3px; }
    .greeting-text { font-size: 15px; line-height: 1.75; color: #94a3b8; font-weight: 400; margin-bottom: 28px; }
    .greeting-text strong { color: #e2e8f0; font-weight: 600; }

    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent); margin: 28px 0; }

    /* Info boxes */
    .info-box { display: flex; gap: 16px; padding: 20px 24px; border-radius: 14px; margin: 24px 0; }
    .info-green { background: rgba(16,185,129,0.07); border: 1px solid rgba(16,185,129,0.2); }
    .info-orange { background: rgba(251,146,60,0.07); border: 1px solid rgba(251,146,60,0.2); }
    .ib-icon { font-size: 22px; flex-shrink: 0; margin-top: 2px; }
    .ib-body { flex: 1; }
    .ib-title { font-size: 14px; font-weight: 700; color: #e2e8f0; margin-bottom: 6px; }
    .ib-text  { font-size: 13px; line-height: 1.65; color: #94a3b8; }
    .ib-text strong { color: #e2e8f0; font-weight: 600; }
    .ib-link  { color: #10b981; text-decoration: none; }

    /* Plan badge */
    .plan-row { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; margin: 20px 0; }
    .plan-row-label { font-size: 13px; color: #64748b; font-weight: 500; }
    .plan-row-value { font-size: 15px; font-weight: 700; color: #e2e8f0; }
    .plan-row-end   { font-size: 13px; color: #f59e0b; font-weight: 600; }

    /* CTA */
    .cta-section { text-align: center; margin: 32px 0 8px; }
    .cta-btn { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff !important; text-decoration: none; padding: 14px 40px; border-radius: 10px; font-weight: 700; font-size: 15px; box-shadow: 0 8px 24px rgba(16,185,129,0.25), 0 2px 6px rgba(0,0,0,0.4); }

    /* Reactivation note */
    .reactivate-note { background: rgba(16,185,129,0.04); border: 1px solid rgba(16,185,129,0.12); border-radius: 10px; padding: 16px 20px; margin: 24px 0 0; }
    .rn-title { font-size: 13px; font-weight: 700; color: #10b981; margin-bottom: 6px; }
    .rn-text  { font-size: 13px; color: #64748b; line-height: 1.6; }

    /* Footer */
    .email-footer { padding: 32px 48px 28px; border-top: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.2); text-align: center; }
    .footer-brand { font-size: 18px; font-weight: 900; color: #10b981; letter-spacing: -0.3px; margin-bottom: 12px; }
    .footer-links { margin-bottom: 16px; }
    .footer-link  { display: inline-block; color: #475569 !important; text-decoration: none; font-size: 13px; font-weight: 500; padding: 0 12px; }
    .footer-sep   { color: #1e293b; font-size: 13px; }
    .footer-divider-line { width: 48px; height: 1px; background: linear-gradient(90deg, transparent, rgba(16,185,129,0.4), transparent); margin: 16px auto; }
    .footer-copy  { font-size: 12px; color: #334155; line-height: 1.6; }
    .outer-footer { text-align: center; padding-top: 24px; }
    .outer-footer span { font-size: 12px; color: #1e293b; font-weight: 500; }

    @media only screen and (max-width: 600px) {
      .email-bg { padding: 24px 12px; }
      .header-strip { padding: 36px 24px 28px; }
      .body-content { padding: 28px 24px 24px; }
      .email-footer { padding: 24px 20px; }
      .status-banner { margin: 0 24px; margin-top: 24px; }
      .brand-name { font-size: 22px; }
      .greeting-name { font-size: 20px; }
    }
  </style>
</head>
<body>
<div class="email-bg">
  <div class="wrapper">

    <div class="top-wordmark"><span>G R A N A E V O</span></div>

    <div class="hero-card">

      <!-- Header vermelho -->
      <div class="header-strip">
        <div class="header-lines"></div>
        <div class="logo-wrap">
          <div class="logo-ring"></div>
          <img class="logo-img" src="https://www.granaevo.com/assets/icons/granaevo-logo.jpg" alt="GranaEvo">
        </div>
        <span class="brand-name">GranaEvo</span>
        <span class="header-tagline">Gerenciamento de assinatura</span>
      </div>

      <!-- Banner de status -->
      <div class="status-banner">
        <span class="status-banner-icon">${isScheduled ? '📅' : '🔕'}</span>
        <span class="status-banner-text">${headlineText}</span>
      </div>

      <!-- Corpo -->
      <div class="body-content">
        <span class="greeting-eyebrow">Confirmação de cancelamento</span>
        <div class="greeting-name">Olá, ${safeName}!</div>
        <p class="greeting-text">${bodyText}</p>

        <!-- Linha de dados do plano -->
        <div class="plan-row">
          <span class="plan-row-label">Plano</span>
          <span class="plan-row-value">${safePlan}</span>
          ${rawPeriodEnd ? `<span class="plan-row-end">Acesso até ${periodEndFmt}</span>` : ''}
        </div>

        <!-- Caixa informativa (reembolso ou acesso garantido) -->
        ${infoBoxHtml}

        <div class="divider"></div>

        <!-- Nota de reativação -->
        <div class="reactivate-note">
          <div class="rn-title">Mudou de ideia?</div>
          <p class="rn-text">Você pode reassinar a qualquer momento em <a href="https://granaevo.com/planos.html" style="color:#10b981;text-decoration:none;">granaevo.com/planos.html</a> sem taxas extras ou penalidades. Seu histórico financeiro permanece salvo.</p>
        </div>

        <!-- CTA -->
        <div class="cta-section">
          <a href="https://granaevo.com/dashboard.html" class="cta-btn">Acessar o Dashboard →</a>
        </div>
      </div>

      <!-- Footer -->
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
          Você recebeu este email por ter uma assinatura ativa em granaevo.com
        </div>
      </div>

    </div>

    <div class="outer-footer"><span>Evolua suas finanças com inteligência · granaevo.com</span></div>
  </div>
</div>
</body>
</html>`,
      }),
    })

    const responseText = await emailResponse.text()
    if (!emailResponse.ok) throw new Error(`Erro Resend (${emailResponse.status}): ${responseText}`)

    const result = JSON.parse(responseText)
    console.log('[send-cancellation-email] Enviado para:', rawEmail, '| id:', result.id)
    return new Response(JSON.stringify({ success: true, email_id: result.id }), { headers: corsHeaders, status: 200 })

  } catch (error) {
    console.error('[send-cancellation-email] Erro:', error)
    return new Response(JSON.stringify({ success: false, error: 'Erro interno' }), { headers: corsHeaders, status: 500 })
  }
})
