// ========================================
// CONFIGURAÇÃO
// ========================================
const PLANS = {
  'Individual': { price: 19.99, max_profiles: 1 },
  'Casal': { price: 29.99, max_profiles: 2 },
  'Família': { price: 49.99, max_profiles: 4 }
};

const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

let currentUserId = null;

// ========================================
// INICIALIZAÇÃO
// ========================================

const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');

if (!planName || !PLANS[planName]) {
  alert('Plano não selecionado!');
  window.location.href = 'planos.html';
}

document.getElementById('planName').textContent = planName;
document.getElementById('planPrice').textContent = PLANS[planName].price.toFixed(2);

// Remover seleção de método de pagamento (não é mais necessário)
const paymentMethodsSection = document.querySelector('.payment-methods');
if (paymentMethodsSection) {
  paymentMethodsSection.closest('.form-group').style.display = 'none';
}

const creditCardFields = document.getElementById('creditCardFields');
if (creditCardFields) {
  creditCardFields.style.display = 'none';
}

// ========================================
// FORMATAÇÃO DOS CAMPOS
// ========================================

const cpfInput = document.getElementById('userCPF');
if (cpfInput) {
  cpfInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length <= 11) {
      value = value.replace(/(\d{3})(\d)/, '$1.$2');
      value = value.replace(/(\d{3})(\d)/, '$1.$2');
      value = value.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    }
    e.target.value = value;
  });
}

// ========================================
// ENVIAR FORMULÁRIO
// ========================================
const form = document.getElementById('form-checkout');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.querySelector('.loading-text');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const email = document.getElementById('userEmail').value.trim();
  const password = document.getElementById('userPassword').value.trim();
  const confirmPassword = document.getElementById('confirmPassword').value.trim();
  const nomeCompleto = document.getElementById('userName').value.trim();
  const cpf = document.getElementById('userCPF').value.trim();
  
  // Validações
  if (!email || !password || !confirmPassword || !nomeCompleto || !cpf) {
    alert('❌ Preencha todos os campos!');
    return;
  }
  
  if (password !== confirmPassword) {
    alert('❌ As senhas não coincidem!');
    return;
  }
  
  if (password.length < 6) {
    alert('❌ A senha deve ter no mínimo 6 caracteres');
    return;
  }
  
  if (nomeCompleto.length < 3) {
    alert('❌ Digite seu nome completo (mínimo 3 caracteres)');
    return;
  }
  
  const cpfLimpo = cpf.replace(/\D/g, '');
  if (cpfLimpo.length !== 11) {
    alert('❌ CPF inválido! Digite os 11 dígitos.');
    return;
  }
  
  loadingOverlay.classList.add('active');
  loadingText.textContent = 'Criando sua conta...';
  
  try {
    console.log('📤 Enviando dados:', { email, nomeCompleto, planName });
    
    // ✅ Chamar Edge Function
    const response = await fetch(`${SUPABASE_URL}/functions/v1/process-cakto-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({
        email,
        password,
        userName: nomeCompleto,
        planName,
        cpf: cpfLimpo
      })
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const textResponse = await response.text();
      console.error('❌ Resposta não é JSON:', textResponse);
      throw new Error('Erro no servidor. A função pode não estar deployada corretamente.');
    }

    const data = await response.json();
    console.log('📦 Resposta:', data);

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Erro desconhecido');
    }
    
    currentUserId = data.userId;
    loadingOverlay.classList.remove('active');
    
    // ✅ Mostrar modal com checkout da Cakto
    mostrarCheckoutCakto(data.checkoutUrl);
    
  } catch (error) {
    loadingOverlay.classList.remove('active');
    console.error('❌ Erro:', error);
    alert('Erro ao processar: ' + error.message);
  }
});

// ========================================
// MODAL DE CHECKOUT CAKTO
// ========================================
function mostrarCheckoutCakto(checkoutUrl) {
  // Esconder formulário
  form.style.display = 'none';
  
  // Criar modal
  const modalHTML = `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.95);
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    " id="caktoModal">
      <div style="
        background: white;
        border-radius: 12px;
        width: 100%;
        max-width: 600px;
        height: 80vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      ">
        <div style="
          padding: 20px;
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <h2 style="margin: 0; font-size: 18px;">💳 Finalizar Pagamento</h2>
          <button onclick="fecharCheckout()" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 20px;
            line-height: 1;
          ">×</button>
        </div>
        
        <iframe 
          src="${checkoutUrl}" 
          style="
            flex: 1;
            border: none;
            width: 100%;
          "
          id="caktoIframe"
        ></iframe>
        
        <div style="
          padding: 15px;
          background: #f3f4f6;
          text-align: center;
          color: #6b7280;
          font-size: 13px;
        ">
          ✅ Após o pagamento, você será redirecionado automaticamente
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Verificar status do pagamento periodicamente
  iniciarVerificacaoPagamento();
}

window.fecharCheckout = function() {
  const modal = document.getElementById('caktoModal');
  if (modal) {
    if (confirm('⚠️ Tem certeza? Seu pagamento ainda não foi confirmado.')) {
      modal.remove();
      form.style.display = 'block';
    }
  }
}

// ========================================
// VERIFICAR PAGAMENTO
// ========================================
let verificacaoInterval = null;

function iniciarVerificacaoPagamento() {
  console.log('🔄 Iniciando verificação de pagamento...');
  
  // Verificar a cada 3 segundos
  verificacaoInterval = setInterval(async () => {
    if (!currentUserId) return;
    
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/verify-cakto-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          userId: currentUserId
        })
      });

      const data = await response.json();
      
      if (data.paid) {
        clearInterval(verificacaoInterval);
        
        const modal = document.getElementById('caktoModal');
        if (modal) modal.remove();
        
        loadingOverlay.classList.add('active');
        loadingText.textContent = '✅ Pagamento confirmado!';
        
        setTimeout(() => {
          alert('✅ Pagamento confirmado! Redirecionando para o login...');
          window.location.href = 'login.html';
        }, 1500);
      }
      
    } catch (error) {
      console.error('❌ Erro ao verificar pagamento:', error);
    }
  }, 3000); // Verificar a cada 3 segundos
}

// Limpar interval quando sair da página
window.addEventListener('beforeunload', () => {
  if (verificacaoInterval) {
    clearInterval(verificacaoInterval);
  }
});