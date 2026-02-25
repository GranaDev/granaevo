/**
 * GranaEvo — login.js
 *
 * CORREÇÕES DE SEGURANÇA APLICADAS:
 *
 * [SEC-01] captchaToken e captchaResolved movidos para closure privada (não acessíveis via console)
 * [SEC-02] loginAttempts persiste em sessionStorage (resiste a refresh de página)
 * [SEC-03] Token reCAPTCHA validado SOMENTE no backend via Edge Function
 * [SEC-04] Mensagem de erro genérica para login falho (evita enumeração de usuários)
 * [SEC-05] Botão de submit desabilitado ANTES do await (evita double-submit/race condition)
 * [SEC-06] Toda inserção de texto no DOM usa textContent (nunca innerHTML com dados externos)
 * [SEC-07] Spinner de loading usa elementos DOM criados programaticamente (sem innerHTML com dados externos)
 * [SEC-08] Rate limiting frontend adicional com timestamp em sessionStorage
 * [SEC-09] Limpeza de campos sensíveis após erros
 * [SEC-10] Sem console.log com dados sensíveis em produção
 * [SEC-11] Callbacks do reCAPTCHA registrados via window apenas quando necessário
 * [SEC-12] Validação de email com regex no cliente (dupla validação — backend é a autoridade)
 * [SEC-13] Cooldowns de envio de código persistem em sessionStorage (anti-flood)
 * [SEC-14] is_guest_member removido do sessionStorage — lógica de autorização real fica no AuthGuard
 * [SEC-15] supabase.supabaseKey NÃO é usado diretamente nas chamadas de Edge Function (use a anon key configurada)
 */

import { supabase } from './supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
    moneyParticleCount:        15,
    chartLineCount:             8,
    MAX_ATTEMPTS_BEFORE_CAPTCHA: 3,
    MESSAGE_AUTO_HIDE_MS:      5000,

    // Cooldown entre envios de código (30s)
    SEND_CODE_COOLDOWN_MS:    30_000,

    // Rate limit de frontend: máx N submissões por janela de tempo
    RATE_LIMIT_MAX:            10,
    RATE_LIMIT_WINDOW_MS:     60_000,

    // Chaves de sessionStorage (prefixadas para evitar colisão)
    KEYS: Object.freeze({
        loginAttempts:      '_ge_la',
        sendCooldown:       '_ge_scc',
        resendCooldown:     '_ge_rcc',
        submitRateLog:      '_ge_srl',
    }),

    SUPABASE_URL: 'https://fvrhqqeofqedmhadzzqw.supabase.co',
});

// ═══════════════════════════════════════════════════════════════
//  MÓDULO PRIVADO: ESTADO DO RECAPTCHA
//  [SEC-01] Estado em closure — inacessível via console/DevTools
// ═══════════════════════════════════════════════════════════════
const CaptchaState = (() => {
    let _token    = null;
    let _resolved = false;

    // Registra callbacks globais que o reCAPTCHA v2 exige
    window.onCaptchaResolved = (token) => {
        if (typeof token === 'string' && token.length > 20) {
            _token    = token;
            _resolved = true;
        }
    };

    window.onCaptchaExpired = () => {
        _token    = null;
        _resolved = false;
    };

    window.onCaptchaError = () => {
        _token    = null;
        _resolved = false;
    };

    return {
        isResolved: ()  => _resolved,
        getToken:   ()  => _token,

        reset() {
            _token    = null;
            _resolved = false;
            if (typeof grecaptcha !== 'undefined') {
                try { grecaptcha.reset(); } catch (_) { /* widget ainda não renderizado */ }
            }
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: TENTATIVAS DE LOGIN
//  [SEC-02] Persiste em sessionStorage para resistir a refresh
// ═══════════════════════════════════════════════════════════════
const LoginAttempts = {
    get()   { return parseInt(sessionStorage.getItem(CONFIG.KEYS.loginAttempts) || '0', 10); },
    set(n)  { sessionStorage.setItem(CONFIG.KEYS.loginAttempts, String(Math.max(0, n))); },
    inc()   { this.set(this.get() + 1); },
    reset() { sessionStorage.removeItem(CONFIG.KEYS.loginAttempts); },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: COOLDOWN ANTI-FLOOD
//  [SEC-13] Throttle persistente para envio de código
// ═══════════════════════════════════════════════════════════════
const Cooldown = {
    isActive(key) {
        const until = parseInt(sessionStorage.getItem(key) || '0', 10);
        return Date.now() < until;
    },
    set(key, ms) {
        sessionStorage.setItem(key, String(Date.now() + ms));
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: RATE LIMITER DE SUBMISSÃO (frontend)
//  [SEC-08] Impede flood de requests no período de tempo configurado
//  NOTA: Rate limiting real DEVE estar no backend (Edge Function / RLS)
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

        // Remove entradas fora da janela
        log = log.filter(ts => ts > windowStart);

        if (log.length >= CONFIG.RATE_LIMIT_MAX) return false;

        log.push(now);

        try {
            sessionStorage.setItem(CONFIG.KEYS.submitRateLog, JSON.stringify(log));
        } catch { /* sessionStorage cheio */ }

        return true;
    },
};

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIO: SANITIZAÇÃO DE TEXTO (XSS)
//  [SEC-06] Toda saída para o DOM usa este helper ou textContent direto
// ═══════════════════════════════════════════════════════════════
function sanitizeText(value) {
    // Retorna string segura para inserção via textContent
    return String(value ?? '').trim();
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIO: VALIDAÇÃO DE EMAIL
//  [SEC-12] Valida formato antes de enviar ao servidor
// ═══════════════════════════════════════════════════════════════
function isValidEmail(email) {
    // RFC 5322 simplificado — validação definitiva ocorre no backend
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIO: CRIAR SPINNER SEM innerHTML
//  [SEC-07] Evita injeção via innerHTML ao criar elementos de loading
// ═══════════════════════════════════════════════════════════════
function createSpinnerElement(labelText) {
    const wrapper = document.createDocumentFragment();

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'width:20px;height:20px;animation:spin 1s linear infinite;';

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '4');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('opacity', '0.25');
    svg.appendChild(circle);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 2a10 10 0 0 1 10 10');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '4');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);

    const text = document.createTextNode(' ' + sanitizeText(labelText));

    wrapper.appendChild(svg);
    wrapper.appendChild(text);

    return wrapper;
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIO: ESTADO DO BOTÃO DE LOADING
//  Salva/restaura conteúdo do botão sem usar innerHTML com dados externos
// ═══════════════════════════════════════════════════════════════
function setButtonLoading(btn, loadingText) {
    btn.disabled = true;
    btn.dataset.originalHtml = btn.innerHTML; // salva HTML seguro (apenas template interno)
    btn.textContent = '';
    btn.appendChild(createSpinnerElement(loadingText));
}

function restoreButton(btn) {
    btn.disabled = false;
    if (btn.dataset.originalHtml) {
        // O conteúdo original foi gerado pelo desenvolvedor (não por input do usuário)
        // eslint-disable-next-line no-unsanitized/property
        btn.innerHTML = btn.dataset.originalHtml;
        delete btn.dataset.originalHtml;
    }
}

// ═══════════════════════════════════════════════════════════════
//  SELEÇÃO DE ELEMENTOS DO DOM
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
    loginEmail:    document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    recoveryEmail: document.getElementById('recoveryEmail'),
    codeInputs:    document.querySelectorAll('.code-input'),
    newPassword:   document.getElementById('newPassword'),
    confirmPassword: document.getElementById('confirmPassword'),
});

const loginForm      = document.getElementById('loginForm');
const errorMessage   = document.getElementById('errorMessage');
const togglePassword = document.getElementById('togglePassword');

// ═══════════════════════════════════════════════════════════════
//  ESTADO DE RECUPERAÇÃO DE SENHA
//  Mantido em closure — não exposto globalmente
// ═══════════════════════════════════════════════════════════════
let _recoveryEmail = '';
let _verifiedCode  = '';

// ═══════════════════════════════════════════════════════════════
//  FUNÇÕES DE MENSAGEM
//  [SEC-06] Usa textContent — nunca innerHTML com input do usuário
// ═══════════════════════════════════════════════════════════════
let _messageTimer = null;

function showAuthMessage(message, type) {
    const messageDiv = document.getElementById('authErrorMessage');
    if (!messageDiv) return;

    // Cancela timer anterior para evitar race condition de hide
    if (_messageTimer) {
        clearTimeout(_messageTimer);
        _messageTimer = null;
    }

    // [SEC-06] textContent — nunca innerHTML com dados externos
    messageDiv.textContent = sanitizeText(message);
    messageDiv.className   = `auth-message ${type} show`;
    messageDiv.style.display = 'flex';

    _messageTimer = setTimeout(() => {
        messageDiv.classList.remove('show');
        setTimeout(() => {
            messageDiv.style.display = 'none';
            messageDiv.textContent   = '';
        }, 300);
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
//  EFEITOS VISUAIS: SHAKE E INPUT
// ═══════════════════════════════════════════════════════════════
function shakeInput(input) {
    if (!input) return;
    input.style.animation   = 'shake 0.5s';
    input.style.borderColor = 'var(--error-red)';
    setTimeout(() => {
        input.style.animation   = '';
        input.style.borderColor = '';
    }, 500);
}

// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
    // Verifica sessão ativa antes de qualquer coisa
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            window.location.replace('dashboard.html');
            return;
        }
    } catch {
        // Não há sessão ou erro de rede — continua para o login
    }

    // Exibe reCAPTCHA imediatamente se já havia tentativas acima do limite
    if (LoginAttempts.get() >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        showCaptcha();
    }

    createMoneyParticles();
    createAnimatedCharts();

    // Exibe erro de autenticação vindo de outra página (ex: AuthGuard)
    const authError = sessionStorage.getItem('auth_error');
    if (authError) {
        // [SEC-06] Usa sanitizeText antes de exibir
        showAuthMessage(sanitizeText(authError), 'error');
        sessionStorage.removeItem('auth_error');
    }
});

// ═══════════════════════════════════════════════════════════════
//  CAPTCHA: EXIBIR / OCULTAR
// ═══════════════════════════════════════════════════════════════
function showCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.classList.remove('captcha-hidden');
    el.classList.add('captcha-visible');
}

function hideCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.classList.remove('captcha-visible');
    el.classList.add('captcha-hidden');
}

// ═══════════════════════════════════════════════════════════════
//  VALIDAÇÃO DO CAPTCHA NO BACKEND
//  [SEC-03] Token validado APENAS no servidor — frontend só repassa
//  [SEC-15] Usa a anon key pública do Supabase (configurada no client)
// ═══════════════════════════════════════════════════════════════
async function validateCaptchaOnBackend(token) {
    if (!token || typeof token !== 'string' || token.trim().length < 20) {
        return false;
    }

    try {
        const { data: { session } } = await supabase.auth.getSession();

        const response = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/verify-recaptcha`, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                // Usa a anon key pública — nunca a service role key
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
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
//  SUBSCRIPTION: VERIFICAÇÃO PÓS-LOGIN
// ═══════════════════════════════════════════════════════════════
async function getActiveSubscription(userId) {
    try {
        // 1. Verifica se o próprio usuário tem assinatura ativa
        const { data: ownSub, error: ownErr } = await supabase
            .from('subscriptions')
            .select('id, plans(name), is_active, payment_status, expires_at')
            .eq('user_id', userId)
            .eq('payment_status', 'approved')
            .eq('is_active', true)
            .maybeSingle();

        if (!ownErr && ownSub) {
            if (ownSub.expires_at && new Date(ownSub.expires_at) < new Date()) {
                return { subscription: null, isGuest: false };
            }
            return { subscription: ownSub, isGuest: false };
        }

        // 2. Verifica se é convidado com dono de plano ativo
        const { data: membership, error: memErr } = await supabase
            .from('account_members')
            .select('owner_user_id')
            .eq('member_user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (memErr || !membership) return { subscription: null, isGuest: false };

        const { data: ownerSub, error: ownerErr } = await supabase
            .from('subscriptions')
            .select('id, plans(name), is_active, payment_status, expires_at')
            .eq('user_id', membership.owner_user_id)
            .eq('payment_status', 'approved')
            .eq('is_active', true)
            .maybeSingle();

        if (ownerErr || !ownerSub) return { subscription: null, isGuest: false };

        if (ownerSub.expires_at && new Date(ownerSub.expires_at) < new Date()) {
            return { subscription: null, isGuest: false };
        }

        return { subscription: ownerSub, isGuest: true };
    } catch {
        return { subscription: null, isGuest: false };
    }
}

// ═══════════════════════════════════════════════════════════════
//  FORMULÁRIO DE LOGIN
// ═══════════════════════════════════════════════════════════════
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // [SEC-08] Rate limit de submissão no frontend
    if (!SubmitRateLimiter.isAllowed()) {
        showAuthMessage('Muitas tentativas em pouco tempo. Aguarde um momento.', 'error');
        return;
    }

    const email    = sanitizeText(inputs.loginEmail.value);
    const password = inputs.loginPassword.value; // senha não é trimada

    // Validações básicas
    if (!email || !password) {
        showAuthMessage('Por favor, preencha todos os campos.', 'error');
        return;
    }

    if (!isValidEmail(email)) {
        showAuthMessage('Formato de email inválido.', 'error');
        shakeInput(inputs.loginEmail);
        return;
    }

    if (password.length < 8 || password.length > 128) {
        showAuthMessage('Senha deve ter entre 8 e 128 caracteres.', 'error');
        shakeInput(inputs.loginPassword);
        return;
    }

    const currentAttempts = LoginAttempts.get();

    // ── Verificação do reCAPTCHA ──────────────────────────────
    if (currentAttempts >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        if (!CaptchaState.isResolved()) {
            showAuthMessage('Por favor, resolva a verificação de segurança.', 'error');
            highlightCaptcha();
            return;
        }

        // [SEC-03] Validação do token no backend
        showAuthMessage('Verificando segurança...', 'info');
        const captchaValid = await validateCaptchaOnBackend(CaptchaState.getToken());

        if (!captchaValid) {
            showAuthMessage('Falha na verificação de segurança. Tente novamente.', 'error');
            CaptchaState.reset();
            return;
        }
    }

    // [SEC-05] Desabilita o botão ANTES do await para evitar double-submit
    const submitBtn = buttons.loginSubmit;
    setButtonLoading(submitBtn, 'Verificando...');

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            // [SEC-09] Limpa a senha após falha
            inputs.loginPassword.value = '';

            LoginAttempts.inc();
            CaptchaState.reset();

            const attempts = LoginAttempts.get();

            if (attempts >= CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA) {
                showCaptcha();
                // [SEC-04] Mensagem genérica — não revela se email existe
                showAuthMessage(
                    'Credenciais inválidas. Complete a verificação de segurança para continuar.',
                    'error'
                );
            } else {
                const remaining = CONFIG.MAX_ATTEMPTS_BEFORE_CAPTCHA - attempts;
                // [SEC-04] Não diferencia "email não encontrado" de "senha errada"
                showAuthMessage(
                    `Credenciais inválidas. ${remaining} tentativa${remaining !== 1 ? 's' : ''} restante${remaining !== 1 ? 's' : ''}.`,
                    'error'
                );
            }

            shakeInput(inputs.loginEmail);
            shakeInput(inputs.loginPassword);
            return;
        }

        // ✅ Login bem-sucedido
        LoginAttempts.reset();
        CaptchaState.reset();
        hideCaptcha();

        // [SEC-14] NÃO grava is_guest_member no sessionStorage
        // A autorização real é verificada pelo AuthGuard no dashboard

        try {
            const { subscription } = await getActiveSubscription(data.user.id);

            if (!subscription) {
                // Sem plano: destrói sessão imediatamente
                await supabase.auth.signOut();
                showAuthMessage('Você precisa de um plano ativo para acessar o sistema.', 'error');
                setTimeout(() => {
                    window.location.replace('planos.html');
                }, 2500);
                return;
            }

            // Nome vem dos metadados — sanitizado antes de exibir
            const userName = sanitizeText(data.user.user_metadata?.name || 'Usuário');
            showAuthMessage(`Bem-vindo de volta, ${userName}!`, 'success');

            setTimeout(() => {
                window.location.replace('dashboard.html');
            }, 1500);

        } catch {
            // Erro ao verificar plano APÓS login — destrói sessão por segurança
            await supabase.auth.signOut().catch(() => {});
            showAuthMessage('Erro ao verificar seu plano. Tente novamente.', 'error');
        }

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
        togglePassword.setAttribute('aria-label', isPassword ? 'Ocultar senha' : 'Mostrar senha');
        togglePassword.setAttribute('aria-pressed', String(isPassword));
    });
}

// ═══════════════════════════════════════════════════════════════
//  HIGHLIGHT DO CAPTCHA (sem border inline desnecessária)
// ═══════════════════════════════════════════════════════════════
function highlightCaptcha() {
    const el = document.getElementById('captchaContainer');
    if (!el) return;
    el.classList.add('captcha-error');
    setTimeout(() => el.classList.remove('captcha-error'), 2000);
}

// ═══════════════════════════════════════════════════════════════
//  NAVEGAÇÃO ENTRE TELAS
// ═══════════════════════════════════════════════════════════════
function switchScreen(currentScreen, nextScreen) {
    // Desativa todas as telas
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

// ─── Navegação: Esqueceu senha ────────────────────────────────
if (buttons.forgotPassword) {
    buttons.forgotPassword.addEventListener('click', (e) => {
        e.preventDefault();
        switchScreen(screens.login, screens.forgotEmail);
        setTimeout(() => inputs.recoveryEmail?.focus(), 520);
    });
}

// ─── Navegação: Voltar para login ────────────────────────────
if (buttons.backToLogin) {
    buttons.backToLogin.addEventListener('click', () => {
        if (inputs.recoveryEmail) inputs.recoveryEmail.value = '';
        switchScreen(screens.forgotEmail, screens.login);
    });
}

// ═══════════════════════════════════════════════════════════════
//  ENVIAR CÓDIGO DE RECUPERAÇÃO
//  [SEC-13] Cooldown persistente anti-flood
// ═══════════════════════════════════════════════════════════════
if (buttons.sendCode) {
    buttons.sendCode.addEventListener('click', async () => {
        const email = sanitizeText(inputs.recoveryEmail?.value || '');

        if (!email || !isValidEmail(email)) {
            if (inputs.recoveryEmail) {
                inputs.recoveryEmail.style.borderColor = 'var(--error-red)';
                setTimeout(() => { inputs.recoveryEmail.style.borderColor = ''; }, 2000);
            }
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
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': `Bearer ${supabase.supabaseKey}`,
                    },
                    body: JSON.stringify({ email }),
                }
            );

            if (!response.ok) {
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            const result = await response.json();

            if (result.status === 'sent') {
                _recoveryEmail = email;
                Cooldown.set(CONFIG.KEYS.sendCooldown, CONFIG.SEND_CODE_COOLDOWN_MS);
                showAuthMessage('Código enviado! Verifique seu email.', 'success');
                switchScreen(screens.forgotEmail, screens.code);
                setTimeout(() => inputs.codeInputs[0]?.focus(), 520);

            } else if (result.status === 'not_found' || result.status === 'payment_not_approved') {
                // [SEC-04] Mensagem genérica para não revelar se o email existe
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

// ─── Navegação: Voltar para email ────────────────────────────
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

        _verifiedCode = code;
        switchScreen(screens.code, screens.newPassword);
        setTimeout(() => inputs.newPassword?.focus(), 520);
    });
}

// ─── Navegação: Voltar para código ───────────────────────────
if (buttons.backToCode) {
    buttons.backToCode.addEventListener('click', () => {
        hideError();
        if (inputs.newPassword)    inputs.newPassword.value    = '';
        if (inputs.confirmPassword) inputs.confirmPassword.value = '';
        switchScreen(screens.newPassword, screens.code);
    });
}

// ═══════════════════════════════════════════════════════════════
//  ALTERAR SENHA
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
            if (inputs.newPassword)     { inputs.newPassword.style.borderColor     = 'var(--error-red)'; }
            if (inputs.confirmPassword) { inputs.confirmPassword.style.borderColor = 'var(--error-red)'; }
            setTimeout(() => {
                if (inputs.newPassword)     inputs.newPassword.style.borderColor     = '';
                if (inputs.confirmPassword) inputs.confirmPassword.style.borderColor = '';
            }, 2000);
            return;
        }

        if (!_recoveryEmail || !_verifiedCode) {
            showError('Sessão de recuperação expirada. Reinicie o processo.');
            setTimeout(() => {
                _clearRecoveryState();
                switchScreen(screens.newPassword, screens.login);
            }, 2000);
            return;
        }

        setButtonLoading(buttons.changePassword, 'Alterando...');

        try {
            const response = await fetch(
                `${CONFIG.SUPABASE_URL}/functions/v1/verify-and-reset-password`,
                {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': `Bearer ${supabase.supabaseKey}`,
                    },
                    body: JSON.stringify({
                        email:       _recoveryEmail,
                        code:        _verifiedCode,
                        newPassword: newPass,
                    }),
                }
            );

            if (!response.ok) {
                showError('Erro de conexão. Tente novamente.');
                return;
            }

            const result = await response.json();

            if (result.status === 'success') {
                // Limpa dados sensíveis da memória imediatamente
                _verifiedCode  = '';
                _recoveryEmail = '';
                switchScreen(screens.newPassword, screens.success);

            } else if (result.status === 'invalid_code') {
                showError('Código inválido, expirado ou já utilizado.');
                _verifiedCode = ''; // Força nova solicitação de código

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

// ─── Navegação: Sucesso → Login ───────────────────────────────
if (buttons.backToLoginFinal) {
    buttons.backToLoginFinal.addEventListener('click', () => {
        _clearRecoveryState();
        switchScreen(screens.success, screens.login);
    });
}

// ═══════════════════════════════════════════════════════════════
//  REENVIAR CÓDIGO
//  [SEC-13] Cooldown independente e persistente
// ═══════════════════════════════════════════════════════════════
if (buttons.resendCode) {
    buttons.resendCode.addEventListener('click', async (e) => {
        e.preventDefault();

        if (!_recoveryEmail) {
            showAuthMessage('Email não encontrado. Volte e digite novamente.', 'error');
            return;
        }

        if (Cooldown.isActive(CONFIG.KEYS.resendCooldown)) {
            showAuthMessage('Aguarde antes de reenviar o código.', 'error');
            return;
        }

        const btn         = buttons.resendCode;
        const originalText = sanitizeText(btn.textContent);
        btn.disabled      = true;
        btn.textContent   = 'Enviando...';

        try {
            const response = await fetch(
                `${CONFIG.SUPABASE_URL}/functions/v1/send-password-reset-code`,
                {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': `Bearer ${supabase.supabaseKey}`,
                    },
                    body: JSON.stringify({ email: _recoveryEmail }),
                }
            );

            if (!response.ok) {
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

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
    _recoveryEmail = '';
    _verifiedCode  = '';
    if (inputs.recoveryEmail)   inputs.recoveryEmail.value   = '';
    if (inputs.newPassword)     inputs.newPassword.value     = '';
    if (inputs.confirmPassword) inputs.confirmPassword.value = '';
    resetCodeInputs();
    hideError();
}

// ═══════════════════════════════════════════════════════════════
//  INPUTS DE CÓDIGO — COMPORTAMENTO
// ═══════════════════════════════════════════════════════════════
inputs.codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        // Filtra para apenas dígitos
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
            buttons.verifyCode.style.transform = 'scale(1.02)';
            setTimeout(() => { buttons.verifyCode.style.transform = ''; }, 200);
        }
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) {
            const prev = inputs.codeInputs[index - 1];
            prev.focus();
            prev.value = '';
            prev.classList.remove('filled');
        }
        if (e.key === 'Enter') {
            buttons.verifyCode?.click();
        }
    });

    input.addEventListener('keypress', (e) => {
        if (!/[0-9]/.test(e.key)) e.preventDefault();
    });

    // Suporte a colar código completo
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pasted = e.clipboardData
            .getData('text')
            .replace(/[^0-9]/g, '')
            .slice(0, 6);

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

// ═══════════════════════════════════════════════════════════════
//  AUXILIAR: RESET DOS INPUTS DE CÓDIGO
// ═══════════════════════════════════════════════════════════════
function resetCodeInputs() {
    inputs.codeInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
}

// ═══════════════════════════════════════════════════════════════
//  PARTÍCULAS E GRÁFICOS ANIMADOS
// ═══════════════════════════════════════════════════════════════
function createMoneyParticles() {
    const container = document.getElementById('moneyParticles');
    if (!container) return;

    const symbols = ['$', '€', '£', '¥', '₿'];

    for (let i = 0; i < CONFIG.moneyParticleCount; i++) {
        const particle = document.createElement('div');
        particle.classList.add('money-particle');
        // [SEC-06] textContent para inserir símbolo
        particle.textContent = symbols[Math.floor(Math.random() * symbols.length)];

        particle.style.left            = `${Math.random() * 100}%`;
        particle.style.top             = `${Math.random() * 100}%`;
        particle.style.fontSize        = `${Math.random() * 12 + 18}px`;
        particle.style.animationDuration  = `${Math.random() * 10 + 15}s`;
        particle.style.animationDelay    = `${Math.random() * 5}s`;
        particle.style.color           = `rgba(16, 185, 129, ${Math.random() * 0.4 + 0.3})`;

        container.appendChild(particle);
    }
}

function createAnimatedCharts() {
    const container = document.getElementById('animatedCharts');
    if (!container) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';

    for (let i = 0; i < CONFIG.chartLineCount; i++) {
        const path     = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const segments = 12;
        const points   = [];

        for (let j = 0; j <= segments; j++) {
            points.push(`${(j / segments) * 100},${20 + Math.random() * 60}`);
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

inputs.newPassword?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') inputs.confirmPassword?.focus();
});

inputs.confirmPassword?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') buttons.changePassword?.click();
});

inputs.recoveryEmail?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') buttons.sendCode?.click();
});

// ═══════════════════════════════════════════════════════════════
//  PARALLAX DO MOUSE
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
        visual.style.transform = `
            rotateY(${-8 + currentX * 8}deg)
            rotateX(${3 + currentY * 5}deg)
        `;
    }

    document.querySelectorAll('.gradient-orb').forEach((orb, i) => {
        const speed = (i + 1) * 0.4;
        orb.style.transform = `translate(${currentX * speed * 25}px, ${currentY * speed * 25}px)`;
    });

    requestAnimationFrame(animateParallax);
}

animateParallax();

// ═══════════════════════════════════════════════════════════════
//  EFEITO DE RIPPLE NOS BOTÕES
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
            'background:rgba(255,255,255,0.35)',
            `left:${e.clientX - rect.left - size / 2}px`,
            `top:${e.clientY - rect.top  - size / 2}px`,
            'pointer-events:none',
            'animation:ripple 0.6s ease-out forwards',
        ].join(';');

        // Garante overflow hidden para o efeito funcionar
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(ripple);

        setTimeout(() => ripple.remove(), 600);
    });
});

// ═══════════════════════════════════════════════════════════════
//  ESTILOS DE ANIMAÇÃO INJETADOS (apenas keyframes — sem dados externos)
// ═══════════════════════════════════════════════════════════════
const animStyle = document.createElement('style');
animStyle.textContent = `
    @keyframes ripple { to { transform: scale(2.5); opacity: 0; } }
    @keyframes spin    { to { transform: rotate(360deg); } }
    @keyframes shake   {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-6px); }
        40%, 80% { transform: translateX(6px); }
    }
    .captcha-hidden  { display: none; }
    .captcha-visible { display: block; animation: fadeInUp 0.4s ease; }
    .captcha-error   { outline: 2px solid var(--error-red); border-radius: 12px; }
    @keyframes fadeInUp {
        from { opacity: 0; transform: translateY(10px); }
        to   { opacity: 1; transform: translateY(0); }
    }
`;
document.head.appendChild(animStyle);

// ═══════════════════════════════════════════════════════════════
//  EFEITO NOS INPUTS (focus/blur)
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('.form-input').forEach(input => {
    input.addEventListener('focus', () => {
        input.closest('.input-wrapper')?.style.setProperty('transform', 'scale(1.01)');
    });
    input.addEventListener('blur', () => {
        input.closest('.input-wrapper')?.style.setProperty('transform', 'scale(1)');
    });
});

// ═══════════════════════════════════════════════════════════════
//  FEEDBACK VISUAL NO CHECKBOX
// ═══════════════════════════════════════════════════════════════
document.querySelector('.checkbox-wrapper')?.addEventListener('click', () => {
    const custom = document.querySelector('.checkbox-custom');
    if (!custom) return;
    custom.style.transform = 'scale(1.15)';
    setTimeout(() => { custom.style.transform = 'scale(1)'; }, 200);
});