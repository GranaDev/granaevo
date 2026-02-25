import { supabase } from './supabase-client.js';

// ===== CONFIGURAÇÕES =====
const CONFIG = {
    moneyParticleCount: 15,
    chartLineCount: 8
};

// ===== CRIAR PARTÍCULAS DE MOEDAS =====
function createMoneyParticles() {
    const container = document.getElementById('moneyParticles');
    const symbols = ['$', '€', '£', '¥', '₿'];
    
    for (let i = 0; i < CONFIG.moneyParticleCount; i++) {
        const particle = document.createElement('div');
        particle.classList.add('money-particle');
        particle.textContent = symbols[Math.floor(Math.random() * symbols.length)];
        
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        const duration = Math.random() * 10 + 15;
        const delay = Math.random() * 5;
        const size = Math.random() * 12 + 18;
        
        particle.style.left = x + '%';
        particle.style.top = y + '%';
        particle.style.fontSize = size + 'px';
        particle.style.animationDuration = duration + 's';
        particle.style.animationDelay = delay + 's';
        particle.style.color = `rgba(16, 185, 129, ${Math.random() * 0.4 + 0.3})`;
        
        container.appendChild(particle);
    }
}

// ===== CRIAR GRÁFICOS ANIMADOS =====
function createAnimatedCharts() {
    const container = document.getElementById('animatedCharts');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%;';
    
    for (let i = 0; i < CONFIG.chartLineCount; i++) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('chart-line');
        
        const points = [];
        const segments = 12;
        for (let j = 0; j <= segments; j++) {
            const x = (j / segments) * 100;
            const y = 20 + Math.random() * 60;
            points.push(`${x},${y}`);
        }
        
        const pathData = `M ${points.join(' L ')}`;
        path.setAttribute('d', pathData);
        path.style.opacity = Math.random() * 0.2 + 0.1;
        path.style.animationDelay = `${Math.random() * 3}s`;
        path.style.animationDuration = `${Math.random() * 5 + 8}s`;
        
        svg.appendChild(path);
    }
    
    container.appendChild(svg);
}

// ===== SELEÇÃO DE ELEMENTOS =====
const screens = {
    login: document.getElementById('loginScreen'),
    forgotEmail: document.getElementById('forgotEmailScreen'),
    code: document.getElementById('codeScreen'),
    newPassword: document.getElementById('newPasswordScreen'),
    success: document.getElementById('successScreen')
};

const buttons = {
    forgotPassword: document.getElementById('forgotPasswordBtn'),
    backToLogin: document.getElementById('backToLogin'),
    sendCode: document.getElementById('sendCodeBtn'),
    backToEmail: document.getElementById('backToEmail'),
    verifyCode: document.getElementById('verifyCodeBtn'),
    backToCode: document.getElementById('backToCode'),
    changePassword: document.getElementById('changePasswordBtn'),
    backToLoginFinal: document.getElementById('backToLoginFinal'),
    resendCode: document.getElementById('resendCode')
};

const inputs = {
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    recoveryEmail: document.getElementById('recoveryEmail'),
    codeInputs: document.querySelectorAll('.code-input'),
    newPassword: document.getElementById('newPassword'),
    confirmPassword: document.getElementById('confirmPassword')
};

const loginForm = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');
const togglePassword = document.getElementById('togglePassword');

// ===== VARIÁVEIS GLOBAIS PARA RECUPERAÇÃO =====
let recoveryEmailGlobal = '';
let verifiedCodeGlobal = '';

// ===== VARIÁVEIS DO RECAPTCHA =====
// FIX #2: loginAttempts persiste na sessão para evitar bypass por refresh de página
const LOGIN_ATTEMPTS_KEY = '_ge_la';
const MAX_ATTEMPTS_BEFORE_CAPTCHA = 3;
let captchaToken = null;
let captchaResolved = false;

function getLoginAttempts() {
    return parseInt(sessionStorage.getItem(LOGIN_ATTEMPTS_KEY) || '0', 10);
}

function setLoginAttempts(n) {
    sessionStorage.setItem(LOGIN_ATTEMPTS_KEY, String(n));
}

function resetLoginAttempts() {
    sessionStorage.removeItem(LOGIN_ATTEMPTS_KEY);
}

// Callback global chamado pelo reCAPTCHA quando resolvido
window.onCaptchaResolved = function(token) {
    captchaToken = token;
    captchaResolved = true;
    console.log('✅ reCAPTCHA resolvido');
};

// Callback chamado quando o reCAPTCHA expira
window.onCaptchaExpired = function() {
    captchaToken = null;
    captchaResolved = false;
    console.log('⚠️ reCAPTCHA expirou');
};

// ===== EXIBIR / ESCONDER CAPTCHA =====
function showCaptcha() {
    const captchaContainer = document.getElementById('captchaContainer');
    if (captchaContainer) {
        captchaContainer.style.display = 'block';
        captchaContainer.style.animation = 'fadeInUp 0.4s ease';
    }
}

function hideCaptcha() {
    const captchaContainer = document.getElementById('captchaContainer');
    if (captchaContainer) {
        captchaContainer.style.display = 'none';
    }
}

function resetCaptcha() {
    captchaToken = null;
    captchaResolved = false;
    if (typeof grecaptcha !== 'undefined') {
        try {
            grecaptcha.reset();
        } catch (e) {
            // Ignora se o widget ainda não foi renderizado
        }
    }
}

// ===== VALIDAR CAPTCHA NA EDGE FUNCTION DO SUPABASE =====
async function validateCaptcha(token) {
    // FIX #3: Token vazio ou claramente inválido é rejeitado imediatamente
    if (!token || typeof token !== 'string' || token.trim().length < 20) {
        console.warn('⚠️ Token reCAPTCHA inválido ou muito curto — rejeitado localmente');
        return false;
    }

    try {
        const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
        const response = await fetch(`${SUPABASE_URL}/functions/v1/verify-recaptcha`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
            body: JSON.stringify({ token }),
        });

        if (!response.ok) {
            console.error('❌ Erro HTTP ao validar reCAPTCHA:', response.status);
            return false;
        }

        const result = await response.json();
        return result.success === true;
    } catch (error) {
        console.error('❌ Erro ao validar reCAPTCHA:', error);
        return false;
    }
}

// ===== VALIDAÇÃO DE EMAIL (FIX #4: regex adequado) =====
function isValidEmail(email) {
    // Regex RFC 5322 simplificado — cobre 99.9% dos casos reais
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    return emailRegex.test(email);
}

// ===== INICIALIZAÇÃO =====
window.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        console.log('✅ Usuário já autenticado, redirecionando...');
        window.location.href = 'dashboard.html';
        return;
    }

    // Se já havia tentativas na sessão e ultrapassam o limite, exibe reCAPTCHA de imediato
    if (getLoginAttempts() >= MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        showCaptcha();
    }
    
    createMoneyParticles();
    createAnimatedCharts();
    
    const authError = sessionStorage.getItem('auth_error');
    if (authError) {
        showAuthMessage(authError, 'error');
        sessionStorage.removeItem('auth_error');
    }
    
    console.log('🚀 GranaEvo Login carregado!');
});

// ===== FUNÇÃO: BUSCAR SUBSCRIPTION ATIVA (dono OU convidado) =====
async function getActiveSubscription(userId) {
    // 1️⃣ Verifica se o próprio usuário tem assinatura ativa
    const { data: ownSub } = await supabase
        .from('subscriptions')
        .select('*, plans(*)')
        .eq('user_id', userId)
        .eq('payment_status', 'approved')
        .eq('is_active', true)
        .maybeSingle();

    if (ownSub) return { subscription: ownSub, isGuest: false };

    // 2️⃣ Verifica se é um convidado vinculado a uma conta com assinatura ativa
    const { data: membership } = await supabase
        .from('account_members')
        .select('owner_user_id')
        .eq('member_user_id', userId)
        .eq('is_active', true)
        .maybeSingle();

    if (!membership) return { subscription: null, isGuest: false };

    const { data: ownerSub } = await supabase
        .from('subscriptions')
        .select('*, plans(*)')
        .eq('user_id', membership.owner_user_id)
        .eq('payment_status', 'approved')
        .eq('is_active', true)
        .maybeSingle();

    if (ownerSub) return { subscription: ownerSub, isGuest: true };

    return { subscription: null, isGuest: false };
}

// ===== SISTEMA DE LOGIN COM RECAPTCHA =====
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = inputs.loginEmail.value.trim();
    const password = inputs.loginPassword.value;
    
    if (!email || !password) {
        showAuthMessage('Por favor, preencha todos os campos', 'error');
        return;
    }
    
    // FIX #4: Validação de email com regex adequado
    if (!isValidEmail(email)) {
        showAuthMessage('Email inválido', 'error');
        shakeInput(inputs.loginEmail);
        return;
    }

    const currentAttempts = getLoginAttempts();

    // ===== VERIFICAÇÃO DO CAPTCHA (após 3 tentativas) =====
    if (currentAttempts >= MAX_ATTEMPTS_BEFORE_CAPTCHA) {
        if (!captchaResolved || !captchaToken) {
            showAuthMessage('Por favor, resolva o reCAPTCHA para continuar', 'error');
            const captchaContainer = document.getElementById('captchaContainer');
            if (captchaContainer) {
                captchaContainer.style.border = '2px solid var(--error-red)';
                captchaContainer.style.borderRadius = '12px';
                captchaContainer.style.padding = '8px';
                setTimeout(() => {
                    captchaContainer.style.border = '';
                    captchaContainer.style.padding = '';
                }, 2000);
            }
            return;
        }

        // Valida o token no backend (Supabase Edge Function)
        showAuthMessage('Verificando reCAPTCHA...', 'info');
        const captchaValid = await validateCaptcha(captchaToken);
        if (!captchaValid) {
            showAuthMessage('Falha na verificação do reCAPTCHA. Tente novamente.', 'error');
            resetCaptcha();
            return;
        }
    }

    try {
        showAuthMessage('Verificando credenciais...', 'info');
        
        // Autenticar no Supabase
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            // FIX #2: Incrementa contador persistente
            const newAttempts = currentAttempts + 1;
            setLoginAttempts(newAttempts);
            inputs.loginPassword.value = '';
            
            // Reseta o captcha para nova resolução na próxima tentativa
            resetCaptcha();

            if (newAttempts >= MAX_ATTEMPTS_BEFORE_CAPTCHA) {
                showCaptcha();
                showAuthMessage(
                    `Email ou senha incorretos. Resolva o reCAPTCHA para continuar (tentativa ${newAttempts}).`,
                    'error'
                );
            } else {
                const restantes = MAX_ATTEMPTS_BEFORE_CAPTCHA - newAttempts;
                showAuthMessage(
                    `Email ou senha incorretos. ${restantes} tentativa${restantes > 1 ? 's' : ''} restante${restantes > 1 ? 's' : ''} antes do reCAPTCHA.`,
                    'error'
                );
            }

            shakeInput(inputs.loginEmail);
            shakeInput(inputs.loginPassword);
            return;
        }

        // ✅ Login bem-sucedido — reseta contagem persistente
        resetLoginAttempts();
        resetCaptcha();
        hideCaptcha();

        // Verifica subscription do próprio usuário OU do dono (se for convidado)
        const { subscription, isGuest } = await getActiveSubscription(data.user.id);

        if (!subscription) {
            // FIX #1 e #bogfix: Deslogar o usuário imediatamente — sem plano, sem sessão ativa
            await supabase.auth.signOut();
            showAuthMessage('Você precisa adquirir um plano para acessar o sistema.', 'error');
            setTimeout(() => {
                window.location.href = 'planos.html';
            }, 2500);
            return;
        }

        // FIX #6: is_guest_member é apenas um hint de UI — a autorização real é feita
        // pelo AuthGuard no dashboard via consulta ao banco. Mantemos o flag mas
        // o dashboard NÃO deve confiar nele para decisões de segurança.
        if (isGuest) {
            sessionStorage.setItem('is_guest_member', 'true');
        } else {
            sessionStorage.removeItem('is_guest_member');
        }

        const userName = data.user.user_metadata?.name || 'Usuário';
        showAuthMessage(`Bem-vindo de volta, ${userName}!`, 'success');
        
        setTimeout(() => {
            window.location.href = 'dashboard.html';
        }, 1500);
        
    } catch (error) {
        showAuthMessage('Erro ao fazer login. Tente novamente.', 'error');
        console.error(error);
    }
});

// ===== TOGGLE PASSWORD =====
if (togglePassword) {
    togglePassword.addEventListener('click', () => {
        const type = inputs.loginPassword.getAttribute('type') === 'password' ? 'text' : 'password';
        inputs.loginPassword.setAttribute('type', type);
        
        togglePassword.style.transform = 'scale(1.15)';
        setTimeout(() => {
            togglePassword.style.transform = 'scale(1)';
        }, 200);
    });
}

// ===== FUNÇÕES DE MENSAGEM =====
function showAuthMessage(message, type) {
    const messageDiv = document.getElementById('authErrorMessage');
    messageDiv.textContent = message;
    messageDiv.className = `auth-message ${type} show`;
    messageDiv.style.display = 'flex';
    
    setTimeout(() => {
        messageDiv.classList.remove('show');
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 300);
    }, 5000);
}

function shakeInput(input) {
    input.style.animation = 'shake 0.5s';
    input.style.borderColor = 'var(--error-red)';
    
    setTimeout(() => {
        input.style.animation = '';
        input.style.borderColor = '';
    }, 500);
}

// ===== NAVEGAÇÃO ENTRE TELAS =====
function switchScreen(currentScreen, nextScreen) {
    Object.values(screens).forEach(screen => {
        if (screen !== currentScreen) {
            screen.classList.remove('active', 'exit-left');
        }
    });
    
    if (currentScreen) {
        currentScreen.classList.add('exit-left');
        
        setTimeout(() => {
            currentScreen.classList.remove('active', 'exit-left');
            nextScreen.classList.add('active');
        }, 500);
    } else {
        nextScreen.classList.add('active');
    }
}

// ===== NAVEGAÇÃO - BOTÕES =====
if (buttons.forgotPassword) {
    buttons.forgotPassword.addEventListener('click', (e) => {
        e.preventDefault();
        switchScreen(screens.login, screens.forgotEmail);
    });
}

if (buttons.backToLogin) {
    buttons.backToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        inputs.recoveryEmail.value = '';
        switchScreen(screens.forgotEmail, screens.login);
    });
}

// ===== ENVIAR CÓDIGO DE RECUPERAÇÃO =====
// FIX #5: Throttle persiste em sessionStorage para sobreviver a refresh de página
const SEND_CODE_COOLDOWN_KEY  = '_ge_scc';
const RESEND_CODE_COOLDOWN_KEY = '_ge_rcc';
const SEND_CODE_COOLDOWN_MS   = 30000; // 30 segundos entre envios

function isSendCooldownActive(key) {
    const until = parseInt(sessionStorage.getItem(key) || '0', 10);
    return Date.now() < until;
}

function setSendCooldown(key, ms) {
    sessionStorage.setItem(key, String(Date.now() + ms));
}

if (buttons.sendCode) {
    buttons.sendCode.addEventListener('click', async () => {
        const email = inputs.recoveryEmail.value.trim();
        
        // FIX #4: Usa regex de validação de email
        if (!email || !isValidEmail(email)) {
            inputs.recoveryEmail.style.borderColor = 'var(--error-red)';
            showAuthMessage('Digite um email válido', 'error');
            setTimeout(() => {
                inputs.recoveryEmail.style.borderColor = '';
            }, 2000);
            return;
        }

        // FIX #5: Bloqueia envio repetido em menos de 30s (persiste em refresh)
        if (isSendCooldownActive(SEND_CODE_COOLDOWN_KEY)) {
            showAuthMessage('Aguarde alguns segundos antes de solicitar um novo código.', 'error');
            return;
        }

        buttons.sendCode.disabled = true;
        buttons.sendCode.innerHTML = `
            <svg class="spinner" viewBox="0 0 24 24" style="width: 20px; height: 20px; animation: spin 1s linear infinite;">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" opacity="0.25"/>
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="4" fill="none"/>
            </svg>
            Enviando...
        `;

        try {
            const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
            
            const response = await fetch(`${SUPABASE_URL}/functions/v1/send-password-reset-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabase.supabaseKey}`,
                },
                body: JSON.stringify({ email }),
            });

            if (!response.ok) {
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            const result = await response.json();

            if (result.status === 'sent') {
                recoveryEmailGlobal = email;

                // Ativa cooldown persistente para evitar flood
                setSendCooldown(SEND_CODE_COOLDOWN_KEY, SEND_CODE_COOLDOWN_MS);

                showAuthMessage('Código enviado! Verifique seu email.', 'success');
                switchScreen(screens.forgotEmail, screens.code);
                
                setTimeout(() => {
                    inputs.codeInputs[0].focus();
                }, 500);
            } else if (result.status === 'not_found') {
                showAuthMessage('Email não encontrado ou sem plano ativo', 'error');
            } else if (result.status === 'payment_not_approved') {
                showAuthMessage('Seu plano não está aprovado. Verifique o pagamento.', 'error');
            } else {
                showAuthMessage(result.message || 'Erro ao enviar código', 'error');
            }

        } catch (error) {
            console.error('❌ Erro:', error);
            showAuthMessage('Erro de conexão. Tente novamente.', 'error');
        } finally {
            buttons.sendCode.disabled = false;
            buttons.sendCode.innerHTML = `
                <span class="btn-text">Enviar código</span>
                <div class="btn-glow"></div>
            `;
        }
    });
}

if (buttons.backToEmail) {
    buttons.backToEmail.addEventListener('click', (e) => {
        e.preventDefault();
        resetCodeInputs();
        switchScreen(screens.code, screens.forgotEmail);
    });
}

// ===== VERIFICAR CÓDIGO =====
if (buttons.verifyCode) {
    buttons.verifyCode.addEventListener('click', () => {
        const code = Array.from(inputs.codeInputs).map(input => input.value).join('');
        
        if (code.length !== 6 || !/^\d{6}$/.test(code)) {
            showAuthMessage('Digite o código completo de 6 dígitos', 'error');
            return;
        }

        verifiedCodeGlobal = code;
        switchScreen(screens.code, screens.newPassword);
        
        setTimeout(() => {
            inputs.newPassword.focus();
        }, 500);
    });
}

if (buttons.backToCode) {
    buttons.backToCode.addEventListener('click', (e) => {
        e.preventDefault();
        hideError();
        inputs.newPassword.value = '';
        inputs.confirmPassword.value = '';
        switchScreen(screens.newPassword, screens.code);
    });
}

// ===== ALTERAR SENHA =====
if (buttons.changePassword) {
    buttons.changePassword.addEventListener('click', async () => {
        const newPass = inputs.newPassword.value;
        const confirmPass = inputs.confirmPassword.value;
        
        hideError();
        
        if (!newPass || !confirmPass) {
            showError('Por favor, preencha todos os campos');
            return;
        }
        
        if (newPass.length < 8) {
            showError('A senha deve ter no mínimo 8 caracteres');
            return;
        }

        // Verificação básica de complexidade de senha
        if (!/[A-Za-z]/.test(newPass) || !/[0-9]/.test(newPass)) {
            showError('A senha deve conter letras e números');
            return;
        }
        
        if (newPass !== confirmPass) {
            showError('As senhas não coincidem');
            inputs.newPassword.style.borderColor = 'var(--error-red)';
            inputs.confirmPassword.style.borderColor = 'var(--error-red)';
            setTimeout(() => {
                inputs.newPassword.style.borderColor = '';
                inputs.confirmPassword.style.borderColor = '';
            }, 2000);
            return;
        }

        // Garante que temos email e código antes de continuar
        if (!recoveryEmailGlobal || !verifiedCodeGlobal) {
            showError('Sessão de recuperação expirada. Por favor, recomece o processo.');
            setTimeout(() => {
                resetCodeInputs();
                inputs.newPassword.value = '';
                inputs.confirmPassword.value = '';
                hideError();
                recoveryEmailGlobal = '';
                verifiedCodeGlobal = '';
                switchScreen(screens.newPassword, screens.login);
            }, 2000);
            return;
        }

        buttons.changePassword.disabled = true;
        buttons.changePassword.innerHTML = `
            <svg class="spinner" viewBox="0 0 24 24" style="width: 20px; height: 20px; animation: spin 1s linear infinite;">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" opacity="0.25"/>
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="4" fill="none"/>
            </svg>
            Alterando...
        `;

        try {
            const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
            
            const response = await fetch(`${SUPABASE_URL}/functions/v1/verify-and-reset-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabase.supabaseKey}`,
                },
                body: JSON.stringify({ 
                    email: recoveryEmailGlobal,
                    code: verifiedCodeGlobal,
                    newPassword: newPass
                }),
            });

            if (!response.ok) {
                showError('Erro de conexão. Tente novamente.');
                return;
            }

            const result = await response.json();

            if (result.status === 'success') {
                // Limpa dados sensíveis da memória imediatamente após sucesso
                verifiedCodeGlobal = '';
                switchScreen(screens.newPassword, screens.success);
            } else if (result.status === 'invalid_code') {
                showError('Código inválido, expirado ou já utilizado');
                // Limpa o código para forçar nova solicitação
                verifiedCodeGlobal = '';
            } else {
                showError(result.message || 'Erro ao alterar senha');
            }

        } catch (error) {
            console.error('❌ Erro:', error);
            showError('Erro de conexão. Tente novamente.');
        } finally {
            buttons.changePassword.disabled = false;
            buttons.changePassword.innerHTML = `
                <span class="btn-text">Alterar senha</span>
                <div class="btn-glow"></div>
            `;
        }
    });
}

if (buttons.backToLoginFinal) {
    buttons.backToLoginFinal.addEventListener('click', () => {
        inputs.recoveryEmail.value = '';
        resetCodeInputs();
        inputs.newPassword.value = '';
        inputs.confirmPassword.value = '';
        hideError();
        recoveryEmailGlobal = '';
        verifiedCodeGlobal = '';
        switchScreen(screens.success, screens.login);
    });
}

// ===== REENVIAR CÓDIGO =====
// FIX #5: Throttle independente para o botão de reenvio (também persistente)
const RESEND_CODE_COOLDOWN_MS = 30000; // 30 segundos

if (buttons.resendCode) {
    buttons.resendCode.addEventListener('click', async (e) => {
        e.preventDefault();
        
        if (!recoveryEmailGlobal) {
            showAuthMessage('Email não encontrado. Volte e digite novamente.', 'error');
            return;
        }

        // FIX #5: Bloqueia reenvio rápido (persiste em refresh)
        if (isSendCooldownActive(RESEND_CODE_COOLDOWN_KEY)) {
            showAuthMessage('Aguarde alguns segundos antes de reenviar o código.', 'error');
            return;
        }

        buttons.resendCode.disabled = true;
        const originalText = buttons.resendCode.textContent;
        buttons.resendCode.textContent = 'Enviando...';

        try {
            const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
            
            const response = await fetch(`${SUPABASE_URL}/functions/v1/send-password-reset-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabase.supabaseKey}`,
                },
                body: JSON.stringify({ email: recoveryEmailGlobal }),
            });

            if (!response.ok) {
                showAuthMessage('Erro de conexão. Tente novamente.', 'error');
                return;
            }

            const result = await response.json();

            if (result.status === 'sent') {
                // Ativa cooldown persistente
                setSendCooldown(RESEND_CODE_COOLDOWN_KEY, RESEND_CODE_COOLDOWN_MS);

                showAuthMessage('Novo código enviado!', 'success');
                buttons.resendCode.style.color = 'var(--neon-green)';
                buttons.resendCode.textContent = 'Código enviado!';
                
                setTimeout(() => {
                    buttons.resendCode.style.color = '';
                    buttons.resendCode.textContent = originalText;
                }, 3000);
                
                resetCodeInputs();
                inputs.codeInputs[0].focus();
            } else {
                showAuthMessage('Erro ao reenviar código', 'error');
            }

        } catch (error) {
            console.error('❌ Erro:', error);
            showAuthMessage('Erro de conexão', 'error');
        } finally {
            buttons.resendCode.disabled = false;
        }
    });
}

// ===== LÓGICA DOS INPUTS DE CÓDIGO =====
inputs.codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        // Aceita apenas dígitos numéricos
        const value = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = value;

        if (value.length === 1) {
            input.classList.add('filled');
            if (index < inputs.codeInputs.length - 1) {
                inputs.codeInputs[index + 1].focus();
            }
        } else {
            input.classList.remove('filled');
        }
        
        const allFilled = Array.from(inputs.codeInputs).every(inp => inp.value.length === 1);
        if (allFilled) {
            buttons.verifyCode.style.transform = 'scale(1.02)';
            setTimeout(() => {
                buttons.verifyCode.style.transform = '';
            }, 200);
        }
    });
    
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && index > 0) {
            inputs.codeInputs[index - 1].focus();
            inputs.codeInputs[index - 1].value = '';
            inputs.codeInputs[index - 1].classList.remove('filled');
        }
        if (e.key === 'Enter') {
            buttons.verifyCode.click();
        }
    });
    
    input.addEventListener('keypress', (e) => {
        if (!/[0-9]/.test(e.key)) {
            e.preventDefault();
        }
    });
    
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const pastedData = e.clipboardData.getData('text').replace(/[^0-9]/g, '').slice(0, 6);
        
        pastedData.split('').forEach((char, i) => {
            if (inputs.codeInputs[i]) {
                inputs.codeInputs[i].value = char;
                inputs.codeInputs[i].classList.add('filled');
            }
        });
        
        const lastFilledIndex = Math.min(pastedData.length - 1, 5);
        if (lastFilledIndex >= 0) {
            inputs.codeInputs[lastFilledIndex].focus();
        }
    });
});

// ===== FUNÇÕES AUXILIARES =====
function resetCodeInputs() {
    inputs.codeInputs.forEach(input => {
        input.value = '';
        input.classList.remove('filled', 'error');
    });
}

function showError(message) {
    if (errorMessage) {
        errorMessage.textContent = message;
        errorMessage.classList.add('show');
    }
}

function hideError() {
    if (errorMessage) {
        errorMessage.classList.remove('show');
        setTimeout(() => {
            errorMessage.textContent = '';
        }, 300);
    }
}

// ===== EFEITO PARALLAX NO MOUSE =====
let mouseX = 0;
let mouseY = 0;
let currentX = 0;
let currentY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
});

function animateParallax() {
    currentX += (mouseX - currentX) * 0.08;
    currentY += (mouseY - currentY) * 0.08;
    
    const financialVisual = document.querySelector('.financial-visual');
    if (financialVisual) {
        financialVisual.style.transform = `
            rotateY(${-8 + currentX * 8}deg) 
            rotateX(${3 + currentY * 5}deg)
        `;
    }
    
    const orbs = document.querySelectorAll('.gradient-orb');
    orbs.forEach((orb, index) => {
        const speed = (index + 1) * 0.4;
        orb.style.transform = `translate(${currentX * speed * 25}px, ${currentY * speed * 25}px)`;
    });
    
    requestAnimationFrame(animateParallax);
}

animateParallax();

// ===== EFEITO DE RIPPLE NOS BOTÕES =====
const buttons_ripple = document.querySelectorAll('.btn-submit, .btn-social');

buttons_ripple.forEach(button => {
    button.addEventListener('click', function(e) {
        const ripple = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;
        
        ripple.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.4);
            left: ${x}px;
            top: ${y}px;
            pointer-events: none;
            animation: ripple 0.6s ease-out;
        `;
        
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(ripple);
        
        setTimeout(() => ripple.remove(), 600);
    });
});

const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
    @keyframes ripple {
        to { transform: scale(2.5); opacity: 0; }
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
`;
document.head.appendChild(rippleStyle);

// ===== ATALHOS DE TECLADO =====
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement === inputs.loginEmail) {
        e.preventDefault();
        inputs.loginPassword.focus();
    }
});

if (inputs.newPassword) {
    inputs.newPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') inputs.confirmPassword.focus();
    });
}

if (inputs.confirmPassword) {
    inputs.confirmPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') buttons.changePassword.click();
    });
}

if (inputs.recoveryEmail) {
    inputs.recoveryEmail.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') buttons.sendCode.click();
    });
}

// ===== EFEITO NOS INPUTS =====
const allInputs = document.querySelectorAll('.form-input');

allInputs.forEach(input => {
    input.addEventListener('focus', () => {
        const wrapper = input.closest('.input-wrapper');
        if (wrapper) wrapper.style.transform = 'scale(1.01)';
    });
    
    input.addEventListener('blur', () => {
        const wrapper = input.closest('.input-wrapper');
        if (wrapper) wrapper.style.transform = 'scale(1)';
    });
});

// ===== FEEDBACK VISUAL NO CHECKBOX =====
const checkbox = document.querySelector('.checkbox-wrapper');
if (checkbox) {
    checkbox.addEventListener('click', () => {
        const customCheckbox = checkbox.querySelector('.checkbox-custom');
        customCheckbox.style.transform = 'scale(1.15)';
        setTimeout(() => {
            customCheckbox.style.transform = 'scale(1)';
        }, 200);
    });
}

console.log('✅ GranaEvo Login carregado!');