import { supabase, SUPABASE_ANON_KEY, setRememberMe, loginWithPassword, logout, supabaseReady } from '../services/supabase-client.js';
// Chunk separado: só é baixado por quem tem 2FA ativo (ver mfa-api.js).
import { verifyMfaLogin, recoverMfaLogin } from '../services/mfa-api.js';
import { initErrorTracking } from '../modules/error-tracking.js';

// Rastreamento de erros (no-op sem VITE_SENTRY_DSN / fora de produção)
initErrorTracking();

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
    // Chave PÚBLICA do Turnstile, injetada no build. Sem ela o widget não
    // renderiza — e o gate do servidor falha ABERTO, então o login continua
    // funcionando (ver turnstileOk() em api/auth-session.js).
    CAPTCHA_SITE_KEY: import.meta.env?.VITE_TURNSTILE_SITE_KEY ?? '',
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
//  MAPEAMENTO DE CÓDIGOS DE REDIRECT DO AUTH-GUARD (?c=)
//  Códigos emitidos por auth-guard.js ao redirecionar para login.
// ═══════════════════════════════════════════════════════════════
const _AUTH_REDIRECT_MSGS = Object.freeze({
    a1: { msg: 'Sua sessão expirou. Por favor, entre novamente.',                        type: 'error'   },
    a2: { msg: 'Sua sessão expirou. Por favor, entre novamente.',                        type: 'error'   },
    a3: { msg: 'Sessão encerrada por segurança. Por favor, entre novamente.',            type: 'error'   },
    a4: { msg: 'Sessão encerrada por inatividade. Por favor, entre novamente.',          type: 'error'   },
    a5: { msg: 'Sessão encerrada por segurança. Por favor, entre novamente.',            type: 'error'   },
    a6: { msg: 'Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.', type: 'error'   },
    a7: { msg: 'Assinatura não encontrada. Verifique seu plano para continuar.',         type: 'error',  redirect: 'planos.html' },
    a8: { msg: 'Esta página não está disponível para convidados.',                       type: 'error'   },
    a9: { msg: 'Convidados não podem gerenciar planos.',                                 type: 'error'   },
    b1: { msg: 'Sua sessão foi encerrada. Por favor, entre novamente.',                  type: 'error'   },
    b2: { msg: 'Você saiu da sua conta com sucesso.',                                    type: 'success' },
    b3: { msg: 'Sessão encerrada por segurança. Por favor, entre novamente.',            type: 'error'   },
    b4: { msg: 'Ocorreu um problema. Por favor, entre novamente.',                       type: 'error'   },
});

// ═══════════════════════════════════════════════════════════════
//  CABEÇALHOS
// ═══════════════════════════════════════════════════════════════
async function _requireSessionHeader() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('No active session.');
    return `Bearer ${session.access_token}`;
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

    const aoResolver = (token) => {
        if (!_active) return;
        if (typeof token !== 'string' || token.length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return;
        if (typeof turnstile === 'undefined') return;
        try {
            const widgetId = getWidgetId();
            const widgetResponse = turnstile.getResponse(widgetId ?? undefined);
            if (!widgetResponse || widgetResponse !== token) return;
            _token = token; _resolved = true; _resolvedAt = Date.now();
        } catch {
            _token = null; _resolved = false; _resolvedAt = 0;
        }
    };

    const aoLimpar = () => { _token = null; _resolved = false; _resolvedAt = 0; };

    // Os globais continuam existindo: o login.html os cita e eles são o contrato
    // público desta tela. Mas NÃO são mais o caminho pelo qual o widget chega
    // aqui — ver `handlers` abaixo.
    window[resolvedCallbackName] = aoResolver;
    window[expiredCallbackName]  = aoLimpar;
    window[errorCallbackName]    = aoLimpar;

    return {
        // ⚠️ O Turnstile exige FUNÇÃO, não nome de função.
        //
        // O reCAPTCHA aceitava `callback: 'nomeDaGlobal'` — uma string — e
        // resolvia o nome sozinho. O Turnstile não: ele guarda o que recebe e
        // depois faz `s.call(...)`. Com uma string aquilo vira
        // `TypeError: s.call is not a function`, lançado LÁ DENTRO do api.js.
        //
        // O sintoma era cruel: o desafio da Cloudflare passava e o widget
        // mostrava "Sucesso!", mas o callback morria antes de marcar o token
        // aqui — então `isResolved()` seguia falso e o login se recusava a
        // enviar, pedindo um captcha que o usuário acabara de resolver.
        //
        // Passe SEMPRE estas referências ao `turnstile.render()`.
        handlers: { resolved: aoResolver, expired: aoLimpar, error: aoLimpar },

        activate()   { _active = true;  },
        deactivate() { _active = false; },
        isResolved() {
            if (!_resolved || !_token) return false;
            return (Date.now() - _resolvedAt) < CONFIG.CAPTCHA_TOKEN_MAX_AGE_MS;
        },
        getToken() { return this.isResolved() ? _token : null; },
        reset() {
            _token = null; _resolved = false; _resolvedAt = 0;
            if (typeof turnstile === 'undefined') return;
            try {
                const widgetId = getWidgetId();
                if (widgetId !== null) turnstile.reset(widgetId);
                else turnstile.reset();
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
// [GHOST-003] Contador de tentativas armazenado em localStorage (persistente entre abas)
// ao invés de sessionStorage (resetado ao abrir nova aba). Um atacante que abria nova aba
// resetava o contador e bypassa o captcha frontend. localStorage persiste entre abas e
// sessões, tornando o bypass mais difícil. O reset apenas ocorre após login bem-sucedido.
// Nota: o lockout progressivo server-side é a proteção primária — este é um layer adicional.
const LoginAttempts = {
    get()   { try { return parseInt(localStorage.getItem(CONFIG.KEYS.loginAttempts) || '0', 10); } catch { return 0; } },
    set(n)  { try { localStorage.setItem(CONFIG.KEYS.loginAttempts, String(Math.max(0, n))); } catch {} },
    inc()   { this.set(this.get() + 1); },
    reset() { try { localStorage.removeItem(CONFIG.KEYS.loginAttempts); } catch {} },
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

    if (typeof turnstile === 'undefined') {
        console.warn(`[Turnstile:${containerId}] API não carregada — aguardando`);
        if (containerId === 'captchaContainer') window.__tsPendingRender = () => _renderCaptchaInContainer(containerId, callbacks, getWidgetId, setWidgetId, getRenderAttempt, setRenderAttempt);
        return;
    }

    const el = document.getElementById(containerId);
    if (!el) { console.error(`[Turnstile] #${containerId} não encontrado`); return; }

    const computedDisplay = window.getComputedStyle(el).display;
    if (computedDisplay === 'none') {
        console.warn(`[Turnstile:${containerId}] Container oculto no momento do render`);
        return;
    }

    const container = el.querySelector('.cf-turnstile');
    if (!container) { console.error(`[Turnstile] .cf-turnstile não encontrado em #${containerId}`); return; }

    while (container.firstChild) container.removeChild(container.firstChild);

    try {
        // O Turnstile não tem equivalente ao turnstile.ready(): quando o objeto
        // global existe, a API já está utilizável. A IIFE mantém o corpo abaixo
        // sem alteração e preserva o mesmo escopo de antes.
        (() => {
            if (getWidgetId() !== null) return;

            const currentEl = document.getElementById(containerId);
            if (!currentEl) return;
            if (window.getComputedStyle(currentEl).display === 'none') return;
            const currentContainer = currentEl.querySelector('.cf-turnstile');
            if (!currentContainer) return;

            // Trava contra a regressão de 2026-07-30: se algum callback vier
            // como string (convenção do reCAPTCHA), o Turnstile só estoura lá
            // dentro do api.js dele, com `s.call is not a function` — sem
            // apontar para cá. Melhor barrar aqui, com o nome do culpado.
            for (const nome of ['resolved', 'expired', 'error']) {
                if (typeof callbacks[nome] !== 'function') {
                    console.error(
                        `[Turnstile:${containerId}] callback "${nome}" não é função ` +
                        `(recebi ${typeof callbacks[nome]}). O Turnstile exige a função, ` +
                        `não o nome dela. Render abortado.`,
                    );
                    return;
                }
            }

            try {
                const widgetId = turnstile.render(currentContainer, {
                    sitekey:            CONFIG.CAPTCHA_SITE_KEY,
                    callback:           callbacks.resolved,
                    'expired-callback': callbacks.expired,
                    'error-callback':   callbacks.error,
                    theme:              'dark',
                });
                setWidgetId(widgetId);

                // ⚠️ NÃO sondar o tamanho do iframe aqui.
                //
                // Existia neste ponto uma verificação herdada do reCAPTCHA: depois
                // de 600ms, se o iframe tivesse offsetWidth 0, o widget era
                // destruído e re-renderizado (até 3 vezes).
                //
                // Com o reCAPTCHA aquilo funcionava, porque ele pinta uma caixinha
                // visível imediatamente. O Turnstile em modo Managed faz a
                // verificação INVISÍVEL primeiro — e nesse momento o iframe é
                // legitimamente 0x0. A sonda lia isso como falha, destruía o
                // widget e tentava de novo: 3 piscadas e depois nada na tela.
                //
                // O Turnstile já tem `error-callback` para falha de verdade. Uma
                // heurística de DOM em cima disso não acrescenta nada e mente.

            } catch (err) {
                console.error(`[Turnstile:${containerId}] render() falhou:`, err);
                setWidgetId(null);
                const attempt = getRenderAttempt() + 1;
                setRenderAttempt(attempt);
                if (attempt <= _CAPTCHA_MAX_RENDER_ATTEMPTS) {
                    setTimeout(() => _renderCaptchaInContainer(containerId, callbacks, getWidgetId, setWidgetId, getRenderAttempt, setRenderAttempt), attempt * 500);
                }
            }
        })();
    } catch (err) {
        console.error(`[Turnstile:${containerId}] ready() falhou:`, err);
    }
}

// ── Captcha do login ──────────────────────────────────────────
function _renderLoginCaptcha() {
    _renderCaptchaInContainer(
        'captchaContainer',
        LoginCaptchaState.handlers,
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
        CodeCaptchaState.handlers,
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

    // Widget já existe: só devolve um desafio novo. NÃO destrói.
    //
    // Aqui havia a mesma sonda de `offsetWidth === 0` do render — e com o
    // Turnstile ela era pior: como `showCaptcha()` pode ser chamado várias vezes
    // (contador local, e depois o 403 do servidor), cada chamada destruía um
    // widget que estava funcionando, só porque o modo Managed o mantém 0x0
    // durante a verificação invisível.
    //
    // `reset()` já é o suficiente: limpa token velho e pede desafio novo,
    // preservando o widget montado.
    if (getWidgetId() !== null) {
        try { if (typeof turnstile !== 'undefined') turnstile.reset(getWidgetId()); } catch {}
        return;
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
//  Usa o proxy Vercel /api/verify-recaptcha — nunca expõe a URL
//  da Edge Function diretamente no frontend.
// ═══════════════════════════════════════════════════════════════
async function validateLoginCaptchaOnBackend(token) {
    if (!token || typeof token !== 'string' || token.trim().length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return false;
    try {
        const response = await fetch('/api/verify-recaptcha', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
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
//  Usa o proxy Vercel /api/check-user-access — nunca expõe a URL
//  da Edge Function diretamente no frontend.
// ═══════════════════════════════════════════════════════════════
async function checkUserAccess() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id || !session?.access_token) return { hasAccess: false };

        const authHeader = await _requireSessionHeader();
        const response   = await fetch('/api/check-user-access', {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': authHeader,
            },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(8_000),
        });

        // Lockout progressivo (429) — conta bloqueada
        if (response.status === 429) {
            try {
                const lockResult = await response.json();
                return { hasAccess: false, lockMessage: lockResult?.message || 'Conta bloqueada temporariamente.' };
            } catch {
                return { hasAccess: false, lockMessage: 'Conta bloqueada temporariamente.' };
            }
        }

        // [GHOST-002] Fail-closed: erros de servidor não concedem acesso.
        // Antes era fail-open (5xx/timeout → hasAccess: true), permitindo que
        // usuários com subscription cancelada acessassem o dashboard se o
        // endpoint estivesse instável. Agora qualquer falha nega o acesso
        // com mensagem amigável indicando problema temporário.
        if (response.status === 404 || response.status >= 500) {
            console.warn('[checkUserAccess] Proxy indisponível (' + response.status + ')');
            return { hasAccess: false, serverError: true };
        }
        if (!response.ok) return { hasAccess: false };
        const result = await response.json();
        return { hasAccess: result?.hasAccess === true };
    } catch {
        // [GHOST-002] Erro de rede ou timeout — fail-closed
        console.warn('[checkUserAccess] Erro de rede — acesso negado');
        return { hasAccess: false, serverError: true };
    }
}

// ═══════════════════════════════════════════════════════════════
//  LOADING SCREEN
// ═══════════════════════════════════════════════════════════════
function hideLoginLoadingScreen() {
    const loadingScreen = document.getElementById('loadingScreen');
    if (!loadingScreen) return;
    loadingScreen.classList.add('hidden');
    // Remove do DOM após a transição CSS — não bloqueia o layout
    loadingScreen.addEventListener('transitionend', () => loadingScreen.remove(), { once: true });
    // Fallback caso transitionend não dispare
    setTimeout(() => loadingScreen?.remove(), 800);
}

// Esconde assim que a página estiver pronta — sem atraso artificial.
// requestAnimationFrame garante que o browser pintou antes do fade-out.
if (document.readyState === 'complete') {
    requestAnimationFrame(hideLoginLoadingScreen);
} else {
    window.addEventListener('load', () => requestAnimationFrame(hideLoginLoadingScreen));
}

// ═══════════════════════════════════════════════════════════════
//  REDIRECIONAMENTO PÓS-LOGIN
// Lê parâmetro ?next= e valida contra whitelist de páginas internas.
// Impede open redirect: só aceita paths relativos conhecidos.
// ═══════════════════════════════════════════════════════════════
const NEXT_WHITELIST = new Set([
    '/planos.html', '/planos',
    '/dashboard.html', '/dashboard',
    '/atualizarplano.html', '/atualizarplano',
    '/assistente.html', '/assistente',
]);

function getNextRedirect() {
    try {
        // Prioridade 1: parâmetro ?next= na URL
        const params = new URLSearchParams(window.location.search);
        const next   = params.get('next');
        if (next && next.startsWith('/') && NEXT_WHITELIST.has(next.split('?')[0])) {
            return next;
        }
        return null;
    } catch {
        return null;
    }
}

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

    // Sessão existente → redireciona (respeitando ?next=)
    // Aguarda a reidratação via cookie HttpOnly antes de checar a sessão.
    try {
        await supabaseReady;
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            const next = getNextRedirect();
            window.location.replace(next ?? 'dashboard.html');
            return;
        }
    } catch {}

    // Exibe captcha se já havia tentativas suficientes
    if (LoginAttempts.get() >= CONFIG.MAX_LOGIN_ATTEMPTS_BEFORE_CAPTCHA) showLoginCaptcha();
    if (CodeAttempts.get()  >= CONFIG.MAX_CODE_ATTEMPTS_BEFORE_CAPTCHA)  showCodeCaptcha();

    createMoneyParticles();
    createAnimatedCharts();

    // Interpreta ?c= (código de redirect emitido pelo auth-guard) e exibe mensagem amigável.
    // Remove o parâmetro da URL após leitura para evitar reexibição ao recarregar.
    try {
        const urlParams    = new URLSearchParams(window.location.search);
        const redirectCode = urlParams.get('c');
        if (redirectCode) {
            urlParams.delete('c');
            const newSearch = urlParams.toString();
            history.replaceState(null, '', window.location.pathname + (newSearch ? '?' + newSearch : ''));
            const entry = _AUTH_REDIRECT_MSGS[redirectCode];
            if (entry) {
                showAuthMessage(entry.msg, entry.type);
                if (entry.redirect) setTimeout(() => window.location.replace(entry.redirect), 1800);
            }
        }
    } catch {}

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

    // Honeypot check — bots preenchem campos ocultos, humanos não
    const hpEmail = document.getElementById('_ge_confirm_email');
    const hpPhone = document.getElementById('_ge_phone');
    if ((hpEmail && hpEmail.value) || (hpPhone && hpPhone.value)) {
        // Silencioso: simula comportamento normal sem revelar detecção
        setTimeout(() => window.location.replace('login.html'), 2000);
        return;
    }

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

    // ── Captcha (B-2) ────────────────────────────────────────────────────────
    // Este bloco NÃO decide mais se o captcha é necessário — quem decide é o
    // servidor, pelo contador de falhas por conta que ele mantém no Redis. Aqui
    // ficou só a antecipação: se o contador LOCAL já sabe que houve erros, o
    // widget aparece antes de o servidor pedir, poupando um round-trip.
    //
    // O contador local pode estar errado (aba nova, localStorage limpo, outro
    // aparelho) e isso deixou de ser um problema: quando ele erra para menos, o
    // servidor responde `captcha_required` e o fluxo abaixo se ajusta.
    if (LoginAttempts.get() >= CONFIG.MAX_LOGIN_ATTEMPTS_BEFORE_CAPTCHA
        && !LoginCaptchaState.isResolved()) {
        showAuthMessage('Por favor, resolva a verificação de segurança.', 'error');
        highlightLoginCaptcha();
        return;
    }

    const submitBtn  = buttons.loginSubmit;
    setButtonLoading(submitBtn, 'Verificando...');

    // Define o storage ANTES do signIn — o adapter usa essa flag ao salvar o token
    const rememberChecked = document.getElementById('remember')?.checked ?? false;
    setRememberMe(rememberChecked);

    try {
        let data;
        try {
            // Login server-side: o refresh token fica em cookie HttpOnly,
            // só o access token volta (para a memória, via supabase-client).
            data = await loginWithPassword(email, password, rememberChecked,
                                           LoginCaptchaState.getToken());
        } catch (err) {
            const status = err?.status ?? 0;

            // ── O servidor exigiu o desafio (B-2) ────────────────────────────
            // Acontece quando o contador de falhas por CONTA passou do limite —
            // inclusive em aba nova, aparelho novo, ou depois de o usuário
            // limpar o localStorage. É a diferença entre o captcha de antes
            // (que o navegador escolhia mostrar) e o de agora.
            if (err?.captchaRequired) {
                LoginCaptchaState.reset();
                showLoginCaptcha();
                highlightLoginCaptcha();
                showAuthMessage(
                    err.message === 'captcha_invalid'
                        ? 'Verificação expirou. Resolva de novo e tente outra vez.'
                        : 'Por segurança, resolva a verificação abaixo e tente de novo.',
                    'error');
                inputs.loginPassword.value = '';
                return;
            }

            if (status === 429) {
                // Rate limit server-side — não conta como tentativa de credencial
                showAuthMessage('Muitas tentativas. Aguarde alguns minutos e tente novamente.', 'error');
                return;
            }
            if (status >= 400 && status < 500) {
                // Credenciais inválidas (401/400) — mensagem genérica
                inputs.loginPassword.value = '';
                LoginCaptchaState.reset();
                _registerFailedLoginAttempt();
                showAuthMessage(LOGIN_ERROR_MSG, 'error');
                shakeInput(inputs.loginEmail);
                shakeInput(inputs.loginPassword);
                return;
            }
            // 5xx / rede → tratado como erro de conexão no catch externo
            throw err;
        }

        // ── 2º fator (Passo 31 · B-1) ────────────────────────────────────────
        // A senha estava certa, mas a conta tem 2FA. O servidor NÃO devolveu
        // sessão: ela está num cookie HttpOnly de 5 min esperando o código.
        // Enquanto isso não for resolvido, não há sessão nenhuma neste browser.
        if (data?.mfaRequired) {
            LoginAttempts.reset();
            LoginCaptchaState.reset();
            hideLoginCaptcha();
            restoreButton(submitBtn);

            const mfa = await pedirCodigoMfa(rememberChecked);
            if (!mfa) {
                // Cancelou, errou 5 vezes ou o cookie expirou → volta à estaca zero.
                inputs.loginPassword.value = '';
                return;
            }
            data = mfa.data;
            if (mfa.mfaDisabled) {
                showAuthMessage('Verificação em duas etapas desativada. Reative em Configurações → Segurança.', 'info');
            }
            setButtonLoading(submitBtn, 'Verificando plano...');
        }

        // Login bem-sucedido
        LoginAttempts.reset();
        LoginCaptchaState.reset();
        hideLoginCaptcha();

        setButtonLoading(submitBtn, 'Verificando plano...');
        const checkAccessResult = await checkUserAccess();
        const { hasAccess } = checkAccessResult;

        if (!hasAccess) {
            // Encerra a sessão recém-criada (limpa cookie HttpOnly + revoga)
            await logout();
            const lockMsg = checkAccessResult?.lockMessage;
            if (lockMsg) {
                showAuthMessage(sanitizeText(lockMsg), 'error');
            } else if (checkAccessResult?.serverError) {
                // [GHOST-002] Erro de servidor — mensagem distinta de "sem plano"
                showAuthMessage('Serviço temporariamente indisponível. Tente novamente em instantes.', 'error');
            } else {
                showAuthMessage('Você precisa de um plano ativo para acessar o sistema.', 'error');
                setTimeout(() => window.location.replace('planos.html'), 1800);
            }
            return;
        }

        inputs.loginPassword.value = '';
        inputs.loginEmail.value    = '';

        // Alerta de aparelho novo (fire-and-forget — NUNCA atrasa nem falha o login).
        // O servidor identifica o aparelho pelo user-agent e, se for a 1ª vez dele
        // nesta conta (e a conta já tiver outro aparelho), manda e-mail de alerta.
        try {
            const tk = data?.access_token || data?.session?.access_token;
            if (tk) {
                fetch('/api/user-data', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}` },
                    body: JSON.stringify({ action: 'login-notify' }),
                    keepalive: true,
                }).catch(() => {});
            }
        } catch { /* best-effort */ }

        // `data?.` e não `data.`: o catch lá embaixo é cego — ele transforma
        // QUALQUER exceção daqui, inclusive um TypeError nosso, na mensagem
        // "Erro de conexão". Um acesso não-protegido neste ponto vira um bug que
        // mente sobre a própria causa e some quando o usuário recarrega.
        const userName = sanitizeText(data?.user?.user_metadata?.name || 'Usuário');
        showAuthMessage(`Bem-vindo de volta, ${userName}!`, 'success');
        const nextPage = getNextRedirect() ?? 'dashboard.html';
        // Caminho feliz: tempo curto só para registrar o "bem-vindo" sem travar a entrada.
        setTimeout(() => window.location.replace(nextPage), 800);

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
    // Move o foco para o body antes de esconder as telas para evitar
    // aria-hidden num ancestral de elemento focado (violação WAI-ARIA).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
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
//  A validação do email acontece server-side em /api/reset-password
//  (step='send'), que internamente verifica o status antes de disparar
//  o OTP. O servidor sempre responde {status:'sent'} independente do
//  resultado — anti-enumeração: o frontend nunca sabe se o email existe.
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

        setButtonLoading(buttons.sendCode, 'Enviando...');

        try {
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

                if (!sendResponse.ok) {
                    shakeInput(inputs.recoveryEmail);
                    showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                    return;
                }

                sendResult = await sendResponse.json();
            } catch {
                shakeInput(inputs.recoveryEmail);
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            if (sendResult.status === 'sent') {
                RecoveryState.setEmail(email);
                CodeAttempts.reset();
                Cooldown.set(CONFIG.KEYS.sendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
                showAuthMessage('Se este email estiver cadastrado, você receberá um código.', 'success');
                switchScreen(screens.forgotEmail, screens.code);
                setTimeout(() => inputs.codeInputs[0]?.focus(), 520);
            } else {
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
            shakeInput(inputs.newPassword);
            return;
        }

        if (!/[A-Z]/.test(newPass)) {
            showError('A senha deve conter pelo menos uma letra maiúscula.');
            shakeInput(inputs.newPassword);
            return;
        }

        if (!/[0-9]/.test(newPass)) {
            showError('A senha deve conter pelo menos um número.');
            shakeInput(inputs.newPassword);
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
                    signal: AbortSignal.timeout(25_000),
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

            } else if (result.status === 'weak_password') {
                // Senha vazada (HIBP, server-side) — o código segue válido; usuário só troca a senha
                showError(result.message || 'Essa senha apareceu em vazamentos de dados. Escolha uma senha diferente.');
                shakeInput(inputs.newPassword);

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
// ═══════════════════════════════════════════════════════════════
//  VALIDAÇÃO EM TEMPO REAL — NOVA SENHA
//  Atualiza os indicadores de requisito conforme o usuário digita.
// ═══════════════════════════════════════════════════════════════
function _updatePasswordRequirements(value) {
    const reqLength    = document.getElementById('req-length');
    const reqUppercase = document.getElementById('req-uppercase');
    const reqNumber    = document.getElementById('req-number');
    if (!reqLength || !reqUppercase || !reqNumber) return;

    const hasLength    = value.length >= 8 && value.length <= 128;
    const hasUppercase = /[A-Z]/.test(value);
    const hasNumber    = /[0-9]/.test(value);

    reqLength.dataset.valid    = String(hasLength);
    reqUppercase.dataset.valid = String(hasUppercase);
    reqNumber.dataset.valid    = String(hasNumber);
}

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

    // Validação em tempo real nos campos de senha
    inputs.newPassword?.addEventListener('input', (e) => {
        _updatePasswordRequirements(e.target.value);
        // Limpa o erro ao digitar novamente
        if (errorMessage?.classList.contains('show')) hideError();
    });
    inputs.confirmPassword?.addEventListener('input', () => {
        if (errorMessage?.classList.contains('show')) hideError();
    });
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
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    animateParallax();
}

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


// ═══════════════════════════════════════════════════════════════
//  2º FATOR NO LOGIN (Passo 31 · B-1)
// ═══════════════════════════════════════════════════════════════
// Chamado quando o servidor responde `mfa_required`. Nesse ponto a senha já foi
// aceita, mas a sessão está retida num cookie HttpOnly de 5 minutos — este
// browser ainda não tem sessão nenhuma. Só o código certo (ou um código de
// recuperação) a libera.
//
// Nada aqui vira HTML por string: todo nó é createElement + textContent. Um
// modal de autenticação é o último lugar do app onde se pode aceitar markup
// dinâmico.
//
// Retorna:
//   { data, mfaDisabled }  → sessão aplicada, pode seguir o fluxo de login
//   null                   → cancelou, esgotou tentativas ou o prazo venceu

const MFA_CSS = `
#geMfaGate { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 16px; }
#geMfaGate .mfa-ov { position: absolute; inset: 0; background: rgba(3,7,18,0.86); backdrop-filter: blur(6px); }
#geMfaGate .mfa-card { position: relative; background: #13141f; border: 1px solid rgba(16,185,129,0.22); border-radius: 20px; padding: 28px 24px; max-width: 380px; width: 100%; box-shadow: 0 24px 48px rgba(0,0,0,0.55); color: #d1d5db; text-align: center; }
#geMfaGate .mfa-ico { font-size: 2rem; margin-bottom: 10px; }
#geMfaGate h3 { color: #fff; font-size: 1.12rem; margin: 0 0 6px; }
#geMfaGate .mfa-sub { color: #9ca3af; font-size: 0.85rem; margin: 0 0 20px; line-height: 1.5; }
#geMfaGate input { width: 100%; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 14px; color: #fff; font-size: 1.35rem; text-align: center; letter-spacing: 0.34em; font-weight: 700; font-variant-numeric: tabular-nums; }
#geMfaGate input.mfa-rec { font-size: 1rem; letter-spacing: 0.14em; text-transform: uppercase; }
#geMfaGate input:focus { outline: none; border-color: rgba(16,185,129,0.6); box-shadow: 0 0 0 3px rgba(16,185,129,0.14); }
#geMfaGate .mfa-err { color: #fca5a5; font-size: 0.8rem; margin: 10px 0 0; min-height: 1.1em; }
#geMfaGate .mfa-go { width: 100%; margin-top: 16px; background: linear-gradient(135deg,#10b981,#059669); color: #fff; border: none; border-radius: 12px; padding: 14px; font-weight: 700; font-size: 0.95rem; cursor: pointer; }
#geMfaGate .mfa-go[disabled] { opacity: 0.55; cursor: default; }
#geMfaGate .mfa-alt { background: none; border: none; color: #6b7280; font-size: 0.8rem; margin-top: 14px; cursor: pointer; text-decoration: underline; padding: 4px; }
#geMfaGate .mfa-alt:hover { color: #9ca3af; }
#geMfaGate .mfa-warn { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); color: #fcd34d; border-radius: 10px; padding: 10px 12px; font-size: 0.78rem; margin-top: 14px; line-height: 1.45; text-align: left; }
`;

let _mfaCssPronto = false;
function _injetarCssMfa() {
    if (_mfaCssPronto) return;
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(MFA_CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
        const s = document.createElement('style');
        s.textContent = MFA_CSS;
        document.head.appendChild(s);
    }
    _mfaCssPronto = true;
}

function pedirCodigoMfa(remember) {
    _injetarCssMfa();
    document.getElementById('geMfaGate')?.remove();

    return new Promise((resolve) => {
        // `modoRecuperacao` alterna entre o código de 6 dígitos do app e o
        // código de recuperação de 8 caracteres.
        let modoRecuperacao = false;
        let encerrado       = false;

        const novo = (tag, cls, txt) => {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (txt != null) e.textContent = txt;
            return e;
        };

        const root  = novo('div'); root.id = 'geMfaGate';
        const ov    = novo('div', 'mfa-ov');
        const card  = novo('div', 'mfa-card');
        root.append(ov, card);

        const ico   = novo('div', 'mfa-ico', '🔐');
        const tit   = novo('h3', null, 'Verificação em duas etapas');
        const sub   = novo('p', 'mfa-sub', 'Digite o código de 6 dígitos do seu app autenticador.');
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'one-time-code';
        input.maxLength = 6;
        input.setAttribute('aria-label', 'Código de verificação');
        const erro  = novo('p', 'mfa-err', '');
        erro.setAttribute('role', 'alert');
        erro.setAttribute('aria-live', 'assertive');
        const btn   = novo('button', 'mfa-go', 'Entrar');
        btn.type = 'button';
        const alt   = novo('button', 'mfa-alt', 'Perdi o acesso ao meu autenticador');
        alt.type = 'button';
        const cancelar = novo('button', 'mfa-alt', 'Cancelar e voltar');
        cancelar.type = 'button';

        card.append(ico, tit, sub, input, erro, btn, alt, cancelar);
        document.body.appendChild(root);
        setTimeout(() => input.focus(), 60);

        const fechar = (valor) => {
            if (encerrado) return;
            encerrado = true;
            root.remove();
            resolve(valor);
        };

        // Alterna app autenticador ↔ código de recuperação.
        alt.addEventListener('click', () => {
            modoRecuperacao = !modoRecuperacao;
            erro.textContent = '';
            input.value = '';
            if (modoRecuperacao) {
                tit.textContent   = 'Código de recuperação';
                sub.textContent   = 'Digite um dos códigos que você guardou ao ativar a verificação.';
                input.className   = 'mfa-rec';
                input.maxLength   = 9;             // XXXX-XXXX
                input.inputMode   = 'text';
                input.autocomplete = 'off';
                alt.textContent   = 'Voltar para o código do app';
                if (!card.querySelector('.mfa-warn')) {
                    const w = novo('div', 'mfa-warn',
                        'Usar um código de recuperação DESATIVA a verificação em duas etapas. '
                        + 'Sua conta volta a ser protegida só pela senha até você reativá-la em '
                        + 'Configurações → Segurança da conta.');
                    card.insertBefore(w, alt);
                }
            } else {
                tit.textContent   = 'Verificação em duas etapas';
                sub.textContent   = 'Digite o código de 6 dígitos do seu app autenticador.';
                input.className   = '';
                input.maxLength   = 6;
                input.inputMode   = 'numeric';
                input.autocomplete = 'one-time-code';
                alt.textContent   = 'Perdi o acesso ao meu autenticador';
                card.querySelector('.mfa-warn')?.remove();
            }
            input.focus();
        });

        cancelar.addEventListener('click', () => fechar(null));

        // Envio automático ao completar os 6 dígitos: é o que o usuário espera de
        // um campo de OTP, e evita o "digitei e não aconteceu nada".
        input.addEventListener('input', () => {
            if (modoRecuperacao) return;
            input.value = input.value.replace(/\D/g, '').slice(0, 6);
            if (input.value.length === 6) enviar();
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });

        let enviando = false;
        async function enviar() {
            if (enviando || encerrado) return;
            const valor = input.value.trim();
            if (modoRecuperacao ? valor.replace(/-/g, '').length !== 8 : valor.length !== 6) {
                erro.textContent = modoRecuperacao
                    ? 'O código de recuperação tem 8 caracteres.'
                    : 'O código tem 6 dígitos.';
                return;
            }

            enviando = true;
            btn.disabled = true;
            btn.textContent = 'Verificando…';
            erro.textContent = '';

            try {
                if (modoRecuperacao) {
                    const r = await recoverMfaLogin(valor, remember);
                    // `r.data`, não `null`. Aqui ficava `data: null` e o fluxo de
                    // login logo adiante lia `data.user` — TypeError engolido pelo
                    // catch geral, que anunciava "Erro de conexão" enquanto a
                    // sessão já estava criada. Sintoma em produção (2026-07-30):
                    // código de recuperação certo, erro na tela, e o F5 entrava.
                    fechar({ data: r.data, mfaDisabled: r.mfaDisabled });
                } else {
                    const grant = await verifyMfaLogin(valor, remember);
                    fechar({ data: grant, mfaDisabled: false });
                }
            } catch (err) {
                const motivo = String(err?.message ?? '');
                // 440 = o cookie de 5 min venceu · mfa_locked = 5 erros
                if (err?.status === 440 || motivo === 'mfa_expired') {
                    showAuthMessage('O tempo para confirmar expirou. Entre novamente.', 'error');
                    return fechar(null);
                }
                if (motivo === 'mfa_locked' || err?.status === 429) {
                    showAuthMessage('Muitas tentativas. Entre novamente daqui a pouco.', 'error');
                    return fechar(null);
                }
                const restam = err?.attemptsLeft;
                erro.textContent = typeof restam === 'number'
                    ? `Código incorreto. ${restam} tentativa${restam === 1 ? '' : 's'} restante${restam === 1 ? '' : 's'}.`
                    : 'Código incorreto.';
                input.value = '';
                input.focus();
            } finally {
                enviando = false;
                btn.disabled = false;
                btn.textContent = 'Entrar';
            }
        }

        btn.addEventListener('click', enviar);
    });
}
