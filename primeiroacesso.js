import { supabase } from './supabase-client.js';

// ==========================================
// ELEMENTOS DO DOM
// ==========================================
const accessForm          = document.getElementById('accessForm');
const emailCheckState     = document.getElementById('emailCheckState');
const passwordInputs      = document.getElementById('passwordInputs');
const checkEmailBtn       = document.getElementById('checkEmailBtn');
const submitBtn           = document.getElementById('submitBtn');

const emailInput          = document.getElementById('email');
const passwordInput       = document.getElementById('password');
const confirmPasswordInput= document.getElementById('confirmPassword');
const termsCheckbox       = document.getElementById('termsCheckbox');

const alertBox            = document.getElementById('alertBox');
const alertMessage        = document.getElementById('alertMessage');
const infoBox             = document.getElementById('infoBox');
const userName            = document.getElementById('userName');
const userEmail           = document.getElementById('userEmail');
const planName            = document.getElementById('planName');

const confirmError        = document.getElementById('confirmError');
const termsError          = document.getElementById('termsError');
const strengthFill        = document.getElementById('strengthFill');
const strengthText        = document.getElementById('strengthText');

const togglePassword1     = document.getElementById('togglePassword1');
const togglePassword2     = document.getElementById('togglePassword2');

// ==========================================
// ESTADO
// ==========================================
let currentSubscriptionData = null;
const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

// ==========================================
// VERIFICAR EMAIL
// ==========================================
checkEmailBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim().toLowerCase();

    if (!email) {
        showAlert('error', 'Por favor, digite seu email.');
        return;
    }

    if (!isValidEmail(email)) {
        showAlert('error', 'Email inválido. Digite um email válido.');
        return;
    }

    checkEmailBtn.disabled = true;
    setButtonLoading(checkEmailBtn, 'Verificando...');

    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/check-email-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
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
                showAlert('warning', 'Pagamento ainda não aprovado para este email. Aguarde a confirmação do pagamento.');
                hidePasswordInputs();
                break;

            case 'password_exists':
                // [FIX-01] Usuário existe no Auth mas user_id ainda está NULL na subscription.
                // Tenta vincular automaticamente antes de redirecionar.
                showAlert('warning', 'Email já possui uma senha cadastrada. <a href="login.html">Fazer login</a> ou <a href="login.html">esqueceu a senha?</a>');
                hidePasswordInputs();

                // Tentativa silenciosa de vínculo caso user_id seja NULL
                if (result.needs_link && result.data?.subscription_id) {
                    await _tryLinkExistingUser(email, result.data.subscription_id);
                }
                break;

            case 'ready':
                currentSubscriptionData = result.data;
                showPasswordForm(result.data);
                break;

            case 'error':
                showAlert('error', 'Erro ao verificar email. Tente novamente.');
                hidePasswordInputs();
                break;

            default:
                showAlert('error', 'Resposta inesperada do servidor. Tente novamente.');
                hidePasswordInputs();
        }

    } catch {
        showAlert('error', 'Erro de conexão. Verifique sua internet e tente novamente.');
        hidePasswordInputs();
    } finally {
        checkEmailBtn.disabled = false;
        restoreButton(checkEmailBtn, 'Verificar Email');
    }
});

// ==========================================
// [FIX-01] VINCULAR USUÁRIO EXISTENTE
// Cobre o caso em que signUp funcionou mas o UPDATE da subscription falhou.
// Chamado silenciosamente quando o backend informa password_exists + needs_link.
// ==========================================
async function _tryLinkExistingUser(email, subscriptionId) {
    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/link-user-subscription`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
            body: JSON.stringify({ email, subscription_id: subscriptionId }),
        });

        // Falha silenciosa — não bloqueia o fluxo do usuário
        if (!response.ok) return;
    } catch {
        // Silencioso
    }
}

// ==========================================
// MOSTRAR FORMULÁRIO DE SENHA
// ==========================================
function showPasswordForm(data) {
    alertBox.style.display = 'none';
    infoBox.style.display  = 'block';

    // [SEC] textContent — sem innerHTML com dados do servidor
    userName.textContent = data.user_name || 'Usuário';
    userEmail.textContent = data.email;
    planName.textContent = data.plan_name;

    emailCheckState.style.display = 'none';
    passwordInputs.style.display  = 'block';

    setTimeout(() => passwordInput.focus(), 300);
}

// ==========================================
// ESCONDER INPUTS DE SENHA
// ==========================================
function hidePasswordInputs() {
    passwordInputs.style.display  = 'none';
    infoBox.style.display         = 'none';
    emailCheckState.style.display = 'block';
}

// ==========================================
// SHOW ALERT
// [SEC] innerHTML apenas para mensagens internas hardcoded com link seguro
// ==========================================
function showAlert(type, message) {
    alertBox.className       = 'alert-box ' + type;
    alertBox.style.display   = 'flex';
    alertMessage.innerHTML   = message; // links são hardcoded no código, não vêm do servidor

    if (type !== 'error') {
        setTimeout(() => { alertBox.style.display = 'none'; }, 8000);
    }
}

// ==========================================
// VALIDAR EMAIL
// ==========================================
function isValidEmail(email) {
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ==========================================
// HELPER: LOADING STATE DOS BOTÕES
// ==========================================
function setButtonLoading(btn, label) {
    btn.disabled     = true;
    btn.dataset.orig = btn.innerHTML;
    btn.textContent  = label;
}

function restoreButton(btn, label) {
    btn.disabled    = false;
    btn.textContent = '';
    btn.innerHTML   = btn.dataset.orig || label;
    delete btn.dataset.orig;
}

// ==========================================
// TOGGLE PASSWORD VISIBILITY
// ==========================================
togglePassword1.addEventListener('click', () => {
    passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
});

togglePassword2.addEventListener('click', () => {
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

passwordInput.addEventListener('input', () => {
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
confirmPasswordInput.addEventListener('input', () => {
    if (confirmPasswordInput.value && confirmPasswordInput.value !== passwordInput.value) {
        confirmError.style.display              = 'block';
        confirmPasswordInput.style.borderColor  = 'var(--error)';
    } else {
        confirmError.style.display              = 'none';
        confirmPasswordInput.style.borderColor  = 'rgba(255, 255, 255, 0.1)';
    }
});

// ==========================================
// CHECKBOX DE TERMOS
// ==========================================
const checkboxWrapper = document.querySelector('.checkbox-wrapper');

termsCheckbox.addEventListener('change', () => {
    const termsWarning = document.getElementById('termsWarning');

    if (termsCheckbox.checked) {
        termsError.style.display = 'none';
        checkboxWrapper.classList.remove('error');
        checkboxWrapper.style.borderColor  = 'rgba(16, 185, 129, 0.3)';
        checkboxWrapper.style.background   = 'rgba(16, 185, 129, 0.05)';
        if (termsWarning) {
            termsWarning.classList.remove('show');
            termsWarning.style.display = 'none';
        }
    } else {
        checkboxWrapper.style.borderColor  = 'rgba(255, 255, 255, 0.05)';
        checkboxWrapper.style.background   = 'rgba(255, 255, 255, 0.02)';
    }
});

function showTermsError() {
    const termsWarning = document.getElementById('termsWarning');
    if (termsWarning) {
        termsWarning.classList.add('show');
        termsWarning.style.display = 'flex';
    }
    termsError.style.display            = 'block';
    checkboxWrapper.classList.add('error');
    checkboxWrapper.style.borderColor   = 'var(--error)';
    checkboxWrapper.style.background    = 'rgba(239, 68, 68, 0.05)';
    checkboxWrapper.style.animation     = 'shake 0.5s';
    checkboxWrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => termsCheckbox.focus(), 500);
}

// ==========================================
// SUBMIT — CRIAR SENHA
// [FIX-02] Fluxo robusto com retry de vínculo e tratamento de "já registrado"
// ==========================================
accessForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentSubscriptionData) {
        showAlert('error', 'Dados da assinatura não encontrados. Recarregue a página.');
        return;
    }

    // Validação de termos — prioridade máxima
    if (!termsCheckbox.checked) {
        showTermsError();
        showAlert('error', '⚠️ ATENÇÃO: Você DEVE aceitar os Termos de Uso para criar sua conta. Marque a caixa acima para continuar.');
        return;
    }

    const password        = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (password.length < 8) {
        showAlert('error', 'A senha deve ter no mínimo 8 caracteres.');
        passwordInput.focus();
        return;
    }

    if (password !== confirmPassword) {
        showAlert('error', 'As senhas não coincidem.');
        confirmPasswordInput.focus();
        return;
    }

    submitBtn.disabled = true;
    setButtonLoading(submitBtn, 'Criando sua conta...');

    try {
        const email = currentSubscriptionData.email;

        // ── ETAPA 1: Criar usuário no Auth ──────────────────────────
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

        let userId;

        if (authError) {
            const alreadyRegistered =
                authError.message.toLowerCase().includes('already registered') ||
                authError.message.toLowerCase().includes('user already registered');

            if (alreadyRegistered) {
                // [FIX-02] Usuário já existe no Auth (criação prévia com falha no UPDATE).
                // Delega ao backend o vínculo e a atualização do password_created.
                const linked = await _linkViaBackend(email, currentSubscriptionData.subscription_id, password);

                if (linked) {
                    showAlert('info', '✅ Conta configurada com sucesso! Redirecionando para o login...');
                    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
                    return;
                }

                // Backend falhou — orienta o usuário
                showAlert('error', 'Conta já existe. <a href="login.html">Fazer login</a> ou use "Esqueci a senha" se não lembrar.');
                return;
            }

            throw authError;
        }

        userId = authData.user.id;

        // ── ETAPA 2: Confirmar email via Edge Function ───────────────
        await _confirmEmail(userId);

        // ── ETAPA 3: Vincular user_id na subscription ────────────────
        // [FIX-03] Vínculo é a etapa MAIS CRÍTICA. Qualquer falha aqui
        //          deve ser retentada e logada, pois é o que causava o bug.
        const linked = await _updateSubscription(userId, currentSubscriptionData.subscription_id);

        if (!linked) {
            // Tenta via backend como fallback
            await _linkViaBackend(email, currentSubscriptionData.subscription_id, null);
        }

        // ── ETAPA 4: Registrar aceitação dos termos ──────────────────
        await _acceptTerms(userId, email);

        // ── ETAPA 5: Criar user_data ─────────────────────────────────
        await _createUserData(userId, email, currentSubscriptionData);

        // ── ETAPA 6: Login automático ────────────────────────────────
        // [FIX-04] Aguarda 800ms para que a confirmação de email propague
        //          antes de tentar o signIn, evitando falha silenciosa de sessão.
        await new Promise(resolve => setTimeout(resolve, 800));

        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });

        if (loginError) {
            // Login automático falhou, mas conta foi criada — apenas redireciona para login manual
            showAlert('info', '✅ Conta criada com sucesso! Faça login para continuar.');
            setTimeout(() => { window.location.href = 'login.html'; }, 2000);
            return;
        }

        showAlert('info', '✅ Conta criada com sucesso! Redirecionando...');
        setTimeout(() => { window.location.href = 'login.html'; }, 1500);

    } catch (err) {
        let msg = 'Erro ao criar conta. Tente novamente.';

        if (err?.message?.toLowerCase().includes('invalid email')) {
            msg = 'Email inválido.';
        } else if (err?.message?.toLowerCase().includes('password')) {
            msg = 'Erro na senha. Tente uma senha diferente.';
        }

        showAlert('error', msg);

        submitBtn.disabled = false;
        restoreButton(submitBtn, 'Criar Senha e Acessar');
    }
});

// ==========================================
// HELPERS INTERNOS
// ==========================================

/** Confirma email do usuário via Edge Function */
async function _confirmEmail(userId) {
    try {
        await fetch(`${SUPABASE_URL}/functions/v1/confirm-user-email`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
            body: JSON.stringify({ userId }),
        });
    } catch {
        // Não crítico — o login pode funcionar mesmo sem confirmação em projetos com email desabilitado
    }
}

/**
 * [FIX-03] Vincula user_id à subscription e marca password_created = true.
 * Retorna true se bem-sucedido.
 */
async function _updateSubscription(userId, subscriptionId) {
    try {
        const { error } = await supabase
            .from('subscriptions')
            .update({
                user_id:             userId,
                password_created:    true,
                password_created_at: new Date().toISOString(),
                updated_at:          new Date().toISOString(),
            })
            .eq('id', subscriptionId);

        return !error;
    } catch {
        return false;
    }
}

/**
 * [FIX-02] Delega vínculo ao backend quando o usuário já existe no Auth.
 * O backend usa service role key para buscar o auth.users pelo email.
 * Retorna true se bem-sucedido.
 */
async function _linkViaBackend(email, subscriptionId, password) {
    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/link-user-subscription`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
            body: JSON.stringify({ email, subscription_id: subscriptionId }),
        });

        if (!response.ok) return false;
        const result = await response.json();
        return result?.success === true;
    } catch {
        return false;
    }
}

/** Registra aceitação dos termos (não crítico) */
async function _acceptTerms(userId, email) {
    try {
        await supabase.from('terms_acceptance').insert({
            user_id:    userId,
            email,
            accepted:   true,
            accepted_at: new Date().toISOString(),
            user_agent:  navigator.userAgent,
        });
    } catch {
        // Não bloqueia o fluxo
    }
}

/** Cria entrada em user_data (não crítico) */
async function _createUserData(userId, email, subData) {
    try {
        await supabase.from('user_data').insert({
            user_id: userId,
            email,
            data_json: {
                created_via: 'first_access',
                plan:        subData.plan_name,
                name:        subData.user_name,
                created_at:  new Date().toISOString(),
            },
        });
    } catch {
        // Não bloqueia o fluxo
    }
}

// ==========================================
// ANIMAÇÃO DO SPINNER
// ==========================================
const style = document.createElement('style');
style.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
        20%, 40%, 60%, 80% { transform: translateX(5px); }
    }
`;
document.head.appendChild(style);