import { supabase } from './supabase-client.js';

// STRIPE PRICE IDs - SUBSTITUA PELOS SEUS!
const STRIPE_PRICES = {
    'Individual': 'prod_TjUG7DCtUTqRuc', // Substitua
    'Casal': 'prod_TjUHrWXj3M7RlG',      // Substitua
    'Família': 'prod_TjUHJ28fo6yKaJ'     // Substitua
};

const PLANS = {
    'Individual': { price: 19.99, max_profiles: 1 },
    'Casal': { price: 29.99, max_profiles: 2 },
    'Família': { price: 49.99, max_profiles: 4 }
};

const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');
const isUpgrade = urlParams.get('upgrade') === 'true';

if (!planName || !PLANS[planName]) {
    alert('Plano não selecionado!');
    window.location.href = 'planos.html';
}

document.getElementById('planName').textContent = planName;
document.getElementById('planPrice').textContent = PLANS[planName].price.toFixed(2);

const form = document.getElementById('form-checkout');
const submitButton = document.getElementById('submitButton');
const loadingOverlay = document.getElementById('loadingOverlay');
const errorMessage = document.getElementById('errorMessage');

// Se for upgrade, pré-preencher email
if (isUpgrade) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        document.getElementById('userEmail').value = user.email;
        document.getElementById('userName').value = user.user_metadata.name || '';
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const userEmail = document.getElementById('userEmail').value.trim();
    const userName = document.getElementById('userName').value.trim();
    
    if (!userEmail || !userName) {
        showError('Por favor, preencha todos os campos.');
        return;
    }
    
    if (!userEmail.includes('@')) {
        showError('Email inválido.');
        return;
    }
    
    try {
        submitButton.disabled = true;
        loadingOverlay.classList.add('active');
        errorMessage.classList.remove('show');
        
        console.log('🚀 Criando sessão de checkout...');
        
        // Chamar Edge Function para criar sessão Stripe
        const { data, error } = await supabase.functions.invoke('create-checkout-session', {
            body: {
                priceId: STRIPE_PRICES[planName],
                email: userEmail,
                name: userName,
                planName: planName,
                isUpgrade: isUpgrade
            }
        });
        
        if (error) {
            console.error('❌ Erro:', error);
            throw new Error(error.message || 'Erro ao criar sessão de pagamento');
        }
        
        if (!data.url) {
            throw new Error('URL de checkout não retornada');
        }
        
        console.log('✅ Redirecionando para Stripe Checkout...');
        
        // Redirecionar para página de pagamento do Stripe
        window.location.href = data.url;
        
    } catch (error) {
        console.error('❌ Erro ao processar:', error);
        showError(error.message || 'Erro ao processar pagamento. Tente novamente.');
        submitButton.disabled = false;
        loadingOverlay.classList.remove('active');
    }
});

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add('show');
    
    setTimeout(() => {
        errorMessage.classList.remove('show');
    }, 5000);
}

console.log('✅ Checkout Stripe carregado');
console.log('📦 Plano:', planName);
console.log('💰 Valor:', PLANS[planName].price);
console.log('⬆️ É upgrade?', isUpgrade);