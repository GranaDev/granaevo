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

// Variável global para armazenar o paymentId
let currentPaymentId = null;
let currentUserEmail = null;

// Pegar plano da URL
const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');

if (!planName || !PLANS[planName]) {
  alert('Plano não selecionado!');
  window.location.href = 'planos.html';
}

document.getElementById('planName').textContent = planName;
document.getElementById('planPrice').textContent = PLANS[planName].price.toFixed(2);

// Alternar métodos de pagamento
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

// Formatação dos campos
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

// Enviar formulário
const form = document.getElementById('form-checkout');
const loadingOverlay = document.getElementById('loadingOverlay');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const email = document.getElementById('userEmail').value.trim();
  const name = document.getElementById('userName').value.trim();
  
  if (!email || !name) {
    alert('Preencha todos os campos');
    return;
  }
  
  currentUserEmail = email; // Guardar email
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
    
    // Gerar um ID único para esta transação
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
      currentPaymentId = data.paymentId; // GUARDAR payment ID
      document.getElementById('pixQrcodeImg').src = `data:image/png;base64,${data.qrCodeBase64}`;
      document.getElementById('pixQrcode').classList.add('active');
      form.style.display = 'none';
    } else {
      // Se for cartão aprovado
      alert('✅ Pagamento aprovado! Verifique seu email para as credenciais de acesso.');
      window.location.href = 'login.html';
    }
    
  } catch (error) {
    loadingOverlay.classList.remove('active');
    console.error('❌ Erro completo:', error);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error message:', error.message);
    alert('Erro ao processar pagamento: ' + error.message);
  }
});

// FUNÇÃO PARA VERIFICAR PAGAMENTO PIX
async function verificarPagamentoPix() {
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
}

// Expor função globalmente para o botão HTML
window.verificarPagamentoPix = verificarPagamentoPix;

console.log('✅ Checkout carregado');