import { supabase } from './supabase-client.js';

// ==========================================
// ELEMENTOS DO DOM
// ==========================================
const accessForm = document.getElementById('accessForm');
const emailCheckState = document.getElementById('emailCheckState');
const passwordInputs = document.getElementById('passwordInputs');
const checkEmailBtn = document.getElementById('checkEmailBtn');
const submitBtn = document.getElementById('submitBtn');

const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');

const alertBox = document.getElementById('alertBox');
const alertMessage = document.getElementById('alertMessage');
const infoBox = document.getElementById('infoBox');
const userName = document.getElementById('userName');
const userEmail = document.getElementById('userEmail');
const planName = document.getElementById('planName');

const confirmError = document.getElementById('confirmError');
const strengthFill = document.getElementById('strengthFill');
const strengthText = document.getElementById('strengthText');

const togglePassword1 = document.getElementById('togglePassword1');
const togglePassword2 = document.getElementById('togglePassword2');

// ==========================================
// VARIÁVEIS GLOBAIS
// ==========================================
let currentSubscriptionData = null;
const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

// ==========================================
// VERIFICAR EMAIL
// ==========================================
checkEmailBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();

    if (!email) {
        showAlert('error', 'Por favor, digite seu email.');
        return;
    }

    if (!isValidEmail(email)) {
        showAlert('error', 'Email inválido. Digite um email válido.');
        return;
    }

    // Desabilitar botão e mostrar loading
    checkEmailBtn.disabled = true;
    checkEmailBtn.innerHTML = `
        <svg class="spinner" viewBox="0 0 24 24" style="width: 20px; height: 20px; animation: spin 1s linear infinite;">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" opacity="0.25"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="4" fill="none"/>
        </svg>
        Verificando...
    `;

    try {
        // Chamar Edge Function
        const response = await fetch(`${SUPABASE_URL}/functions/v1/check-email-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabase.supabaseKey}`,
            },
            body: JSON.stringify({ email }),
        });

        const result = await response.json();

        console.log('📋 Resultado da verificação:', result);

        // Processar resposta
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
                showAlert('warning', 'Email já possui uma senha cadastrada. <a href="login.html">Fazer login</a> ou <a href="login.html#esqueci-senha">esqueceu a senha?</a>');
                hidePasswordInputs();
                break;

            case 'ready':
                // Salvar dados e mostrar formulário de senha
                currentSubscriptionData = result.data;
                showPasswordForm(result.data);
                break;

            case 'error':
                showAlert('error', 'Erro ao verificar email: ' + result.message);
                hidePasswordInputs();
                break;

            default:
                showAlert('error', 'Resposta inesperada do servidor. Tente novamente.');
                hidePasswordInputs();
        }

    } catch (error) {
        console.error('❌ Erro ao verificar email:', error);
        showAlert('error', 'Erro de conexão. Verifique sua internet e tente novamente.');
        hidePasswordInputs();
    } finally {
        // Reabilitar botão
        checkEmailBtn.disabled = false;
        checkEmailBtn.innerHTML = `
            Verificar Email
            <svg viewBox="0 0 20 20" fill="none">
                <path d="M7 13L13 7M13 7H7M13 7V13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
        `;
    }
});

// ==========================================
// MOSTRAR FORMULÁRIO DE SENHA
// ==========================================
function showPasswordForm(data) {
    // Esconder alert
    alertBox.style.display = 'none';

    // Mostrar info box
    infoBox.style.display = 'block';
    userName.textContent = data.user_name || 'Usuário';
    userEmail.textContent = data.email;
    planName.textContent = data.plan_name;

    // Esconder email input
    emailCheckState.style.display = 'none';

    // Mostrar password inputs
    passwordInputs.style.display = 'block';

    // Focar no campo de senha
    setTimeout(() => {
        passwordInput.focus();
    }, 300);
}

// ==========================================
// ESCONDER INPUTS DE SENHA
// ==========================================
function hidePasswordInputs() {
    passwordInputs.style.display = 'none';
    infoBox.style.display = 'none';
    emailCheckState.style.display = 'block';
}

// ==========================================
// MOSTRAR ALERT
// ==========================================
function showAlert(type, message) {
    alertBox.className = 'alert-box ' + type;
    alertBox.style.display = 'flex';
    alertMessage.innerHTML = message;

    // Auto-hide após 8 segundos (exceto para errors)
    if (type !== 'error') {
        setTimeout(() => {
            alertBox.style.display = 'none';
        }, 8000);
    }
}

// ==========================================
// VALIDAR EMAIL
// ==========================================
function isValidEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
}

// ==========================================
// TOGGLE PASSWORD VISIBILITY
// ==========================================
togglePassword1.addEventListener('click', () => {
    const type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = type;
});

togglePassword2.addEventListener('click', () => {
    const type = confirmPasswordInput.type === 'password' ? 'text' : 'password';
    confirmPasswordInput.type = type;
});

// ==========================================
// PASSWORD STRENGTH CHECKER
// ==========================================
function checkPasswordStrength(password) {
    let strength = 0;
    
    if (password.length >= 8) strength++;
    if (password.length >= 12) strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
    if (/\d/.test(password)) strength++;
    if (/[^a-zA-Z0-9]/.test(password)) strength++;

    return strength;
}

function updatePasswordStrength() {
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
}

passwordInput.addEventListener('input', updatePasswordStrength);

// ==========================================
// VALIDAR CONFIRMAÇÃO DE SENHA
// ==========================================
confirmPasswordInput.addEventListener('input', () => {
    if (confirmPasswordInput.value && confirmPasswordInput.value !== passwordInput.value) {
        confirmError.style.display = 'block';
        confirmPasswordInput.style.borderColor = 'var(--error)';
    } else {
        confirmError.style.display = 'none';
        confirmPasswordInput.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    }
});

// ==========================================
// SUBMIT FORM - CRIAR SENHA
// ==========================================
accessForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!currentSubscriptionData) {
        showAlert('error', 'Dados da assinatura não encontrados. Recarregue a página.');
        return;
    }

    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    // Validações
    if (password.length < 8) {
        showAlert('error', 'A senha deve ter no mínimo 8 caracteres');
        passwordInput.focus();
        return;
    }

    if (password !== confirmPassword) {
        showAlert('error', 'As senhas não coincidem');
        confirmPasswordInput.focus();
        return;
    }

    // Desabilitar botão
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
        <svg class="spinner" viewBox="0 0 24 24" style="width: 20px; height: 20px; animation: spin 1s linear infinite;">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" opacity="0.25"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="4" fill="none"/>
        </svg>
        Criando sua conta...
    `;

    try {
        console.log('🔐 Criando usuário no Auth...');

        // 1. Criar usuário no Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: currentSubscriptionData.email,
            password: password,
            options: {
                data: {
                    name: currentSubscriptionData.user_name,
                    plan: currentSubscriptionData.plan_name,
                }
            }
        });

        if (authError) {
            console.error('❌ Erro no Auth:', authError);
            throw authError;
        }

        const userId = authData.user.id;
        console.log('✅ Usuário criado no Auth:', userId);

        // 2. Atualizar subscription com user_id e marcar senha como criada
        console.log('📝 Atualizando subscription...');
        const { error: updateError } = await supabase
            .from('subscriptions')
            .update({
                user_id: userId,
                password_created: true,
                password_created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', currentSubscriptionData.subscription_id);

        if (updateError) {
            console.error('❌ Erro ao atualizar subscription:', updateError);
            throw updateError;
        }

        console.log('✅ Subscription atualizada');

        // 3. Criar entrada em user_data
console.log('💾 Criando user_data...');
const { data: userData, error: userDataError } = await supabase
    .from('user_data')
    .insert({
        user_id: userId,
        email: currentSubscriptionData.email,
        data_json: {
            created_via: 'first_access',
            plan: currentSubscriptionData.plan_name,
            name: currentSubscriptionData.user_name,
            created_at: new Date().toISOString(),
        },
    })
    .select();

if (userDataError) {
    console.error('❌ Erro ao criar user_data:', userDataError);
    console.error('📊 Detalhes do erro:', JSON.stringify(userDataError, null, 2));
    
    // Se falhar por RLS mas o usuário foi criado, continuar mesmo assim
    if (userDataError.code === '42501') {
        console.warn('⚠️ Falha de RLS, mas usuário foi criado. Continuando...');
        // Não lançar erro, apenas avisar
    } else {
        throw userDataError;
    }
} else {
    console.log('✅ User_data criado:', userData);
}

        // Sucesso!
        showAlert('info', '✅ Senha criada com sucesso! Redirecionando...');
        
        // Redirecionar após 2 segundos
        setTimeout(() => {
            window.location.href = 'login.html';
        }, 2000);

    } catch (error) {
        console.error('❌ Erro ao criar senha:', error);
        
        let errorMessage = 'Erro ao criar senha. ';
        
        if (error.message.includes('already registered')) {
            errorMessage = 'Este email já está registrado. Tente fazer login.';
        } else if (error.message.includes('Invalid email')) {
            errorMessage = 'Email inválido.';
        } else {
            errorMessage += error.message || 'Tente novamente.';
        }
        
        showAlert('error', errorMessage);
        
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
            Criar Senha e Acessar
            <svg viewBox="0 0 20 20" fill="none">
                <path d="M7 13L13 7M13 7H7M13 7V13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
        `;
    }
});

// ==========================================
// ADICIONAR ESTILO DO SPINNER
// ==========================================
const style = document.createElement('style');
style.textContent = `
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
`;
document.head.appendChild(style);

// ==========================================
// INICIALIZAÇÃO
// ==========================================
console.log('✅ Primeiro Acesso carregado');