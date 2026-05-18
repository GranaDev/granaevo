// supabase/functions/send-access-revoked-email/index.ts
// Notifica convidado que seu acesso à conta GranaEvo foi encerrado pelo dono.
// Chamada server-to-server (webhook-stripe). Requer proxy secret. Sem CORS de browser.

const corsHeaders = { 'Content-Type': 'application/json' }

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function isValidEmail(email: string): boolean {
  return /^[^\x00-\x1F\x7F\s@]{1,64}@[^\x00-\x1F\x7F\s@]+\.[^\x00-\x1F\x7F\s@]{2,}$/.test(email)
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB = enc.encode(a), bB = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

// Rate limit in-memory: máx 2 emails por destinatário em 10 min
const _rl = new Map<string, { count: number; windowStart: number }>()
function checkRL(email: string): boolean {
  const now = Date.now()
  const rec = _rl.get(email)
  if (!rec || now - rec.windowStart > 600_000) { _rl.set(email, { count: 1, windowStart: now }); return true }
  if (rec.count >= 2) return false
  rec.count++; return true
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#060810; font-family:'Outfit',-apple-system,sans-serif; color:#e2e8f0; -webkit-font-smoothing:antialiased; margin:0; padding:0; width:100% !important; }
  .email-bg { background:#060810; padding:48px 16px; width:100%; }
  .wrapper { max-width:620px; margin:0 auto; }
  .top-wordmark { text-align:center; padding-bottom:28px; }
  .top-wordmark span { font-size:13px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:#10b981; opacity:.7; }
  .hero-card { background:linear-gradient(160deg,#0d1117 0%,#111827 60%,#0a0f1a 100%); border:1px solid rgba(16,185,129,.18); border-radius:24px; overflow:hidden; box-shadow:0 32px 64px rgba(0,0,0,.7); }
  .header-strip { position:relative; padding:48px 48px 40px; text-align:center; background:linear-gradient(135deg,#1c1409 0%,#292008 40%,#1a1508 100%); overflow:hidden; }
  .header-strip::before { content:''; position:absolute; top:-80px; left:-80px; width:260px; height:260px; background:radial-gradient(circle,rgba(255,255,255,.05) 0%,transparent 70%); border-radius:50%; }
  .header-lines { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px); background-size:32px 32px; }
  .logo-wrap { position:relative; display:inline-block; margin-bottom:20px; z-index:2; }
  .logo-ring { position:absolute; inset:-6px; border-radius:22px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); }
  .logo-img { position:relative; width:72px; height:72px; border-radius:16px; display:block; object-fit:contain; background:#fff; }
  .brand-name { position:relative; z-index:2; font-size:28px; font-weight:900; color:#fff; letter-spacing:-.5px; display:block; margin-bottom:8px; }
  .header-tagline { position:relative; z-index:2; font-size:13px; color:rgba(255,255,255,.6); font-weight:500; }
  .status-banner { display:flex; align-items:center; gap:12px; margin:28px 48px 0; padding:14px 22px; background:rgba(239,68,68,.08); border:1px solid rgba(239,68,68,.25); border-radius:12px; }
  .status-banner-icon { font-size:22px; }
  .status-banner-text { font-size:17px; font-weight:700; color:#fca5a5; }
  .body-content { padding:36px 48px 40px; }
  .greeting-eyebrow { display:inline-block; font-size:11px; font-weight:700; letter-spacing:2.5px; text-transform:uppercase; color:#6b7280; margin-bottom:10px; }
  .greeting-name { font-size:26px; font-weight:800; color:#f1f5f9; line-height:1.25; margin-bottom:14px; letter-spacing:-.3px; }
  .greeting-text { font-size:15px; line-height:1.75; color:#94a3b8; margin-bottom:24px; }
  .greeting-text strong { color:#e2e8f0; font-weight:600; }
  .divider { height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent); margin:28px 0; }
  .info-box { display:flex; gap:16px; padding:20px 24px; border-radius:14px; margin:20px 0; }
  .info-amber { background:rgba(245,158,11,.06); border:1px solid rgba(245,158,11,.2); }
  .info-green { background:rgba(16,185,129,.06); border:1px solid rgba(16,185,129,.18); }
  .ib-icon { font-size:22px; flex-shrink:0; margin-top:2px; }
  .ib-body { flex:1; }
  .ib-title { font-size:14px; font-weight:700; color:#e2e8f0; margin-bottom:6px; }
  .ib-text { font-size:13px; line-height:1.65; color:#94a3b8; }
  .ib-text strong { color:#e2e8f0; font-weight:600; }
  .detail-row { display:flex; align-items:center; justify-content:space-between; padding:13px 16px; border-radius:10px; margin:8px 0; background:rgba(255,255,255,.025); border:1px solid rgba(255,255,255,.05); }
  .dr-label { font-size:13px; color:#64748b; font-weight:500; }
  .dr-value { font-size:14px; font-weight:700; color:#e2e8f0; }
  .cta-section { text-align:center; margin:32px 0 8px; }
  .cta-btn { display:inline-block; background:linear-gradient(135deg,#10b981 0%,#059669 100%); color:#fff !important; text-decoration:none; padding:15px 44px; border-radius:12px; font-weight:700; font-size:15px; box-shadow:0 8px 24px rgba(16,185,129,.3); }
  .email-footer { padding:32px 48px 28px; border-top:1px solid rgba(255,255,255,.05); background:rgba(0,0,0,.2); text-align:center; }
  .footer-brand { font-size:18px; font-weight:900; color:#10b981; letter-spacing:-.3px; margin-bottom:12px; }
  .footer-links { margin-bottom:16px; }
  .footer-link { display:inline-block; color:#475569 !important; text-decoration:none; font-size:13px; font-weight:500; padding:0 12px; }
  .footer-sep { color:#1e293b; font-size:13px; }
  .footer-divider-line { width:48px; height:1px; background:linear-gradient(90deg,transparent,rgba(16,185,129,.4),transparent); margin:16px auto; }
  .footer-copy { font-size:12px; color:#334155; line-height:1.6; }
  .outer-footer { text-align:center; padding-top:24px; }
  .outer-footer span { font-size:12px; color:#1e293b; font-weight:500; }
  @media only screen and (max-width:600px) {
    .email-bg { padding:24px 12px; }
    .header-strip { padding:36px 24px 28px; }
    .body-content { padding:28px 24px 24px; }
    .email-footer { padding:24px 20px; }
    .status-banner { margin:20px 24px 0; }
    .brand-name { font-size:22px; }
    .greeting-name { font-size:20px; }
  }
`

function buildHtml(safeName: string, ownerEmail: string, reason: 'downgrade' | 'removed'): string {
  const safeOwner  = escapeHtml(ownerEmail)
  const reasonText = reason === 'downgrade'
    ? `O proprietário da conta realizou um <strong>downgrade de plano</strong>, reduzindo o número de acessos disponíveis. Por isso, sua conta de convidado foi desativada automaticamente.`
    : `O proprietário da conta <strong>removeu seu acesso</strong> manualmente.`

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Acesso encerrado — GranaEvo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
<div class="email-bg"><div class="wrapper">
  <div class="top-wordmark"><span>G R A N A E V O</span></div>
  <div class="hero-card">
    <div class="header-strip">
      <div class="header-lines"></div>
      <div class="logo-wrap">
        <div class="logo-ring"></div>
        <img class="logo-img" src="https://www.granaevo.com/assets/icons/granaevo-logo.jpg" alt="GranaEvo">
      </div>
      <span class="brand-name">GranaEvo</span>
      <span class="header-tagline">Gerenciamento de acesso</span>
    </div>

    <div class="status-banner">
      <span class="status-banner-icon">🔒</span>
      <span class="status-banner-text">Seu acesso foi encerrado</span>
    </div>

    <div class="body-content">
      <span class="greeting-eyebrow">Notificação de acesso</span>
      <div class="greeting-name">Olá, ${safeName}!</div>
      <p class="greeting-text">
        ${reasonText}<br><br>
        Seus dados pessoais <strong>não foram excluídos</strong> — eles ficam protegidos por até 90 dias
        caso o proprietário reative seu acesso ou você adquira seu próprio plano.
      </p>

      <div class="detail-row">
        <span class="dr-label">Conta vinculada</span>
        <span class="dr-value">${safeOwner}</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">Status do acesso</span>
        <span class="dr-value" style="color:#f87171;">Encerrado</span>
      </div>

      <div class="info-box info-green">
        <div class="ib-icon">💡</div>
        <div class="ib-body">
          <div class="ib-title">Continue organizando suas finanças</div>
          <p class="ib-text">
            Adquira seu próprio plano GranaEvo e tenha controle total das suas finanças
            com dashboard completo, metas, relatórios e muito mais —
            a partir de <strong>R$&nbsp;19,99/mês</strong>.
          </p>
        </div>
      </div>

      <div class="info-box info-amber">
        <div class="ib-icon">🗄️</div>
        <div class="ib-body">
          <div class="ib-title">Seus dados estão seguros</div>
          <p class="ib-text">
            Caso o proprietário da conta reative seu acesso ou você adquira um plano dentro de
            <strong>90 dias</strong>, todos os seus dados serão restaurados automaticamente.
            Após esse prazo, os dados são excluídos permanentemente conforme a LGPD.
          </p>
        </div>
      </div>

      <div class="divider"></div>

      <div class="cta-section">
        <a href="https://granaevo.com/planos.html" class="cta-btn">Ver planos disponíveis →</a>
      </div>
    </div>

    <div class="email-footer">
      <div class="footer-brand">GranaEvo</div>
      <div class="footer-links">
        <a href="https://granaevo.com" class="footer-link">Plataforma</a>
        <span class="footer-sep">·</span>
        <a href="https://granaevo.com/planos.html" class="footer-link">Planos</a>
        <span class="footer-sep">·</span>
        <a href="mailto:suporte@granaevo.com" class="footer-link">Suporte</a>
      </div>
      <div class="footer-divider-line"></div>
      <div class="footer-copy">
        © 2026 GranaEvo. Todos os direitos reservados.<br>
        Você recebeu este email por ter sido convidado para uma conta GranaEvo.
      </div>
    </div>
  </div>
  <div class="outer-footer"><span>Evolua suas finanças com inteligência · granaevo.com</span></div>
</div></div>
</body></html>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })

  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[send-access-revoked-email] PROXY_SECRET não configurada')
    return new Response(JSON.stringify({ success: false, error: 'Configuração interna inválida.' }), { headers: corsHeaders, status: 500 })
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[send-access-revoked-email] Proxy secret inválido')
    return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), { headers: corsHeaders, status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ success: false, error: 'Body inválido' }), { headers: corsHeaders, status: 400 })
  }

  const rawEmail = typeof body.email      === 'string' ? body.email.toLowerCase().trim()     : ''
  const rawName  = typeof body.name       === 'string' ? body.name.trim()                     : ''
  const rawOwner = typeof body.ownerEmail === 'string' ? body.ownerEmail.toLowerCase().trim() : ''
  const rawReason = (body.reason === 'downgrade' || body.reason === 'removed') ? body.reason : 'removed'

  if (!rawEmail || !isValidEmail(rawEmail)) {
    console.warn('[send-access-revoked-email] Email do convidado inválido')
    return new Response(JSON.stringify({ success: false, error: 'Email inválido' }), { headers: corsHeaders, status: 400 })
  }

  if (!checkRL(rawEmail)) {
    console.warn(`[send-access-revoked-email] Rate limit: ${rawEmail.slice(0, 8)}***`)
    return new Response(JSON.stringify({ success: false, error: 'Rate limit atingido' }), { headers: corsHeaders, status: 429 })
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    console.error('[send-access-revoked-email] RESEND_API_KEY não configurada')
    return new Response(JSON.stringify({ success: false, error: 'Configuração de email incompleta' }), { headers: corsHeaders, status: 500 })
  }

  const safeName  = escapeHtml(rawName || rawEmail.split('@')[0])
  const ownerMask = rawOwner
    ? rawOwner.replace(/(?<=.{3}).+(?=@)/, '***')
    : 'proprietário da conta'

  const html = buildHtml(safeName, ownerMask, rawReason)

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'GranaEvo <noreply@granaevo.com>',
        to:      [rawEmail],
        subject: '🔒 Seu acesso ao GranaEvo foi encerrado',
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const text = await resp.text()
    if (!resp.ok) throw new Error(`Resend ${resp.status}: ${text}`)

    const result = JSON.parse(text)
    console.log(`[send-access-revoked-email] Enviado → ${rawEmail.slice(0, 8)}*** reason: ${rawReason} id: ${result.id}`)
    return new Response(JSON.stringify({ success: true, email_id: result.id }), { headers: corsHeaders, status: 200 })

  } catch (err) {
    console.error('[send-access-revoked-email] Erro:', (err as Error).message)
    return new Response(JSON.stringify({ success: false, error: 'Erro ao enviar email' }), { headers: corsHeaders, status: 500 })
  }
})
