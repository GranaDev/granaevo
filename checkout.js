import { supabase } from './supabase-client.js';

// ⚠️ IMPORTANTE: Cole sua Public Key do Mercado Pago aqui
const MERCADO_PAGO_PUBLIC_KEY = 'APP_USR-COLE_SUA_PUBLIC_KEY_AQUI';

const mp = new MercadoPago(MERCADO_PAGO_PUBLIC_KEY);

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

// Inicializar formulário do Mercado Pago
const cardForm = mp.cardForm({
    amount: String(PLANS[planName].price),
    iframe: true,
    form: {
        id: "form-checkout",
        cardNumber: {
            id: "form-checkout__cardNumber",
            placeholder: "Número do cartão",
        },
        expirationDate: {
            id: "form-checkout__expirationDate",
            placeholder: "MM/AA",
        },
        securityCode: {
            id: "form-checkout__securityCode",
            placeholder: "CVV",
        },
        cardholderName: {
            id: "form-checkout__cardholderName",
            placeholder: "Titular do cartão",
        },
        issuer: {
            id: "form-checkout__issuer",
            placeholder: "Banco emissor",
        },
        installments: {
            id: "form-checkout__installments",
            placeholder: "Parcelas",
        },
        identificationType: {
            id: "form-checkout__identificationType",
            placeholder: "Tipo de documento",
        },
        identificationNumber: {
            id: "form-checkout__identificationNumber",
            placeholder: "Número do documento",
        },
        cardholderEmail: {
            id: "form-checkout__cardholderEmail",
            placeholder: "E-mail",
        },
    },
    callbacks: {
        onFormMounted: error => {
            if (error) {
                console.error('Erro ao montar formulário:', error);
                showError('Erro ao carregar formulário de pagamento. Tente novamente.');
            }
        },
        onSubmit: async (event) => {
            event.preventDefault();
            await processPayment();
        },
    },
});

async function processPayment() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorMessage = document.getElementById('errorMessage');
    
    try {
        // Validar campos customizados
        const userEmail = document.getElementById('userEmail').value.trim();
        const userName = document.getElementById('userName').value.trim();
        
        if (!userEmail || !userName) {
            showError('Por favor, preencha seu email e nome completo.');
            return;
        }
        
        if (!userEmail.includes('@')) {
            showError('Email inválido.');
            return;
        }
        
        loadingOverlay.classList.add('active');
        errorMessage.classList.remove('show');
        
        // Obter dados do cartão
        const {
            paymentMethodId,
            issuerId,
            cardholderEmail,
            amount,
            token,
            installments,
            identificationNumber,
            identificationType,
        } = cardForm.getCardFormData();
        
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
                    token,
                    payment_method_id: paymentMethodId,
                    issuer_id: issuerId,
                    payer: {
                        email: cardholderEmail || userEmail,
                        identification: {
                            type: identificationType,
                            number: identificationNumber,
                        },
                    },
                    transaction_amount: Number(amount),
                    installments: Number(installments),
                    description: `GranaEvo - Plano ${planName}`,
                }
            }
        });
        
        if (error) {
            throw error;
        }
        
        // Verificar status do pagamento
        if (data.status === 'approved') {
            // Pagamento aprovado
            alert('🎉 Pagamento aprovado! Bem-vindo ao GranaEvo!\n\nVocê receberá um email com suas credenciais de acesso em instantes.');
            window.location.href = 'login.html';
        } else if (data.status === 'in_process') {
            alert('⏳ Pagamento em análise.\n\nVocê receberá um email assim que for aprovado.');
            window.location.href = 'planos.html';
        } else {
            showError('Pagamento recusado. Verifique os dados do cartão e tente novamente.');
        }
        
    } catch (error) {
        console.error('Erro ao processar pagamento:', error);
        showError('Erro ao processar pagamento. Tente novamente.');
    } finally {
        loadingOverlay.classList.remove('active');
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