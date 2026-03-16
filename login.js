/**
 * GRANAEVO — LOGIN v3.0
 * ─────────────────────────────────────────────────────────────
 * Segurança implementada:
 *   • Trusted Types (fallback para browsers sem suporte)
 *   • Anti-enumeração: mensagem genérica para qualquer falha de login
 *   • Rate limiter client-side (10 req / 60s por sessão)
 *   • reCAPTCHA v2 após 3 tentativas falhadas (validado no backend)
 *   • Token de captcha validado server-side antes de qualquer auth
 *   • Sem inline style em dados do usuário (textContent apenas)
 *   • Cooldown anti-flood para envio de código de recuperação
 *   • Sessão existente → redirect imediato (sem flickering)
 *   • Senha limpa do DOM imediatamente após uso/erro
 *   • Formulário com method="POST" (nunca expõe via GET)
 * ─────────────────────────────────────────────────────────────
 */

import { supabase } from './supabase-client.js';

/* ═══════════════════════════════════════════════════════════════
   TRUSTED TYPES — apenas para restoreButton() com HTML estático
   Nunca usa input do usuário.
   ═══════════════════════════════════════════════════════════════ */
const _tt = (() => {
  if (typeof window.trustedTypes?.createPolicy !== 'function') return null;
  try {
    return window.trustedTypes.createPolicy('granaevo-login', {
      createHTML: (s) => s, // HTML sempre vem de _captureBtn, nunca do usuário
    });
  } catch { return null; }
})();

/* ═══════════════════════════════════════════════════════════════
   CONFIGURAÇÃO (imutável)
   ═══════════════════════════════════════════════════════════════ */
const CFG = Object.freeze({
  MAX_FAIL_BEFORE_CAPTCHA:  3,
  MSG_HIDE_MS:           5_000,
  CODE_COOLDOWN_MS:     30_000,
  RATE_LIMIT_MAX:           10,
  RATE_LIMIT_WIN_MS:    60_000,
  CAPTCHA_MAX_AGE_MS:  110_000,
  CAPTCHA_MIN_LEN:          50,
  CAPTCHA_KEY: '6Lfxo3IsAAAAAFpfVxePWUYsyKjeWbP7PoXC3Hye',
  SUPABASE_URL: 'https://fvrhqqeofqedmhadzzqw.supabase.co',
  SK: Object.freeze({
    attempts:   '_ge_a',
    sendCD:     '_ge_sc',
    resendCD:   '_ge_rc',
    rateLog:    '_ge_rl',
  }),
});

/* Mensagem genérica — nunca revela se é email ou senha o problema */
const LOGIN_ERR = 'Tentativa inválida: email ou senha incorreto';

/* ── Headers ── */
async function _authHeader() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('no-session');
  return `Bearer ${session.access_token}`;
}
function _pubHeader() { return `Bearer ${supabase.supabaseKey}`; }

/* ═══════════════════════════════════════════════════════════════
   MÓDULOS DE ESTADO
   ═══════════════════════════════════════════════════════════════ */

/* ── Tentativas de login ── */
const Attempts = {
  get()   { return +( sessionStorage.getItem(CFG.SK.attempts) || 0 ); },
  inc()   { sessionStorage.setItem(CFG.SK.attempts, this.get() + 1); },
  reset() { sessionStorage.removeItem(CFG.SK.attempts); },
};

/* ── Cooldown ── */
const Cooldown = {
  active: (k) => Date.now() < +( sessionStorage.getItem(k) || 0 ),
  set:    (k, ms) => sessionStorage.setItem(k, Date.now() + ms),
};

/* ── Rate limiter ── */
const RateLimiter = {
  ok() {
    const now = Date.now();
    let log;
    try { log = JSON.parse(sessionStorage.getItem(CFG.SK.rateLog) || '[]'); }
    catch { log = []; }
    log = log.filter(ts => ts > now - CFG.RATE_LIMIT_WIN_MS);
    if (log.length >= CFG.RATE_LIMIT_MAX) return false;
    log.push(now);
    try { sessionStorage.setItem(CFG.SK.rateLog, JSON.stringify(log)); } catch { /* full */ }
    return true;
  },
};

/* ── Estado de recuperação ── */
const Recovery = (() => {
  let _email = '', _code = '';
  return {
    email:      ()  => _email,
    code:       ()  => _code,
    setEmail:   (v) => { _email = String(v ?? '').trim(); },
    setCode:    (v) => { _code  = String(v ?? '').trim(); },
    clearCode:  ()  => { _code  = ''; },
    clear:      ()  => { _email = ''; _code = ''; },
    valid:      ()  => _email.length > 0 && _code.length === 6,
  };
})();

/* ── Estado do reCAPTCHA ── */
let _captchaId = null; // null = não renderizado

const Captcha = (() => {
  let _tok = null, _ok = false, _at = 0, _active = false;

  /* Callbacks globais chamados pelo widget */
  window.onCaptchaResolved = (token) => {
    if (!_active) return;
    if (typeof token !== 'string' || token.length < CFG.CAPTCHA_MIN_LEN) return;
    if (typeof grecaptcha === 'undefined') return;
    try {
      const resp = grecaptcha.getResponse(_captchaId ?? undefined);
      if (!resp || resp !== token) return;
      _tok = token; _ok = true; _at = Date.now();
    } catch { _tok = null; _ok = false; }
  };
  window.onCaptchaExpired = () => { _tok = null; _ok = false; };
  window.onCaptchaError   = () => { _tok = null; _ok = false; };

  return {
    activate()   { _active = true;  },
    deactivate() { _active = false; },
    resolved()   {
      return _ok && !!_tok && (Date.now() - _at) < CFG.CAPTCHA_MAX_AGE_MS;
    },
    token() { return this.resolved() ? _tok : null; },
    reset() {
      _tok = null; _ok = false; _at = 0;
      if (typeof grecaptcha === 'undefined') return;
      try {
        _captchaId !== null ? grecaptcha.reset(_captchaId) : grecaptcha.reset();
      } catch { /* ainda não renderizado */ }
    },
  };
})();

/* ═══════════════════════════════════════════════════════════════
   UTILITÁRIOS
   ═══════════════════════════════════════════════════════════════ */
const clean    = (v) => String(v ?? '').trim();
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e);

/* ── Botões: captura e restauração (Trusted Types safe) ── */
const _btnHTML = new WeakMap();
const captureBtn = (btn) => {
  if (btn instanceof HTMLElement && !_btnHTML.has(btn))
    _btnHTML.set(btn, btn.innerHTML);
};
const restoreBtn = (btn) => {
  btn.disabled = false;
  const orig = _btnHTML.get(btn);
  if (orig === undefined) return;
  if (_tt) btn.innerHTML = _tt.createHTML(orig);
  else      btn.innerHTML = orig;
};

/* ── Spinner ── */
function makeSpinner(label) {
  const frag = document.createDocumentFragment();
  const svg  = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('spinner-svg');
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx','12'); c.setAttribute('cy','12'); c.setAttribute('r','10');
  c.setAttribute('stroke','currentColor'); c.setAttribute('stroke-width','4');
  c.setAttribute('fill','none'); c.setAttribute('opacity','0.25');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d','M12 2a10 10 0 0 1 10 10');
  p.setAttribute('stroke','currentColor'); p.setAttribute('stroke-width','4');
  p.setAttribute('fill','none');
  svg.appendChild(c); svg.appendChild(p);
  frag.appendChild(svg);
  frag.appendChild(document.createTextNode(' ' + clean(label)));
  return frag;
}
function setLoading(btn, txt) {
  btn.disabled = true;
  btn.textContent = '';
  btn.appendChild(makeSpinner(txt));
}

/* ── Shake de input ── */
function shake(el) {
  if (!el) return;
  el.classList.add('is-shake');
  setTimeout(() => el.classList.remove('is-shake'), 450);
}

/* ═══════════════════════════════════════════════════════════════
   REFERÊNCIAS DO DOM
   ═══════════════════════════════════════════════════════════════ */
const sc = {
  login:   document.getElementById('s-login'),
  forgot:  document.getElementById('s-forgot'),
  code:    document.getElementById('s-code'),
  newpw:   document.getElementById('s-newpw'),
  ok:      document.getElementById('s-ok'),
};
const bt = {
  loginSubmit:  document.getElementById('loginBtn'),
  forgot:       document.getElementById('forgotBtn'),
  backLogin:    document.getElementById('backToLogin'),
  sendCode:     document.getElementById('sendCodeBtn'),
  backEmail:    document.getElementById('backToEmail'),
  verifyCode:   document.getElementById('verifyCodeBtn'),
  backCode:     document.getElementById('backToCode'),
  changePw:     document.getElementById('changePwBtn'),
  goLogin:      document.getElementById('goLoginBtn'),
  resend:       document.getElementById('resendBtn'),
};
const inp = {
  email:    document.getElementById('loginEmail'),
  password: document.getElementById('loginPassword'),
  recovery: document.getElementById('recoveryEmail'),
  codes:    document.querySelectorAll('.code-box'),
  newPw:    document.getElementById('newPassword'),
  confirmPw:document.getElementById('confirmPassword'),
};
const loginForm = document.getElementById('loginForm');
const pwError   = document.getElementById('pwError');
const togglePw  = document.getElementById('togglePw');

/* ═══════════════════════════════════════════════════════════════
   MENSAGENS (flash global)
   ═══════════════════════════════════════════════════════════════ */
let _msgTimer = null;
function showMsg(msg, type) {
  const el = document.getElementById('authMsg');
  if (!el) return;
  if (_msgTimer) { clearTimeout(_msgTimer); _msgTimer = null; }
  el.textContent = clean(msg); // textContent — nunca innerHTML
  el.className   = `flash ${type} visible`;
  requestAnimationFrame(() => el.classList.add('show'));
  _msgTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.classList.remove('visible'); el.textContent = ''; }, 320);
  }, CFG.MSG_HIDE_MS);
}

/* ── Erro inline (tela nova senha) ── */
function showPwErr(msg) {
  if (!pwError) return;
  pwError.textContent = clean(msg);
  pwError.classList.add('show');
}
function hidePwErr() {
  if (!pwError) return;
  pwError.classList.remove('show');
  setTimeout(() => { pwError.textContent = ''; }, 280);
}

/* ═══════════════════════════════════════════════════════════════
   CAPTCHA
   ═══════════════════════════════════════════════════════════════ */
function _renderWidget() {
  if (_captchaId !== null) return;
  const el = document.getElementById('captchaWrap');
  const box = el?.querySelector('.g-recaptcha');
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  try {
    _captchaId = grecaptcha.render(box, {
      sitekey:              CFG.CAPTCHA_KEY,
      callback:             'onCaptchaResolved',
      'expired-callback':   'onCaptchaExpired',
      'error-callback':     'onCaptchaError',
      theme:                'dark',
    });
  } catch {
    _captchaId = box.querySelector('iframe') ? 0 : null;
  }
}

function showCaptcha() {
  const el = document.getElementById('captchaWrap');
  if (!el) return;
  el.style.display = ''; // limpa inline residual
  el.classList.remove('captcha-hidden');
  el.classList.add('captcha-visible');
  Captcha.activate();
  if (_captchaId !== null) return;
  // Espera o script do reCAPTCHA estar pronto
  const ready = () =>
    typeof grecaptcha !== 'undefined' && typeof grecaptcha.render === 'function';
  if (ready()) { _renderWidget(); return; }
  const deadline = Date.now() + 15_000;
  const poll = setInterval(() => {
    if (_captchaId !== null) { clearInterval(poll); return; }
    if (ready()) { clearInterval(poll); _renderWidget(); }
    else if (Date.now() >= deadline) clearInterval(poll);
  }, 250);
}

function hideCaptcha() {
  const el = document.getElementById('captchaWrap');
  if (!el) return;
  el.style.display = '';
  el.classList.remove('captcha-visible');
  el.classList.add('captcha-hidden');
  Captcha.deactivate();
}

function highlightCaptcha() {
  const el = document.getElementById('captchaWrap');
  if (!el) return;
  el.classList.add('captcha-error');
  setTimeout(() => el.classList.remove('captcha-error'), 2000);
}

async function verifyCaptchaBackend(token) {
  if (!token || token.length < CFG.CAPTCHA_MIN_LEN) return false;
  try {
    const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/verify-recaptcha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': _pubHeader() },
      body: JSON.stringify({ token: token.trim() }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    return d?.success === true;
  } catch { return false; }
}

/* ═══════════════════════════════════════════════════════════════
   VERIFICAÇÃO DE ACESSO (plano ativo)
   ═══════════════════════════════════════════════════════════════ */
async function checkAccess() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id || !session?.access_token) return false;
    const h = await _authHeader();
    const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/check-user-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': h },
      body: JSON.stringify({ user_id: session.user.id }),
    });
    if (!r.ok) return false;
    return (await r.json())?.hasAccess === true;
  } catch { return false; }
}

/* ═══════════════════════════════════════════════════════════════
   HELPER: registra falha e ativa captcha se necessário
   ═══════════════════════════════════════════════════════════════ */
function _fail() {
  Attempts.inc();
  if (Attempts.get() >= CFG.MAX_FAIL_BEFORE_CAPTCHA) showCaptcha();
}

/* ═══════════════════════════════════════════════════════════════
   INICIALIZAÇÃO
   ═══════════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {

  /* Estado inicial do captcha — só classes, sem inline style */
  const cw = document.getElementById('captchaWrap');
  if (cw) { cw.style.display = ''; cw.classList.add('captcha-hidden'); }

  /* Captura HTML original de cada botão antes de qualquer mutação */
  Object.values(bt).forEach(b => { if (b) captureBtn(b); });

  /* Redireciona se já autenticado */
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) { window.location.replace('dashboard.html'); return; }
  } catch { /* continua */ }

  /* Mostra captcha se limite já atingido em sessão anterior */
  if (Attempts.get() >= CFG.MAX_FAIL_BEFORE_CAPTCHA) showCaptcha();

  /* Partículas */
  _initParticles();

  /* Erro pendente de outro módulo (ex: dashboard) */
  const err = sessionStorage.getItem('auth_error');
  if (err) {
    showMsg(clean(err), 'error');
    sessionStorage.removeItem('auth_error');
  }
});

/* ═══════════════════════════════════════════════════════════════
   PARTÍCULAS CANVAS (performático — zero dependências)
   ═══════════════════════════════════════════════════════════════ */
function _initParticles() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const N = 42;
  let W = 0, H = 0;

  const resize = () => {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  const pts = Array.from({ length: N }, () => ({
    x:  Math.random() * window.innerWidth,
    y:  Math.random() * window.innerHeight,
    r:  Math.random() * 1.6 + 0.5,
    dx: (Math.random() - .5) * .22,
    dy: -(Math.random() * .22 + .07),
    a:  Math.random() * .35 + .07,
  }));

  let raf;
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle   = `rgba(0,230,118,${p.a})`;
      ctx.shadowBlur  = 4;
      ctx.shadowColor = 'rgba(0,230,118,.45)';
      ctx.fill();
      ctx.shadowBlur  = 0;
      p.x += p.dx; p.y += p.dy;
      if (p.y < -6) { p.y = H + 6; p.x = Math.random() * W; }
      if (p.x < -6) p.x = W + 6;
      if (p.x > W + 6) p.x = -6;
    }
    raf = requestAnimationFrame(draw);
  };
  draw();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else draw();
  });
}

/* ═══════════════════════════════════════════════════════════════
   NAVEGAÇÃO ENTRE TELAS
   ═══════════════════════════════════════════════════════════════ */
function switchTo(from, to) {
  Object.values(sc).forEach(s => {
    s.classList.remove('active', 'exit-left');
    s.setAttribute('aria-hidden', 'true');
  });
  if (from) {
    from.classList.add('exit-left');
    setTimeout(() => {
      from.classList.remove('active', 'exit-left');
      to.classList.add('active');
      to.setAttribute('aria-hidden', 'false');
    }, 360);
  } else {
    to.classList.add('active');
    to.setAttribute('aria-hidden', 'false');
  }
}

/* ═══════════════════════════════════════════════════════════════
   FORMULÁRIO DE LOGIN
   ─────────────────────────────────────────────────────────────
   REGRA DE SEGURANÇA ANTI-ENUMERAÇÃO:
   Qualquer falha (email vazio, inválido, senha vazia, erro
   do Supabase) usa a mesma mensagem genérica e conta como
   tentativa para o captcha. Nunca revelamos se é o email
   ou a senha que está errado.
   ═══════════════════════════════════════════════════════════════ */
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!RateLimiter.ok()) {
    showMsg('Muitas tentativas. Aguarde um momento.', 'error');
    return;
  }

  const email = clean(inp.email.value);
  // NÃO aparar senha — espaços podem ser válidos
  const pw    = inp.password.value;

  /* Validações locais contam como tentativa (anti-enumeração) */
  if (!email || !validEmail(email)) {
    inp.password.value = '';
    _fail();
    showMsg(LOGIN_ERR, 'error');
    shake(inp.email); shake(inp.password);
    return;
  }
  if (!pw) {
    _fail();
    showMsg(LOGIN_ERR, 'error');
    shake(inp.password);
    return;
  }

  /* Captcha obrigatório após 3 falhas */
  if (Attempts.get() >= CFG.MAX_FAIL_BEFORE_CAPTCHA) {
    if (!Captcha.resolved()) {
      showMsg('Resolva a verificação de segurança.', 'error');
      highlightCaptcha();
      return;
    }
    showMsg('Verificando segurança…', 'info');
    const ok = await verifyCaptchaBackend(Captcha.token());
    if (!ok) {
      showMsg('Falha na verificação. Tente novamente.', 'error');
      Captcha.reset();
      return;
    }
  }

  setLoading(bt.loginSubmit, 'Verificando…');

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pw });

    if (error) {
      inp.password.value = ''; // limpa imediatamente
      Captcha.reset();
      _fail();
      showMsg(LOGIN_ERR, 'error');
      shake(inp.email); shake(inp.password);
      return;
    }

    /* ── Sucesso de autenticação ── */
    Attempts.reset();
    Captcha.reset();
    hideCaptcha();

    setLoading(bt.loginSubmit, 'Verificando plano…');
    const hasAccess = await checkAccess();

    if (!hasAccess) {
      await supabase.auth.signOut();
      showMsg('Você precisa de um plano ativo para acessar.', 'error');
      setTimeout(() => window.location.replace('planos.html'), 2600);
      return;
    }

    inp.password.value = '';
    inp.email.value    = '';
    const name = clean(data.user.user_metadata?.name || 'Usuário');
    showMsg(`Bem-vindo de volta, ${name}!`, 'success');
    setTimeout(() => window.location.replace('dashboard.html'), 1400);

  } catch {
    showMsg('Erro de conexão. Verifique sua internet.', 'error');
  } finally {
    restoreBtn(bt.loginSubmit);
  }
});

/* ── Toggle de senha ── */
togglePw?.addEventListener('click', () => {
  if (!inp.password) return;
  const isHidden = inp.password.type === 'password';
  inp.password.type = isHidden ? 'text' : 'password';
  togglePw.setAttribute('aria-label',   isHidden ? 'Ocultar senha' : 'Mostrar senha');
  togglePw.setAttribute('aria-pressed', String(isHidden));
  /* Atualiza SVG via DOM seguro (sem innerHTML) */
  const svg = togglePw.querySelector('svg');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (isHidden) {
    const paths = [
      'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24',
      'M1 1 23 23',
    ];
    paths.forEach((d, i) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', i === 0 ? 'path' : 'line');
      if (i === 0) { el.setAttribute('d', d); el.setAttribute('stroke-width','1.5'); el.setAttribute('fill','none'); }
      else { el.setAttribute('x1','1'); el.setAttribute('y1','1'); el.setAttribute('x2','23'); el.setAttribute('y2','23'); el.setAttribute('stroke-width','1.5'); }
      el.setAttribute('stroke','currentColor');
      svg.appendChild(el);
    });
  } else {
    const p  = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const ci = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    p.setAttribute('d','M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');
    p.setAttribute('stroke-width','1.5'); p.setAttribute('stroke','currentColor'); p.setAttribute('fill','none');
    ci.setAttribute('cx','12'); ci.setAttribute('cy','12'); ci.setAttribute('r','3');
    ci.setAttribute('stroke-width','1.5'); ci.setAttribute('stroke','currentColor'); ci.setAttribute('fill','none');
    svg.appendChild(p); svg.appendChild(ci);
  }
});

/* ═══════════════════════════════════════════════════════════════
   NAVEGAÇÃO — RECUPERAÇÃO
   ═══════════════════════════════════════════════════════════════ */
bt.forgot?.addEventListener('click', (e) => {
  e.preventDefault();
  switchTo(sc.login, sc.forgot);
  setTimeout(() => inp.recovery?.focus(), 380);
});

bt.backLogin?.addEventListener('click', () => {
  _clearRecovery();
  switchTo(sc.forgot, sc.login);
});

/* ═══════════════════════════════════════════════════════════════
   ENVIAR CÓDIGO DE RECUPERAÇÃO
   ═══════════════════════════════════════════════════════════════ */
bt.sendCode?.addEventListener('click', async () => {
  const email = clean(inp.recovery?.value || '');

  if (!email || !validEmail(email)) {
    inp.recovery?.classList.add('is-error');
    setTimeout(() => inp.recovery?.classList.remove('is-error'), 2000);
    showMsg('Digite um email válido.', 'error');
    return;
  }
  if (Cooldown.active(CFG.SK.sendCD)) {
    showMsg('Aguarde antes de solicitar novo código.', 'error');
    return;
  }

  setLoading(bt.sendCode, 'Enviando…');
  try {
    const r = await fetch(
      `${CFG.SUPABASE_URL}/functions/v1/send-password-reset-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': _pubHeader() },
        body: JSON.stringify({ email }),
      }
    );
    if (!r.ok) { showMsg('Erro de conexão. Tente novamente.', 'error'); return; }
    const d = await r.json();

    if (d.status === 'sent') {
      Recovery.setEmail(email);
      Cooldown.set(CFG.SK.sendCD, CFG.CODE_COOLDOWN_MS);
      showMsg('Código enviado! Verifique seu email.', 'success');
      switchTo(sc.forgot, sc.code);
      setTimeout(() => inp.codes[0]?.focus(), 380);
    } else if (d.status === 'not_found' || d.status === 'payment_not_approved') {
      /* Anti-enumeração: mesma mensagem para usuário inexistente */
      showMsg('Se o email estiver cadastrado com plano ativo, você receberá o código.', 'info');
    } else {
      showMsg('Não foi possível enviar. Tente novamente.', 'error');
    }
  } catch {
    showMsg('Erro de conexão. Tente novamente.', 'error');
  } finally {
    restoreBtn(bt.sendCode);
  }
});

bt.backEmail?.addEventListener('click', () => {
  _resetCodes();
  switchTo(sc.code, sc.forgot);
});

/* ═══════════════════════════════════════════════════════════════
   VERIFICAR CÓDIGO
   ═══════════════════════════════════════════════════════════════ */
bt.verifyCode?.addEventListener('click', () => {
  const code = Array.from(inp.codes).map(i => i.value).join('');
  if (code.length !== 6 || !/^\d{6}$/.test(code)) {
    showMsg('Digite o código completo de 6 dígitos.', 'error');
    return;
  }
  Recovery.setCode(code);
  switchTo(sc.code, sc.newpw);
  setTimeout(() => inp.newPw?.focus(), 380);
});

bt.backCode?.addEventListener('click', () => {
  hidePwErr();
  if (inp.newPw)    inp.newPw.value    = '';
  if (inp.confirmPw)inp.confirmPw.value = '';
  switchTo(sc.newpw, sc.code);
});

/* ═══════════════════════════════════════════════════════════════
   ALTERAR SENHA
   (validações de força são corretas aqui — usuário está CRIANDO
    uma nova senha, não tentando login)
   ═══════════════════════════════════════════════════════════════ */
bt.changePw?.addEventListener('click', async () => {
  const nw = inp.newPw?.value    || '';
  const cf = inp.confirmPw?.value|| '';
  hidePwErr();

  if (!nw || !cf)                           { showPwErr('Preencha todos os campos.'); return; }
  if (nw.length < 8 || nw.length > 128)     { showPwErr('A senha deve ter entre 8 e 128 caracteres.'); return; }
  if (!/[A-Za-z]/.test(nw)||!/[0-9]/.test(nw)) { showPwErr('A senha deve conter letras e números.'); return; }
  if (nw !== cf) {
    showPwErr('As senhas não coincidem.');
    inp.newPw?.classList.add('is-error');
    inp.confirmPw?.classList.add('is-error');
    setTimeout(() => {
      inp.newPw?.classList.remove('is-error');
      inp.confirmPw?.classList.remove('is-error');
    }, 2000);
    return;
  }
  if (!Recovery.valid()) {
    showPwErr('Sessão expirada. Reinicie o processo.');
    setTimeout(() => { _clearRecovery(); switchTo(sc.newpw, sc.login); }, 2100);
    return;
  }

  setLoading(bt.changePw, 'Alterando…');
  try {
    const r = await fetch(
      `${CFG.SUPABASE_URL}/functions/v1/verify-and-reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': _pubHeader() },
        body: JSON.stringify({
          email:       Recovery.email(),
          code:        Recovery.code(),
          newPassword: nw,
        }),
      }
    );
    if (!r.ok) { showPwErr('Erro de conexão. Tente novamente.'); return; }
    const d = await r.json();

    if (d.status === 'success') {
      Recovery.clear();
      switchTo(sc.newpw, sc.ok);
    } else if (d.status === 'invalid_code') {
      showPwErr('Código inválido, expirado ou já utilizado.');
      Recovery.clearCode();
    } else {
      showPwErr('Não foi possível alterar a senha. Tente novamente.');
    }
  } catch {
    showPwErr('Erro de conexão. Tente novamente.');
  } finally {
    restoreBtn(bt.changePw);
  }
});

/* ── Tela de sucesso → login ── */
bt.goLogin?.addEventListener('click', () => {
  _clearRecovery();
  switchTo(sc.ok, sc.login);
});

/* ═══════════════════════════════════════════════════════════════
   REENVIAR CÓDIGO
   ═══════════════════════════════════════════════════════════════ */
bt.resend?.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!Recovery.email()) {
    showMsg('Email não encontrado. Volte e tente novamente.', 'error');
    return;
  }
  if (Cooldown.active(CFG.SK.resendCD)) {
    showMsg('Aguarde antes de reenviar.', 'error');
    return;
  }
  const orig = clean(bt.resend.textContent);
  bt.resend.disabled = true;
  bt.resend.textContent = 'Enviando…';

  try {
    const r = await fetch(
      `${CFG.SUPABASE_URL}/functions/v1/send-password-reset-code`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': _pubHeader() },
        body: JSON.stringify({ email: Recovery.email() }),
      }
    );
    if (!r.ok) { showMsg('Erro de conexão.', 'error'); return; }
    const d = await r.json();
    if (d.status === 'sent') {
      Cooldown.set(CFG.SK.resendCD, CFG.CODE_COOLDOWN_MS);
      showMsg('Novo código enviado!', 'success');
      bt.resend.textContent = 'Enviado!';
      _resetCodes();
      inp.codes[0]?.focus();
      setTimeout(() => { bt.resend.textContent = orig; }, 3000);
    } else {
      showMsg('Erro ao reenviar.', 'error');
    }
  } catch {
    showMsg('Erro de conexão.', 'error');
  } finally {
    bt.resend.disabled = false;
  }
});

/* ═══════════════════════════════════════════════════════════════
   HELPERS INTERNOS
   ═══════════════════════════════════════════════════════════════ */
function _clearRecovery() {
  Recovery.clear();
  if (inp.recovery)  inp.recovery.value  = '';
  if (inp.newPw)     inp.newPw.value     = '';
  if (inp.confirmPw) inp.confirmPw.value = '';
  _resetCodes();
  hidePwErr();
}
function _resetCodes() {
  inp.codes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
}

/* ═══════════════════════════════════════════════════════════════
   INPUTS DE CÓDIGO — comportamento de teclado completo
   ═══════════════════════════════════════════════════════════════ */
inp.codes.forEach((box, i) => {
  box.addEventListener('input', (e) => {
    const v = e.target.value.replace(/[^0-9]/g, '');
    e.target.value = v;
    box.classList.toggle('filled', v.length === 1);
    if (v.length === 1) inp.codes[i + 1]?.focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      const prev = inp.codes[i - 1];
      prev.focus(); prev.value = ''; prev.classList.remove('filled');
    }
    if (e.key === 'Enter') bt.verifyCode?.click();
  });
  box.addEventListener('keypress', (e) => { if (!/[0-9]/.test(e.key)) e.preventDefault(); });
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
    pasted.split('').forEach((ch, j) => {
      if (inp.codes[j]) {
        inp.codes[j].value = ch;
        inp.codes[j].classList.add('filled');
      }
    });
    const last = Math.min(pasted.length - 1, 5);
    if (last >= 0) inp.codes[last].focus();
  });
});

/* ═══════════════════════════════════════════════════════════════
   ATALHOS DE TECLADO
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement === inp.email) {
    e.preventDefault();
    inp.password?.focus();
  }
});
inp.newPw?.addEventListener('keypress',     (e) => { if (e.key === 'Enter') inp.confirmPw?.focus(); });
inp.confirmPw?.addEventListener('keypress', (e) => { if (e.key === 'Enter') bt.changePw?.click(); });
inp.recovery?.addEventListener('keypress',  (e) => { if (e.key === 'Enter') bt.sendCode?.click(); });

/* ═══════════════════════════════════════════════════════════════
   RIPPLE NOS BOTÕES PRINCIPAIS
   (inline style inevitável — coordenadas calculadas em runtime)
   ═══════════════════════════════════════════════════════════════ */
document.querySelectorAll('.btn').forEach(btn => {
  btn.addEventListener('click', function (e) {
    const r    = document.createElement('span');
    const rect = this.getBoundingClientRect();
    const sz   = Math.max(rect.width, rect.height);
    r.style.cssText = [
      'position:absolute',
      `width:${sz}px`, `height:${sz}px`,
      'border-radius:50%',
      'background:rgba(0,0,0,.18)',
      `left:${e.clientX - rect.left - sz / 2}px`,
      `top:${e.clientY - rect.top  - sz / 2}px`,
      'pointer-events:none',
      'animation:ripple .55s ease-out forwards',
    ].join(';');
    this.style.position = 'relative';
    this.style.overflow = 'hidden';
    this.appendChild(r);
    setTimeout(() => r.remove(), 560);
  });
});