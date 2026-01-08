import { supabase } from './supabase-client.js';

const PLANS = {
  'Individual': { price: 19.99, max_profiles: 1 },
  'Casal': { price: 29.99, max_profiles: 2 },
  'Família': { price: 49.99, max_profiles: 4 }
};

// Pegar plano da URL
const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');

if (!planName || !PLANS[planName]) {
  alert('Plano não selecionado!');
  window.location.href = 'planos.html';
}

document.getElementById('planName').textContent = planName;
document.getElementById('planPrice').textContent = PLANS[planName].price.toFixed(2);

// ==========================================
// VALIDAÇÃO DE EMAIL
// ==========================================
const emailInput = document.getElementById('userEmail');
const emailError = document.getElementById('emailError');

emailInput.addEventListener('blur', () => {
  const email = emailInput.value.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (email && !emailRegex.test(email)) {
    emailInput.classList.add('error');
    emailError.classList.add('show');
  } else {
    emailInput.classList.remove('error');
    emailError.classList.remove('show');
  }
});

// ==========================================
// VALIDAÇÃO DE SENHA
// ==========================================
const passwordInput = document.getElementById('userPassword');
const passwordConfirmInput = document.getElementById('userPasswordConfirm');
const passwordError = document.getElementById('passwordError');
const passwordConfirmError = document.getElementById('passwordConfirmError');
const strengthBar = document.getElementById('passwordStrengthBar');

function checkPasswordStrength(password) {
  let strength = 0;
  
  if (password.length >= 6) strength++;
  if (password.length >= 8) strength++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++;
  if (/[0-9]/.test(password)) strength++;
  if (/[^a-zA-Z0-9]/.test(password)) strength++;
  
  return strength;
}

passwordInput.addEventListener('input', () => {
  const password = passwordInput.value;
  const strength = checkPasswordStrength(password);
  
  strengthBar.classList.remove('weak', 'medium', 'strong');
  
  if (password.length === 0) {
    strengthBar.style.width = '0%';
  } else if (strength <= 2) {
    strengthBar.classList.add('weak');
  } else if (strength <= 3) {
    strengthBar.classList.add('medium');
  } else {
    strengthBar.classList.add('strong');
  }
  
  if (password.length > 0 && password.length < 6) {
    passwordInput.classList.add('error');
    passwordError.classList.add('show');
  } else {
    passwordInput.classList.remove('error');
    passwordError.classList.remove('show');
  }
});

passwordConfirmInput.addEventListener('blur', () => {
  const password = passwordInput.value;
  const confirm = passwordConfirmInput.value;
  
  if (confirm && password !== confirm) {
    passwordConfirmInput.classList.add('error');
    passwordConfirmError.classList.add('show');
  } else {
    passwordConfirmInput.classList.remove('error');
    passwordConfirmError.classList.remove('show');
  }
});

// ==========================================
// ENVIAR FORMULÁRIO
// ==========================================
const form = document.getElementById('form-checkout');
const loadingOverlay = document.getElementById('loadingOverlay');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const email = document.getElementById('userEmail').value.trim();
  const name = document.getElementById('userName').value.trim();
  const password = document.getElementById('userPassword').value;
  const passwordConfirm = document.getElementById('userPasswordConfirm').value;
  
  // Validações
  if (!email || !name || !password || !passwordConfirm) {
    alert('Preencha todos os campos obrigatórios');
    return;
  }
  
  if (password.length < 6) {
    alert('A senha deve ter no mínimo 6 caracteres');
    passwordInput.focus();
    return;
  }
  
  if (password !== passwordConfirm) {
    alert('As senhas não coincidem');
    passwordConfirmInput.focus();
    return;
  }
  
  loadingOverlay.classList.add('active');
  
  try {
    console.log('📤 Criando checkout no Stripe...');
    
    // Chamar Edge Function para criar Stripe Checkout
    const response = await fetch('https://fvrhqqeofqedmhadzzqw.supabase.co/functions/v1/create-stripe-checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo'
      },
      body: JSON.stringify({
        email,
        name,
        password,
        planName
      })
    });

    const data = await response.json();
    console.log('📦 Resposta:', data);

    if (!response.ok) {
      throw new Error(data.error || 'Erro desconhecido');
    }
    
    loadingOverlay.classList.remove('active');
    
    // Redirecionar para o Stripe Checkout
    console.log('✅ Redirecionando para Stripe Checkout...');
    window.location.href = data.checkoutUrl;
    
  } catch (error) {
    loadingOverlay.classList.remove('active');
    console.error('❌ Erro:', error);
    alert('Erro ao processar pagamento: ' + error.message);
  }
});

console.log('✅ Checkout carregado - Stripe');