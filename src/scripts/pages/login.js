import { supabase, SUPABASE_ANON_KEY } from '../services/supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  [TT-POLICY-1] TRUSTED TYPES — POLÍTICA granaevo-policy
// ═══════════════════════════════════════════════════════════════
const _trustedPolicy = (() => {
    if (typeof window.trustedTypes?.createPolicy !== 'function') return null;
    try {
        return window.trustedTypes.createPolicy('granaevo-policy', {
            createHTML: (input) => input,
        });
    } catch {
        return null;
    }
})();

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
    moneyParticleCount:                15,
    chartLineCount:                     8,
    MAX_LOGIN_ATTEMPTS_BEFORE_CAPTCHA:  3,
    MAX_CODE_ATTEMPTS_BEFORE_CAPTCHA:   3,  // CAPTCHA na tela de código após N erros
    MESSAGE_AUTO_HIDE_MS:            5000,
    SEND_CODE_COOLDOWN_MS:          30_000,
    RATE_LIMIT_MAX:                     10,
    RATE_LIMIT_WINDOW_MS:           60_000,
    CAPTCHA_TOKEN_MAX_AGE_MS:      110_000,
    CAPTCHA_TOKEN_MIN_LENGTH:           50,
    CAPTCHA_SITE_KEY: '6Lfxo3IsAAAAAFpfVxePWUYsyKjeWbP7PoXC3Hye',
    KEYS: Object.freeze({
        loginAttempts:  '_ge_la',
        codeAttempts:   '_ge_ca',   // tentativas erradas de código OTP
        sendCooldown:   '_ge_scc',
        resendCooldown: '_ge_rcc',
        submitRateLog:  '_ge_srl',
    }),
    SUPABASE_URL: 'https://fvrhqqeofqedmhadzzqw.supabase.co',
});

// ═══════════════════════════════════════════════════════════════
//  MENSAGEM DE ERRO GENÉRICA DE LOGIN
//  Toda falha de autenticação exibe esta mesma mensagem.
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

function _publicHeader() {
    return `Bearer ${SUPABASE_ANON_KEY}`;
}

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — WIDGET IDs
// ═══════════════════════════════════════════════════════════════
let _loginCaptchaWidgetId      = null;
let _loginCaptchaRenderAttempt = 0;
let _codeCaptchaWidgetId       = null;
let _codeCaptchaRenderAttempt  = 0;
const _CAPTCHA_MAX_RENDER_ATTEMPTS = 3;

// ═══════════════════════════════════════════════════════════════
//  FACTORY: CaptchaStateFactory
//  Cria um módulo de estado de captcha para um dado widget.
//  Usado para o captcha do login E para o captcha da tela de código.
// ═══════════════════════════════════════════════════════════════
function _createCaptchaState(resolvedCallbackName, expiredCallbackName, errorCallbackName, getWidgetId) {
    let _token      = null;
    let _resolved   = false;
    let _resolvedAt = 0;
    let _active     = false;

    window[resolvedCallbackName] = (token) => {
        if (!_active) return;
        if (typeof token !== 'string' || token.length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return;
        if (typeof grecaptcha === 'undefined') return;
        try {
            const widgetId = getWidgetId();
            const widgetResponse = grecaptcha.getResponse(widgetId ?? undefined);
            if (!widgetResponse || widgetResponse !== token) return;
            _token = token; _resolved = true; _resolvedAt = Date.now();
        } catch {
            _token = null; _resolved = false; _resolvedAt = 0;
        }
    };

    window[expiredCallbackName] = () => { _token = null; _resolved = false; _resolvedAt = 0; };
    window[errorCallbackName]   = () => { _token = null; _resolved = false; _resolvedAt = 0; };

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
                const widgetId = getWidgetId();
                if (widgetId !== null) grecaptcha.reset(widgetId);
                else grecaptcha.reset();
            } catch {}
        },
    };
}

const LoginCaptchaState = _createCaptchaState(
    'onLoginCaptchaResolved',
    'onLoginCaptchaExpired',
    'onLoginCaptchaError',
    () => _loginCaptchaWidgetId,
);

const CodeCaptchaState = _createCaptchaState(
    'onCodeCaptchaResolved',
    'onCodeCaptchaExpired',
    'onCodeCaptchaError',
    () => _codeCaptchaWidgetId,
);

// ═══════════════════════════════════════════════════════════════
//  RECOVERY STATE
// ═══════════════════════════════════════════════════════════════
const RecoveryState = (() => {
    let _email = '';
    let _code  = '';
    return {
        getEmail:   ()  => _email,
        getCode:    ()  => _code,
        setEmail:   (v) => { _email = String(v ?? '').trim(); },
        setCode:    (v) => { _code  = String(v ?? '').trim(); },
        clearEmail: ()  => { _email = ''; },
        clearCode:  ()  => { _code  = ''; },
        clear:      ()  => { _email = ''; _code = ''; },
        hasEmail:   ()  => _email.length > 0,
        isValid:    ()  => _email.length > 0 && _code.length === 6,
    };
})();

// ═══════════════════════════════════════════════════════════════
//  TENTATIVAS DE LOGIN
// ═══════════════════════════════════════════════════════════════
const LoginAttempts = {
    get()   { return parseInt(sessionStorage.getItem(CONFIG.KEYS.loginAttempts) || '0', 10); },
    set(n)  { sessionStorage.setItem(CONFIG.KEYS.loginAttempts, String(Math.max(0, n))); },
    inc()   { this.set(this.get() + 1); },
    reset() { sessionStorage.removeItem(CONFIG.KEYS.loginAttempts); },
};

// ═══════════════════════════════════════════════════════════════
//  TENTATIVAS DE CÓDIGO OTP
//  Controla quando exibir o captcha na tela de código.
// ═══════════════════════════════════════════════════════════════
const CodeAttempts = {
    get()   { return parseInt(sessionStorage.getItem(CONFIG.KEYS.codeAttempts) || '0', 10); },
    set(n)  { sessionStorage.setItem(CONFIG.KEYS.codeAttempts, String(Math.max(0, n))); },
    inc()   { this.set(this.get() + 1); },
    reset() { sessionStorage.removeItem(CONFIG.KEYS.codeAttempts); },
};

// ═══════════════════════════════════════════════════════════════
//  COOLDOWN ANTI-FLOOD
// ═══════════════════════════════════════════════════════════════
const Cooldown = {
    isActive(key) {
        const until = parseInt(sessionStorage.getItem(key) || '0', 10);
        return Date.now() < until;
    },
    set(key, ms) {
        sessionStorage.setItem(key, String(Date.now() + ms));
    },
    remaining(key) {
        const until = parseInt(sessionStorage.getItem(key) || '0', 10);
        return Math.max(0, Math.ceil((until - Date.now()) / 1000));
    },
};

// ═══════════════════════════════════════════════════════════════
//  RATE LIMITER DE SUBMISSÃO
// ═══════════════════════════════════════════════════════════════
const SubmitRateLimiter = {
    isAllowed() {
        const now         = Date.now();
        const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;
        let log;
        try {
            log = JSON.parse(sessionStorage.getItem(CONFIG.KEYS.submitRateLog) || '[]');
        } catch {
            log = [];
        }
        log = log.filter(ts => ts > windowStart);
        if (log.length >= CONFIG.RATE_LIMIT_MAX) return false;
        log.push(now);
        try { sessionStorage.setItem(CONFIG.KEYS.submitRateLog, JSON.stringify(log)); } catch {}
        return true;
    },
};

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════
function sanitizeText(value) {
    return String(value ?? '').trim();
}

function isValidEmail(email) {
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ═══════════════════════════════════════════════════════════════
//  RESTAURAÇÃO DE BOTÕES (TRUSTED TYPES)
// ═══════════════════════════════════════════════════════════════
const _buttonOriginalHTML = new WeakMap();

function _captureButtonHTML(btn) {
    if (btn && !_buttonOriginalHTML.has(btn)) {
        _buttonOriginalHTML.set(btn, btn.innerHTML);
    }
}

function restoreButton(btn) {
    btn.disabled = false;
    const original = _buttonOriginalHTML.get(btn);
    if (original === undefined) return;
    if (_trustedPolicy) {
        btn.innerHTML = _trustedPolicy.createHTML(original);
    } else {
        btn.innerHTML = original;
    }
}

// ═══════════════════════════════════════════════════════════════
//  SPINNER
// ═══════════════════════════════════════════════════════════════
function createSpinnerElement(labelText) {
    const wrapper = document.createDocumentFragment();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('loading-svg');

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
    circle.setAttribute('stroke', 'currentColor'); circle.setAttribute('stroke-width', '4');
    circle.setAttribute('fill', 'none'); circle.setAttribute('opacity', '0.25');
    svg.appendChild(circle);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 2a10 10 0 0 1 10 10');
    path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '4');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);

    wrapper.appendChild(svg);
    wrapper.appendChild(document.createTextNode(' ' + sanitizeText(labelText)));
    return wrapper;
}

function setButtonLoading(btn, loadingText) {
    btn.disabled    = true;
    btn.textContent = '';
    btn.appendChild(createSpinnerElement(loadingText));
}

// ═══════════════════════════════════════════════════════════════
//  ELEMENTOS DO DOM
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
    codeInputs:      document.querySelectorAll('.code-input'),
    newPassword:     document.getElementById('newPassword'),
    confirmPassword: document.getElementById('confirmPassword'),
});

const loginForm    = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');
const togglePassword = document.getElementById('togglePassword');

// ═══════════════════════════════════════════════════════════════
//  MENSAGENS
// ═══════════════════════════════════════════════════════════════
let _messageTimer = null;

function showAuthMessage(message, type) {
    const el = document.getElementById('authErrorMessage');
    if (!el) return;
    if (_messageTimer) { clearTimeout(_messageTimer); _messageTimer = null; }
    el.textContent = sanitizeText(message);
    el.className   = `auth-message ${type} visible show`;
    _messageTimer = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => { el.classList.remove('visible'); el.textContent = ''; }, 300);
    }, CONFIG.MESSAGE_AUTO_HIDE_MS);
}

function showError(message) {
    if (!errorMessage) return;
    errorMessage.textContent = sanitizeText(message);
    errorMessage.classList.add('show');
}

function hideError() {
    if (!errorMessage) return;
    errorMessage.classList.remove('show');
    setTimeout(() => { errorMessage.textContent = ''; }, 300);
}

// ═══════════════════════════════════════════════════════════════
//  SHAKE
// ═══════════════════════════════════════════════════════════════
function shakeInput(input) {
    if (!input) return;
    input.classList.add('input-shake');
    setTimeout(() => input.classList.remove('input-shake'), 500);
}

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — RENDER GENÉRICO
//  Renderiza um widget em qualquer container.
// ═══════════════════════════════════════════════════════════════
function _renderCaptchaInContainer(containerId, callbacks, getWidgetId, setWidgetId, getRenderAttempt, setRenderAttempt) {

    // Widget já existe e é válido
    if (getWidgetId() !== null) return;

    if (typeof grecaptcha === 'undefined') {
        console.warn(`[reCAPTCHA:${containerId}] API não carregada — aguardando`);
        if (containerId === 'captchaContainer') window.__grPendingRender = () => _renderCaptchaInContainer(containerId, callbacks, getWidgetId, setWidgetId, getRenderAttempt, setRenderAttempt);
        return;
    }

    const el = document.getElementById(containerId);
    if (!el) { console.error(`[reCAPTCHA] #${containerId} não encontrado`); return; }

    const computedDisplay = window.getComputedStyle(el).display;
    if (computedDisplay === 'none') {
        console.warn(`[reCAPTCHA:${containerId}] Container oculto no momento do render`);
        return;
    }

    const container = el.querySelector('.g-recaptcha');
    if (!container) { console.error(`[reCAPTCHA] .g-recaptcha não encontrado em #${containerId}`); return; }

    while (container.firstChild) container.removeChild(container.firstChild);

    try {
        grecaptcha.ready(() => {
            if (getWidgetId() !== null) return;

            const currentEl = document.getElementById(containerId);
            if (!currentEl) return;
            if (window.getComputedStyle(currentEl).display === 'none') return;
            const currentContainer = currentEl.querySelector('.g-recaptcha');
            if (!currentContainer) return;

            try {
                const widgetId = grecaptcha.render(currentContainer, {
                    sitekey:            CONFIG.CAPTCHA_SITE_KEY,
                    callback:           callbacks.resolved,
                    'expired-callback': callbacks.expired,
                    'error-callback':   callbacks.error,
                    theme:              'dark',
                });
                setWidgetId(widgetId);

                setTimeout(() => {
                    const iframe = currentContainer.querySelector('iframe');
                    if (!iframe || iframe.offsetWidth === 0) {
                        console.warn(`[reCAPTCHA:${containerId}] Iframe 0x0 — tentando novamente`);
                        while (currentContainer.firstChild) currentContainer.removeChild(currentContainer.firstChild);
                        setWidgetId(null);
                        const attempt = getRenderAttempt() + 1;
                        setRenderAttempt(attempt);
                        if (attempt <= _CAPTCHA_MAX_RENDER_ATTEMPTS) {
                            setTimeout(() => _renderCaptchaInContainer(containerId, callbacks, getWidgetId, setWidgetId, getRenderAttempt, setRenderAttempt), attempt * 500);
                        }
                    }
                }, 600);

            } catch (err) {
                console.error(`[reCAPTCHA:${containerId}] render() falhou:`, err);
                setWidgetId(null);
                const attempt = getRenderAttempt() + 1;
                setRenderAttempt(attempt);
                if (attempt <= _CAPTCHA_MAX_RENDER_ATTEMPTS) {
                    setTimeout(() => _renderCaptchaInContainer(containerId, callbacks, getWidgetId, setWidgetId, getRenderAttempt, setRenderAttempt), attempt * 500);
                }
            }
        });
    } catch (err) {
        console.error(`[reCAPTCHA:${containerId}] ready() falhou:`, err);
    }
}

// ── Captcha do login ──────────────────────────────────────────
function _renderLoginCaptcha() {
    _renderCaptchaInContainer(
        'captchaContainer',
        { resolved: 'onLoginCaptchaResolved', expired: 'onLoginCaptchaExpired', error: 'onLoginCaptchaError' },
        () => _loginCaptchaWidgetId,
        (id) => { _loginCaptchaWidgetId = id; },
        () => _loginCaptchaRenderAttempt,
        (n) => { _loginCaptchaRenderAttempt = n; },
    );
}

// ── Captcha da tela de código ─────────────────────────────────
function _renderCodeCaptcha() {
    _renderCaptchaInContainer(
        'codeCaptchaContainer',
        { resolved: 'onCodeCaptchaResolved', expired: 'onCodeCaptchaExpired', error: 'onCodeCaptchaError' },
        () => _codeCaptchaWidgetId,
        (id) => { _codeCaptchaWidgetId = id; },
        () => _codeCaptchaRenderAttempt,
        (n) => { _codeCaptchaRenderAttempt = n; },
    );
}

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — SHOW / HIDE
// ═══════════════════════════════════════════════════════════════
function _showCaptchaContainer(containerId, captchaState, renderFn, getWidgetId, setWidgetId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.style.display = '';
    el.classList.remove('captcha-hidden');
    el.classList.add('captcha-visible');
    captchaState.activate();

    if (getWidgetId() !== null) {
        const container = el.querySelector('.g-recaptcha');
        const iframe    = container ? container.querySelector('iframe') : null;
        if (!iframe || iframe.offsetWidth === 0) {
            try { if (typeof grecaptcha !== 'undefined') grecaptcha.reset(getWidgetId()); } catch {}
            if (container) while (container.firstChild) container.removeChild(container.firstChild);
            setWidgetId(null);
        }
    }

    if (getWidgetId() !== null) return;
    setTimeout(renderFn, 100);
}

function _hideCaptchaContainer(containerId, captchaState) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.style.display = '';
    el.classList.remove('captcha-visible');
    el.classList.add('captcha-hidden');
    captchaState.deactivate();
}

function showLoginCaptcha() {
    _showCaptchaContainer(
        'captchaContainer', LoginCaptchaState, _renderLoginCaptcha,
        () => _loginCaptchaWidgetId, (id) => { _loginCaptchaWidgetId = id; },
    );
}
function hideLoginCaptcha() { _hideCaptchaContainer('captchaContainer', LoginCaptchaState); }
function highlightLoginCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.classList.add('captcha-error');
    setTimeout(() => el.classList.remove('captcha-error'), 2000);
}

function showCodeCaptcha() {
    _showCaptchaContainer(
        'codeCaptchaContainer', CodeCaptchaState, _renderCodeCaptcha,
        () => _codeCaptchaWidgetId, (id) => { _codeCaptchaWidgetId = id; },
    );
}
function hideCodeCaptcha() { _hideCaptchaContainer('codeCaptchaContainer', CodeCaptchaState); }
function highlightCodeCaptcha() {
    const el = document.getElementById('codeCaptchaContainer');
    if (!el) return;
    el.classList.add('captcha-error');
    setTimeout(() => el.classList.remove('captcha-error'), 2000);
}

// ═══════════════════════════════════════════════════════════════
//  VERIFICAÇÃO DE CAPTCHA NO BACKEND (para o login)
// ═══════════════════════════════════════════════════════════════
async function validateLoginCaptchaOnBackend(token) {
    if (!token || typeof token !== 'string' || token.trim().length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return false;
    try {
        const response = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-recaptcha`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ token: token.trim() }),
        });
        if (!response.ok) return false;
        const result = await response.json();
        return result?.success === true;
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
//  VERIFICAÇÃO DE ACESSO
// ═══════════════════════════════════════════════════════════════
async function checkUserAccess() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id || !session?.access_token) return { hasAccess: false };

        const authHeader = await _requireSessionHeader();
        const response   = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/check-user-access`, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
                'apikey': SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ user_id: session.user.id }),
        });
        if (!response.ok) return { hasAccess: false };
        const result = await response.json();
        return { hasAccess: result?.hasAccess === true };
    } catch {
        return { hasAccess: false };
    }
}

// ═══════════════════════════════════════════════════════════════
//  LOADING SCREEN
// ═══════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
        setTimeout(() => loadingScreen.classList.add('hidden'), 1200);
    }
});

// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {

    // Estado inicial dos captchas
    ['captchaContainer', 'codeCaptchaContainer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = '';
            el.classList.remove('captcha-visible');
            el.classList.add('captcha-hidden');
        }
    });

    Object.values(buttons).forEach(btn => {
        if (btn instanceof HTMLElement) _captureButtonHTML(btn);
    });

    // Sessão existente → dashboard
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) { window.location.replace('dashboard.html'); return; }
    } catch {}

    // Exibe captcha se já havia tentativas suficientes
    if (LoginAttempts.get() >= CONFIG.MAX_LOGIN_ATTEMPTS_BEFORE_CAPTCHA) showLoginCaptcha();
    if (CodeAttempts.get()  >= CONFIG.MAX_CODE_ATTEMPTS_BEFORE_CAPTCHA)  showCodeCaptcha();

    createMoneyParticles();
    createAnimatedCharts();

    const authError = sessionStorage.getItem('auth_error');
    if (authError) {
        showAuthMessage(sanitizeText(authError), 'error');
        sessionStorage.removeItem('auth_error');
    }

    _registerKeyboardShortcuts();
});

// ═══════════════════════════════════════════════════════════════
//  FORMULÁRIO DE LOGIN
//
//  [FIX-LOGIN-1] Zero validação de formato/tamanho de senha.
//  [FIX-LOGIN-2] Toda falha de autenticação conta como tentativa
//                (exceto erro de rede).
// ═══════════════════════════════════════════════════════════════
function _registerFailedLoginAttempt() {
    LoginAttempts.inc();
    if (LoginAttempts.get() >= CONFIG.MAX_LOGIN_ATTEMPTS_BEFORE_CAPTCHA) showLoginCaptcha();
}

loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!SubmitRateLimiter.isAllowed()) {
        showAuthMessage('Muitas tentativas em pouco tempo. Aguarde um momento.', 'error');
        return;
    }

    const email    = sanitizeText(inputs.loginEmail.value);
    const password = inputs.loginPassword.value; // NÃO apara — espaços são válidos em senha

    if (!email || !isValidEmail(email)) {
        inputs.loginPassword.value = '';
        _registerFailedLoginAttempt();
        showAuthMessage(LOGIN_ERROR_MSG, 'error');
        shakeInput(inputs.loginEmail);
        shakeInput(inputs.loginPassword);
        return;
    }

    if (!password) {
        _registerFailedLoginAttempt();
        showAuthMessage(LOGIN_ERROR_MSG, 'error');
        shakeInput(inputs.loginPassword);
        return;
    }

    // Captcha obrigatório após N tentativas
    if (LoginAttempts.get() >= CONFIG.MAX_LOGIN_ATTEMPTS_BEFORE_CAPTCHA) {
        if (!LoginCaptchaState.isResolved()) {
            showAuthMessage('Por favor, resolva a verificação de segurança.', 'error');
            highlightLoginCaptcha();
            return;
        }
        showAuthMessage('Verificando segurança...', 'info');
        const captchaValid = await validateLoginCaptchaOnBackend(LoginCaptchaState.getToken());
        if (!captchaValid) {
            showAuthMessage('Falha na verificação de segurança. Tente novamente.', 'error');
            LoginCaptchaState.reset();
            return;
        }
    }

    const submitBtn = buttons.loginSubmit;
    setButtonLoading(submitBtn, 'Verificando...');

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            inputs.loginPassword.value = '';
            LoginCaptchaState.reset();
            _registerFailedLoginAttempt();
            showAuthMessage(LOGIN_ERROR_MSG, 'error');
            shakeInput(inputs.loginEmail);
            shakeInput(inputs.loginPassword);
            return;
        }

        // Login bem-sucedido
        LoginAttempts.reset();
        LoginCaptchaState.reset();
        hideLoginCaptcha();

        setButtonLoading(submitBtn, 'Verificando plano...');
        const { hasAccess } = await checkUserAccess();

        if (!hasAccess) {
            await supabase.auth.signOut();
            showAuthMessage('Você precisa de um plano ativo para acessar o sistema.', 'error');
            setTimeout(() => window.location.replace('planos.html'), 2500);
            return;
        }

        inputs.loginPassword.value = '';
        inputs.loginEmail.value    = '';

        const userName = sanitizeText(data.user.user_metadata?.name || 'Usuário');
        showAuthMessage(`Bem-vindo de volta, ${userName}!`, 'success');
        setTimeout(() => window.location.replace('dashboard.html'), 1500);

    } catch {
        // Erro de rede — não penaliza o usuário
        showAuthMessage('Erro de conexão. Verifique sua internet e tente novamente.', 'error');
    } finally {
        restoreButton(submitBtn);
    }
});

// ═══════════════════════════════════════════════════════════════
//  TOGGLE DE SENHA
// ═══════════════════════════════════════════════════════════════
if (togglePassword && inputs.loginPassword) {
    togglePassword.addEventListener('click', () => {
        const isPassword = inputs.loginPassword.type === 'password';
        inputs.loginPassword.type = isPassword ? 'text' : 'password';
        togglePassword.setAttribute('aria-label',   isPassword ? 'Ocultar senha' : 'Mostrar senha');
        togglePassword.setAttribute('aria-pressed', String(isPassword));
    });
}

// ═══════════════════════════════════════════════════════════════
//  NAVEGAÇÃO ENTRE TELAS
// ═══════════════════════════════════════════════════════════════
function switchScreen(currentScreen, nextScreen) {
    Object.values(screens).forEach(s => {
        s.classList.remove('active', 'exit-left');
        s.setAttribute('aria-hidden', 'true');
    });
    if (currentScreen) {
        currentScreen.classList.add('exit-left');
        setTimeout(() => {
            currentScreen.classList.remove('active', 'exit-left');
            nextScreen.classList.add('active');
            nextScreen.setAttribute('aria-hidden', 'false');
        }, 500);
    } else {
        nextScreen.classList.add('active');
        nextScreen.setAttribute('aria-hidden', 'false');
    }
}

if (buttons.forgotPassword) {
    buttons.forgotPassword.addEventListener('click', (e) => {
        e.preventDefault();
        switchScreen(screens.login, screens.forgotEmail);
        setTimeout(() => inputs.recoveryEmail?.focus(), 520);
    });
}

if (buttons.backToLogin) {
    buttons.backToLogin.addEventListener('click', () => {
        _clearRecoveryState();
        switchScreen(screens.forgotEmail, screens.login);
    });
}

// ═══════════════════════════════════════════════════════════════
//  ENVIAR CÓDIGO DE RECUPERAÇÃO
//
//  [FIX-SEND-DEFINITIVO] A raiz do bug era que send-password-reset-code
//  retornava { status: 'sent' } para TODOS os emails (inclusive
//  inválidos), como medida de segurança anti-enumeração no backend.
//  Por isso, qualquer lógica de verificação no retorno dessa função
//  nunca funcionaria — ela sempre retorna 'sent'.
//
//  SOLUÇÃO: Antes de chamar send-password-reset-code, chamamos
//  check-email-status, que retorna os status corretos (not_found,
//  payment_pending, ready, password_exists).
//  Somente se o email for válido e tiver subscription ativa com
//  pagamento aprovado (status 'ready' ou 'password_exists') é que
//  avançamos para enviar o código e redirecionar para a tela de código.
//  Qualquer outro status mantém o usuário na tela de email com a
//  mensagem "Email não cadastrado ou inexistente.".
//
//  [FIX-SEND-1] not_found, payment_pending, payment_not_approved e
//  qualquer outro status não-válido: mensagem genérica, fica na tela.
//  [FIX-SEND-2] Erros de rede ou resposta HTTP não-ok: fica na tela.
// ═══════════════════════════════════════════════════════════════
if (buttons.sendCode) {
    buttons.sendCode.addEventListener('click', async () => {
        const email = sanitizeText(inputs.recoveryEmail?.value || '');

        if (!email || !isValidEmail(email)) {
            inputs.recoveryEmail?.classList.add('input-error-border');
            setTimeout(() => inputs.recoveryEmail?.classList.remove('input-error-border'), 2000);
            shakeInput(inputs.recoveryEmail);
            showAuthMessage('Digite um email válido.', 'error');
            return;
        }

        if (Cooldown.isActive(CONFIG.KEYS.sendCooldown)) {
            const remaining = Cooldown.remaining(CONFIG.KEYS.sendCooldown);
            showAuthMessage(`Aguarde ${remaining}s antes de solicitar um novo código.`, 'error');
            return;
        }

        setButtonLoading(buttons.sendCode, 'Verificando...');

        try {
            // ── ETAPA 1: Verificar se o email existe e tem pagamento aprovado ──
            // [FIX-SEND-DEFINITIVO] Esta chamada é o gate de validação.
            // check-email-status retorna status confiáveis (not_found,
            // payment_pending, ready, password_exists) ao contrário de
            // send-password-reset-code que sempre retorna 'sent'.
            let checkResult;
            try {
                const checkResponse = await fetch(
                    '/api/check-email',
                    {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email }),
                    }
                );

                // [FIX-SEND-2] Resposta HTTP não-ok → permanece na tela de email
                if (!checkResponse.ok) {
                    shakeInput(inputs.recoveryEmail);
                    showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                    return;
                }

                checkResult = await checkResponse.json();
            } catch {
                // Erro de rede na verificação → permanece na tela de email
                shakeInput(inputs.recoveryEmail);
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            // [FIX-SEND-1] Apenas 'ready' e 'password_exists' indicam email válido
            // com subscription ativa e pagamento aprovado — qualquer outro status
            // exibe mensagem genérica e mantém o usuário na tela de email.
            //
            // 'ready'           → email válido, pagamento OK, ainda não criou senha
            // 'password_exists' → email válido, pagamento OK, senha já criada (recuperação normal)
            // 'not_found'       → email não existe nas subscriptions
            // 'payment_pending' → email existe mas pagamento não aprovado
            // 'error'           → erro interno no backend
            const emailIsValid = (
                checkResult.status === 'ready' ||
                checkResult.status === 'password_exists'
            );

            if (!emailIsValid) {
                // [FIX-SEND-1] Mensagem genérica — não revela se o email existe
                // ou qual é o motivo da rejeição (anti-enumeração).
                shakeInput(inputs.recoveryEmail);
                showAuthMessage('Email não cadastrado ou inexistente.', 'error');
                return;
            }

            // ── ETAPA 2: Email válido — agora sim envia o código ──────────────
            setButtonLoading(buttons.sendCode, 'Enviando...');

            let sendResult;
            try {
                const sendResponse = await fetch(
                    '/api/reset-password',
                    {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ step: 'send', email }),
                    }
                );

                // [FIX-SEND-2] Resposta HTTP não-ok → permanece na tela de email
                if (!sendResponse.ok) {
                    shakeInput(inputs.recoveryEmail);
                    showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                    return;
                }

                sendResult = await sendResponse.json();
            } catch {
                // Erro de rede no envio → permanece na tela de email
                shakeInput(inputs.recoveryEmail);
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            if (sendResult.status === 'sent') {
                // Único caminho que avança para a tela de código
                RecoveryState.setEmail(email);
                CodeAttempts.reset();        // zera tentativas ao enviar novo código
                Cooldown.set(CONFIG.KEYS.sendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
                showAuthMessage('Código enviado! Verifique seu email.', 'success');
                switchScreen(screens.forgotEmail, screens.code);
                setTimeout(() => inputs.codeInputs[0]?.focus(), 520);
            } else {
                // [FIX-SEND-2] Qualquer outro status inesperado: fica na tela de email
                shakeInput(inputs.recoveryEmail);
                showAuthMessage('Não foi possível enviar o código. Tente novamente.', 'error');
            }

        } finally {
            restoreButton(buttons.sendCode);
        }
    });
}

if (buttons.backToEmail) {
    buttons.backToEmail.addEventListener('click', () => {
        resetCodeInputs();
        hideCodeCaptcha();
        CodeAttempts.reset();
        switchScreen(screens.code, screens.forgotEmail);
    });
}

// ═══════════════════════════════════════════════════════════════
//  VERIFICAR CÓDIGO
//
//  [FIX-CODE-1] Chama o backend com action='verify_code'.
//  O código NÃO é armazenado localmente até ser validado.
//  [FIX-CODE-2] Após MAX_CODE_ATTEMPTS_BEFORE_CAPTCHA erros,
//  exibe CAPTCHA obrigatório. O token é enviado junto à requisição
//  e verificado pelo backend.
//  [FIX-CODE-3] Toda resposta de código errado exibe apenas
//  "Código inválido." — sem revelar contagem de tentativas.
//  [FIX-CODE-4] resetCodeInputs() é chamado APÓS showAuthMessage(),
//  garantindo que a mensagem de erro apareça antes de limpar os campos.
// ═══════════════════════════════════════════════════════════════
if (buttons.verifyCode) {
    buttons.verifyCode.addEventListener('click', async () => {
        const code = Array.from(inputs.codeInputs).map(i => i.value).join('');

        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            showAuthMessage('Digite o código completo de 6 dígitos.', 'error');
            Array.from(inputs.codeInputs).forEach(i => shakeInput(i));
            return;
        }

        if (!RecoveryState.hasEmail()) {
            showAuthMessage('Sessão expirada. Volte e informe seu email novamente.', 'error');
            return;
        }

        // Verifica se CAPTCHA é necessário
        const codeAttempts = CodeAttempts.get();
        if (codeAttempts >= CONFIG.MAX_CODE_ATTEMPTS_BEFORE_CAPTCHA) {
            if (!CodeCaptchaState.isResolved()) {
                showAuthMessage('Por favor, resolva a verificação de segurança.', 'error');
                showCodeCaptcha();
                highlightCodeCaptcha();
                return;
            }
        }

        setButtonLoading(buttons.verifyCode, 'Verificando...');

        try {
            const body = {
                step:  'verify_code',
                email: RecoveryState.getEmail(),
                code,
                ...(CodeCaptchaState.getToken() ? { captchaToken: CodeCaptchaState.getToken() } : {}),
            };

            const response = await fetch(
                '/api/reset-password',
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }
            );

            if (!response.ok) {
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            const result = await response.json();

            if (result.status === 'code_valid') {
                // Código correto — armazena e avança para nova senha
                RecoveryState.setCode(code);
                CodeAttempts.reset();
                CodeCaptchaState.reset();
                hideCodeCaptcha();
                switchScreen(screens.code, screens.newPassword);
                setTimeout(() => inputs.newPassword?.focus(), 520);

            } else if (result.status === 'captcha_required') {
                // [FIX-CODE-3] Backend exige CAPTCHA — mostra o widget e mensagem padronizada
                showCodeCaptcha();
                CodeCaptchaState.reset();
                // [FIX-CODE-4] Exibe mensagem ANTES de resetar os inputs
                showAuthMessage('Código inválido.', 'error');
                resetCodeInputs();
                inputs.codeInputs[0]?.focus();

            } else if (result.status === 'invalid_code') {
                // [FIX-CODE-3] Código errado — sempre exibe "Código inválido."
                CodeAttempts.set(result.attempts ?? CodeAttempts.get() + 1);

                if (result.captcha_required || CodeAttempts.get() >= CONFIG.MAX_CODE_ATTEMPTS_BEFORE_CAPTCHA) {
                    showCodeCaptcha();
                    CodeCaptchaState.reset();
                }

                // [FIX-CODE-4] Exibe mensagem ANTES de resetar os inputs
                showAuthMessage('Código inválido.', 'error');
                resetCodeInputs();
                inputs.codeInputs[0]?.focus();

            } else {
                showAuthMessage('Erro ao verificar código. Tente novamente.', 'error');
            }

        } catch {
            showAuthMessage('Erro de conexão. Tente novamente.', 'error');
        } finally {
            restoreButton(buttons.verifyCode);
        }
    });
}

if (buttons.backToCode) {
    buttons.backToCode.addEventListener('click', () => {
        hideError();
        if (inputs.newPassword)     inputs.newPassword.value     = '';
        if (inputs.confirmPassword) inputs.confirmPassword.value = '';
        switchScreen(screens.newPassword, screens.code);
    });
}

// ═══════════════════════════════════════════════════════════════
//  ALTERAR SENHA
//
//  [FIX-RESET-1] Usa action='reset_password' para verificar o
//  código novamente no backend antes de alterar a senha.
//  Isso garante que ninguém pule a tela de verificação ou
//  manipule o estado local para avançar indevidamente.
// ═══════════════════════════════════════════════════════════════
if (buttons.changePassword) {
    buttons.changePassword.addEventListener('click', async () => {
        const newPass     = inputs.newPassword?.value     || '';
        const confirmPass = inputs.confirmPassword?.value || '';

        hideError();

        if (!newPass || !confirmPass) {
            showError('Por favor, preencha todos os campos.');
            return;
        }

        if (newPass.length < 8 || newPass.length > 128) {
            showError('A senha deve ter entre 8 e 128 caracteres.');
            return;
        }

        if (!/[A-Za-z]/.test(newPass) || !/[0-9]/.test(newPass)) {
            showError('A senha deve conter letras e números.');
            return;
        }

        if (newPass !== confirmPass) {
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
            setTimeout(() => {
                _clearRecoveryState();
                switchScreen(screens.newPassword, screens.login);
            }, 2000);
            return;
        }

        setButtonLoading(buttons.changePassword, 'Alterando...');

        try {
            // [FIX-RESET-1] Envia action='reset_password' — o backend re-verifica
            // o código e só então altera a senha. O código é marcado como usado.
            const response = await fetch(
                '/api/reset-password',
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        step:        'reset_password',
                        email:       RecoveryState.getEmail(),
                        code:        RecoveryState.getCode(),
                        newPassword: newPass,
                    }),
                }
            );

            if (!response.ok) { showError('Erro de conexão. Tente novamente.'); return; }

            const result = await response.json();

            if (result.status === 'success') {
                RecoveryState.clear();
                CodeAttempts.reset();
                switchScreen(screens.newPassword, screens.success);

            } else if (result.status === 'invalid_code') {
                // Código expirou ou foi usado entre verify_code e reset_password
                showError('Código expirado ou inválido. Por favor, solicite um novo código.');
                RecoveryState.clearCode();
                setTimeout(() => switchScreen(screens.newPassword, screens.code), 2500);

            } else {
                showError('Não foi possível alterar a senha. Tente novamente.');
            }

        } catch {
            showError('Erro de conexão. Tente novamente.');
        } finally {
            restoreButton(buttons.changePassword);
        }
    });
}

if (buttons.backToLoginFinal) {
    buttons.backToLoginFinal.addEventListener('click', () => {
        _clearRecoveryState();
        switchScreen(screens.success, screens.login);
    });
}

// ═══════════════════════════════════════════════════════════════
//  REENVIAR CÓDIGO
// ═══════════════════════════════════════════════════════════════
if (buttons.resendCode) {
    buttons.resendCode.addEventListener('click', async (e) => {
        e.preventDefault();

        if (!RecoveryState.hasEmail()) {
            showAuthMessage('Email não encontrado. Volte e informe seu email.', 'error');
            return;
        }

        if (Cooldown.isActive(CONFIG.KEYS.resendCooldown)) {
            const remaining = Cooldown.remaining(CONFIG.KEYS.resendCooldown);
            showAuthMessage(`Aguarde ${remaining}s antes de reenviar.`, 'error');
            return;
        }

        const btn          = buttons.resendCode;
        const originalText = sanitizeText(btn.textContent);
        btn.disabled       = true;
        btn.textContent    = 'Enviando...';

        try {
            const response = await fetch(
                '/api/reset-password',
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ step: 'send', email: RecoveryState.getEmail() }),
                }
            );

            if (!response.ok) { showAuthMessage('Erro de conexão. Tente novamente.', 'error'); return; }

            const result = await response.json();

            if (result.status === 'sent') {
                // Zera tentativas e captcha ao enviar novo código
                CodeAttempts.reset();
                CodeCaptchaState.reset();
                hideCodeCaptcha();

                Cooldown.set(CONFIG.KEYS.resendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
                showAuthMessage('Novo código enviado!', 'success');
                btn.textContent = 'Código enviado!';
                resetCodeInputs();
                inputs.codeInputs[0]?.focus();
                setTimeout(() => { btn.textContent = originalText; }, 3000);
            } else {
                showAuthMessage('Erro ao reenviar o código. Tente novamente.', 'error');
            }

        } catch {
            showAuthMessage('Erro de conexão.', 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  LIMPAR ESTADO DE RECUPERAÇÃO
// ═══════════════════════════════════════════════════════════════
function _clearRecoveryState() {
    RecoveryState.clear();
    CodeAttempts.reset();
    CodeCaptchaState.reset();
    hideCodeCaptcha();
    if (inputs.recoveryEmail)   inputs.recoveryEmail.value   = '';
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    resetCodeInputs();
    hideError();
}

// ═══════════════════════════════════════════════════════════════
//  INPUTS DE CÓDIGO
// ═══════════════════════════════════════════════════════════════
inputs.codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        const value = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = value;
        if (value.length === 1) {
            input.classList.add('filled');
            inputs.codeInputs[index + 1]?.focus();
        } else {
            input.classList.remove('filled');
        }
        const allFilled = Array.from(inputs.codeInputs).every(i => i.value.length === 1);
        if (allFilled && buttons.verifyCode) {
            buttons.verifyCode.classList.add('btn-pulse');
            setTimeout(() => buttons.verifyCode.classList.remove('btn-pulse'), 200);
        }
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) {
            const prev = inputs.codeInputs[index - 1];
            prev.focus(); prev.value = ''; prev.classList.remove('filled');
        }
        if (e.key === 'Enter') buttons.verifyCode?.click();
    });

    input.addEventListener('keypress', (e) => {
        if (!/[0-9]/.test(e.key)) e.preventDefault();
    });

    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
        pasted.split('').forEach((char, i) => {
            if (inputs.codeInputs[i]) {
                inputs.codeInputs[i].value = char;
                inputs.codeInputs[i].classList.add('filled');
            }
        });
        const lastIdx = Math.min(pasted.length - 1, 5);
        if (lastIdx >= 0) inputs.codeInputs[lastIdx].focus();
    });
});

function resetCodeInputs() {
    inputs.codeInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
}

// ═══════════════════════════════════════════════════════════════
//  PARTÍCULAS E GRÁFICOS
// ═══════════════════════════════════════════════════════════════
function createMoneyParticles() {
    const container = document.getElementById('moneyParticles');
    if (!container) return;
    const symbols = ['$', '€', '£', '¥', '₿'];
    for (let i = 0; i < CONFIG.moneyParticleCount; i++) {
        const particle = document.createElement('div');
        particle.classList.add('money-particle');
        particle.textContent             = symbols[Math.floor(Math.random() * symbols.length)];
        particle.style.left              = `${Math.random() * 100}%`;
        particle.style.top               = `${Math.random() * 100}%`;
        particle.style.fontSize          = `${Math.random() * 12 + 18}px`;
        particle.style.animationDuration = `${Math.random() * 10 + 15}s`;
        particle.style.animationDelay    = `${Math.random() * 5}s`;
        particle.style.color             = `rgba(16, 185, 129, ${Math.random() * 0.4 + 0.3})`;
        container.appendChild(particle);
    }
}

function createAnimatedCharts() {
    const container = document.getElementById('animatedCharts');
    if (!container) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    for (let i = 0; i < CONFIG.chartLineCount; i++) {
        const path   = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const points = [];
        for (let j = 0; j <= 12; j++) points.push(`${(j / 12) * 100},${20 + Math.random() * 60}`);
        path.classList.add('chart-line');
        path.setAttribute('d', `M ${points.join(' L ')}`);
        path.style.opacity           = String(Math.random() * 0.2 + 0.1);
        path.style.animationDelay    = `${Math.random() * 3}s`;
        path.style.animationDuration = `${Math.random() * 5 + 8}s`;
        svg.appendChild(path);
    }
    container.appendChild(svg);
}

// ═══════════════════════════════════════════════════════════════
//  ATALHOS DE TECLADO
// ═══════════════════════════════════════════════════════════════
function _registerKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && document.activeElement === inputs.loginEmail) {
            e.preventDefault();
            inputs.loginPassword?.focus();
        }
    });
    inputs.newPassword?.addEventListener('keypress',     (e) => { if (e.key === 'Enter') inputs.confirmPassword?.focus(); });
    inputs.confirmPassword?.addEventListener('keypress', (e) => { if (e.key === 'Enter') buttons.changePassword?.click(); });
    inputs.recoveryEmail?.addEventListener('keypress',   (e) => { if (e.key === 'Enter') buttons.sendCode?.click(); });
}

// ═══════════════════════════════════════════════════════════════
//  PARALLAX
// ═══════════════════════════════════════════════════════════════
let mouseX = 0, mouseY = 0, currentX = 0, currentY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth  - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
});

function animateParallax() {
    currentX += (mouseX - currentX) * 0.08;
    currentY += (mouseY - currentY) * 0.08;
    const visual = document.querySelector('.financial-visual');
    if (visual) visual.style.transform = `rotateY(${-8 + currentX * 8}deg) rotateX(${3 + currentY * 5}deg)`;
    document.querySelectorAll('.gradient-orb').forEach((orb, i) => {
        const speed = (i + 1) * 0.4;
        orb.style.transform = `translate(${currentX * speed * 25}px, ${currentY * speed * 25}px)`;
    });
    requestAnimationFrame(animateParallax);
}
animateParallax();

// ═══════════════════════════════════════════════════════════════
//  RIPPLE
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('.btn-submit').forEach(button => {
    button.addEventListener('click', function (e) {
        const ripple = document.createElement('span');
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);
        ripple.style.cssText = [
            'position:absolute',
            `width:${size}px`, `height:${size}px`,
            'border-radius:50%',
            'background:rgba(255,255,255,0.25)',
            `left:${e.clientX - rect.left - size / 2}px`,
            `top:${e.clientY - rect.top  - size / 2}px`,
            'pointer-events:none',
            'animation:ripple 0.6s ease-out forwards',
        ].join(';');
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
    });
});

// ═══════════════════════════════════════════════════════════════
//  CHECKBOX BOUNCE
// ═══════════════════════════════════════════════════════════════
document.querySelector('.checkbox-wrapper')?.addEventListener('click', () => {
    const custom = document.querySelector('.checkbox-custom');
    if (!custom) return;
    custom.classList.add('checkbox-custom-bounce');
    setTimeout(() => custom.classList.remove('checkbox-custom-bounce'), 200);
});