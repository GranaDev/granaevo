// cadastro.js
import { supabase } from './supabase-client.js';

const form = document.getElementById('cadastroForm');
const nomeInput = document.getElementById('cadastroNome');
const emailInput = document.getElementById('cadastroEmail');
const senhaInput = document.getElementById('cadastroSenha');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const nome = nomeInput.value.trim();
    const email = emailInput.value.trim();
    const senha = senhaInput.value;
    
    if (!nome || !email || !senha) {
        showMessage('Preencha todos os campos', 'error');
        return;
    }
    
    if (senha.length < 6) {
        showMessage('A senha deve ter no mínimo 6 caracteres', 'error');
        return;
    }
    
    try {
        // Criar conta no Supabase
        const { data, error } = await supabase.auth.signUp({
            email: email,
            password: senha,
            options: {
                data: {
                    name: nome
                }
            }
        });
        
        if (error) throw error;
        
        showMessage('Conta criada com sucesso! Redirecionando...', 'success');
        
        // Redirecionar para checkout com o plano selecionado
        const planoSelecionado = localStorage.getItem('plano_selecionado') || 'Individual';
        
        setTimeout(() => {
            window.location.href = `checkout.html?plan=${planoSelecionado}`;
        }, 2000);
        
    } catch (error) {
        if (error.message.includes('already registered')) {
            showMessage('Este email já está cadastrado. Faça login!', 'error');
        } else {
            showMessage('Erro ao criar conta. Tente novamente.', 'error');
        }
        console.error(error);
    }
});

function showMessage(message, type) {
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