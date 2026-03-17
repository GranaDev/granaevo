import { supabase } from './supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  [TT-POLICY-1] TRUSTED TYPES — POLÍTICA granaevo-policy
//
//  Usada EXCLUSIVAMENTE em restoreButton() para reinjetar o
//  innerHTML ESTÁTICO dos botões capturado na inicialização.
//  Nunca contém input do usuário.
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
//  NOTA: window.__grOnLoad está definido em recaptcha-init.js
//
//  Ele NÃO pode ser definido aqui porque este arquivo é type="module"
//  — módulos são sempre diferidos e executam DEPOIS do HTML ser parseado.
//  O api.js (async) pode terminar antes disso e chamar __grOnLoad quando
//  ele ainda não existiria. recaptcha-init.js é um script síncrono
//  carregado antes do api.js, garantindo a ordem correta.
//
//  Fluxo garantido:
//    1. recaptcha-init.js executa → window.__grOnLoad fica disponível
//    2. api.js carrega em background (async defer)
//    3. Usuário erra 3x → showCaptcha() → container fica visível
//    4a. Se API já carregou → __grCaptchaReady=true → render imediato
//    4b. Se API ainda carrega → __grPendingRender fica registrado
//    5. api.js termina → __grOnLoad dispara → executa __grPendingRender
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
    moneyParticleCount:          15,
    chartLineCount:               8,
    MAX_ATTEMPTS_BEFORE_CAPTCHA:  3,
    MESSAGE_AUTO_HIDE_MS:      5000,
    SEND_CODE_COOLDOWN_MS:    30_000,
    RATE_LIMIT_MAX:               10,
    RATE_LIMIT_WINDOW_MS:     60_000,
    CAPTCHA_TOKEN_MAX_AGE_MS: 110_000,
    CAPTCHA_TOKEN_MIN_LENGTH:     50,
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
//  MENSAGEM DE ERRO PADRÃO DE LOGIN
//
//  [FIX-MSG] Mensagem única para TODA falha de autenticação,
//  incluindo email vazio, email inválido, senha vazia, senha
//  errada, usuário inexistente e qualquer outro erro do Supabase.
//  Nunca revela detalhes (anti-enumeração de email/senha).
// ═══════════════════════════════════════════════════════════════
const LOGIN_ERROR_MSG = 'Tentativa inválida: email ou senha incorreto';

// ═══════════════════════════════════════════════════════════════
//  CABEÇALHOS DE AUTENTICAÇÃO
// ═══════════════════════════════════════════════════════════════
async function _requireSessionHeader() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
        throw new Error('No active session — authenticated header required.');
    }
    return `Bearer ${session.access_token}`;
}

function _publicHeader() {
    return `Bearer ${supabase.supabaseKey}`;
}


// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — ESTADO
// ═══════════════════════════════════════════════════════════════
let _captchaWidgetId  = null;  // null = não renderizado
let _captchaVisible   = false; // true = container deve estar visível
let _captchaPollTimer = null;  // timer do polling

const CaptchaState = (() => {
    let _token         = null;
    let _resolved      = false;
    let _resolvedAt    = 0;
    let _captchaActive = false;

    window.onCaptchaResolved = (token) => {
        if (!_captchaActive) return;
        if (typeof token !== 'string' || token.length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) return;
        if (typeof grecaptcha === 'undefined') return;
        try {
            const widgetResponse = grecaptcha.getResponse(_captchaWidgetId ?? undefined);
            if (!widgetResponse || widgetResponse !== token) return;
            _token      = token;
            _resolved   = true;
            _resolvedAt = Date.now();
        } catch {
            _token = null; _resolved = false; _resolvedAt = 0;
        }
    };

    window.onCaptchaExpired = () => { _token = null; _resolved = false; _resolvedAt = 0; };
    window.onCaptchaError   = () => { _token = null; _resolved = false; _resolvedAt = 0; };

    return {
        activate()   { _captchaActive = true;  },
        deactivate() { _captchaActive = false; },

        isResolved() {
            if (!_resolved || !_token) return false;
            return (Date.now() - _resolvedAt) < CONFIG.CAPTCHA_TOKEN_MAX_AGE_MS;
        },

        getToken() { return this.isResolved() ? _token : null; },

        reset() {
            _token = null; _resolved = false; _resolvedAt = 0;
            if (typeof grecaptcha === 'undefined') return;
            try {
                if (_captchaWidgetId !== null) {
                    grecaptcha.reset(_captchaWidgetId);
                } else {
                    grecaptcha.reset();
                }
            } catch { /* widget ainda não renderizado */ }
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA — POLLING
//
//  Abordagem definitiva: polling simples a cada 200ms.
//  Não depende de callbacks, onload, requestAnimationFrame
//  ou setTimeout. Verifica as duas condições necessárias:
//    1. grecaptcha.ready disponível
//    2. container visível com dimensões reais
//  Quando ambas OK → renderiza e para o poll.
// ═══════════════════════════════════════════════════════════════
function _startCaptchaPoll() {
    if (_captchaPollTimer !== null) return; // já polling

    _captchaPollTimer = setInterval(() => {
        // Para se widget já foi criado
        if (_captchaWidgetId !== null) {
            clearInterval(_captchaPollTimer);
            _captchaPollTimer = null;
            return;
        }

        // Espera container estar visível
        const el = document.getElementById('captchaContainer');
        if (!el || el.offsetParent === null) return; // não visível ainda

        // Espera container ter largura real
        if (el.offsetWidth < 50) return;

        // Espera grecaptcha carregar
        if (typeof grecaptcha === 'undefined' || typeof grecaptcha.render !== 'function') return;

        // Tudo pronto — renderiza
        clearInterval(_captchaPollTimer);
        _captchaPollTimer = null;

        const container = el.querySelector('.g-recaptcha');
        if (!container) return;

        // Limpa container
        while (container.firstChild) container.removeChild(container.firstChild);

        try {
            grecaptcha.ready(() => {
                if (_captchaWidgetId !== null) return;
                try {
                    _captchaWidgetId = grecaptcha.render(container, {
                        sitekey:            CONFIG.CAPTCHA_SITE_KEY,
                        callback:           'onCaptchaResolved',
                        'expired-callback': 'onCaptchaExpired',
                        'error-callback':   'onCaptchaError',
                        theme:              'dark',
                    });
                    console.log('[reCAPTCHA] OK — id:', _captchaWidgetId);
                } catch (err) {
                    console.error('[reCAPTCHA] render falhou:', err);
                    // Se o iframe foi criado mesmo com erro, considera sucesso
                    if (container.querySelector('iframe')) _captchaWidgetId = 0;
                    else _startCaptchaPoll(); // tenta de novo
                }
            });
        } catch (err) {
            console.error('[reCAPTCHA] ready() falhou:', err);
            _captchaPollTimer = null;
            _startCaptchaPoll(); // reagenda
        }

    }, 200);
}

function showCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;

    _captchaVisible = true;
    el.style.display      = 'flex';
    el.style.flexDirection = 'column';
    CaptchaState.activate();

    if (_captchaWidgetId !== null) return; // widget já existe

    _startCaptchaPoll();
}

function hideCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    _captchaVisible = false;
    el.style.display = 'none';
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
    if (!token || typeof token !== 'string' || token.trim().length < CONFIG.CAPTCHA_TOKEN_MIN_LENGTH) {
        return false;
    }
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
//  VERIFICAÇÃO DE ACESSO — SEM ENUMERAÇÃO DE EMAIL
// ═══════════════════════════════════════════════════════════════
async function checkUserAccess() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id || !session?.access_token) return { hasAccess: false };

        const authHeader = await _requireSessionHeader();
        const response   = await fetch(
            `${CONFIG.SUPABASE_URL}/functions/v1/check-user-access`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
                body: JSON.stringify({ user_id: session.user.id }),
            }
        );
        if (!response.ok) return { hasAccess: false };
        const result = await response.json();
        return { hasAccess: result?.hasAccess === true };
    } catch {
        return { hasAccess: false };
    }
}

// ═══════════════════════════════════════════════════════════════
//  FORMULÁRIO DE LOGIN
//
//  [FIX-ATTEMPTS] Regra central corrigida:
//
//  ANTES (bugado):
//    — email vazio         → return sem contar tentativa
//    — email mal-formatado → return sem contar tentativa
//    — senha vazia         → return sem contar tentativa
//    — senha < 8 chars     → return sem contar tentativa (via minlength nativo)
//    — senha > 128 chars   → return sem contar tentativa
//
//  Resultado: o captcha nunca aparecia nesses casos e o atacante
//  podia tentar infinitamente com senhas inválidas.
//
//  AGORA (corrigido):
//    — QUALQUER falha de validação local → conta tentativa
//                                        → mostra LOGIN_ERROR_MSG
//                                        → ativa captcha se >= 3 tentativas
//    — Nenhuma validação de tamanho/formato de senha no login.
//      Qualquer senha não-vazia é enviada ao Supabase.
//      Motivo: validar tamanho localmente revela ao atacante
//      informações sobre a senha (anti-enumeração de senhas)
//      e quebra o mecanismo de captcha.
//
//  Fluxo garantido:
//    Tentativa 1 → LOGIN_ERROR_MSG
//    Tentativa 2 → LOGIN_ERROR_MSG
//    Tentativa 3 → LOGIN_ERROR_MSG + captcha aparece ← CORRIGIDO
//    Tentativa 4+ → captcha obrigatório antes de submeter
// ═══════════════════════════════════════════════════════════════

// Helper interno: contabiliza tentativa, exibe mensagem e mostra captcha se necessário.
function _registerFailedAttempt() {
    LoginAttempts.inc();
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        showCaptcha();
    }
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Proteção contra flood de submissões (10 por minuto)
    if (!SubmitRateLimiter.isAllowed()) {
        showAuthMessage('Muitas tentativas em pouco tempo. Aguarde um momento.', 'error');
        return;
    }

    const email    = sanitizeText(inputs.loginEmail.value);
    const password = inputs.loginPassword.value; // NÃO aparar — espaços podem ser senha válida

    // ── [FIX-ATTEMPTS] Email vazio ou inválido conta como tentativa ──
    if (!email || !isValidEmail(email)) {
        inputs.loginPassword.value = '';
        _registerFailedAttempt();
        showAuthMessage(LOGIN_ERROR_MSG, 'error');
        shakeInput(inputs.loginEmail);
        shakeInput(inputs.loginPassword);
        return;
    }

    // ── [FIX-ATTEMPTS] Senha vazia conta como tentativa ──
    if (!password) {
        _registerFailedAttempt();
        showAuthMessage(LOGIN_ERROR_MSG, 'error');
        shakeInput(inputs.loginPassword);
        return;
    }

    // ── Verifica captcha se limite de tentativas atingido ──
    const currentAttempts = LoginAttempts.get();
    if (currentAttempts >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        if (!CaptchaState.isResolved()) {
            showAuthMessage('Por favor, resolva a verificação de segurança.', 'error');
            highlightCaptcha();
            return;
        }

        showAuthMessage('Verificando segurança...', 'info');
        const captchaValid = await validateCaptchaOnBackend(CaptchaState.getToken());
        if (!captchaValid) {
            showAuthMessage('Falha na verificação de segurança. Tente novamente.', 'error');
            CaptchaState.reset();
            return;
        }
    }

    const submitBtn = buttons.loginSubmit;
    setButtonLoading(submitBtn, 'Verificando...');

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

        // ── Login bem-sucedido ──
        LoginAttempts.reset();
        CaptchaState.reset();
        hideCaptcha();

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
// ═══════════════════════════════════════════════════════════════
if (buttons.sendCode) {
    buttons.sendCode.addEventListener('click', async () => {
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

        setButtonLoading(buttons.sendCode, 'Enviando...');

        try {
            const response = await fetch(
                `${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
                    body: JSON.stringify({ email }),
                }
            );

            if (!response.ok) { showAuthMessage('Erro de conexão. Tente novamente.', 'error'); return; }

            const result = await response.json();

            if (result.status === 'sent') {
                RecoveryState.setEmail(email);
                Cooldown.set(CONFIG.KEYS.sendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
                showAuthMessage('Código enviado! Verifique seu email.', 'success');
                switchScreen(screens.forgotEmail, screens.code);
                setTimeout(() => inputs.codeInputs[0]?.focus(), 520);
            } else if (result.status === 'not_found' || result.status === 'payment_not_approved') {
                showAuthMessage('Se o email estiver cadastrado com plano ativo, você receberá o código.', 'info');
            } else {
                showAuthMessage('Não foi possível enviar o código. Tente novamente.', 'error');
            }
        } catch {
            showAuthMessage('Erro de conexão. Tente novamente.', 'error');
        } finally {
            restoreButton(buttons.sendCode);
        }
    });
}

if (buttons.backToEmail) {
    buttons.backToEmail.addEventListener('click', () => {
        resetCodeInputs();
        switchScreen(screens.code, screens.forgotEmail);
    });
}

// ═══════════════════════════════════════════════════════════════
//  VERIFICAR CÓDIGO
// ═══════════════════════════════════════════════════════════════
if (buttons.verifyCode) {
    buttons.verifyCode.addEventListener('click', () => {
        const code = Array.from(inputs.codeInputs).map(i => i.value).join('');

        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            showAuthMessage('Digite o código completo de 6 dígitos.', 'error');
            return;
        }

        RecoveryState.setCode(code);
        switchScreen(screens.code, screens.newPassword);
        setTimeout(() => inputs.newPassword?.focus(), 520);
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
//  ALTERAR SENHA (tela de recuperação — validações permitidas aqui)
// ═══════════════════════════════════════════════════════════════
if (buttons.changePassword) {
    buttons.changePassword.addEventListener('click', async () => {
        const newPass     = inputs.newPassword?.value     || '';
        const confirmPass = inputs.confirmPassword?.value || '';

        hideError();

        if (!newPass || !confirmPass) { showError('Por favor, preencha todos os campos.'); return; }

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
            setTimeout(() => { _clearRecoveryState(); switchScreen(screens.newPassword, screens.login); }, 2000);
            return;
        }

        setButtonLoading(buttons.changePassword, 'Alterando...');

        try {
            const response = await fetch(
                `${CONFIG.SUPABASE_URL}/functions/v1/verify-and-reset-password`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
                    body: JSON.stringify({
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
                switchScreen(screens.newPassword, screens.success);
            } else if (result.status === 'invalid_code') {
                showError('Código inválido, expirado ou já utilizado.');
                RecoveryState.clearCode();
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

        if (!RecoveryState.getEmail()) {
            showAuthMessage('Email não encontrado. Volte e digite novamente.', 'error');
            return;
        }

        if (Cooldown.isActive(CONFIG.KEYS.resendCooldown)) {
            showAuthMessage('Aguarde antes de reenviar o código.', 'error');
            return;
        }

        const btn          = buttons.resendCode;
        const originalText = sanitizeText(btn.textContent);
        btn.disabled       = true;
        btn.textContent    = 'Enviando...';

        try {
            const response = await fetch(
                `${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': _publicHeader() },
                    body: JSON.stringify({ email: RecoveryState.getEmail() }),
                }
            );

            if (!response.ok) { showAuthMessage('Erro de conexão. Tente novamente.', 'error'); return; }

            const result = await response.json();

            if (result.status === 'sent') {
                Cooldown.set(CONFIG.KEYS.resendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
                showAuthMessage('Novo código enviado!', 'success');
                btn.textContent = 'Código enviado!';
                resetCodeInputs();
                inputs.codeInputs[0]?.focus();
                setTimeout(() => { btn.textContent = originalText; }, 3000);
            } else {
                showAuthMessage('Erro ao reenviar o código.', 'error');
            }
        } catch {
            showAuthMessage('Erro de conexão.', 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  LIMPEZA DO ESTADO DE RECUPERAÇÃO
// ═══════════════════════════════════════════════════════════════
function _clearRecoveryState() {
    RecoveryState.clear();
    if (inputs.recoveryEmail)   inputs.recoveryEmail.value   = '';
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    resetCodeInputs();
    hideError();
}

// ═══════════════════════════════════════════════════════════════
//  INPUTS DE CÓDIGO DE VERIFICAÇÃO
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
            prev.focus();
            prev.value = '';
            prev.classList.remove('filled');
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
//  PARTÍCULAS E GRÁFICOS ANIMADOS
//  Inline styles: valores numéricos gerados em runtime.
// ═══════════════════════════════════════════════════════════════
function createMoneyParticles() {
    const container = document.getElementById('moneyParticles');
    if (!container) return;
    const symbols = ['$', '€', '£', '¥', '₿'];
    for (let i = 0; i < CONFIG.moneyParticleCount; i++) {
        const particle = document.createElement('div');
        particle.classList.add('money-particle');
        particle.textContent              = symbols[Math.floor(Math.random() * symbols.length)];
        particle.style.left               = `${Math.random() * 100}%`;
        particle.style.top                = `${Math.random() * 100}%`;
        particle.style.fontSize           = `${Math.random() * 12 + 18}px`;
        particle.style.animationDuration  = `${Math.random() * 10 + 15}s`;
        particle.style.animationDelay     = `${Math.random() * 5}s`;
        particle.style.color              = `rgba(16, 185, 129, ${Math.random() * 0.4 + 0.3})`;
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
        for (let j = 0; j <= 12; j++) {
            points.push(`${(j / 12) * 100},${20 + Math.random() * 60}`);
        }
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
//  PARALLAX DO MOUSE — inline style necessário (valores dinâmicos)
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
    if (visual) {
        visual.style.transform = `rotateY(${-8 + currentX * 8}deg) rotateX(${3 + currentY * 5}deg)`;
    }

    document.querySelectorAll('.gradient-orb').forEach((orb, i) => {
        const speed = (i + 1) * 0.4;
        orb.style.transform = `translate(${currentX * speed * 25}px, ${currentY * speed * 25}px)`;
    });

    requestAnimationFrame(animateParallax);
}

animateParallax();

// ═══════════════════════════════════════════════════════════════
//  EFEITO DE RIPPLE NOS BOTÕES — inline style necessário (coords)
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('.btn-submit').forEach(button => {
    button.addEventListener('click', function (e) {
        const ripple = document.createElement('span');
        const rect   = this.getBoundingClientRect();
        const size   = Math.max(rect.width, rect.height);

        ripple.style.cssText = [
            'position:absolute',
            `width:${size}px`,
            `height:${size}px`,
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
//  FEEDBACK VISUAL NO CHECKBOX — usa .checkbox-custom-bounce (CSS)
// ═══════════════════════════════════════════════════════════════
document.querySelector('.checkbox-wrapper')?.addEventListener('click', () => {
    const custom = document.querySelector('.checkbox-custom');
    if (!custom) return;
    custom.classList.add('checkbox-custom-bounce');
    setTimeout(() => custom.classList.remove('checkbox-custom-bounce'), 200);
});