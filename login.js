import { supabase } from './supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  TRUSTED TYPES — granaevo-policy
//  Usada exclusivamente em restoreButton() para innerHTML estático.
//  Nunca contém input do usuário.
// ═══════════════════════════════════════════════════════════════
const _trustedPolicy = (() => {
    if (typeof window.trustedTypes?.createPolicy !== 'function') return null;
    try {
        return window.trustedTypes.createPolicy('granaevo-policy', {
            createHTML: (s) => s,
        });
    } catch { return null; }
})();

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
    MAX_ATTEMPTS_BEFORE_CAPTCHA: 3,
    MESSAGE_AUTO_HIDE_MS:     5000,
    SEND_CODE_COOLDOWN_MS:   30_000,
    RATE_LIMIT_MAX:              10,
    RATE_LIMIT_WINDOW_MS:    60_000,
    CAPTCHA_TOKEN_MAX_AGE_MS: 110_000,
    CAPTCHA_TOKEN_MIN_LENGTH:    50,
    CAPTCHA_SITE_KEY: '6Lfxo3IsAAAAAFpfVxePWUYsyKjeWbP7PoXC3Hye',
    KEYS: Object.freeze({
        loginAttempts:  '_ge_la',
        sendCooldown:   '_ge_scc',
        resendCooldown: '_ge_rcc',
        submitRateLog:  '_ge_srl',
    }),
    SUPABASE_URL: 'https://fvrhqqeofqedmhadzzqw.supabase.co',
});

// ═══════════════════════════════════════════════════════════════
//  MENSAGEM DE ERRO PADRÃO
//  Única mensagem para qualquer falha de autenticação.
//  Anti-enumeração: nunca revela se é email ou senha o problema.
// ═══════════════════════════════════════════════════════════════
const LOGIN_ERROR_MSG = 'Tentativa inválida: email ou senha incorreto';

// ═══════════════════════════════════════════════════════════════
//  CABEÇALHOS
// ═══════════════════════════════════════════════════════════════
async function _requireSessionHeader() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('No active session.');
    return `Bearer ${session.access_token}`;
}
function _publicHeader() { return `Bearer ${supabase.supabaseKey}`; }

// ═══════════════════════════════════════════════════════════════
//  reCAPTCHA — ID DO WIDGET
//  null = não renderizado, 0+ = ID do widget
// ═══════════════════════════════════════════════════════════════
let _captchaWidgetId = null;

function _isCaptchaReady() {
    return window.__grCaptchaReady === true ||
           (typeof grecaptcha !== 'undefined' && typeof grecaptcha.render === 'function');
}

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA STATE
// ═══════════════════════════════════════════════════════════════
const CaptchaState = (() => {
    let _token = null, _resolved = false, _resolvedAt = 0, _active = false;

    window.onCaptchaResolved = (token) => {
        if (!_active) return;
        if (typeof token !== 'string' || token.length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return;
        if (typeof grecaptcha === 'undefined') return;
        try {
            const resp = grecaptcha.getResponse(_captchaWidgetId ?? undefined);
            if (!resp || resp !== token) return;
            _token = token; _resolved = true; _resolvedAt = Date.now();
        } catch { _token = null; _resolved = false; _resolvedAt = 0; }
    };
    window.onCaptchaExpired = () => { _token = null; _resolved = false; _resolvedAt = 0; };
    window.onCaptchaError   = () => { _token = null; _resolved = false; _resolvedAt = 0; };

    return {
        activate()   { _active = true;  },
        deactivate() { _active = false; },
        isResolved() {
            if (!_resolved || !_token) return false;
            return (Date.now() - _resolvedAt) < CONFIG.CAPTCHA_TOKEN_MAX_AGE_MS;
        },
        getToken() { return this.isResolved() ? _token : null; },
        reset() {
            _token = null; _resolved = false; _resolvedAt = 0;
            if (typeof grecaptcha === 'undefined') return;
            try {
                _captchaWidgetId !== null
                    ? grecaptcha.reset(_captchaWidgetId)
                    : grecaptcha.reset();
            } catch { /* not yet rendered */ }
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  RECOVERY STATE
// ═══════════════════════════════════════════════════════════════
const RecoveryState = (() => {
    let _email = '', _code = '';
    return {
        getEmail: () => _email,
        getCode:  () => _code,
        setEmail: (v) => { _email = String(v ?? '').trim(); },
        setCode:  (v) => { _code  = String(v ?? '').trim(); },
        clearEmail: () => { _email = ''; },
        clearCode:  () => { _code  = ''; },
        clear:      () => { _email = ''; _code = ''; },
        isValid:    () => _email.length > 0 && _code.length === 6,
    };
})();

// ═══════════════════════════════════════════════════════════════
//  LOGIN ATTEMPTS
// ═══════════════════════════════════════════════════════════════
const LoginAttempts = {
    get()   { return parseInt(sessionStorage.getItem(CONFIG.KEYS.loginAttempts) || '0', 10); },
    set(n)  { sessionStorage.setItem(CONFIG.KEYS.loginAttempts, String(Math.max(0, n))); },
    inc()   { this.set(this.get() + 1); },
    reset() { sessionStorage.removeItem(CONFIG.KEYS.loginAttempts); },
};

// ═══════════════════════════════════════════════════════════════
//  COOLDOWN
// ═══════════════════════════════════════════════════════════════
const Cooldown = {
    isActive(key) {
        return Date.now() < parseInt(sessionStorage.getItem(key) || '0', 10);
    },
    set(key, ms) {
        sessionStorage.setItem(key, String(Date.now() + ms));
    },
};

// ═══════════════════════════════════════════════════════════════
//  RATE LIMITER (client-side)
// ═══════════════════════════════════════════════════════════════
const SubmitRateLimiter = {
    isAllowed() {
        const now = Date.now();
        let log;
        try { log = JSON.parse(sessionStorage.getItem(CONFIG.KEYS.submitRateLog) || '[]'); }
        catch { log = []; }
        log = log.filter(ts => ts > now - CONFIG.RATE_LIMIT_WINDOW_MS);
        if (log.length >= CONFIG.RATE_LIMIT_MAX) return false;
        log.push(now);
        try { sessionStorage.setItem(CONFIG.KEYS.submitRateLog, JSON.stringify(log)); } catch { /* full */ }
        return true;
    },
};

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════
const sanitize  = (v) => String(v ?? '').trim();
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e);

// ═══════════════════════════════════════════════════════════════
//  BOTÕES — captura e restauração (Trusted Types compliant)
// ═══════════════════════════════════════════════════════════════
const _btnHTML = new WeakMap();

function _captureBtn(btn) {
    if (btn && !_btnHTML.has(btn)) _btnHTML.set(btn, btn.innerHTML);
}

function restoreButton(btn) {
    btn.disabled = false;
    const orig = _btnHTML.get(btn);
    if (orig === undefined) return;
    if (_trustedPolicy) { btn.innerHTML = _trustedPolicy.createHTML(orig); }
    else { btn.innerHTML = orig; }
}

// ═══════════════════════════════════════════════════════════════
//  SPINNER
// ═══════════════════════════════════════════════════════════════
function _makeSpinner(label) {
    const frag = document.createDocumentFragment();
    const svg  = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('loading-svg');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');  circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '4'); circle.setAttribute('fill', 'none');
    circle.setAttribute('opacity', '0.25');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 2a10 10 0 0 1 10 10');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '4'); path.setAttribute('fill', 'none');
    svg.appendChild(circle); svg.appendChild(path);
    frag.appendChild(svg);
    frag.appendChild(document.createTextNode(' ' + sanitize(label)));
    return frag;
}

function setLoading(btn, text) {
    btn.disabled = true;
    btn.textContent = '';
    btn.appendChild(_makeSpinner(text));
}

// ═══════════════════════════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════════════════════════
const screens = Object.freeze({
    login:       document.getElementById('loginScreen'),
    forgotEmail: document.getElementById('forgotEmailScreen'),
    code:        document.getElementById('codeScreen'),
    newPassword: document.getElementById('newPasswordScreen'),
    success:     document.getElementById('successScreen'),
});

const buttons = Object.freeze({
    forgotPassword:   document.getElementById('forgotPasswordBtn'),
    backToLogin:      document.getElementById('backToLogin'),
    sendCode:         document.getElementById('sendCodeBtn'),
    backToEmail:      document.getElementById('backToEmail'),
    verifyCode:       document.getElementById('verifyCodeBtn'),
    backToCode:       document.getElementById('backToCode'),
    changePassword:   document.getElementById('changePasswordBtn'),
    backToLoginFinal: document.getElementById('backToLoginFinal'),
    resendCode:       document.getElementById('resendCode'),
    loginSubmit:      document.getElementById('loginSubmitBtn'),
});

const inputs = Object.freeze({
    loginEmail:      document.getElementById('loginEmail'),
    loginPassword:   document.getElementById('loginPassword'),
    recoveryEmail:   document.getElementById('recoveryEmail'),
    codeBoxes:       document.querySelectorAll('.code-box'),
    newPassword:     document.getElementById('newPassword'),
    confirmPassword: document.getElementById('confirmPassword'),
});

const loginForm    = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');
const togglePwBtn  = document.getElementById('togglePassword');

// ═══════════════════════════════════════════════════════════════
//  MENSAGENS
// ═══════════════════════════════════════════════════════════════
let _msgTimer = null;

function showAuthMessage(msg, type) {
    const el = document.getElementById('authErrorMessage');
    if (!el) return;
    if (_msgTimer) { clearTimeout(_msgTimer); _msgTimer = null; }
    el.textContent = sanitize(msg);
    el.className = `auth-msg ${type} visible show`;
    _msgTimer = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => { el.classList.remove('visible'); el.textContent = ''; }, 300);
    }, CONFIG.MESSAGE_AUTO_HIDE_MS);
}

function showError(msg) {
    if (!errorMessage) return;
    errorMessage.textContent = sanitize(msg);
    errorMessage.classList.add('show');
}
function hideError() {
    if (!errorMessage) return;
    errorMessage.classList.remove('show');
    setTimeout(() => { errorMessage.textContent = ''; }, 280);
}

// ═══════════════════════════════════════════════════════════════
//  SHAKE INPUT
// ═══════════════════════════════════════════════════════════════
function shakeInput(inp) {
    if (!inp) return;
    inp.classList.add('input-shake');
    setTimeout(() => inp.classList.remove('input-shake'), 450);
}

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — RENDER INTERNO (idempotente)
// ═══════════════════════════════════════════════════════════════
function _renderCaptchaWidget() {
    if (_captchaWidgetId !== null) return;
    const el        = document.getElementById('captchaContainer');
    const container = el?.querySelector('.g-recaptcha');
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    try {
        _captchaWidgetId = grecaptcha.render(container, {
            sitekey:            CONFIG.CAPTCHA_SITE_KEY,
            callback:           'onCaptchaResolved',
            'expired-callback': 'onCaptchaExpired',
            'error-callback':   'onCaptchaError',
            theme:              'dark',
        });
    } catch {
        const iframe = container.querySelector('iframe');
        _captchaWidgetId = iframe ? 0 : null;
    }
}

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — SHOW / HIDE
//  Controle EXCLUSIVAMENTE via classList.
//  el.style.display = '' limpa inline style residual para que
//  .captcha-hidden { display:none !important } funcione sempre.
// ═══════════════════════════════════════════════════════════════
function showCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.style.display = '';
    el.classList.remove('captcha-hidden');
    el.classList.add('captcha-visible');
    CaptchaState.activate();
    if (_captchaWidgetId !== null) return;

    if (_isCaptchaReady()) {
        _renderCaptchaWidget();
    } else {
        window.__grPendingRender = _renderCaptchaWidget;
        const deadline = Date.now() + 15_000;
        const poll = setInterval(() => {
            if (_captchaWidgetId !== null) { clearInterval(poll); window.__grPendingRender = null; return; }
            if (_isCaptchaReady()) {
                clearInterval(poll);
                window.__grCaptchaReady = true; window.__grPendingRender = null;
                _renderCaptchaWidget();
            } else if (Date.now() >= deadline) { clearInterval(poll); window.__grPendingRender = null; }
        }, 250);
    }
}

function hideCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.style.display = '';
    el.classList.remove('captcha-visible');
    el.classList.add('captcha-hidden');
    CaptchaState.deactivate();
}

function highlightCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.classList.add('captcha-error');
    setTimeout(() => el.classList.remove('captcha-error'), 2000);
}

// ═══════════════════════════════════════════════════════════════
//  VALIDAÇÃO DO CAPTCHA NO BACKEND
// ═══════════════════════════════════════════════════════════════
async function validateCaptchaOnBackend(token) {
    if (!token || typeof token !== 'string' || token.trim().length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return false;
    try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-recaptcha`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ token: token.trim() }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data?.success === true;
    } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
//  VERIFICAÇÃO DE ACESSO
// ═══════════════════════════════════════════════════════════════
async function checkUserAccess() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id || !session?.access_token) return { hasAccess: false };
        const authHeader = await _requireSessionHeader();
        const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/check-user-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
            body: JSON.stringify({ user_id: session.user.id }),
        });
        if (!res.ok) return { hasAccess: false };
        const data = await res.json();
        return { hasAccess: data?.hasAccess === true };
    } catch { return { hasAccess: false }; }
}

// ═══════════════════════════════════════════════════════════════
//  HELPER: registra tentativa falha e mostra captcha se necessário
// ═══════════════════════════════════════════════════════════════
function _registerFailedAttempt() {
    LoginAttempts.inc();
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) showCaptcha();
}

// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {

    // Estado inicial do captcha — limpeza de inline style residual
    const captchaEl = document.getElementById('captchaContainer');
    if (captchaEl) {
        captchaEl.style.display = '';
        captchaEl.classList.add('captcha-hidden');
        captchaEl.classList.remove('captcha-visible');
    }

    // Captura HTML original de cada botão
    Object.values(buttons).forEach(btn => {
        if (btn instanceof HTMLElement) _captureBtn(btn);
    });

    // Verifica sessão existente
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) { window.location.replace('dashboard.html'); return; }
    } catch { /* sem sessão */ }

    // Exibe captcha se já atingiu o limite em sessão anterior
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) showCaptcha();

    // Inicia partículas canvas
    _initParticles();

    // Erro pendente de outro módulo (ex: dashboard)
    const authError = sessionStorage.getItem('auth_error');
    if (authError) {
        showAuthMessage(sanitize(authError), 'error');
        sessionStorage.removeItem('auth_error');
    }
});

// ═══════════════════════════════════════════════════════════════
//  PARTÍCULAS CANVAS (performático — sem texto, só pontos)
// ═══════════════════════════════════════════════════════════════
function _initParticles() {
    const canvas = document.getElementById('particleCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const COUNT = 38;
    let W = 0, H = 0;

    const resize = () => {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });

    const particles = Array.from({ length: COUNT }, () => ({
        x:    Math.random() * window.innerWidth,
        y:    Math.random() * window.innerHeight,
        r:    Math.random() * 1.8 + 0.6,
        dx:   (Math.random() - 0.5) * 0.25,
        dy:   -(Math.random() * 0.25 + 0.08),
        a:    Math.random() * 0.38 + 0.08,
    }));

    let raf;
    function draw() {
        ctx.clearRect(0, 0, W, H);
        for (const p of particles) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0,232,122,${p.a})`;
            ctx.shadowBlur  = 5;
            ctx.shadowColor = 'rgba(0,232,122,0.5)';
            ctx.fill();
            ctx.shadowBlur = 0;
            p.x += p.dx;
            p.y += p.dy;
            if (p.y < -6) { p.y = H + 6; p.x = Math.random() * W; }
            if (p.x < -6) p.x = W + 6;
            if (p.x > W + 6) p.x = -6;
        }
        raf = requestAnimationFrame(draw);
    }
    draw();

    // Parar quando a aba fica em background (economia de bateria)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancelAnimationFrame(raf);
        else draw();
    });
}

// ═══════════════════════════════════════════════════════════════
//  NAVEGAÇÃO ENTRE TELAS
// ═══════════════════════════════════════════════════════════════
function switchScreen(from, to) {
    Object.values(screens).forEach(s => {
        s.classList.remove('active', 'exit-left');
        s.setAttribute('aria-hidden', 'true');
    });
    if (from) {
        from.classList.add('exit-left');
        setTimeout(() => {
            from.classList.remove('active', 'exit-left');
            to.classList.add('active');
            to.setAttribute('aria-hidden', 'false');
        }, 380);
    } else {
        to.classList.add('active');
        to.setAttribute('aria-hidden', 'false');
    }
}

// ═══════════════════════════════════════════════════════════════
//  FORMULÁRIO DE LOGIN
//
//  Regras:
//  • Qualquer falha (email vazio, inválido, senha vazia, erro Supabase)
//    conta como tentativa e ativa captcha após 3 erros.
//  • Sem validação de tamanho de senha no login (anti-enumeração).
//  • Mensagem sempre genérica: LOGIN_ERROR_MSG.
// ═══════════════════════════════════════════════════════════════
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!SubmitRateLimiter.isAllowed()) {
        showAuthMessage('Muitas tentativas em pouco tempo. Aguarde.', 'error');
        return;
    }

    const email    = sanitize(inputs.loginEmail.value);
    const password = inputs.loginPassword.value; // nunca aparar — espaços podem ser senha válida

    // Email vazio ou inválido → conta tentativa (anti-enumeração)
    if (!email || !validEmail(email)) {
        inputs.loginPassword.value = '';
        _registerFailedAttempt();
        showAuthMessage(LOGIN_ERROR_MSG, 'error');
        shakeInput(inputs.loginEmail);
        shakeInput(inputs.loginPassword);
        return;
    }

    // Senha vazia → conta tentativa
    if (!password) {
        _registerFailedAttempt();
        showAuthMessage(LOGIN_ERROR_MSG, 'error');
        shakeInput(inputs.loginPassword);
        return;
    }

    // Captcha obrigatório após limite de tentativas
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        if (!CaptchaState.isResolved()) {
            showAuthMessage('Por favor, resolva a verificação de segurança.', 'error');
            highlightCaptcha();
            return;
        }
        showAuthMessage('Verificando segurança...', 'info');
        const ok = await validateCaptchaOnBackend(CaptchaState.getToken());
        if (!ok) {
            showAuthMessage('Falha na verificação de segurança. Tente novamente.', 'error');
            CaptchaState.reset();
            return;
        }
    }

    const btn = buttons.loginSubmit;
    setLoading(btn, 'Verificando...');

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            inputs.loginPassword.value = '';
            CaptchaState.reset();
            _registerFailedAttempt();
            showAuthMessage(LOGIN_ERROR_MSG, 'error');
            shakeInput(inputs.loginEmail);
            shakeInput(inputs.loginPassword);
            return;
        }

        // Sucesso
        LoginAttempts.reset();
        CaptchaState.reset();
        hideCaptcha();

        setLoading(btn, 'Verificando plano...');
        const { hasAccess } = await checkUserAccess();

        if (!hasAccess) {
            await supabase.auth.signOut();
            showAuthMessage('Você precisa de um plano ativo para acessar.', 'error');
            setTimeout(() => window.location.replace('planos.html'), 2500);
            return;
        }

        inputs.loginPassword.value = '';
        inputs.loginEmail.value    = '';
        const name = sanitize(data.user.user_metadata?.name || 'Usuário');
        showAuthMessage(`Bem-vindo de volta, ${name}!`, 'success');
        setTimeout(() => window.location.replace('dashboard.html'), 1400);

    } catch {
        showAuthMessage('Erro de conexão. Verifique sua internet.', 'error');
    } finally {
        restoreButton(btn);
    }
});

// ═══════════════════════════════════════════════════════════════
//  TOGGLE DE SENHA
// ═══════════════════════════════════════════════════════════════
if (togglePwBtn && inputs.loginPassword) {
    togglePwBtn.addEventListener('click', () => {
        const isPw = inputs.loginPassword.type === 'password';
        inputs.loginPassword.type = isPw ? 'text' : 'password';
        togglePwBtn.setAttribute('aria-label',   isPw ? 'Ocultar senha' : 'Mostrar senha');
        togglePwBtn.setAttribute('aria-pressed', String(isPw));
        const svg = togglePwBtn.querySelector('svg');
        if (!svg) return;
        if (isPw) {
            svg.innerHTML = `
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" stroke-width="1.5" stroke="currentColor" fill="none"/>
                <line x1="1" y1="1" x2="23" y2="23" stroke-width="1.5" stroke="currentColor"/>`;
        } else {
            svg.innerHTML = `
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke-width="1.5" stroke="currentColor" fill="none"/>
                <circle cx="12" cy="12" r="3" stroke-width="1.5" stroke="currentColor" fill="none"/>`;
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  NAVEGAÇÃO — RECUPERAÇÃO
// ═══════════════════════════════════════════════════════════════
buttons.forgotPassword?.addEventListener('click', (e) => {
    e.preventDefault();
    switchScreen(screens.login, screens.forgotEmail);
    setTimeout(() => inputs.recoveryEmail?.focus(), 400);
});

buttons.backToLogin?.addEventListener('click', () => {
    _clearRecovery();
    switchScreen(screens.forgotEmail, screens.login);
});

// ═══════════════════════════════════════════════════════════════
//  ENVIAR CÓDIGO DE RECUPERAÇÃO
// ═══════════════════════════════════════════════════════════════
buttons.sendCode?.addEventListener('click', async () => {
    const email = sanitize(inputs.recoveryEmail?.value || '');

    if (!email || !validEmail(email)) {
        inputs.recoveryEmail?.classList.add('input-error-border');
        setTimeout(() => inputs.recoveryEmail?.classList.remove('input-error-border'), 2000);
        showAuthMessage('Digite um email válido.', 'error');
        return;
    }

    if (Cooldown.isActive(CONFIG.KEYS.sendCooldown)) {
        showAuthMessage('Aguarde antes de solicitar um novo código.', 'error');
        return;
    }

    setLoading(buttons.sendCode, 'Enviando...');
    try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ email }),
        });
        if (!res.ok) { showAuthMessage('Erro de conexão. Tente novamente.', 'error'); return; }
        const data = await res.json();

        if (data.status === 'sent') {
            RecoveryState.setEmail(email);
            Cooldown.set(CONFIG.KEYS.sendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
            showAuthMessage('Código enviado! Verifique seu email.', 'success');
            switchScreen(screens.forgotEmail, screens.code);
            setTimeout(() => inputs.codeBoxes[0]?.focus(), 400);
        } else if (data.status === 'not_found' || data.status === 'payment_not_approved') {
            showAuthMessage('Se o email estiver cadastrado com plano ativo, você receberá o código.', 'info');
        } else {
            showAuthMessage('Não foi possível enviar o código. Tente novamente.', 'error');
        }
    } catch { showAuthMessage('Erro de conexão. Tente novamente.', 'error'); }
    finally   { restoreButton(buttons.sendCode); }
});

buttons.backToEmail?.addEventListener('click', () => {
    _resetCodeBoxes();
    switchScreen(screens.code, screens.forgotEmail);
});

// ═══════════════════════════════════════════════════════════════
//  VERIFICAR CÓDIGO
// ═══════════════════════════════════════════════════════════════
buttons.verifyCode?.addEventListener('click', () => {
    const code = Array.from(inputs.codeBoxes).map(i => i.value).join('');
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
        showAuthMessage('Digite o código completo de 6 dígitos.', 'error');
        return;
    }
    RecoveryState.setCode(code);
    switchScreen(screens.code, screens.newPassword);
    setTimeout(() => inputs.newPassword?.focus(), 400);
});

buttons.backToCode?.addEventListener('click', () => {
    hideError();
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    switchScreen(screens.newPassword, screens.code);
});

// ═══════════════════════════════════════════════════════════════
//  ALTERAR SENHA
//  Validações de tamanho/força são CORRETAS aqui:
//  o usuário está CRIANDO uma nova senha, não tentando login.
// ═══════════════════════════════════════════════════════════════
buttons.changePassword?.addEventListener('click', async () => {
    const newPw   = inputs.newPassword?.value     || '';
    const confirm = inputs.confirmPassword?.value || '';
    hideError();

    if (!newPw || !confirm) { showError('Por favor, preencha todos os campos.'); return; }
    if (newPw.length < 8 || newPw.length > 128) { showError('A senha deve ter entre 8 e 128 caracteres.'); return; }
    if (!/[A-Za-z]/.test(newPw) || !/[0-9]/.test(newPw)) { showError('A senha deve conter letras e números.'); return; }
    if (newPw !== confirm) {
        showError('As senhas não coincidem.');
        inputs.newPassword?.classList.add('input-error-border');
        inputs.confirmPassword?.classList.add('input-error-border');
        setTimeout(() => {
            inputs.newPassword?.classList.remove('input-error-border');
            inputs.confirmPassword?.classList.remove('input-error-border');
        }, 2000);
        return;
    }
    if (!RecoveryState.isValid()) {
        showError('Sessão de recuperação expirada. Reinicie o processo.');
        setTimeout(() => { _clearRecovery(); switchScreen(screens.newPassword, screens.login); }, 2000);
        return;
    }

    setLoading(buttons.changePassword, 'Alterando...');
    try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-and-reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({
                email:       RecoveryState.getEmail(),
                code:        RecoveryState.getCode(),
                newPassword: newPw,
            }),
        });
        if (!res.ok) { showError('Erro de conexão. Tente novamente.'); return; }
        const data = await res.json();

        if (data.status === 'success') {
            RecoveryState.clear();
            switchScreen(screens.newPassword, screens.success);
        } else if (data.status === 'invalid_code') {
            showError('Código inválido, expirado ou já utilizado.');
            RecoveryState.clearCode();
        } else {
            showError('Não foi possível alterar a senha. Tente novamente.');
        }
    } catch { showError('Erro de conexão. Tente novamente.'); }
    finally   { restoreButton(buttons.changePassword); }
});

buttons.backToLoginFinal?.addEventListener('click', () => {
    _clearRecovery();
    switchScreen(screens.success, screens.login);
});

// ═══════════════════════════════════════════════════════════════
//  REENVIAR CÓDIGO
// ═══════════════════════════════════════════════════════════════
buttons.resendCode?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!RecoveryState.getEmail()) {
        showAuthMessage('Email não encontrado. Volte e tente novamente.', 'error');
        return;
    }
    if (Cooldown.isActive(CONFIG.KEYS.resendCooldown)) {
        showAuthMessage('Aguarde antes de reenviar o código.', 'error');
        return;
    }
    const btn = buttons.resendCode;
    const orig = sanitize(btn.textContent);
    btn.disabled = true; btn.textContent = 'Enviando...';

    try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ email: RecoveryState.getEmail() }),
        });
        if (!res.ok) { showAuthMessage('Erro de conexão. Tente novamente.', 'error'); return; }
        const data = await res.json();

        if (data.status === 'sent') {
            Cooldown.set(CONFIG.KEYS.resendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
            showAuthMessage('Novo código enviado!', 'success');
            btn.textContent = 'Código enviado!';
            _resetCodeBoxes();
            inputs.codeBoxes[0]?.focus();
            setTimeout(() => { btn.textContent = orig; }, 3000);
        } else {
            showAuthMessage('Erro ao reenviar o código.', 'error');
        }
    } catch { showAuthMessage('Erro de conexão.', 'error'); }
    finally   { btn.disabled = false; }
});

// ═══════════════════════════════════════════════════════════════
//  LIMPEZA DO ESTADO DE RECUPERAÇÃO
// ═══════════════════════════════════════════════════════════════
function _clearRecovery() {
    RecoveryState.clear();
    if (inputs.recoveryEmail)   inputs.recoveryEmail.value   = '';
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    _resetCodeBoxes();
    hideError();
}

// ═══════════════════════════════════════════════════════════════
//  INPUTS DE CÓDIGO
// ═══════════════════════════════════════════════════════════════
inputs.codeBoxes.forEach((box, i) => {
    box.addEventListener('input', (e) => {
        const v = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = v;
        if (v.length === 1) {
            box.classList.add('filled');
            inputs.codeBoxes[i + 1]?.focus();
        } else { box.classList.remove('filled'); }

        const full = Array.from(inputs.codeBoxes).every(b => b.value.length === 1);
        if (full) {
            buttons.verifyCode?.classList.add('pulse');
            setTimeout(() => buttons.verifyCode?.classList.remove('pulse'), 200);
        }
    });
    box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
            const prev = inputs.codeBoxes[i - 1];
            prev.focus(); prev.value = ''; prev.classList.remove('filled');
        }
        if (e.key === 'Enter') buttons.verifyCode?.click();
    });
    box.addEventListener('keypress', (e) => { if (!/[0-9]/.test(e.key)) e.preventDefault(); });
    box.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
        pasted.split('').forEach((ch, j) => {
            if (inputs.codeBoxes[j]) { inputs.codeBoxes[j].value = ch; inputs.codeBoxes[j].classList.add('filled'); }
        });
        const last = Math.min(pasted.length - 1, 5);
        if (last >= 0) inputs.codeBoxes[last].focus();
    });
});

function _resetCodeBoxes() {
    inputs.codeBoxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
}

// ═══════════════════════════════════════════════════════════════
//  ATALHOS DE TECLADO
// ═══════════════════════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement === inputs.loginEmail) {
        e.preventDefault();
        inputs.loginPassword?.focus();
    }
});
inputs.newPassword?.addEventListener('keypress',     (e) => { if (e.key === 'Enter') inputs.confirmPassword?.focus(); });
inputs.confirmPassword?.addEventListener('keypress', (e) => { if (e.key === 'Enter') buttons.changePassword?.click(); });
inputs.recoveryEmail?.addEventListener('keypress',   (e) => { if (e.key === 'Enter') buttons.sendCode?.click(); });

// ═══════════════════════════════════════════════════════════════
//  RIPPLE NOS BOTÕES
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
        const r    = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const sz   = Math.max(rect.width, rect.height);
        r.style.cssText = [
            'position:absolute',
            `width:${sz}px`, `height:${sz}px`,
            'border-radius:50%',
            'background:rgba(0,0,0,0.18)',
            `left:${e.clientX - rect.left - sz / 2}px`,
            `top:${e.clientY - rect.top  - sz / 2}px`,
            'pointer-events:none',
            'animation:ripple 0.55s ease-out forwards',
        ].join(';');
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(r);
        setTimeout(() => r.remove(), 560);
    });
});