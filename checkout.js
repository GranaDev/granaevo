import { supabase } from './supabase-client.js';

// Inicializar MercadoPago
const mp = new MercadoPago('APP_USR-757bf3df-9b23-4b20-b6d4-a2f4d0062345', {
  locale: 'pt-BR'
});

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
    }
    
    // Chamar Edge Function
    const { data, error } = await supabase.functions.invoke('process-mercadopago-payment', {
      body: {
        email,
        name,
        planName,
        paymentMethod: selectedMethod,
        cardToken
      }
    });
    
    if (error) throw error;
    
    loadingOverlay.classList.remove('active');
    
    // Se for PIX, mostrar QR Code
    if (data.paymentMethod === 'pix') {
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
    console.error('❌ Erro:', error);
    alert('Erro ao processar pagamento. Tente novamente.');
  }
});

console.log('✅ Checkout carregado');