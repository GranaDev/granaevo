import { supabase } from './supabase-client.js';

// ─────────────────────────────────────────────────────────────────
//  TRUSTED TYPES — granaevo-policy
//  Usado somente em restoreButton() para reinjetar HTML estático
//  dos botões capturado na inicialização. Nunca contém input externo.
// ─────────────────────────────────────────────────────────────────
const _trustedPolicy = (() => {
    if (typeof window.trustedTypes?.createPolicy !== 'function') return null;
    try {
        return window.trustedTypes.createPolicy('granaevo-policy', {
            createHTML: (s) => s,
        });
    } catch { return null; }
})();

// ─────────────────────────────────────────────────────────────────
//  CONFIGURAÇÕES
// ─────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
    moneyParticleCount:          15,
    chartLineCount:               8,
    MAX_ATTEMPTS_BEFORE_CAPTCHA:  3,   // exibe captcha após N tentativas erradas
    MESSAGE_AUTO_HIDE_MS:      5000,
    SEND_CODE_COOLDOWN_MS:    30_000,
    RATE_LIMIT_MAX:               10,
    RATE_LIMIT_WINDOW_MS:     60_000,
    CAPTCHA_TOKEN_MAX_AGE_MS: 110_000,
    CAPTCHA_TOKEN_MIN_LENGTH:     50,
    CAPTCHA_POLL_INTERVAL_MS:    300,  // intervalo do poll para grecaptcha
    CAPTCHA_POLL_TIMEOUT_MS:  15_000,  // timeout máximo do poll
    CAPTCHA_SITE_KEY: '6Lfxo3IsAAAAAFpfVxePWUYsyKjeWbP7PoXC3Hye',
    KEYS: Object.freeze({
        loginAttempts:  '_ge_la',
        sendCooldown:   '_ge_scc',
        resendCooldown: '_ge_rcc',
        submitRateLog:  '_ge_srl',
    }),
    SUPABASE_URL: 'https://fvrhqqeofqedmhadzzqw.supabase.co',
});

// ─────────────────────────────────────────────────────────────────
//  MENSAGEM DE ERRO DE LOGIN
//  Uma única mensagem para QUALQUER falha de autenticação.
//  Nunca revela se o email existe, se a senha é curta etc.
// ─────────────────────────────────────────────────────────────────
const LOGIN_ERROR_MSG = 'Erro: Email ou senha inválido.';

// ─────────────────────────────────────────────────────────────────
//  HEADERS
// ─────────────────────────────────────────────────────────────────
async function _requireSessionHeader() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('No session');
    return `Bearer ${session.access_token}`;
}
function _publicHeader() {
    return `Bearer ${supabase.supabaseKey}`;
}

// ─────────────────────────────────────────────────────────────────
//  CAPTCHA — ESTADO INTERNO
// ─────────────────────────────────────────────────────────────────
let _widgetId      = null;   // null = não renderizado ainda
let _pollTimer     = null;   // referência ao setInterval do poll
let _captchaActive = false;  // true quando o container está visível

// Callbacks globais obrigatórios para o reCAPTCHA v2 explícito
let _captchaToken     = null;
let _captchaResolvedAt = 0;

window.onCaptchaResolved = function (token) {
    if (!_captchaActive) return;
    if (typeof token !== 'string' || token.length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return;
    _captchaToken      = token;
    _captchaResolvedAt = Date.now();
};
window.onCaptchaExpired = function () {
    _captchaToken = null; _captchaResolvedAt = 0;
};
window.onCaptchaError = function () {
    _captchaToken = null; _captchaResolvedAt = 0;
};

function _isCaptchaResolved() {
    if (!_captchaToken) return false;
    return (Date.now() - _captchaResolvedAt) < CONFIG.CAPTCHA_TOKEN_MAX_AGE_MS;
}
function _getCaptchaToken() {
    return _isCaptchaResolved() ? _captchaToken : null;
}
function _resetCaptchaToken() {
    _captchaToken = null; _captchaResolvedAt = 0;
    if (_widgetId !== null && typeof grecaptcha !== 'undefined') {
        try { grecaptcha.reset(_widgetId); } catch { /* widget não renderizado */ }
    }
}

// ─────────────────────────────────────────────────────────────────
//  CAPTCHA — RENDER
//
//  Abordagem: poll simples.
//  Não depende de onload callback, não depende de ordem de carregamento.
//  A cada CAPTCHA_POLL_INTERVAL_MS verifica se grecaptcha está disponível.
//  Para quando renderiza com sucesso ou atinge o timeout.
// ─────────────────────────────────────────────────────────────────
function _renderCaptchaWidget() {
    // Já renderizado — não faz nada
    if (_widgetId !== null) return;

    // Já tem poll rodando — não duplica
    if (_pollTimer !== null) return;

    const deadline = Date.now() + CONFIG.CAPTCHA_POLL_TIMEOUT_MS;

    _pollTimer = setInterval(() => {
        // Verifica se grecaptcha está disponível
        if (typeof grecaptcha === 'undefined' || typeof grecaptcha.render !== 'function') {
            if (Date.now() >= deadline) {
                clearInterval(_pollTimer);
                _pollTimer = null;
            }
            return;
        }

        // grecaptcha pronto — para o poll e renderiza
        clearInterval(_pollTimer);
        _pollTimer = null;

        const el        = document.getElementById('captchaContainer');
        const container = el?.querySelector('.g-recaptcha');
        if (!container) return;

        // Limpa filhos de forma segura (evita bloqueio por Trusted Types)
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        try {
            _widgetId = grecaptcha.render(container, {
                sitekey:              CONFIG.CAPTCHA_SITE_KEY,
                callback:             'onCaptchaResolved',
                'expired-callback':   'onCaptchaExpired',
                'error-callback':     'onCaptchaError',
                theme:                'dark',
            });
        } catch {
            // Se lançou mas já tem iframe, o widget foi criado mesmo assim
            _widgetId = container.querySelector('iframe') ? 0 : null;
        }
    }, CONFIG.CAPTCHA_POLL_INTERVAL_MS);
}

function showCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;

    // Mostra o container
    el.style.display = 'flex';
    el.classList.remove('captcha-hidden');
    el.classList.add('captcha-visible');
    _captchaActive = true;

    // Inicia render (com poll interno)
    _renderCaptchaWidget();
}

function hideCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.style.display = 'none';
    el.classList.remove('captcha-visible');
    el.classList.add('captcha-hidden');
    _captchaActive = false;
}

function highlightCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.classList.add('captcha-error');
    setTimeout(() => el.classList.remove('captcha-error'), 2000);
}

// ─────────────────────────────────────────────────────────────────
//  RECOVERY STATE
// ─────────────────────────────────────────────────────────────────
const RecoveryState = (() => {
    let _email = '', _code = '';
    return {
        getEmail:   ()  => _email,
        getCode:    ()  => _code,
        setEmail:   (v) => { _email = String(v ?? '').trim(); },
        setCode:    (v) => { _code  = String(v ?? '').trim(); },
        clearCode:  ()  => { _code  = ''; },
        clear:      ()  => { _email = ''; _code = ''; },
        isValid:    ()  => _email.length > 0 && _code.length === 6,
    };
})();

// ─────────────────────────────────────────────────────────────────
//  TENTATIVAS DE LOGIN
// ─────────────────────────────────────────────────────────────────
const LoginAttempts = {
    get()   { return parseInt(sessionStorage.getItem(CONFIG.KEYS.loginAttempts) || '0', 10); },
    set(n)  { sessionStorage.setItem(CONFIG.KEYS.loginAttempts, String(Math.max(0, n))); },
    inc()   { this.set(this.get() + 1); },
    reset() { sessionStorage.removeItem(CONFIG.KEYS.loginAttempts); },
};

// ─────────────────────────────────────────────────────────────────
//  COOLDOWN ANTI-FLOOD
// ─────────────────────────────────────────────────────────────────
const Cooldown = {
    isActive(key) {
        return Date.now() < parseInt(sessionStorage.getItem(key) || '0', 10);
    },
    set(key, ms) {
        sessionStorage.setItem(key, String(Date.now() + ms));
    },
};

// ─────────────────────────────────────────────────────────────────
//  RATE LIMITER (client-side)
// ─────────────────────────────────────────────────────────────────
const SubmitRateLimiter = {
    isAllowed() {
        const now = Date.now();
        let log;
        try { log = JSON.parse(sessionStorage.getItem(CONFIG.KEYS.submitRateLog) || '[]'); }
        catch { log = []; }
        log = log.filter(ts => ts > now - CONFIG.RATE_LIMIT_WINDOW_MS);
        if (log.length >= CONFIG.RATE_LIMIT_MAX) return false;
        log.push(now);
        try { sessionStorage.setItem(CONFIG.KEYS.submitRateLog, JSON.stringify(log)); } catch { /* cheio */ }
        return true;
    },
};

// ─────────────────────────────────────────────────────────────────
//  UTILITÁRIOS
// ─────────────────────────────────────────────────────────────────
function sanitizeText(v) { return String(v ?? '').trim(); }
function isValidEmail(e) { return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e); }

// ─────────────────────────────────────────────────────────────────
//  BOTÕES — captura e restauração do HTML original
// ─────────────────────────────────────────────────────────────────
const _btnOriginalHTML = new WeakMap();

function _captureBtn(btn) {
    if (btn && !_btnOriginalHTML.has(btn)) _btnOriginalHTML.set(btn, btn.innerHTML);
}

function restoreButton(btn) {
    btn.disabled = false;
    const orig = _btnOriginalHTML.get(btn);
    if (orig === undefined) return;
    if (_trustedPolicy) { btn.innerHTML = _trustedPolicy.createHTML(orig); }
    else                { btn.innerHTML = orig; }
}

// ─────────────────────────────────────────────────────────────────
//  SPINNER
// ─────────────────────────────────────────────────────────────────
function _makeSpinner(text) {
    const frag = document.createDocumentFragment();
    const svg  = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('loading-svg');
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx','12'); c.setAttribute('cy','12'); c.setAttribute('r','10');
    c.setAttribute('stroke','currentColor'); c.setAttribute('stroke-width','4');
    c.setAttribute('fill','none'); c.setAttribute('opacity','0.25');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d','M12 2a10 10 0 0 1 10 10');
    p.setAttribute('stroke','currentColor'); p.setAttribute('stroke-width','4'); p.setAttribute('fill','none');
    svg.appendChild(c); svg.appendChild(p);
    frag.appendChild(svg);
    frag.appendChild(document.createTextNode(' ' + sanitizeText(text)));
    return frag;
}

function setLoading(btn, text) {
    btn.disabled = true; btn.textContent = '';
    btn.appendChild(_makeSpinner(text));
}

// ─────────────────────────────────────────────────────────────────
//  SELEÇÃO DE ELEMENTOS
// ─────────────────────────────────────────────────────────────────
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
const togglePwd    = document.getElementById('togglePassword');

// ─────────────────────────────────────────────────────────────────
//  MENSAGENS
// ─────────────────────────────────────────────────────────────────
let _msgTimer = null;

function showAuthMessage(msg, type) {
    const div = document.getElementById('authErrorMessage');
    if (!div) return;
    if (_msgTimer) { clearTimeout(_msgTimer); _msgTimer = null; }
    div.textContent = sanitizeText(msg);  // textContent = anti-XSS
    div.className   = `auth-message ${type} visible show`;
    _msgTimer = setTimeout(() => {
        div.classList.remove('show');
        setTimeout(() => { div.classList.remove('visible'); div.textContent = ''; }, 300);
    }, CONFIG.MESSAGE_AUTO_HIDE_MS);
}

function showError(msg) {
    if (!errorMessage) return;
    errorMessage.textContent = sanitizeText(msg);
    errorMessage.classList.add('show');
}

function hideError() {
    if (!errorMessage) return;
    errorMessage.classList.remove('show');
    setTimeout(() => { errorMessage.textContent = ''; }, 300);
}

function shakeInput(el) {
    if (!el) return;
    el.classList.add('input-shake');
    setTimeout(() => el.classList.remove('input-shake'), 500);
}

// ─────────────────────────────────────────────────────────────────
//  INICIALIZAÇÃO
// ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {

    // Estado inicial do captcha: sempre oculto
    const captchaEl = document.getElementById('captchaContainer');
    if (captchaEl) {
        captchaEl.style.display = 'none';
        captchaEl.classList.add('captcha-hidden');
        captchaEl.classList.remove('captcha-visible');
    }

    // Captura HTML original dos botões antes de qualquer mutação
    Object.values(buttons).forEach(btn => {
        if (btn instanceof HTMLElement) _captureBtn(btn);
    });

    // Redireciona se já tem sessão ativa
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) { window.location.replace('dashboard.html'); return; }
    } catch { /* sem sessão — continua */ }

    // Mostra captcha se já atingiu o limite de tentativas
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        showCaptcha();
    }

    createMoneyParticles();
    createAnimatedCharts();

    const authError = sessionStorage.getItem('auth_error');
    if (authError) {
        showAuthMessage(sanitizeText(authError), 'error');
        sessionStorage.removeItem('auth_error');
    }
});

// ─────────────────────────────────────────────────────────────────
//  VALIDAÇÃO DO CAPTCHA NO BACKEND
// ─────────────────────────────────────────────────────────────────
async function validateCaptchaOnBackend(token) {
    if (!token || token.trim().length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return false;
    try {
        const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-recaptcha`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ token: token.trim() }),
        });
        if (!r.ok) return false;
        const res = await r.json();
        return res?.success === true;
    } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
//  VERIFICAÇÃO DE ACESSO
// ─────────────────────────────────────────────────────────────────
async function checkUserAccess() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id) return { hasAccess: false };
        const auth = await _requireSessionHeader();
        const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/check-user-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': auth },
            body: JSON.stringify({ user_id: session.user.id }),
        });
        if (!r.ok) return { hasAccess: false };
        const res = await r.json();
        return { hasAccess: res?.hasAccess === true };
    } catch { return { hasAccess: false }; }
}

// ─────────────────────────────────────────────────────────────────
//  FORMULÁRIO DE LOGIN
//
//  REGRAS DE VALIDAÇÃO (login):
//  ✅ email vazio         → bloqueia, NÃO conta tentativa
//  ✅ email inválido      → bloqueia, NÃO conta tentativa
//  ✅ senha vazia         → bloqueia, NÃO conta tentativa
//  ❌ senha curta/longa   → NÃO valida aqui — vai direto ao Supabase
//  ❌ qualquer outro fmt  → NÃO valida aqui — vai direto ao Supabase
//
//  Qualquer senha não-vazia (1 a 128 chars) é enviada ao Supabase
//  e CONTA como tentativa — ativando o captcha após 3 erros.
// ─────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!SubmitRateLimiter.isAllowed()) {
        showAuthMessage('Muitas tentativas. Aguarde um momento.', 'error');
        return;
    }

    const email    = sanitizeText(inputs.loginEmail.value);
    const password = inputs.loginPassword.value; // NÃO trim — espaços podem fazer parte da senha

    // Validações de presença (não contam como tentativa)
    if (!email) {
        showAuthMessage('Preencha o email.', 'error');
        shakeInput(inputs.loginEmail);
        return;
    }
    if (!isValidEmail(email)) {
        showAuthMessage('Formato de email inválido.', 'error');
        shakeInput(inputs.loginEmail);
        return;
    }
    if (!password) {
        showAuthMessage('Preencha a senha.', 'error');
        shakeInput(inputs.loginPassword);
        return;
    }

    // A partir daqui QUALQUER erro conta como tentativa
    // (incluindo senha curta, errada, email não encontrado, etc.)

    // Exige captcha após limite de tentativas
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        if (!_isCaptchaResolved()) {
            showAuthMessage('Resolva a verificação de segurança.', 'error');
            highlightCaptcha();
            return;
        }
        showAuthMessage('Verificando segurança...', 'info');
        const ok = await validateCaptchaOnBackend(_getCaptchaToken());
        if (!ok) {
            showAuthMessage('Falha na verificação. Tente novamente.', 'error');
            _resetCaptchaToken();
            return;
        }
    }

    const btn = buttons.loginSubmit;
    setLoading(btn, 'Verificando...');

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            inputs.loginPassword.value = ''; // limpa campo de senha imediatamente
            LoginAttempts.inc();             // conta tentativa
            _resetCaptchaToken();

            if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
                showCaptcha();
            }

            // Mensagem genérica — nunca revela motivo real do erro
            showAuthMessage(LOGIN_ERROR_MSG, 'error');
            shakeInput(inputs.loginEmail);
            shakeInput(inputs.loginPassword);
            return;
        }

        // Login bem-sucedido
        LoginAttempts.reset();
        _resetCaptchaToken();
        hideCaptcha();

        setLoading(btn, 'Verificando plano...');
        const { hasAccess } = await checkUserAccess();

        if (!hasAccess) {
            await supabase.auth.signOut();
            showAuthMessage('Você precisa de um plano ativo.', 'error');
            setTimeout(() => window.location.replace('planos.html'), 2500);
            return;
        }

        inputs.loginPassword.value = '';
        inputs.loginEmail.value    = '';
        const name = sanitizeText(data.user.user_metadata?.name || 'Usuário');
        showAuthMessage(`Bem-vindo de volta, ${name}!`, 'success');
        setTimeout(() => window.location.replace('dashboard.html'), 1500);

    } catch {
        showAuthMessage('Erro de conexão. Verifique sua internet.', 'error');
    } finally {
        restoreButton(btn);
    }
});

// ─────────────────────────────────────────────────────────────────
//  TOGGLE SENHA
// ─────────────────────────────────────────────────────────────────
if (togglePwd && inputs.loginPassword) {
    togglePwd.addEventListener('click', () => {
        const show = inputs.loginPassword.type === 'password';
        inputs.loginPassword.type = show ? 'text' : 'password';
        togglePwd.setAttribute('aria-label',   show ? 'Ocultar senha' : 'Mostrar senha');
        togglePwd.setAttribute('aria-pressed', String(show));
    });
}

// ─────────────────────────────────────────────────────────────────
//  NAVEGAÇÃO ENTRE TELAS
// ─────────────────────────────────────────────────────────────────
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
        }, 500);
    } else {
        to.classList.add('active');
        to.setAttribute('aria-hidden', 'false');
    }
}

buttons.forgotPassword?.addEventListener('click', (e) => {
    e.preventDefault();
    switchScreen(screens.login, screens.forgotEmail);
    setTimeout(() => inputs.recoveryEmail?.focus(), 520);
});

buttons.backToLogin?.addEventListener('click', () => {
    _clearRecovery();
    switchScreen(screens.forgotEmail, screens.login);
});

// ─────────────────────────────────────────────────────────────────
//  ENVIAR CÓDIGO DE RECUPERAÇÃO
// ─────────────────────────────────────────────────────────────────
buttons.sendCode?.addEventListener('click', async () => {
    const email = sanitizeText(inputs.recoveryEmail?.value || '');
    if (!email || !isValidEmail(email)) {
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
        const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ email }),
        });
        if (!r.ok) { showAuthMessage('Erro de conexão.', 'error'); return; }
        const res = await r.json();
        if (res.status === 'sent') {
            RecoveryState.setEmail(email);
            Cooldown.set(CONFIG.KEYS.sendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
            showAuthMessage('Código enviado! Verifique seu email.', 'success');
            switchScreen(screens.forgotEmail, screens.code);
            setTimeout(() => inputs.codeInputs[0]?.focus(), 520);
        } else if (res.status === 'not_found' || res.status === 'payment_not_approved') {
            showAuthMessage('Se o email estiver cadastrado com plano ativo, você receberá o código.', 'info');
        } else {
            showAuthMessage('Não foi possível enviar o código.', 'error');
        }
    } catch { showAuthMessage('Erro de conexão.', 'error'); }
    finally  { restoreButton(buttons.sendCode); }
});

buttons.backToEmail?.addEventListener('click', () => {
    resetCodeInputs();
    switchScreen(screens.code, screens.forgotEmail);
});

// ─────────────────────────────────────────────────────────────────
//  VERIFICAR CÓDIGO
// ─────────────────────────────────────────────────────────────────
buttons.verifyCode?.addEventListener('click', () => {
    const code = Array.from(inputs.codeInputs).map(i => i.value).join('');
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
        showAuthMessage('Digite o código de 6 dígitos.', 'error');
        return;
    }
    RecoveryState.setCode(code);
    switchScreen(screens.code, screens.newPassword);
    setTimeout(() => inputs.newPassword?.focus(), 520);
});

buttons.backToCode?.addEventListener('click', () => {
    hideError();
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    switchScreen(screens.newPassword, screens.code);
});

// ─────────────────────────────────────────────────────────────────
//  ALTERAR SENHA
//  Validações de tamanho/formato SÃO permitidas aqui (nova senha).
// ─────────────────────────────────────────────────────────────────
buttons.changePassword?.addEventListener('click', async () => {
    const np = inputs.newPassword?.value     || '';
    const cp = inputs.confirmPassword?.value || '';
    hideError();

    if (!np || !cp)                            { showError('Preencha todos os campos.'); return; }
    if (np.length < 8 || np.length > 128)     { showError('A senha deve ter entre 8 e 128 caracteres.'); return; }
    if (!/[A-Za-z]/.test(np)||!/[0-9]/.test(np)) { showError('A senha deve conter letras e números.'); return; }
    if (np !== cp) {
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
        showError('Sessão expirada. Reinicie o processo.');
        setTimeout(() => { _clearRecovery(); switchScreen(screens.newPassword, screens.login); }, 2000);
        return;
    }

    setLoading(buttons.changePassword, 'Alterando...');
    try {
        const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-and-reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ email: RecoveryState.getEmail(), code: RecoveryState.getCode(), newPassword: np }),
        });
        if (!r.ok) { showError('Erro de conexão.'); return; }
        const res = await r.json();
        if      (res.status === 'success')      { RecoveryState.clear(); switchScreen(screens.newPassword, screens.success); }
        else if (res.status === 'invalid_code') { showError('Código inválido ou expirado.'); RecoveryState.clearCode(); }
        else                                    { showError('Não foi possível alterar a senha.'); }
    } catch { showError('Erro de conexão.'); }
    finally  { restoreButton(buttons.changePassword); }
});

buttons.backToLoginFinal?.addEventListener('click', () => {
    _clearRecovery();
    switchScreen(screens.success, screens.login);
});

// ─────────────────────────────────────────────────────────────────
//  REENVIAR CÓDIGO
// ─────────────────────────────────────────────────────────────────
buttons.resendCode?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!RecoveryState.getEmail()) { showAuthMessage('Email não encontrado. Volte e tente novamente.', 'error'); return; }
    if (Cooldown.isActive(CONFIG.KEYS.resendCooldown)) { showAuthMessage('Aguarde antes de reenviar.', 'error'); return; }

    const btn = buttons.resendCode;
    const orig = sanitizeText(btn.textContent);
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
        const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
            body: JSON.stringify({ email: RecoveryState.getEmail() }),
        });
        if (!r.ok) { showAuthMessage('Erro de conexão.', 'error'); return; }
        const res = await r.json();
        if (res.status === 'sent') {
            Cooldown.set(CONFIG.KEYS.resendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
            showAuthMessage('Novo código enviado!', 'success');
            btn.textContent = 'Enviado!';
            resetCodeInputs(); inputs.codeInputs[0]?.focus();
            setTimeout(() => { btn.textContent = orig; }, 3000);
        } else { showAuthMessage('Erro ao reenviar.', 'error'); }
    } catch { showAuthMessage('Erro de conexão.', 'error'); }
    finally  { btn.disabled = false; }
});

// ─────────────────────────────────────────────────────────────────
//  UTILITÁRIOS DE RECOVERY
// ─────────────────────────────────────────────────────────────────
function _clearRecovery() {
    RecoveryState.clear();
    if (inputs.recoveryEmail)   inputs.recoveryEmail.value   = '';
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    resetCodeInputs(); hideError();
}

// ─────────────────────────────────────────────────────────────────
//  CODE INPUTS
// ─────────────────────────────────────────────────────────────────
inputs.codeInputs.forEach((input, i) => {
    input.addEventListener('input', (e) => {
        const v = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = v;
        if (v.length === 1) { input.classList.add('filled'); inputs.codeInputs[i + 1]?.focus(); }
        else                { input.classList.remove('filled'); }
        const allFilled = Array.from(inputs.codeInputs).every(x => x.value.length === 1);
        if (allFilled && buttons.verifyCode) {
            buttons.verifyCode.classList.add('btn-pulse');
            setTimeout(() => buttons.verifyCode.classList.remove('btn-pulse'), 200);
        }
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && i > 0) {
            const prev = inputs.codeInputs[i - 1];
            prev.focus(); prev.value = ''; prev.classList.remove('filled');
        }
        if (e.key === 'Enter') buttons.verifyCode?.click();
    });
    input.addEventListener('keypress', (e) => { if (!/[0-9]/.test(e.key)) e.preventDefault(); });
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
        pasted.split('').forEach((ch, j) => {
            if (inputs.codeInputs[j]) { inputs.codeInputs[j].value = ch; inputs.codeInputs[j].classList.add('filled'); }
        });
        const last = Math.min(pasted.length - 1, 5);
        if (last >= 0) inputs.codeInputs[last].focus();
    });
});

function resetCodeInputs() {
    inputs.codeInputs.forEach(x => { x.value = ''; x.classList.remove('filled', 'error'); });
}

// ─────────────────────────────────────────────────────────────────
//  ATALHOS DE TECLADO
// ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement === inputs.loginEmail) {
        e.preventDefault(); inputs.loginPassword?.focus();
    }
});
inputs.newPassword?.addEventListener('keypress',     (e) => { if (e.key==='Enter') inputs.confirmPassword?.focus(); });
inputs.confirmPassword?.addEventListener('keypress', (e) => { if (e.key==='Enter') buttons.changePassword?.click(); });
inputs.recoveryEmail?.addEventListener('keypress',   (e) => { if (e.key==='Enter') buttons.sendCode?.click(); });

// ─────────────────────────────────────────────────────────────────
//  PARTÍCULAS E GRÁFICOS (valores numéricos aleatórios = inline style OK)
// ─────────────────────────────────────────────────────────────────
function createMoneyParticles() {
    const c = document.getElementById('moneyParticles');
    if (!c) return;
    const sym = ['$','€','£','¥','₿'];
    for (let i = 0; i < CONFIG.moneyParticleCount; i++) {
        const p = document.createElement('div');
        p.classList.add('money-particle');
        p.textContent = sym[Math.floor(Math.random() * sym.length)];
        p.style.left              = `${Math.random()*100}%`;
        p.style.top               = `${Math.random()*100}%`;
        p.style.fontSize          = `${Math.random()*12+18}px`;
        p.style.animationDuration = `${Math.random()*10+15}s`;
        p.style.animationDelay    = `${Math.random()*5}s`;
        p.style.color             = `rgba(16,185,129,${Math.random()*0.4+0.3})`;
        c.appendChild(p);
    }
}

function createAnimatedCharts() {
    const c = document.getElementById('animatedCharts');
    if (!c) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    for (let i = 0; i < CONFIG.chartLineCount; i++) {
        const path = document.createElementNS('http://www.w3.org/2000/svg','path');
        const pts  = Array.from({length:13},(_,j)=>`${(j/12)*100},${20+Math.random()*60}`);
        path.classList.add('chart-line');
        path.setAttribute('d', `M ${pts.join(' L ')}`);
        path.style.opacity           = String(Math.random()*0.2+0.1);
        path.style.animationDelay    = `${Math.random()*3}s`;
        path.style.animationDuration = `${Math.random()*5+8}s`;
        svg.appendChild(path);
    }
    c.appendChild(svg);
}

// ─────────────────────────────────────────────────────────────────
//  PARALLAX (valores dinâmicos = inline style OK)
// ─────────────────────────────────────────────────────────────────
let mx=0, my=0, cx=0, cy=0;
document.addEventListener('mousemove', (e) => {
    mx = (e.clientX/window.innerWidth  - 0.5)*2;
    my = (e.clientY/window.innerHeight - 0.5)*2;
});
(function parallax() {
    cx += (mx-cx)*0.08; cy += (my-cy)*0.08;
    const v = document.querySelector('.financial-visual');
    if (v) v.style.transform = `rotateY(${-8+cx*8}deg) rotateX(${3+cy*5}deg)`;
    document.querySelectorAll('.gradient-orb').forEach((o,i) => {
        const s=(i+1)*0.4;
        o.style.transform=`translate(${cx*s*25}px,${cy*s*25}px)`;
    });
    requestAnimationFrame(parallax);
}());

// ─────────────────────────────────────────────────────────────────
//  RIPPLE (coords do clique = inline style OK)
// ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.btn-submit').forEach(btn => {
    btn.addEventListener('click', function(e) {
        const r    = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const sz   = Math.max(rect.width, rect.height);
        r.style.cssText = [
            'position:absolute',`width:${sz}px`,`height:${sz}px`,
            'border-radius:50%','background:rgba(255,255,255,0.25)',
            `left:${e.clientX-rect.left-sz/2}px`,`top:${e.clientY-rect.top-sz/2}px`,
            'pointer-events:none','animation:ripple 0.6s ease-out forwards',
        ].join(';');
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(r);
        setTimeout(() => r.remove(), 600);
    });
});

// ─────────────────────────────────────────────────────────────────
//  CHECKBOX BOUNCE
// ─────────────────────────────────────────────────────────────────
document.querySelector('.checkbox-wrapper')?.addEventListener('click', () => {
    const c = document.querySelector('.checkbox-custom');
    if (!c) return;
    c.classList.add('checkbox-custom-bounce');
    setTimeout(() => c.classList.remove('checkbox-custom-bounce'), 200);
});