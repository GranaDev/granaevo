/**
 * GranaEvo — primeiroacesso.js (v2 BLINDADO)
 *
 * SEGURANÇA — MUDANÇA PRINCIPAL:
 * Antes: _linkViaBackend enviava (email, subscription_id) com a anon key —
 *        qualquer pessoa com a chave pública podia chamar a Edge Function.
 *
 * Agora: após signUp, o usuário recebe um JWT de sessão. Esse JWT é enviado
 *        no header Authorization da chamada à Edge Function. O servidor
 *        extrai a identidade do JWT assinado — não confia no body.
 *        JWT não pode ser forjado. Só o dono da conta pode vincular.
 *
 * CORREÇÕES APLICADAS:
 * [SEC-01] JWT do usuário usado na chamada à Edge Function (não anon key)
 * [SEC-02] _updateSubscription removido — sempre falhava com 403 (RLS) e
 *          era código morto que poluía o console
 * [SEC-03] _confirmEmail removido — a Edge Function já confirma o email
 *          internamente de forma mais segura
 * [SEC-04] showAlert com innerHTML substituído por DOM programático para
 *          mensagens com links — sem risco de XSS
 * [SEC-05] Campos de senha limpos em TODOS os caminhos de erro
 * [FIX-01] submitBtn restaurado em todos os caminhos (estava faltando em
 *          alguns branches do catch original)
 * [FIX-02] Email normalizado para lowercase antes de qualquer operação
 * [FIX-03] Tratamento explícito do erro "email not confirmed" no login automático
 */

import { supabase } from './supabase-client.js';

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

// ==========================================
// ELEMENTOS DO DOM
// ==========================================
const accessForm           = document.getElementById('accessForm');
const emailCheckState      = document.getElementById('emailCheckState');
const passwordInputs       = document.getElementById('passwordInputs');
const checkEmailBtn        = document.getElementById('checkEmailBtn');
const submitBtn            = document.getElementById('submitBtn');

const emailInput           = document.getElementById('email');
const passwordInput        = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');
const termsCheckbox        = document.getElementById('termsCheckbox');

const alertBox             = document.getElementById('alertBox');
const alertMessage         = document.getElementById('alertMessage');
const infoBox              = document.getElementById('infoBox');
const userName             = document.getElementById('userName');
const userEmail            = document.getElementById('userEmail');
const planName             = document.getElementById('planName');

const confirmError         = document.getElementById('confirmError');
const termsError           = document.getElementById('termsError');
const strengthFill         = document.getElementById('strengthFill');
const strengthText         = document.getElementById('strengthText');

const togglePassword1      = document.getElementById('togglePassword1');
const togglePassword2      = document.getElementById('togglePassword2');

// ==========================================
// ESTADO
// ==========================================
let currentSubscriptionData = null;

// ==========================================
// VERIFICAR EMAIL
// ==========================================
checkEmailBtn.addEventListener('click', async () => {
    // [FIX-02] Normaliza lowercase antes de qualquer operação
    const email = (emailInput.value || '').trim().toLowerCase();

    if (!email) {
        showAlert('error', 'Por favor, digite seu email.');
        return;
    }

    if (!isValidEmail(email)) {
        showAlert('error', 'Email inválido. Digite um email válido.');
        return;
    }

    setButtonLoading(checkEmailBtn, 'Verificando...');

    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/check-email-status`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
            body: JSON.stringify({ email }),
        });

        if (!response.ok) {
            showAlert('error', 'Erro de conexão. Tente novamente.');
            return;
        }

        const result = await response.json();

        switch (result.status) {
            case 'not_found':
                showAlert('error', 'Email não reconhecido. Verifique se o pagamento foi aprovado ou se digitou corretamente.');
                hidePasswordInputs();
                break;

            case 'payment_pending':
                showAlert('warning', 'Pagamento ainda não aprovado. Aguarde a confirmação e tente novamente.');
                hidePasswordInputs();
                break;

            case 'password_exists':
                // [SEC-04] Links hardcoded via DOM — sem innerHTML com dados externos
                showAlertWithLinks(
                    'warning',
                    'Este email já possui uma senha cadastrada.',
                    [
                        { text: 'Fazer login', href: 'login.html' },
                        { text: 'Esqueci minha senha', href: 'login.html' },
                    ]
                );
                hidePasswordInputs();
                break;

            case 'ready':
                currentSubscriptionData = result.data;
                showPasswordForm(result.data);
                break;

            case 'error':
            default:
                showAlert('error', 'Erro ao verificar email. Tente novamente.');
                hidePasswordInputs();
        }

    } catch {
        showAlert('error', 'Erro de conexão. Verifique sua internet e tente novamente.');
        hidePasswordInputs();
    } finally {
        restoreButton(checkEmailBtn, 'Verificar Email');
    }
});

// ==========================================
// MOSTRAR FORMULÁRIO DE SENHA
// ==========================================
function showPasswordForm(data) {
    alertBox.style.display = 'none';
    infoBox.style.display  = 'block';

    // textContent — nunca innerHTML com dados do servidor
    userName.textContent  = sanitize(data.user_name  || 'Usuário');
    userEmail.textContent = sanitize(data.email);
    planName.textContent  = sanitize(data.plan_name);

    emailCheckState.style.display = 'none';
    passwordInputs.style.display  = 'block';

    setTimeout(() => passwordInput.focus(), 300);
}

function hidePasswordInputs() {
    passwordInputs.style.display  = 'none';
    infoBox.style.display         = 'none';
    emailCheckState.style.display = 'block';
}

// ==========================================
// UTILITÁRIOS
// ==========================================
function sanitize(value) {
    return String(value ?? '').trim();
}

function isValidEmail(email) {
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ==========================================
// SHOW ALERT
// [SEC-04] Nunca usa innerHTML com dados externos
// ==========================================
function showAlert(type, message) {
    alertBox.className       = 'alert-box ' + type;
    alertBox.style.display   = 'flex';
    alertMessage.textContent = message; // textContent — seguro

    if (type !== 'error') {
        setTimeout(() => { alertBox.style.display = 'none'; }, 8000);
    }
}

// Alerta com links hardcoded — construído via DOM, sem innerHTML com dados externos
function showAlertWithLinks(type, message, links = []) {
    alertBox.className     = 'alert-box ' + type;
    alertBox.style.display = 'flex';
    alertMessage.textContent = '';

    alertMessage.appendChild(document.createTextNode(message + ' '));

    links.forEach((link, i) => {
        if (i > 0) alertMessage.appendChild(document.createTextNode(' · '));
        const a   = document.createElement('a');
        a.href        = link.href;   // href é constante no código — não vem do servidor
        a.textContent = link.text;
        alertMessage.appendChild(a);
    });

    if (type !== 'error') {
        setTimeout(() => { alertBox.style.display = 'none'; }, 8000);
    }
}

// ==========================================
// LOADING STATE DOS BOTÕES
// ==========================================
function setButtonLoading(btn, label) {
    btn.disabled      = true;
    btn.dataset.orig  = btn.innerHTML;
    btn.textContent   = label;
}

function restoreButton(btn, fallbackLabel) {
    btn.disabled = false;
    if (btn.dataset.orig) {
        btn.innerHTML = btn.dataset.orig; // HTML é do desenvolvedor, não do usuário
        delete btn.dataset.orig;
    } else {
        btn.textContent = fallbackLabel;
    }
}

// ==========================================
// TOGGLE PASSWORD VISIBILITY
// ==========================================
togglePassword1?.addEventListener('click', () => {
    passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
});

togglePassword2?.addEventListener('click', () => {
    confirmPasswordInput.type = confirmPasswordInput.type === 'password' ? 'text' : 'password';
});

// ==========================================
// PASSWORD STRENGTH
// ==========================================
function checkPasswordStrength(password) {
    let strength = 0;
    if (password.length >= 8)  strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password))   strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;
    return strength;
}

passwordInput?.addEventListener('input', () => {
    const password = passwordInput.value;
    const strength = checkPasswordStrength(password);

    strengthFill.className = 'strength-fill';

    if (strength === 0) {
        strengthFill.style.width = '0%';
        strengthText.textContent = 'Mínimo 8 caracteres';
    } else if (strength <= 2) {
        strengthFill.classList.add('strength-weak');
        strengthText.textContent = 'Senha fraca';
    } else if (strength <= 4) {
        strengthFill.classList.add('strength-medium');
        strengthText.textContent = 'Senha média';
    } else {
        strengthFill.classList.add('strength-strong');
        strengthText.textContent = 'Senha forte';
    }
});

// ==========================================
// VALIDAR CONFIRMAÇÃO DE SENHA
// ==========================================
confirmPasswordInput?.addEventListener('input', () => {
    if (confirmPasswordInput.value && confirmPasswordInput.value !== passwordInput.value) {
        confirmError.style.display             = 'block';
        confirmPasswordInput.style.borderColor = 'var(--error)';
    } else {
        confirmError.style.display             = 'none';
        confirmPasswordInput.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    }
});

// ==========================================
// CHECKBOX DE TERMOS
// ==========================================
const checkboxWrapper = document.querySelector('.checkbox-wrapper');

termsCheckbox?.addEventListener('change', () => {
    const termsWarning = document.getElementById('termsWarning');
    if (termsCheckbox.checked) {
        if (termsError) termsError.style.display = 'none';
        checkboxWrapper?.classList.remove('error');
        if (checkboxWrapper) {
            checkboxWrapper.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            checkboxWrapper.style.background  = 'rgba(16, 185, 129, 0.05)';
        }
        if (termsWarning) {
            termsWarning.classList.remove('show');
            termsWarning.style.display = 'none';
        }
    } else {
        if (checkboxWrapper) {
            checkboxWrapper.style.borderColor = 'rgba(255, 255, 255, 0.05)';
            checkboxWrapper.style.background  = 'rgba(255, 255, 255, 0.02)';
        }
    }
});

function showTermsError() {
    const termsWarning = document.getElementById('termsWarning');
    if (termsWarning) {
        termsWarning.classList.add('show');
        termsWarning.style.display = 'flex';
    }
    if (termsError) termsError.style.display = 'block';
    checkboxWrapper?.classList.add('error');
    if (checkboxWrapper) {
        checkboxWrapper.style.borderColor = 'var(--error)';
        checkboxWrapper.style.background  = 'rgba(239, 68, 68, 0.05)';
        checkboxWrapper.style.animation   = 'shake 0.5s';
    }
    checkboxWrapper?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => termsCheckbox?.focus(), 500);
}

// ==========================================
// SUBMIT — CRIAR SENHA
// ==========================================
accessForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentSubscriptionData) {
        showAlert('error', 'Dados da assinatura não encontrados. Recarregue a página.');
        return;
    }

    if (!termsCheckbox.checked) {
        showTermsError();
        showAlert('error', 'Você deve aceitar os Termos de Uso para criar sua conta.');
        return;
    }

    const password        = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (password.length < 8) {
        showAlert('error', 'A senha deve ter no mínimo 8 caracteres.');
        passwordInput.focus();
        return;
    }

    if (password.length > 128) {
        showAlert('error', 'A senha deve ter no máximo 128 caracteres.');
        passwordInput.focus();
        return;
    }

    if (password !== confirmPassword) {
        showAlert('error', 'As senhas não coincidem.');
        confirmPasswordInput.focus();
        return;
    }

    setButtonLoading(submitBtn, 'Criando sua conta...');

    try {
        // [FIX-02] Email sempre normalizado
        const email = (currentSubscriptionData.email || '').toLowerCase().trim();

        // ── ETAPA 1: Criar usuário no Auth ──────────────────────────────
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: undefined,
                data: {
                    name: currentSubscriptionData.user_name,
                    plan: currentSubscriptionData.plan_name,
                },
            },
        });

        if (authError) {
            const alreadyRegistered =
                authError.message.toLowerCase().includes('already registered') ||
                authError.message.toLowerCase().includes('user already registered');

            if (alreadyRegistered) {
                // Usuário já existe — orienta para login/reset
                showAlertWithLinks(
                    'warning',
                    'Este email já possui cadastro.',
                    [
                        { text: 'Fazer login', href: 'login.html' },
                        { text: 'Esqueci minha senha', href: 'login.html' },
                    ]
                );
                return;
            }
            throw authError;
        }

        const userId      = authData.user.id;
        const accessToken = authData.session?.access_token;

        // ── ETAPA 2: Vincular subscription via Edge Function ────────────
        // [SEC-01] Envia o JWT do usuário recém-criado — não a anon key
        // A Edge Function extrai o email do JWT assinado (não confia no body)
        if (accessToken) {
            await _linkViaBackend(accessToken, currentSubscriptionData.subscription_id);
        }
        // Se não há accessToken (raro com confirm email desligado), o fallback
        // ocorre no próximo login quando o AuthGuard detecta subscription sem user_id

        // ── ETAPA 3: Registrar aceitação dos termos ─────────────────────
        await _acceptTerms(userId, email);

        // ── ETAPA 4: Criar user_data ────────────────────────────────────
        await _createUserData(userId, email, currentSubscriptionData);

        // ── ETAPA 5: Login automático ────────────────────────────────────
        // Aguarda 800ms para propagação no servidor
        await new Promise(resolve => setTimeout(resolve, 800));

        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });

        // [SEC-05] Limpa campos sensíveis independente do resultado
        passwordInput.value        = '';
        confirmPasswordInput.value = '';

        if (loginError) {
            // [FIX-03] Trata explicitamente email não confirmado
            if (loginError.message?.toLowerCase().includes('email not confirmed')) {
                showAlert('warning', 'Conta criada! Confirme seu email e faça o login.');
            } else {
                showAlert('info', '✅ Conta criada! Faça o login para continuar.');
            }
            setTimeout(() => { window.location.href = 'login.html'; }, 2500);
            return;
        }

        showAlert('info', '✅ Conta criada com sucesso! Redirecionando...');
        setTimeout(() => { window.location.href = 'login.html'; }, 1500);

    } catch (err) {
        // [SEC-05] Limpa senha em qualquer erro
        passwordInput.value        = '';
        confirmPasswordInput.value = '';

        let msg = 'Erro ao criar conta. Tente novamente.';
        const msgLower = (err?.message || '').toLowerCase();

        if (msgLower.includes('invalid email')) {
            msg = 'Email inválido.';
        } else if (msgLower.includes('password')) {
            msg = 'Erro na senha. Tente uma senha diferente.';
        } else if (msgLower.includes('network') || msgLower.includes('fetch')) {
            msg = 'Erro de conexão. Verifique sua internet e tente novamente.';
        }

        showAlert('error', msg);

    } finally {
        // [FIX-01] Restaura o botão em TODOS os caminhos sem exceção
        restoreButton(submitBtn, 'Criar Senha e Acessar');
    }
});

// ==========================================
// HELPERS INTERNOS
// ==========================================

/**
 * [SEC-01] Vincula subscription usando o JWT do usuário como autenticação.
 * A Edge Function verifica o JWT e extrai o email de forma segura —
 * não aceita email do body, impossibilitando falsificação de identidade.
 */
async function _linkViaBackend(accessToken, subscriptionId) {
    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/link-user-subscription`, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                // [SEC-01] JWT do usuário — não a anon key
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ subscription_id: subscriptionId }),
            // Nota: email NÃO é enviado no body — a Edge Function extrai do JWT
        });

        if (!response.ok) return false;
        const result = await response.json();
        return result?.success === true;
    } catch {
        return false;
    }
}

/**
 * Registra aceitação dos termos.
 */
async function _acceptTerms(userId, email) {
    try {
        await supabase.from('terms_acceptance').insert({
            user_id:     userId,
            email,
            accepted:    true,
            accepted_at: new Date().toISOString(),
            // Trunca UserAgent para evitar armazenamento excessivo
            user_agent:  navigator.userAgent.slice(0, 200),
        });
    } catch {
        // Não bloqueia o fluxo principal
    }
}

/**
 * Cria entrada em user_data.
 */
async function _createUserData(userId, email, subData) {
    try {
        await supabase.from('user_data').insert({
            user_id: userId,
            email,
            data_json: {
                created_via: 'first_access',
                plan:        sanitize(subData.plan_name),
                name:        sanitize(subData.user_name),
                created_at:  new Date().toISOString(),
            },
        });
    } catch {
        // Não bloqueia o fluxo principal
    }
}

// ==========================================
// ANIMAÇÕES
// ==========================================
const style = document.createElement('style');
style.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
        20%, 40%, 60%, 80%       { transform: translateX(5px); }
    }
`;
document.head.appendChild(style);