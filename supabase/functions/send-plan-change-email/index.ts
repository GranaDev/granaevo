// supabase/functions/send-plan-change-email/index.ts
// Envia email transacional ao usuário após upgrade ou downgrade de plano.
// Chamada server-to-server (update-stripe-plan). Requer proxy secret.
// Nunca chamado diretamente pelo browser — sem CORS headers de origem.

const corsHeaders = { 'Content-Type': 'application/json' }

// ── Segurança ─────────────────────────────────────────────────────────────────

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

// Rate limit in-memory: máx 3 emails por endereço por 10 minutos
// Protege contra loop (ex: bug no update-stripe-plan que chama em loop)
const _rl = new Map<string, { count: number; windowStart: number }>()
function checkEmailRateLimit(email: string): boolean {
  const now = Date.now()
  const rec = _rl.get(email)
  if (!rec || now - rec.windowStart > 600_000) {
    _rl.set(email, { count: 1, windowStart: now })
    return true
  }
  if (rec.count >= 3) return false
  rec.count++
  return true
}

// Whitelist de nomes de plano — nunca interpola string arbitrária no HTML
const PLAN_LABEL: Record<string, string> = {
  individual: 'Individual',
  casal:      'Casal',
  familia:    'Família',
}
const PLAN_LIMITS: Record<string, number> = {
  individual: 1,
  casal:      2,
  familia:    4,
}
const GUEST_LIMITS: Record<string, number> = {
  individual: 0,
  casal:      1,
  familia:    3,
}

function safeLabel(slug: string): string {
  return PLAN_LABEL[slug.toLowerCase().trim()] ?? '—'
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: 2,
  }).format(cents / 100)
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

// ── HTML compartilhado ────────────────────────────────────────────────────────

const CSS_BASE = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background-color: #060810;
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #e2e8f0; -webkit-font-smoothing: antialiased;
    margin: 0; padding: 0; width: 100% !important; min-width: 100%;
  }
  .email-bg { background-color: #060810; padding: 48px 16px; width: 100%; }
  .wrapper  { max-width: 620px; margin: 0 auto; }
  .top-wordmark { text-align: center; padding-bottom: 28px; }
  .top-wordmark span { font-size: 13px; font-weight: 600; letter-spacing: 3px; text-transform: uppercase; color: #10b981; opacity: 0.7; }
  .hero-card {
    background: linear-gradient(160deg, #0d1117 0%, #111827 60%, #0a0f1a 100%);
    border: 1px solid rgba(16,185,129,0.18); border-radius: 24px; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(16,185,129,0.06), 0 32px 64px rgba(0,0,0,0.7), 0 0 80px rgba(16,185,129,0.06) inset;
  }
  .header-strip {
    position: relative; text-align: center; overflow: hidden;
    padding: 48px 48px 40px;
  }
  .header-strip::before {
    content: ''; position: absolute; top: -80px; left: -80px;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(255,255,255,0.07) 0%, transparent 70%); border-radius: 50%;
  }
  .header-lines {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  .logo-wrap { position: relative; display: inline-block; margin-bottom: 20px; z-index: 2; }
  .logo-ring { position: absolute; inset: -6px; border-radius: 22px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); }
  .logo-img  { position: relative; width: 72px; height: 72px; border-radius: 16px; display: block; object-fit: contain; background: #fff; }
  .brand-name { position: relative; z-index: 2; font-size: 28px; font-weight: 900; color: #fff; letter-spacing: -0.5px; display: block; margin-bottom: 8px; }
  .header-tagline { position: relative; z-index: 2; font-size: 13px; color: rgba(255,255,255,0.7); font-weight: 500; }
  .status-banner {
    display: flex; align-items: center; gap: 12px;
    margin: 28px 48px 0; padding: 14px 22px;
    border-radius: 12px;
  }
  .status-banner-icon { font-size: 22px; }
  .status-banner-text { font-size: 17px; font-weight: 700; }
  .body-content { padding: 36px 48px 40px; }
  .greeting-eyebrow { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase; margin-bottom: 10px; }
  .greeting-name { font-size: 26px; font-weight: 800; color: #f1f5f9; line-height: 1.25; margin-bottom: 14px; letter-spacing: -0.3px; }
  .greeting-text { font-size: 15px; line-height: 1.75; color: #94a3b8; margin-bottom: 8px; }
  .greeting-text strong { color: #e2e8f0; font-weight: 600; }
  .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent); margin: 28px 0; }

  /* Comparativo de planos */
  .plan-compare {
    display: flex; align-items: center; gap: 0;
    border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; overflow: hidden;
    margin: 28px 0;
  }
  .plan-col {
    flex: 1; padding: 24px 20px; text-align: center;
  }
  .plan-col--old { background: rgba(255,255,255,0.02); }
  .plan-col--new { background: rgba(16,185,129,0.06); border-left: 1px solid rgba(255,255,255,0.06); }
  .plan-col--new-amber { background: rgba(245,158,11,0.06); border-left: 1px solid rgba(255,255,255,0.06); }
  .plan-col-arrow {
    padding: 0 8px; font-size: 20px; color: #475569; flex-shrink: 0;
  }
  .plan-col-label { font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #64748b; margin-bottom: 8px; }
  .plan-col-name  { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }
  .plan-col-name--old  { color: #94a3b8; }
  .plan-col-name--new  { color: #10b981; }
  .plan-col-name--amber { color: #f59e0b; }
  .plan-col-price { font-size: 13px; color: #64748b; margin-top: 4px; }

  /* Linha de detalhe */
  .detail-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 16px; border-radius: 10px; margin: 8px 0;
    background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.05);
  }
  .dr-label { font-size: 13px; color: #64748b; font-weight: 500; }
  .dr-value { font-size: 14px; font-weight: 700; }
  .dr-green  { color: #10b981; }
  .dr-amber  { color: #f59e0b; }
  .dr-blue   { color: #60a5fa; }
  .dr-normal { color: #e2e8f0; }

  /* Lista de itens removidos */
  .removed-list { margin: 16px 0; }
  .removed-item {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-radius: 8px; margin: 6px 0;
    background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.15);
  }
  .ri-dot  { width: 6px; height: 6px; border-radius: 50%; background: #ef4444; flex-shrink: 0; }
  .ri-text { font-size: 13px; color: #94a3b8; }
  .ri-text strong { color: #fca5a5; font-weight: 600; }

  /* Caixa de benefícios */
  .benefit-box {
    background: rgba(16,185,129,0.05); border: 1px solid rgba(16,185,129,0.18);
    border-radius: 14px; padding: 24px 24px; margin: 24px 0;
  }
  .bb-title { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #10b981; margin-bottom: 16px; }
  .bb-row { display: flex; align-items: flex-start; gap: 14px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .bb-row:last-child { border-bottom: none; padding-bottom: 0; }
  .bb-icon { font-size: 18px; flex-shrink: 0; width: 32px; text-align: center; }
  .bb-body { flex: 1; }
  .bb-name { font-size: 13px; font-weight: 700; color: #e2e8f0; margin-bottom: 2px; }
  .bb-desc { font-size: 12px; color: #64748b; line-height: 1.5; }

  /* Backup notice */
  .backup-notice {
    background: rgba(96,165,250,0.06); border: 1px solid rgba(96,165,250,0.18);
    border-left: 3px solid #60a5fa; border-radius: 10px; padding: 16px 20px; margin: 20px 0;
  }
  .bn-title { font-size: 12px; font-weight: 700; color: #60a5fa; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 6px; }
  .bn-text  { font-size: 13px; color: #94a3b8; line-height: 1.65; }
  .bn-text strong { color: #bfdbfe; font-weight: 600; }

  /* CTA */
  .cta-section { text-align: center; margin: 32px 0 8px; }
  .cta-btn { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff !important; text-decoration: none; padding: 15px 44px; border-radius: 12px; font-weight: 700; font-size: 15px; box-shadow: 0 8px 24px rgba(16,185,129,0.3), 0 2px 6px rgba(0,0,0,0.4); }

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
    .status-banner { margin: 20px 24px 0; }
    .brand-name { font-size: 22px; }
    .greeting-name { font-size: 20px; }
    .plan-compare { flex-direction: column; }
    .plan-col-arrow { transform: rotate(90deg); padding: 8px 0; }
  }
`

const HEADER_HTML = (tagline: string) => `
  <div class="top-wordmark"><span>G R A N A E V O</span></div>
  <div class="hero-card">
    <div class="header-strip">
      <div class="header-lines"></div>
      <div class="logo-wrap">
        <div class="logo-ring"></div>
        <img class="logo-img" src="https://www.granaevo.com/assets/icons/granaevo-logo.jpg" alt="GranaEvo">
      </div>
      <span class="brand-name">GranaEvo</span>
      <span class="header-tagline">${tagline}</span>
    </div>`

const FOOTER_HTML = `
      <div class="email-footer">
        <div class="footer-brand">GranaEvo</div>
        <div class="footer-links">
          <a href="https://granaevo.com" class="footer-link">Plataforma</a>
          <span class="footer-sep">·</span>
          <a href="https://granaevo.com/atualizarplano.html" class="footer-link">Meu Plano</a>
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
</html>`

// ── Templates ─────────────────────────────────────────────────────────────────

function buildUpgradeEmail(params: {
  safeName:        string
  oldPlan:         string
  newPlan:         string
  amountDue:       number
  newMonthlyAmount: number
  newProfileLimit:  number
  newGuestLimit:    number
  profilesRestored: number
  currency:         string
}): string {
  const {
    safeName, oldPlan, newPlan, amountDue, newMonthlyAmount,
    newProfileLimit, newGuestLimit, profilesRestored, currency,
  } = params

  const oldLabel = safeLabel(oldPlan)
  const newLabel = safeLabel(newPlan)
  const charged  = formatMoney(amountDue)
  const monthly  = formatMoney(newMonthlyAmount)

  const restoredNote = profilesRestored > 0
    ? `<div class="backup-notice">
         <div class="bn-title">📂 Perfis restaurados automaticamente</div>
         <p class="bn-text"><strong>${profilesRestored} perfil${profilesRestored > 1 ? 's' : ''}</strong>
         que estava${profilesRestored > 1 ? 'm' : ''} em backup foram restaurado${profilesRestored > 1 ? 's' : ''}
         automaticamente. Todos os seus dados estão disponíveis novamente.</p>
       </div>`
    : ''

  const guestBenefit = newGuestLimit > 0
    ? `<div class="bb-row">
         <div class="bb-icon">👥</div>
         <div class="bb-body">
           <div class="bb-name">${newGuestLimit} Convidado${newGuestLimit > 1 ? 's' : ''}</div>
           <div class="bb-desc">Compartilhe acesso com ${newGuestLimit} pessoa${newGuestLimit > 1 ? 's' : ''} via convite por email</div>
         </div>
       </div>`
    : ''

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Upgrade realizado — GranaEvo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>${CSS_BASE}
    .header-strip { background: linear-gradient(135deg, #064e35 0%, #065f46 40%, #047857 100%); }
    .status-banner { background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25); }
    .status-banner-text { color: #6ee7b7; }
    .greeting-eyebrow { color: #10b981; }
  </style>
</head>
<body>
<div class="email-bg">
  <div class="wrapper">
    ${HEADER_HTML('Gerenciamento de assinatura')}

    <div class="status-banner">
      <span class="status-banner-icon">🚀</span>
      <span class="status-banner-text">Upgrade realizado com sucesso!</span>
    </div>

    <div class="body-content">
      <span class="greeting-eyebrow">Confirmação de Upgrade ✦</span>
      <div class="greeting-name">Parabéns, ${safeName}! 🎉</div>
      <p class="greeting-text">
        Seu plano foi atualizado para o <strong>${escapeHtml(newLabel)}</strong>.
        A diferença proporcional pelo período restante do ciclo atual foi cobrada imediatamente.
      </p>

      <!-- Comparativo de planos -->
      <div class="plan-compare">
        <div class="plan-col plan-col--old">
          <div class="plan-col-label">Plano Anterior</div>
          <div class="plan-col-name plan-col-name--old">${escapeHtml(oldLabel)}</div>
        </div>
        <div class="plan-col-arrow">→</div>
        <div class="plan-col plan-col--new">
          <div class="plan-col-label">Novo Plano</div>
          <div class="plan-col-name plan-col-name--new">${escapeHtml(newLabel)}</div>
          <div class="plan-col-price">${escapeHtml(monthly)}/mês</div>
        </div>
      </div>

      <!-- Detalhes da cobrança -->
      <div class="detail-row">
        <span class="dr-label">💳 Cobrado agora (proporcional)</span>
        <span class="dr-value dr-green">${escapeHtml(charged)}</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">📅 Novo valor mensal a partir da próxima renovação</span>
        <span class="dr-value dr-normal">${escapeHtml(monthly)}</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">👤 Perfis de usuário disponíveis</span>
        <span class="dr-value dr-green">${newProfileLimit} perfil${newProfileLimit > 1 ? 's' : ''}</span>
      </div>

      ${restoredNote}

      <div class="divider"></div>

      <!-- Benefícios do novo plano -->
      <div class="benefit-box">
        <div class="bb-title">O que está liberado no plano ${escapeHtml(newLabel)}</div>
        <div class="bb-row">
          <div class="bb-icon">👤</div>
          <div class="bb-body">
            <div class="bb-name">${newProfileLimit} Perfil${newProfileLimit > 1 ? 's' : ''} de Usuário</div>
            <div class="bb-desc">Crie e gerencie até ${newProfileLimit} perfil${newProfileLimit > 1 ? 's' : ''} com dashboards financeiros individuais</div>
          </div>
        </div>
        ${guestBenefit}
        <div class="bb-row">
          <div class="bb-icon">📊</div>
          <div class="bb-body">
            <div class="bb-name">Dashboard Financeiro Completo</div>
            <div class="bb-desc">Receitas, despesas, cartões, metas e relatórios em tempo real</div>
          </div>
        </div>
        <div class="bb-row">
          <div class="bb-icon">🎯</div>
          <div class="bb-body">
            <div class="bb-name">Metas &amp; Reservas</div>
            <div class="bb-desc">Defina objetivos e monitore progresso com gráficos intuitivos</div>
          </div>
        </div>
        <div class="bb-row">
          <div class="bb-icon">🔒</div>
          <div class="bb-body">
            <div class="bb-name">Segurança Total</div>
            <div class="bb-desc">Dados criptografados — nunca compartilhados com terceiros</div>
          </div>
        </div>
      </div>

      <div class="cta-section">
        <a href="https://granaevo.com/dashboard.html" class="cta-btn">Acessar o Dashboard →</a>
      </div>
    </div>

    ${FOOTER_HTML}`
}

function buildDowngradeEmail(params: {
  safeName:         string
  oldPlan:          string
  newPlan:          string
  effectiveAt:      string
  newMonthlyAmount: number
  newProfileLimit:  number
  newGuestLimit:    number
  profilesRemoved:  string[]
  membersRemoved:   string[]
  currency:         string
}): string {
  const {
    safeName, oldPlan, newPlan, effectiveAt, newMonthlyAmount,
    newProfileLimit, newGuestLimit, profilesRemoved, membersRemoved,
  } = params

  const oldLabel    = safeLabel(oldPlan)
  const newLabel    = safeLabel(newPlan)
  const monthly     = formatMoney(newMonthlyAmount)
  const effectiveFmt = formatDate(effectiveAt)

  const totalRemoved = profilesRemoved.length + membersRemoved.length
  const hasRemovals  = totalRemoved > 0

  const profilesRemovedHtml = profilesRemoved.length > 0
    ? profilesRemoved.map(name =>
        `<div class="removed-item">
           <div class="ri-dot"></div>
           <div class="ri-text">Perfil <strong>${escapeHtml(name)}</strong> — desativado em ${escapeHtml(effectiveFmt)}</div>
         </div>`
      ).join('')
    : ''

  const membersRemovedHtml = membersRemoved.length > 0
    ? membersRemoved.map(email =>
        `<div class="removed-item">
           <div class="ri-dot"></div>
           <div class="ri-text">Convidado <strong>${escapeHtml(email)}</strong> — acesso removido em ${escapeHtml(effectiveFmt)}</div>
         </div>`
      ).join('')
    : ''

  const removalsSection = hasRemovals
    ? `<div class="divider"></div>
       <span class="greeting-eyebrow" style="color:#f59e0b;">Itens que serão removidos</span>
       <div class="removed-list" style="margin-top:14px;">
         ${profilesRemovedHtml}
         ${membersRemovedHtml}
       </div>
       <div class="backup-notice" style="margin-top:16px;">
         <div class="bn-title">🔒 Seus dados estão protegidos — Backup de 90 dias</div>
         <p class="bn-text">
           Os perfis listados acima serão <strong>desativados</strong> — não excluídos imediatamente.
           Todos os dados ficam em backup por <strong>90 dias</strong> a partir de ${escapeHtml(effectiveFmt)}.
           Se você retornar ao plano <strong>${escapeHtml(oldLabel)}</strong> ou superior dentro desse período,
           os perfis são <strong>restaurados automaticamente</strong>, sem nenhuma ação sua.
           Após 90 dias, os dados são excluídos permanentemente conforme a LGPD.
         </p>
       </div>`
    : ''

  const guestInfo = newGuestLimit > 0
    ? `<div class="detail-row">
         <span class="dr-label">👥 Convidados permitidos</span>
         <span class="dr-value dr-normal">${newGuestLimit} convidado${newGuestLimit > 1 ? 's' : ''}</span>
       </div>`
    : `<div class="detail-row">
         <span class="dr-label">👥 Convidados permitidos</span>
         <span class="dr-value dr-amber">Nenhum (plano individual)</span>
       </div>`

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Downgrade agendado — GranaEvo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>${CSS_BASE}
    .header-strip { background: linear-gradient(135deg, #1c1409 0%, #292008 40%, #1a1508 100%); }
    .status-banner { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25); }
    .status-banner-text { color: #fcd34d; }
    .greeting-eyebrow { color: #f59e0b; }
  </style>
</head>
<body>
<div class="email-bg">
  <div class="wrapper">
    ${HEADER_HTML('Gerenciamento de assinatura')}

    <div class="status-banner">
      <span class="status-banner-icon">📅</span>
      <span class="status-banner-text">Downgrade agendado para ${escapeHtml(effectiveFmt)}</span>
    </div>

    <div class="body-content">
      <span class="greeting-eyebrow">Confirmação de Downgrade</span>
      <div class="greeting-name">Olá, ${safeName}!</div>
      <p class="greeting-text">
        Seu downgrade do plano <strong>${escapeHtml(oldLabel)}</strong> para o plano
        <strong>${escapeHtml(newLabel)}</strong> foi agendado com sucesso.
        Você mantém todos os benefícios do plano atual até a renovação em <strong>${escapeHtml(effectiveFmt)}</strong>.
        <strong>Nenhuma cobrança imediata foi realizada.</strong>
      </p>

      <!-- Comparativo de planos -->
      <div class="plan-compare">
        <div class="plan-col plan-col--old">
          <div class="plan-col-label">Plano Atual</div>
          <div class="plan-col-name plan-col-name--old">${escapeHtml(oldLabel)}</div>
          <div class="plan-col-price">Até ${escapeHtml(effectiveFmt)}</div>
        </div>
        <div class="plan-col-arrow">→</div>
        <div class="plan-col plan-col--new-amber">
          <div class="plan-col-label">Novo Plano em</div>
          <div class="plan-col-name plan-col-name--amber">${escapeHtml(newLabel)}</div>
          <div class="plan-col-price">${escapeHtml(monthly)}/mês</div>
        </div>
      </div>

      <!-- Detalhes -->
      <div class="detail-row">
        <span class="dr-label">💰 Cobrança imediata</span>
        <span class="dr-value dr-green">Nenhuma</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">📅 Novo plano entra em vigor em</span>
        <span class="dr-value dr-amber">${escapeHtml(effectiveFmt)}</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">💳 Novo valor mensal a partir de ${escapeHtml(effectiveFmt)}</span>
        <span class="dr-value dr-normal">${escapeHtml(monthly)}</span>
      </div>
      <div class="detail-row">
        <span class="dr-label">👤 Perfis de usuário no novo plano</span>
        <span class="dr-value dr-normal">${newProfileLimit} perfil${newProfileLimit > 1 ? 's' : ''}</span>
      </div>
      ${guestInfo}

      ${removalsSection}

      <div class="divider"></div>

      <!-- Nota de cancelamento do downgrade -->
      <div class="backup-notice" style="background:rgba(16,185,129,0.05);border-color:rgba(16,185,129,0.18);border-left-color:#10b981;">
        <div class="bn-title" style="color:#10b981;">💡 Mudou de ideia?</div>
        <p class="bn-text">
          Você pode cancelar este downgrade a qualquer momento antes de <strong>${escapeHtml(effectiveFmt)}</strong>
          diretamente no painel de gerenciamento do seu plano.
          Basta acessar <a href="https://granaevo.com/atualizarplano.html" style="color:#10b981;text-decoration:none;">granaevo.com/atualizarplano.html</a>
          e clicar em "Cancelar alteração agendada".
        </p>
      </div>

      <div class="cta-section">
        <a href="https://granaevo.com/atualizarplano.html" class="cta-btn">Gerenciar meu plano →</a>
      </div>
    </div>

    ${FOOTER_HTML}`
}

// ── Handler principal ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })

  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[send-plan-change-email] PROXY_SECRET não configurada')
    return new Response(JSON.stringify({ success: false, error: 'Configuração interna inválida.' }), { headers: corsHeaders, status: 500 })
  }
  const received = req.headers.get('x-proxy-secret') ?? ''
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn('[send-plan-change-email] Proxy secret inválido')
    return new Response(JSON.stringify({ success: false, error: 'Não autorizado.' }), { headers: corsHeaders, status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Body inválido' }), { headers: corsHeaders, status: 400 })
  }

  const rawEmail  = typeof body.email  === 'string' ? body.email.toLowerCase().trim()  : ''
  const rawName   = typeof body.name   === 'string' ? body.name.trim()                  : ''
  const rawAction = typeof body.action === 'string' ? body.action.toLowerCase().trim()  : ''

  if (!rawEmail || !isValidEmail(rawEmail)) {
    console.warn('[send-plan-change-email] Email inválido')
    return new Response(JSON.stringify({ success: false, error: 'Email inválido' }), { headers: corsHeaders, status: 400 })
  }

  if (rawAction !== 'upgrade' && rawAction !== 'downgrade') {
    return new Response(JSON.stringify({ success: false, error: 'action deve ser upgrade ou downgrade' }), { headers: corsHeaders, status: 400 })
  }

  // Rate limit: máx 3 emails por destinatário em 10 min
  if (!checkEmailRateLimit(rawEmail)) {
    console.warn(`[send-plan-change-email] Rate limit atingido para: ${rawEmail.slice(0, 8)}***`)
    return new Response(JSON.stringify({ success: false, error: 'Rate limit atingido' }), { headers: corsHeaders, status: 429 })
  }

  const rawOldPlan = typeof body.oldPlan === 'string' ? body.oldPlan.toLowerCase().trim() : ''
  const rawNewPlan = typeof body.newPlan === 'string' ? body.newPlan.toLowerCase().trim() : ''

  // Valida planos contra whitelist — nunca interpola slug desconhecido
  if (!PLAN_LABEL[rawOldPlan] || !PLAN_LABEL[rawNewPlan]) {
    console.warn('[send-plan-change-email] Plano inválido:', rawOldPlan, rawNewPlan)
    return new Response(JSON.stringify({ success: false, error: 'Plano inválido' }), { headers: corsHeaders, status: 400 })
  }

  const name            = escapeHtml(rawName || rawEmail.split('@')[0])
  const amountDue       = typeof body.amountDue       === 'number' ? Math.max(0, Math.round(body.amountDue))       : 0
  const newMonthlyAmount = typeof body.newMonthlyAmount === 'number' ? Math.max(0, Math.round(body.newMonthlyAmount)) : 0
  const newProfileLimit  = PLAN_LIMITS[rawNewPlan]  ?? 1
  const newGuestLimit    = GUEST_LIMITS[rawNewPlan] ?? 0
  const profilesRestored = typeof body.profilesRestored === 'number' ? Math.max(0, body.profilesRestored) : 0
  const currency         = typeof body.currency === 'string' ? body.currency : 'brl'
  const effectiveAt      = typeof body.effectiveAt === 'string' ? body.effectiveAt : ''

  // Listas de nomes/emails removidos — sanitizadas individualmente
  const rawProfilesRemoved = Array.isArray(body.profilesRemoved) ? body.profilesRemoved : []
  const rawMembersRemoved  = Array.isArray(body.membersRemoved)  ? body.membersRemoved  : []

  const profilesRemoved = rawProfilesRemoved
    .filter((x): x is string => typeof x === 'string')
    .slice(0, 10)
    .map(s => s.trim().slice(0, 120))

  const membersRemoved = rawMembersRemoved
    .filter((x): x is string => typeof x === 'string' && isValidEmail(x.trim()))
    .slice(0, 10)
    .map(s => s.trim().toLowerCase().slice(0, 254))

  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  if (!resendApiKey) {
    console.error('[send-plan-change-email] RESEND_API_KEY não configurada')
    return new Response(JSON.stringify({ success: false, error: 'Configuração de email incompleta' }), { headers: corsHeaders, status: 500 })
  }

  let subject: string
  let html: string

  if (rawAction === 'upgrade') {
    subject = `🚀 Upgrade para o plano ${safeLabel(rawNewPlan)} confirmado — GranaEvo`
    html = buildUpgradeEmail({
      safeName: name,
      oldPlan:  rawOldPlan,
      newPlan:  rawNewPlan,
      amountDue,
      newMonthlyAmount,
      newProfileLimit,
      newGuestLimit,
      profilesRestored,
      currency,
    })
  } else {
    subject = `📅 Downgrade para ${safeLabel(rawNewPlan)} agendado — GranaEvo`
    html = buildDowngradeEmail({
      safeName: name,
      oldPlan:  rawOldPlan,
      newPlan:  rawNewPlan,
      effectiveAt,
      newMonthlyAmount,
      newProfileLimit,
      newGuestLimit,
      profilesRemoved,
      membersRemoved,
      currency,
    })
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'GranaEvo <noreply@granaevo.com>',
        to:      [rawEmail],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const text = await resp.text()
    if (!resp.ok) throw new Error(`Resend ${resp.status}: ${text}`)

    const result = JSON.parse(text)
    console.log(`[send-plan-change-email] Enviado — action: ${rawAction} to: ${rawEmail.slice(0, 8)}*** id: ${result.id}`)
    return new Response(JSON.stringify({ success: true, email_id: result.id }), { headers: corsHeaders, status: 200 })

  } catch (err) {
    console.error('[send-plan-change-email] Erro ao enviar:', (err as Error).message)
    return new Response(JSON.stringify({ success: false, error: 'Erro ao enviar email' }), { headers: corsHeaders, status: 500 })
  }
})
