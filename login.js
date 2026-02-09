import { supabase } from './supabase-client.js';

// ===== CONFIGURAÇÕES =====
const CONFIG = {
    moneyParticleCount: 15,
    chartLineCount: 8
};

// URL das Edge Functions do Supabase
const SUPABASE_FUNCTIONS_URL = 'https://SEU-PROJECT-REF.supabase.co/functions/v1';

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

// ===== INICIALIZAÇÃO =====
window.addEventListener('DOMContentLoaded', async () => {
    // Verificar autenticação
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        console.log('✅ Usuário já autenticado, redirecionando...');
        window.location.href = 'dashboard.html';
        return;
    }
    // Criar partículas e gráficos
    createMoneyParticles();
    createAnimatedCharts();
    
    // Verificar mensagem de erro
    const authError = sessionStorage.getItem('auth_error');
    if (authError) {
        showAuthMessage(authError, 'error');
        sessionStorage.removeItem('auth_error');
    }
    
    console.log('🚀 GranaEvo Login carregado!');
    console.log('📧 Email de teste: admin@granaevo.com');
    console.log('🔑 Senha de teste: 1234');
});

// ===== SISTEMA DE LOGIN =====
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const email = inputs.loginEmail.value.trim();
    const password = inputs.loginPassword.value;
    
    // Validações
    if (!email || !password) {
        showAuthMessage('Por favor, preencha todos os campos', 'error');
        return;
    }
    
    if (!email.includes('@')) {
        showAuthMessage('Email inválido', 'error');
        shakeInput(inputs.loginEmail);
        return;
    }

    try {
        showAuthMessage('Verificando credenciais...', 'info');
        
        // Login no Supabase
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            showAuthMessage('Email ou senha incorretos', 'error');
            shakeInput(inputs.loginEmail);
            shakeInput(inputs.loginPassword);
            inputs.loginPassword.value = '';
            return;
        }

        // Verificar se tem assinatura ativa
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('*, plans(*)')
            .eq('user_id', data.user.id)
            .eq('payment_status', 'approved')
            .single();

        if (!subscription) {
            showAuthMessage('Você precisa adquirir um plano primeiro!', 'error');
            setTimeout(() => {
                window.location.href = 'planos.html';
            }, 2000);
            return;
        }

        // Login bem-sucedido
        showAuthMessage(`Bem-vindo de volta, ${data.user.user_metadata.name || 'Usuário'}!`, 'success');
        
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
    // Remove active de todas as telas exceto a atual
    Object.values(screens).forEach(screen => {
        if (screen !== currentScreen) {
            screen.classList.remove('active', 'exit-left');
        }
    });
    
    // Aplica animação de saída na tela atual
    if (currentScreen) {
        currentScreen.classList.add('exit-left');
        
        // Aguarda a animação de saída completar antes de mostrar a próxima
        setTimeout(() => {
            currentScreen.classList.remove('active', 'exit-left');
            nextScreen.classList.add('active');
        }, 500);
    } else {
        // Se não há tela atual (primeira vez), mostra direto
        nextScreen.classList.add('active');
    }
}

// Event Listeners - Navegação
if (buttons.forgotPassword) {
    buttons.forgotPassword.addEventListener('click', (e) => {
        e.preventDefault();
        switchScreen(screens.login, screens.forgotEmail);
    });
}

if (buttons.backToLogin) {
    buttons.backToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        switchScreen(screens.forgotEmail, screens.login);
    });
}

// ===== ENVIAR CÓDIGO DE RECUPERAÇÃO =====
if (buttons.sendCode) {
    buttons.sendCode.addEventListener('click', async () => {
        const email = inputs.recoveryEmail.value.trim();
        
        if (!email || !email.includes('@')) {
            inputs.recoveryEmail.style.borderColor = 'var(--error-red)';
            setTimeout(() => {
                inputs.recoveryEmail.style.borderColor = '';
            }, 2000);
            return;
        }

        try {
            // Desabilitar botão e mostrar loading
            buttons.sendCode.disabled = true;
            const btnText = buttons.sendCode.querySelector('.btn-text');
            const originalText = btnText.textContent;
            btnText.textContent = 'Enviando...';

            console.log('📧 Enviando código para:', email);

            const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/send-reset-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email })
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Erro ao enviar código');
            }

            console.log('✅ Código enviado com sucesso!');
            
            // Mostrar mensagem de sucesso
            const messageDiv = document.createElement('div');
            messageDiv.className = 'auth-message success show';
            messageDiv.textContent = 'Código enviado! Verifique seu email.';
            messageDiv.style.display = 'flex';
            messageDiv.style.marginBottom = '20px';
            
            const form = buttons.sendCode.closest('.recovery-form');
            form.insertBefore(messageDiv, form.firstChild);
            
            setTimeout(() => {
                messageDiv.remove();
            }, 3000);

            // Ir para tela de código
            switchScreen(screens.forgotEmail, screens.code);
            
            setTimeout(() => {
                inputs.codeInputs[0].focus();
            }, 500);

        } catch (error) {
            console.error('❌ Erro ao enviar código:', error);
            
            // Mostrar mensagem de erro
            const messageDiv = document.createElement('div');
            messageDiv.className = 'auth-message error show';
            messageDiv.textContent = error.message || 'Erro ao enviar código. Tente novamente.';
            messageDiv.style.display = 'flex';
            messageDiv.style.marginBottom = '20px';
            
            const form = buttons.sendCode.closest('.recovery-form');
            form.insertBefore(messageDiv, form.firstChild);
            
            setTimeout(() => {
                messageDiv.remove();
            }, 3000);
            
        } finally {
            // Reabilitar botão
            buttons.sendCode.disabled = false;
            const btnText = buttons.sendCode.querySelector('.btn-text');
            btnText.textContent = 'Enviar código';
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
    buttons.verifyCode.addEventListener('click', async () => {
        const code = Array.from(inputs.codeInputs).map(input => input.value).join('');
        const email = inputs.recoveryEmail.value.trim();
        
        if (code.length !== 6) {
            return;
        }

        try {
            // Desabilitar botão e mostrar loading
            buttons.verifyCode.disabled = true;
            const btnText = buttons.verifyCode.querySelector('.btn-text');
            const originalText = btnText.textContent;
            btnText.textContent = 'Verificando...';

            console.log('🔍 Verificando código...');

            const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/verify-reset-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, code })
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error('Código inválido ou expirado');
            }

            console.log('✅ Código verificado com sucesso!');
            switchScreen(screens.code, screens.newPassword);

        } catch (error) {
            console.error('❌ Erro ao verificar código:', error);
            
            // Animar erro nos inputs
            inputs.codeInputs.forEach(input => {
                input.classList.add('error');
            });
            
            setTimeout(() => {
                inputs.codeInputs.forEach(input => {
                    input.classList.remove('error');
                    input.value = '';
                });
                inputs.codeInputs[0].focus();
            }, 500);
            
        } finally {
            // Reabilitar botão
            buttons.verifyCode.disabled = false;
            const btnText = buttons.verifyCode.querySelector('.btn-text');
            btnText.textContent = 'Confirmar código';
        }
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
        const email = inputs.recoveryEmail.value.trim();
        const code = Array.from(inputs.codeInputs).map(input => input.value).join('');
        
        hideError();
        
        if (!newPass || !confirmPass) {
            showError('Por favor, preencha todos os campos');
            return;
        }
        
        if (newPass.length < 6) {
            showError('A senha deve ter no mínimo 6 caracteres');
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

        try {
            // Desabilitar botão e mostrar loading
            buttons.changePassword.disabled = true;
            const btnText = buttons.changePassword.querySelector('.btn-text');
            const originalText = btnText.textContent;
            btnText.textContent = 'Alterando...';

            console.log('🔐 Alterando senha...');

            const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/reset-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    email, 
                    code, 
                    newPassword: newPass 
                })
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Erro ao alterar senha');
            }

            console.log('✅ Senha alterada com sucesso!');
            switchScreen(screens.newPassword, screens.success);

        } catch (error) {
            console.error('❌ Erro ao alterar senha:', error);
            showError(error.message || 'Erro ao alterar senha. Tente novamente.');
            
        } finally {
            // Reabilitar botão
            buttons.changePassword.disabled = false;
            const btnText = buttons.changePassword.querySelector('.btn-text');
            btnText.textContent = 'Alterar senha';
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
        
        switchScreen(screens.success, screens.login);
    });
}

// ===== REENVIAR CÓDIGO =====
if (buttons.resendCode) {
    buttons.resendCode.addEventListener('click', async (e) => {
        e.preventDefault();
        
        const email = inputs.recoveryEmail.value.trim();
        
        if (!email || !email.includes('@')) {
            console.error('Email não encontrado');
            return;
        }

        try {
            // Desabilitar botão temporariamente
            buttons.resendCode.disabled = true;
            const originalText = buttons.resendCode.textContent;
            buttons.resendCode.textContent = 'Enviando...';

            console.log('📧 Reenviando código para:', email);

            const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/send-reset-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email })
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Erro ao reenviar código');
            }

            console.log('✅ Código reenviado com sucesso!');
            
            // Feedback visual de sucesso
            buttons.resendCode.style.color = 'var(--neon-green)';
            buttons.resendCode.textContent = 'Código enviado!';
            
            // Resetar inputs de código
            resetCodeInputs();
            inputs.codeInputs[0].focus();
            
            setTimeout(() => {
                buttons.resendCode.style.color = '';
                buttons.resendCode.textContent = originalText;
            }, 3000);

        } catch (error) {
            console.error('❌ Erro ao reenviar código:', error);
            buttons.resendCode.textContent = 'Erro ao enviar';
            buttons.resendCode.style.color = 'var(--error-red)';
            
            setTimeout(() => {
                buttons.resendCode.style.color = '';
                buttons.resendCode.textContent = 'Reenviar';
            }, 3000);
            
        } finally {
            // Reabilitar botão após 3 segundos
            setTimeout(() => {
                buttons.resendCode.disabled = false;
            }, 3000);
        }
    });
}

// ===== LÓGICA DOS INPUTS DE CÓDIGO =====
inputs.codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
        const value = e.target.value;
        
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
        const pastedData = e.clipboardData.getData('text').slice(0, 6);
        
        pastedData.split('').forEach((char, i) => {
            if (inputs.codeInputs[i] && /[0-9]/.test(char)) {
                inputs.codeInputs[i].value = char;
                inputs.codeInputs[i].classList.add('filled');
            }
        });
        
        const lastFilledIndex = Math.min(pastedData.length - 1, 5);
        inputs.codeInputs[lastFilledIndex].focus();
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

// Adicionar animação de ripple
const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
    @keyframes ripple {
        to {
            transform: scale(2.5);
            opacity: 0;
        }
    }
`;
document.head.appendChild(rippleStyle);

// ===== ATALHOS DE TECLADO =====
document.addEventListener('keydown', (e) => {
    // Enter no email foca na senha
    if (e.key === 'Enter' && document.activeElement === inputs.loginEmail) {
        e.preventDefault();
        inputs.loginPassword.focus();
    }
});

// Enter nos inputs de senha de recuperação
if (inputs.newPassword) {
    inputs.newPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            inputs.confirmPassword.focus();
        }
    });
}

if (inputs.confirmPassword) {
    inputs.confirmPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            buttons.changePassword.click();
        }
    });
}

// Enter no email de recuperação
if (inputs.recoveryEmail) {
    inputs.recoveryEmail.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            buttons.sendCode.click();
        }
    });
}

// ===== EFEITO NOS INPUTS =====
const allInputs = document.querySelectorAll('.form-input');

allInputs.forEach(input => {
    input.addEventListener('focus', () => {
        const wrapper = input.closest('.input-wrapper');
        if (wrapper) {
            wrapper.style.transform = 'scale(1.01)';
        }
    });
    
    input.addEventListener('blur', () => {
        const wrapper = input.closest('.input-wrapper');
        if (wrapper) {
            wrapper.style.transform = 'scale(1)';
        }
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

// ===== SOCIAL LOGIN HANDLERS =====
const socialButtons = document.querySelectorAll('.btn-social');

socialButtons.forEach(button => {
    button.addEventListener('click', () => {
        const provider = button.classList.contains('btn-google') ? 'Google' : 'GitHub';
        console.log(`Login com ${provider} em desenvolvimento`);
        showAuthMessage(`Login com ${provider} em desenvolvimento`, 'error');
    });
});

console.log('🚀 Sistema de recuperação de senha integrado com Resend!');