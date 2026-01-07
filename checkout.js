import { supabase } from './supabase-client.js';

// Inicializar MercadoPago
const mp = new MercadoPago('APP_USR-474597c2-5121-4b24-8dfe-922d32e49233', {
  locale: 'pt-BR'
});

const PLANS = {
  'Individual': { price: 19.99, max_profiles: 1 },
  'Casal': { price: 29.99, max_profiles: 2 },
  'Família': { price: 49.99, max_profiles: 4 }
};

// Variáveis globais
let currentPaymentId = null;
let currentUserEmail = null;
let currentPixCode = null;

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
// ALTERNAR MÉTODOS DE PAGAMENTO
// ==========================================
const paymentMethods = document.querySelectorAll('.payment-method');
const creditCardFields = document.getElementById('creditCardFields');
let selectedMethod = 'pix';

paymentMethods.forEach(method => {
  method.addEventListener('click', () => {
    paymentMethods.forEach(m => m.classList.remove('active'));
    method.classList.add('active');
    selectedMethod = method.dataset.method;
    
    if (selectedMethod === 'credit_card') {
      creditCardFields.classList.add('active');
    } else {
      creditCardFields.classList.remove('active');
    }
  });
});

// ==========================================
// FORMATAÇÃO DOS CAMPOS DE CARTÃO
// ==========================================
document.getElementById('cardNumber')?.addEventListener('input', (e) => {
  let value = e.target.value.replace(/\s/g, '');
  let formatted = value.match(/.{1,4}/g)?.join(' ') || value;
  e.target.value = formatted;
});

document.getElementById('cardExpiry')?.addEventListener('input', (e) => {
  let value = e.target.value.replace(/\D/g, '');
  if (value.length >= 2) {
    value = value.slice(0, 2) + '/' + value.slice(2, 4);
  }
  e.target.value = value;
});

document.getElementById('cardCvv')?.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '');
});

// ==========================================
// COPIAR CÓDIGO PIX
// ==========================================
window.copyPixCode = function() {
  const pixCode = document.getElementById('pixCode').textContent;
  const copyButton = document.querySelector('.copy-button');
  const copyIcon = document.getElementById('copyIcon');
  const copyText = document.getElementById('copyText');
  
  navigator.clipboard.writeText(pixCode).then(() => {
    copyButton.classList.add('copied');
    copyIcon.textContent = '✅';
    copyText.textContent = 'Código copiado!';
    
    setTimeout(() => {
      copyButton.classList.remove('copied');
      copyIcon.textContent = '📋';
      copyText.textContent = 'Copiar código PIX';
    }, 3000);
  }).catch(err => {
    console.error('Erro ao copiar:', err);
    alert('Erro ao copiar código. Tente copiar manualmente.');
  });
};

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
  
  currentUserEmail = email;
  loadingOverlay.classList.add('active');
  
  try {
    let cardToken = null;
    
    // Se for cartão, criar token
    if (selectedMethod === 'credit_card') {
      const cardNumber = document.getElementById('cardNumber').value.replace(/\s/g, '');
      const cardExpiry = document.getElementById('cardExpiry').value;
      const cardCvv = document.getElementById('cardCvv').value;
      const cardholderName = document.getElementById('cardholderName').value;
      
      if (!cardNumber || !cardExpiry || !cardCvv || !cardholderName) {
        alert('Preencha todos os dados do cartão');
        loadingOverlay.classList.remove('active');
        return;
      }
      
      const [month, year] = cardExpiry.split('/');
      
      console.log('🔐 Criando token do cartão...');
      
      const tokenResponse = await mp.fields.createCardToken({
        cardNumber: cardNumber,
        cardholderName: cardholderName,
        cardExpirationMonth: month,
        cardExpirationYear: '20' + year,
        securityCode: cardCvv,
        identificationType: 'CPF',
        identificationNumber: '00000000000'
      });
      
      if (tokenResponse.error) {
        throw new Error('Erro ao processar cartão');
      }
      
      cardToken = tokenResponse.id;
      console.log('✅ Token criado:', cardToken);
    }
    
    console.log('📤 Enviando dados:', { email, name, planName, paymentMethod: selectedMethod });
    
    // Gerar ID único para esta transação
    const idempotencyKey = `${email}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log('🔑 Idempotency Key:', idempotencyKey);
    
    // Chamar Edge Function
    const response = await fetch('https://fvrhqqeofqedmhadzzqw.supabase.co/functions/v1/process-mercadopago-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        email,
        name,
        password, // A Edge Function irá fazer o hash
        planName,
        paymentMethod: selectedMethod,
        cardToken
      })
    });

    const responseText = await response.text();
    console.log('📦 Resposta RAW:', responseText);

    let data;
    try {
      data = JSON.parse(responseText);
      console.log('📦 Resposta JSON:', data);
    } catch (e) {
      console.error('❌ Erro ao fazer parse:', e);
      throw new Error('Resposta inválida do servidor: ' + responseText);
    }

    if (!response.ok) {
      console.error('❌ Erro do servidor:', data);
      throw new Error(data.error || 'Erro desconhecido');
    }
    
    loadingOverlay.classList.remove('active');
    
    // Se for PIX, mostrar QR Code
    if (data.paymentMethod === 'pix') {
      currentPaymentId = data.paymentId;
      currentPixCode = data.pixCode;
      
      document.getElementById('pixQrcodeImg').src = `data:image/png;base64,${data.qrCodeBase64}`;
      document.getElementById('pixCode').textContent = data.pixCode;
      document.getElementById('pixQrcode').classList.add('active');
      form.style.display = 'none';
    } else {
      // Se for cartão aprovado
      alert('✅ Pagamento aprovado! Você já pode fazer login no aplicativo.');
      window.location.href = 'login.html';
    }
    
  } catch (error) {
    loadingOverlay.classList.remove('active');
    console.error('❌ Erro completo:', error);
    alert('Erro ao processar pagamento: ' + error.message);
  }
});

// ==========================================
// VERIFICAR PAGAMENTO PIX
// ==========================================
window.verificarPagamentoPix = async function() {
  if (!currentPaymentId) {
    alert('Erro: ID do pagamento não encontrado');
    return;
  }

  const loadingText = document.querySelector('.loading-text');
  loadingOverlay.classList.add('active');
  loadingText.textContent = 'Verificando pagamento...';

  try {
    console.log('🔍 Verificando pagamento:', currentPaymentId);

    const response = await fetch('https://fvrhqqeofqedmhadzzqw.supabase.co/functions/v1/verify-pix-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo'
      },
      body: JSON.stringify({
        paymentId: currentPaymentId,
        email: currentUserEmail
      })
    });

    const data = await response.json();
    console.log('📦 Status do pagamento:', data);

    loadingOverlay.classList.remove('active');

    if (data.paid) {
      alert('✅ Pagamento confirmado! Redirecionando para o login...');
      window.location.href = 'login.html';
    } else {
      alert(`⏳ Pagamento ainda não detectado.\n\nStatus: ${data.statusMessage}\n\nPor favor, aguarde alguns instantes após efetuar o pagamento e tente novamente.`);
    }

  } catch (error) {
    loadingOverlay.classList.remove('active');
    console.error('❌ Erro ao verificar pagamento:', error);
    alert('Erro ao verificar pagamento. Tente novamente em alguns instantes.');
  }
};

console.log('✅ Checkout carregado com validações');