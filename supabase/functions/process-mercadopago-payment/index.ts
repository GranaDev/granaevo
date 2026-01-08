import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MERCADOPAGO_ACCESS_TOKEN = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, password, planName, paymentMethod, cardToken } = await req.json()
    
    console.log('📥 Requisição recebida:', { email, planName, paymentMethod })

    // ✅ 1. Buscar plano no banco
    const { data: plan, error: planError } = await supabaseAdmin
      .from('plans')
      .select('*')
      .eq('name', planName)
      .single()

    if (planError || !plan) {
      throw new Error('Plano não encontrado')
    }

    console.log('✅ Plano encontrado:', plan.name, plan.price)

    // ✅ 2. Criar usuário no Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        name: email.split('@')[0],
        plan: planName
      }
    })

    if (authError) {
      if (authError.message.includes('already registered')) {
        throw new Error('Este email já está cadastrado!')
      }
      throw authError
    }

    const userId = authData.user.id
    console.log('✅ Usuário criado:', userId)

    // ✅ 3. Preparar dados de pagamento
    const idempotencyKey = req.headers.get('X-Idempotency-Key') || `${email}-${Date.now()}`
    
    const paymentData = {
      transaction_amount: plan.price,
      description: `Plano ${planName} - GranaEvo`,
      payment_method_id: paymentMethod === 'pix' ? 'pix' : 'credit_card',
      payer: {
        email: email,
        first_name: email.split('@')[0]
      }
    }

    // Se for cartão, adicionar token
    if (paymentMethod === 'credit_card' && cardToken) {
      paymentData.token = cardToken
      paymentData.installments = 1
    }

    console.log('💳 Criando pagamento no Mercado Pago...')

    // ✅ 4. Criar pagamento no Mercado Pago
    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(paymentData)
    })

    const payment = await mpResponse.json()

    if (!payment.id) {
      console.error('❌ Erro no Mercado Pago:', payment)
      throw new Error('Erro ao criar pagamento no Mercado Pago')
    }

    console.log('✅ Pagamento criado:', payment.id, payment.status)

    // ✅ 5. Salvar assinatura no banco COM EMAIL E NOME
    const { error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan_id: plan.id,
        payment_id: payment.id.toString(),
        payment_method: paymentMethod,
        payment_status: payment.status,
        user_email: email,  // ✅ NOVO: Salvando email
        user_name: email.split('@')[0],  // ✅ NOVO: Salvando nome
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      })

    if (subError) {
      console.error('❌ Erro ao salvar assinatura:', subError)
      throw subError
    }

    console.log('✅ Assinatura salva no banco')

    // ✅ 6. Se pagamento aprovado, criar perfil inicial
    if (payment.status === 'approved') {
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert({
          user_id: userId,
          name: email.split('@')[0],
          photo: null
        })

      if (profileError) {
        console.error('⚠️ Erro ao criar perfil:', profileError)
      } else {
        console.log('✅ Perfil inicial criado')
      }
    }

    // ✅ 7. Preparar resposta
    const response = {
      success: true,
      paymentId: payment.id,
      paymentMethod: paymentMethod,
      status: payment.status
    }

    // Se for PIX, adicionar QR Code
    if (paymentMethod === 'pix' && payment.point_of_interaction) {
      response.qrCodeBase64 = payment.point_of_interaction.transaction_data.qr_code_base64
      response.qrCode = payment.point_of_interaction.transaction_data.qr_code
    }

    console.log('✅ Processamento concluído com sucesso')

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('❌ Erro geral:', error)
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Erro desconhecido ao processar pagamento'
      }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})