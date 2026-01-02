// checkout.js
import { supabase } from './supabase-client.js';

const MERCADO_PAGO_PUBLIC_KEY = 'COLE_SUA_PUBLIC_KEY_AQUI'; // Do passo 3.2

const mp = new MercadoPago(MERCADO_PAGO_PUBLIC_KEY);

// Pegar plano selecionado da URL
const urlParams = new URLSearchParams(window.location.search);
const planName = urlParams.get('plan');

if (!planName) {
    alert('Plano não selecionado!');
    window.location.href = 'planos.html';
}

// Buscar dados do plano
const { data: plan } = await supabase
    .from('plans')
    .select('*')
    .eq('name', planName)
    .single();

// Renderizar formulário de pagamento
const cardForm = mp.cardForm({
    amount: String(plan.price),
    iframe: true,
    form: {
        id: "form-checkout",
        cardNumber: {
            id: "form-checkout__cardNumber",
            placeholder: "Número do cartão",
        },
        expirationDate: {
            id: "form-checkout__expirationDate",
            placeholder: "MM/YY",
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
            if (error) console.error(error);
        },
        onSubmit: async (event) => {
            event.preventDefault();

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

            // Enviar para o backend (Supabase Function)
            const { data: { session } } = await supabase.auth.getSession();
            
            const { data, error } = await supabase.functions.invoke('process-payment', {
                body: {
                    user_id: session.user.id,
                    plan_id: plan.id,
                    payment_data: {
                        token,
                        payment_method_id: paymentMethodId,
                        issuer_id: issuerId,
                        payer: {
                            email: cardholderEmail,
                            identification: {
                                type: identificationType,
                                number: identificationNumber,
                            },
                        },
                        transaction_amount: Number(amount),
                        installments: Number(installments),
                    }
                }
            });

            if (error) {
                alert('Erro no pagamento. Tente novamente.');
                return;
            }

            if (data.status === 'approved') {
                alert('Pagamento aprovado! Bem-vindo ao GranaEvo!');
                window.location.href = 'dashboard.html';
            } else {
                alert('Pagamento em análise. Você receberá um email em breve.');
            }
        },
    },
});