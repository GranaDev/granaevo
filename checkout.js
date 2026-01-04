import { supabase } from './supabase-client.js';

// ⚠️ SUBSTITUA pela sua Public Key REAL do Mercado Pago
const MERCADO_PAGO_PUBLIC_KEY = 'APP_USR-757bf3df-9b23-4b20-b6d4-a2f4d0062345';

const mp = new MercadoPago(MERCADO_PAGO_PUBLIC_KEY, {
    locale: 'pt-BR'
});

const PLANS = {
    'Individual': { price: 19.99, max_profiles: 1 },
    'Casal': { price: 29.99, max_profiles: 2 },
    'Família': { price: 49.99, max_profiles: 4 }
};

const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');

if (!planName || !PLANS[planName]) {
    alert('Plano não selecionado!');
    window.location.href = 'planos.html';
}

document.getElementById('planName').textContent = planName;
document.getElementById('planPrice').textContent = PLANS[planName].price.toFixed(2);

// Estado do pagamento
let selectedPaymentMethod = 'credit_card';

// Adicionar seletor de método de pagamento
function setupPaymentMethodSelector() {
    const planInfo = document.querySelector('.plan-info');
    const methodSelector = document.createElement('div');
    methodSelector.className = 'payment-method-selector';
    methodSelector.innerHTML = `
        <div style="display: flex; gap: 10px; margin-top: 20px;">
            <button type="button" class="payment-method-btn active" data-method="credit_card">
                💳 Cartão de Crédito
            </button>
            <button type="button" class="payment-method-btn" data-method="pix">
                📱 PIX
            </button>
        </div>
    `;
    
    planInfo.after(methodSelector);
    
    // Event listeners
    document.querySelectorAll('.payment-method-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.payment-method-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            selectedPaymentMethod = this.dataset.method;
            togglePaymentForm();
        });
    });
}

// Alternar formulário baseado no método
function togglePaymentForm() {
    const cardFields = document.querySelectorAll('.card-field');
    
    if (selectedPaymentMethod === 'pix') {
        // Ocultar campos de cartão e remover required
        cardFields.forEach(field => {
            field.style.display = 'none';
            const inputs = field.querySelectorAll('input');
            inputs.forEach(input => input.removeAttribute('required'));
        });
        document.getElementById('submitButton').textContent = 'Gerar QR Code PIX';
    } else {
        // Mostrar campos de cartão e adicionar required
        cardFields.forEach(field => {
            field.style.display = 'block';
            const inputs = field.querySelectorAll('input');
            inputs.forEach(input => input.setAttribute('required', 'required'));
        });
        document.getElementById('submitButton').textContent = 'Finalizar Pagamento';
    }
}

// Adicionar classe aos campos de cartão
document.querySelectorAll('#cardNumber, #cardholderName, #cardExpirationMonth, #securityCode').forEach(field => {
    field.closest('.form-group').classList.add('card-field');
});

// Adicionar classe à linha com dois campos
const formRows = document.querySelectorAll('.form-row');
formRows.forEach(row => {
    const hasCardField = row.querySelector('#cardExpirationMonth, #securityCode');
    if (hasCardField) {
        row.classList.add('card-field');
    }
});

setupPaymentMethodSelector();

// ==========================================
// MÁSCARAS E VALIDAÇÕES
// ==========================================

const cardNumberInput = document.getElementById('cardNumber');
cardNumberInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\s/g, '');
    let formattedValue = value.match(/.{1,4}/g)?.join(' ') || value;
    e.target.value = formattedValue;
});

const expirationInput = document.getElementById('cardExpirationMonth');
expirationInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length >= 2) {
        value = value.slice(0, 2) + '/' + value.slice(2, 4);
    }
    e.target.value = value;
});

const identificationInput = document.getElementById('identificationNumber');
const identificationTypeSelect = document.getElementById('identificationType');

identificationTypeSelect.addEventListener('change', () => {
    identificationInput.value = '';
});

identificationInput.addEventListener('input', (e) => {
    const type = identificationTypeSelect.value;
    let value = e.target.value.replace(/\D/g, '');
    
    if (type === 'CPF' && value.length <= 11) {
        value = value.replace(/(\d{3})(\d)/, '$1.$2');
        value = value.replace(/(\d{3})(\d)/, '$1.$2');
        value = value.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    } else if (type === 'CNPJ' && value.length <= 14) {
        value = value.replace(/^(\d{2})(\d)/, '$1.$2');
        value = value.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
        value = value.replace(/\.(\d{3})(\d)/, '.$1/$2');
        value = value.replace(/(\d{4})(\d)/, '$1-$2');
    }
    
    e.target.value = value;
});

// Identificar bandeira do cartão (apenas se for cartão)
cardNumberInput.addEventListener('input', async (e) => {
    if (selectedPaymentMethod !== 'credit_card') return;
    
    const cardNumber = e.target.value.replace(/\s/g, '');
    
    if (cardNumber.length >= 6) {
        try {
            const paymentMethods = await mp.getPaymentMethods({ bin: cardNumber.slice(0, 6) });
            
            if (paymentMethods.results.length > 0) {
                const paymentMethod = paymentMethods.results[0];
                document.getElementById('paymentMethodId').value = paymentMethod.id;
                
                if (paymentMethod.id) {
                    const issuers = await mp.getIssuers({ 
                        paymentMethodId: paymentMethod.id, 
                        bin: cardNumber.slice(0, 6) 
                    });
                    if (issuers.length > 0) {
                        document.getElementById('issuer').value = issuers[0].id;
                    }
                }
            }
        } catch (error) {
            console.error('Erro ao identificar cartão:', error);
        }
    }
});

// ==========================================
// PROCESSAR PAGAMENTO
// ==========================================

const form = document.getElementById('form-checkout');
const submitButton = document.getElementById('submitButton');

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (selectedPaymentMethod === 'pix') {
        await processPixPayment();
    } else {
        await processCreditCardPayment();
    }
});

// Processar PIX
async function processPixPayment() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorMessage = document.getElementById('errorMessage');
    
    try {
        const userEmail = document.getElementById('userEmail').value.trim();
        const userName = document.getElementById('userName').value.trim();
        const identificationType = document.getElementById('identificationType').value;
        const identificationNumber = document.getElementById('identificationNumber').value.replace(/\D/g, '');
        
        // Validações
        if (!userEmail || !userName) {
            showError('Por favor, preencha seu email e nome completo.');
            return;
        }
        
        if (!userEmail.includes('@')) {
            showError('Email inválido.');
            return;
        }
        
        if (!identificationType) {
            showError('Selecione o tipo de documento.');
            return;
        }
        
        if (identificationType === 'CPF' && identificationNumber.length !== 11) {
            showError('CPF inválido.');
            return;
        }
        
        if (identificationType === 'CNPJ' && identificationNumber.length !== 14) {
            showError('CNPJ inválido.');
            return;
        }
        
        submitButton.disabled = true;
        loadingOverlay.classList.add('active');
        errorMessage.classList.remove('show');
        
        console.log('📱 Processando pagamento PIX...');
        
        // Buscar plano
        const { data: plan, error: planError } = await supabase
            .from('plans')
            .select('id')
            .eq('name', planName)
            .single();
        
        if (planError) throw new Error('Erro ao buscar plano');
        
        // Processar pagamento PIX
        const { data, error } = await supabase.functions.invoke('process-payment', {
            body: {
                email: userEmail,
                name: userName,
                plan_id: plan.id,
                plan_name: planName,
                payment_method: 'pix',
                payment_data: {
                    transaction_amount: PLANS[planName].price,
                    description: `GranaEvo - Plano ${planName}`,
                    payer: {
                        email: userEmail,
                        identification: {
                            type: identificationType,
                            number: identificationNumber
                        }
                    }
                }
            }
        });
        
        if (error) throw error;
        
        console.log('✅ Resposta PIX:', data);
        
        // Mostrar QR Code do PIX
        if (data.pix) {
            showPixQRCode(data.pix);
        } else {
            showError('Erro ao gerar PIX. Tente novamente.');
        }
        
    } catch (error) {
        console.error('❌ Erro ao processar PIX:', error);
        showError(error.message || 'Erro ao processar pagamento PIX.');
    } finally {
        loadingOverlay.classList.remove('active');
        submitButton.disabled = false;
    }
}

// Processar Cartão de Crédito
async function processCreditCardPayment() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorMessage = document.getElementById('errorMessage');
    
    try {
        const userEmail = document.getElementById('userEmail').value.trim();
        const userName = document.getElementById('userName').value.trim();
        const cardNumber = document.getElementById('cardNumber').value.replace(/\s/g, '');
        const cardholderName = document.getElementById('cardholderName').value.trim();
        const expiration = document.getElementById('cardExpirationMonth').value;
        const securityCode = document.getElementById('securityCode').value;
        const identificationType = document.getElementById('identificationType').value;
        const identificationNumber = document.getElementById('identificationNumber').value.replace(/\D/g, '');
        const paymentMethodId = document.getElementById('paymentMethodId').value;
        const issuerId = document.getElementById('issuer').value;
        
        // Validações
        if (!userEmail || !userName) {
            showError('Por favor, preencha seu email e nome completo.');
            return;
        }
        
        if (!userEmail.includes('@')) {
            showError('Email inválido.');
            return;
        }
        
        if (cardNumber.length < 13) {
            showError('Número do cartão inválido.');
            return;
        }
        
        if (!expiration.includes('/') || expiration.length !== 5) {
            showError('Data de validade inválida. Use MM/AA');
            return;
        }
        
        if (securityCode.length < 3) {
            showError('CVV inválido.');
            return;
        }
        
        if (!identificationType) {
            showError('Selecione o tipo de documento.');
            return;
        }
        
        if (identificationType === 'CPF' && identificationNumber.length !== 11) {
            showError('CPF inválido.');
            return;
        }
        
        if (identificationType === 'CNPJ' && identificationNumber.length !== 14) {
            showError('CNPJ inválido.');
            return;
        }
        
        submitButton.disabled = true;
        loadingOverlay.classList.add('active');
        errorMessage.classList.remove('show');
        
        console.log('💳 Criando token do cartão...');
        
        const [month, year] = expiration.split('/');
        
        // Criar token
        const token = await mp.createCardToken({
            cardNumber: cardNumber,
            cardholderName: cardholderName,
            cardExpirationMonth: month,
            cardExpirationYear: '20' + year,
            securityCode: securityCode,
            identificationType: identificationType,
            identificationNumber: identificationNumber
        });
        
        console.log('✅ Token criado:', token.id);
        
        // Buscar plano
        const { data: plan, error: planError } = await supabase
            .from('plans')
            .select('id')
            .eq('name', planName)
            .single();
        
        if (planError) throw new Error('Erro ao buscar plano');
        
        console.log('📤 Enviando pagamento...');
        
        // Processar pagamento
        const { data, error } = await supabase.functions.invoke('process-payment', {
            body: {
                email: userEmail,
                name: userName,
                plan_id: plan.id,
                plan_name: planName,
                payment_method: 'credit_card',
                payment_data: {
                    token: token.id,
                    payment_method_id: paymentMethodId || 'visa',
                    issuer_id: issuerId,
                    payer: {
                        email: userEmail,
                        identification: {
                            type: identificationType,
                            number: identificationNumber
                        }
                    },
                    transaction_amount: PLANS[planName].price,
                    installments: 1,
                    description: `GranaEvo - Plano ${planName}`
                }
            }
        });
        
        if (error) {
            console.error('❌ Erro da função:', error);
            throw error;
        }
        
        console.log('✅ Resposta do pagamento:', data);
        
        if (data.status === 'approved') {
            alert('🎉 Pagamento aprovado! Bem-vindo ao GranaEvo!\n\nVocê receberá um email com suas credenciais de acesso em instantes.');
            window.location.href = 'login.html';
        } else if (data.status === 'in_process' || data.status === 'pending') {
            alert('⏳ Pagamento em análise.\n\nVocê receberá um email assim que for aprovado.');
            window.location.href = 'planos.html';
        } else {
            showError('Pagamento recusado. Verifique os dados do cartão e tente novamente.');
        }
        
    } catch (error) {
        console.error('❌ Erro ao processar pagamento:', error);
        showError(error.message || 'Erro ao processar pagamento. Tente novamente.');
    } finally {
        loadingOverlay.classList.remove('active');
        submitButton.disabled = false;
    }
}

// Mostrar QR Code do PIX
function showPixQRCode(pixData) {
    const container = document.querySelector('.checkout-container');
    
    const pixModal = document.createElement('div');
    pixModal.className = 'pix-modal';
    pixModal.innerHTML = `
        <div class="pix-modal-content">
            <h2 style="color: #10b981; text-align: center;">📱 Pague com PIX</h2>
            <p style="color: rgba(255,255,255,0.7); text-align: center; margin-bottom: 30px;">
                Escaneie o QR Code abaixo ou copie o código PIX
            </p>
            
            <div style="background: white; padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 20px;">
                <img src="data:image/png;base64,${pixData.qr_code_base64}" 
                     alt="QR Code PIX" 
                     style="max-width: 100%; height: auto;">
            </div>
            
            <div style="background: rgba(16, 185, 129, 0.1); padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                <p style="color: rgba(255,255,255,0.6); font-size: 12px; margin-bottom: 5px;">Código PIX:</p>
                <p id="pixCode" style="color: #fff; word-break: break-all; font-size: 12px; margin: 0;">
                    ${pixData.qr_code}
                </p>
            </div>
            
            <button onclick="copyPixCode('${pixData.qr_code}')" class="submit-button" style="margin-top: 10px;">
                📋 Copiar Código PIX
            </button>
            
            <p style="color: rgba(255,255,255,0.5); font-size: 14px; text-align: center; margin-top: 20px;">
                ⏱️ Assim que o pagamento for confirmado, você receberá um email com suas credenciais de acesso.
            </p>
            
            <a href="planos.html" style="color: #10b981; text-align: center; display: block; margin-top: 20px; text-decoration: none;">
                ← Voltar para planos
            </a>
        </div>
    `;
    
    container.innerHTML = '';
    container.appendChild(pixModal);
}

// Copiar código PIX
window.copyPixCode = function(code) {
    navigator.clipboard.writeText(code).then(() => {
        alert('✅ Código PIX copiado!');
    });
}

function showError(message) {
    const errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;
    errorMessage.classList.add('show');
    
    setTimeout(() => {
        errorMessage.classList.remove('show');
    }, 5000);
}

console.log('✅ Checkout carregado com sucesso');
console.log('📦 Plano selecionado:', planName);
console.log('💰 Valor:', PLANS[planName].price);