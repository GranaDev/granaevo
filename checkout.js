import { supabase } from './supabase-client.js';

// ⚠️ IMPORTANTE: Sua Public Key do Mercado Pago
const MERCADO_PAGO_PUBLIC_KEY = 'APP_USR-757bf3df-9b23-4b20-b6d4-a2f4d0062345';

const mp = new MercadoPago(MERCADO_PAGO_PUBLIC_KEY, {
    locale: 'pt-BR'
});

// Dados dos planos
const PLANS = {
    'Individual': { price: 19.99, max_profiles: 1 },
    'Casal': { price: 29.99, max_profiles: 2 },
    'Família': { price: 49.99, max_profiles: 4 }
};

// Pegar plano selecionado da URL
const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');

if (!planName || !PLANS[planName]) {
    alert('Plano não selecionado!');
    window.location.href = 'planos.html';
}

// Exibir informações do plano
document.getElementById('planName').textContent = planName;
document.getElementById('planPrice').textContent = PLANS[planName].price.toFixed(2);

// ==========================================
// MÁSCARAS E VALIDAÇÕES
// ==========================================

// Máscara do cartão
const cardNumberInput = document.getElementById('cardNumber');
cardNumberInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\s/g, '');
    let formattedValue = value.match(/.{1,4}/g)?.join(' ') || value;
    e.target.value = formattedValue;
});

// Máscara da validade
const expirationInput = document.getElementById('cardExpirationMonth');
expirationInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length >= 2) {
        value = value.slice(0, 2) + '/' + value.slice(2, 4);
    }
    e.target.value = value;
});

// Máscara do CPF/CNPJ
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

// Identificar bandeira do cartão
cardNumberInput.addEventListener('input', async (e) => {
    const cardNumber = e.target.value.replace(/\s/g, '');
    
    if (cardNumber.length >= 6) {
        try {
            const paymentMethods = await mp.getPaymentMethods({ bin: cardNumber.slice(0, 6) });
            
            if (paymentMethods.results.length > 0) {
                const paymentMethod = paymentMethods.results[0];
                document.getElementById('paymentMethodId').value = paymentMethod.id;
                
                // Buscar emissor
                if (paymentMethod.id) {
                    const issuers = await mp.getIssuers({ paymentMethodId: paymentMethod.id, bin: cardNumber.slice(0, 6) });
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
    await processPayment();
});

async function processPayment() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorMessage = document.getElementById('errorMessage');
    
    try {
        // Validar campos
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
        
        // Separar mês e ano
        const [month, year] = expiration.split('/');
        
        // Criar token do cartão
        const token = await mp.createCardToken({
            cardNumber: cardNumber,
            cardholderName: cardholderName,
            cardExpirationMonth: month,
            cardExpirationYear: '20' + year,
            securityCode: securityCode,
            identificationType: identificationType,
            identificationNumber: identificationNumber
        });
        
        console.log('Token criado:', token.id);
        
        // Buscar ID do plano no Supabase
        const { data: plan, error: planError } = await supabase
            .from('plans')
            .select('id')
            .eq('name', planName)
            .single();
        
        if (planError) {
            throw new Error('Erro ao buscar plano');
        }
        
        // Enviar para o backend (Supabase Function)
        const { data, error } = await supabase.functions.invoke('process-payment', {
            body: {
                email: userEmail,
                name: userName,
                plan_id: plan.id,
                plan_name: planName,
                payment_data: {
                    token: token.id,
                    payment_method_id: paymentMethodId || 'master',
                    issuer_id: issuerId,
                    payer: {
                        email: userEmail,
                        identification: {
                            type: identificationType,
                            number: identificationNumber,
                        },
                    },
                    transaction_amount: PLANS[planName].price,
                    installments: 1,
                    description: `GranaEvo - Plano ${planName}`,
                }
            }
        });
        
        if (error) {
            console.error('Erro da função:', error);
            throw error;
        }
        
        console.log('Resposta do pagamento:', data);
        
        // Verificar status do pagamento
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
        console.error('Erro ao processar pagamento:', error);
        showError(error.message || 'Erro ao processar pagamento. Tente novamente.');
    } finally {
        loadingOverlay.classList.remove('active');
        submitButton.disabled = false;
    }
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