import { supabase } from './supabase-client.js';

// ==========================================
// ELEMENTOS DO DOM
// ==========================================
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const formState = document.getElementById('formState');
const successState = document.getElementById('successState');

const errorMessage = document.getElementById('errorMessage');
const userEmail = document.getElementById('userEmail');
const planName = document.getElementById('planName');

const passwordForm = document.getElementById('passwordForm');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');
const confirmError = document.getElementById('confirmError');
const strengthFill = document.getElementById('strengthFill');
const strengthText = document.getElementById('strengthText');
const submitBtn = document.getElementById('submitBtn');

const togglePassword1 = document.getElementById('togglePassword1');
const togglePassword2 = document.getElementById('togglePassword2');

// ==========================================
// VARIÁVEIS GLOBAIS
// ==========================================
let currentToken = null;
let subscriptionData = null;

// ==========================================
// INICIALIZAÇÃO
// ==========================================
async function init() {
    // Pegar token da URL
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    if (!token) {
        showError('Link inválido. Token não encontrado.');
        return;
    }

    currentToken = token;

    // Validar token
    await validateToken(token);
}

// ==========================================
// VALIDAR TOKEN
// ==========================================
async function validateToken(token) {
    try {
        // Chamar função SQL para validar
        const { data, error } = await supabase
            .rpc('validate_access_token', { token_input: token });

        if (error) throw error;

        const validation = data[0];

        if (!validation.is_valid) {
            showError(validation.error_message);
            return;
        }

        // Token válido! Mostrar formulário
        subscriptionData = validation;
        userEmail.textContent = validation.user_email;
        planName.textContent = validation.plan_name;

        showForm();

    } catch (error) {
        console.error('Erro ao validar token:', error);
        showError('Erro ao validar link. Tente novamente mais tarde.');
    }
}

// ==========================================
// TOGGLE PASSWORD VISIBILITY
// ==========================================
function setupPasswordToggles() {
    togglePassword1.addEventListener('click', () => {
        const type = passwordInput.type === 'password' ? 'text' : 'password';
        passwordInput.type = type;
    });

    togglePassword2.addEventListener('click', () => {
        const type = confirmPasswordInput.type === 'password' ? 'text' : 'password';
        confirmPasswordInput.type = type;
    });
}

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
// VALIDAR SENHA CONFIRMAÇÃO
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
// SUBMIT FORM
// ==========================================
passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    // Validações
    if (password.length < 8) {
        alert('A senha deve ter no mínimo 8 caracteres');
        return;
    }

    if (password !== confirmPassword) {
        alert('As senhas não coincidem');
        confirmPasswordInput.focus();
        return;
    }

    // Desabilitar botão
    submitBtn.disabled = true;
    submitBtn.textContent = 'Criando sua conta...';

    try {
        // 1. Criar usuário no Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: subscriptionData.user_email,
            password: password,
        });

        if (authError) throw authError;

        const userId = authData.user.id;

        // 2. Atualizar subscription com user_id e marcar token como usado
        const { error: updateError } = await supabase
            .from('subscriptions')
            .update({
                user_id: userId,
                access_token_used: true,
                password_created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', subscriptionData.subscription_id);

        if (updateError) throw updateError;

        // 3. Criar entrada em user_data
        const { error: userDataError } = await supabase
            .from('user_data')
            .insert({
                user_id: userId,
                email: subscriptionData.user_email,
                data_json: {
                    created_via: 'first_access',
                    plan: subscriptionData.plan_name,
                },
            });

        if (userDataError) throw userDataError;

        // Sucesso!
        showSuccess();

        // Redirecionar após 2 segundos
        setTimeout(() => {
            window.location.href = 'login.html';
        }, 2000);

    } catch (error) {
        console.error('Erro ao criar senha:', error);
        alert('Erro ao criar senha. ' + (error.message || 'Tente novamente.'));
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
// ESTADOS DA UI
// ==========================================
function showForm() {
    loadingState.style.display = 'none';
    errorState.style.display = 'none';
    formState.style.display = 'block';
    successState.style.display = 'none';
}

function showError(message) {
    loadingState.style.display = 'none';
    errorState.style.display = 'block';
    formState.style.display = 'none';
    successState.style.display = 'none';
    errorMessage.textContent = message;
}

function showSuccess() {
    loadingState.style.display = 'none';
    errorState.style.display = 'none';
    formState.style.display = 'none';
    successState.style.display = 'block';
}

// ==========================================
// INICIAR
// ==========================================
setupPasswordToggles();
init();