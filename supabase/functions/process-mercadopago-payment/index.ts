import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-4646534918736333-123104-db4e913a378f25709b38d0620e35fcf2-758074021'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
}

interface PaymentRequest {
  email: string
  password: string
  planName: string
  paymentMethod: string
  cardToken?: string
}

serve(async (req) => {
  // ✅ Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, password, planName, paymentMethod, cardToken }: PaymentRequest = await req.json()

    console.log('📥 Recebendo pagamento:', { email, planName, paymentMethod })

    // Validações
    if (!email || !password || !planName || !paymentMethod) {
      throw new Error('Dados incompletos')
    }

    // ✅ Criar cliente Supabase
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // ✅ 1. Buscar plano
    const { data: plan, error: planError } = await supabaseAdmin
      .from('plans')
      .select('*')
      .eq('name', planName)
      .single()

    if (planError || !plan) {
      throw new Error('Plano não encontrado')
    }

    console.log('📦 Plano encontrado:', plan)

    // ✅ 2. Criar usuário no Supabase Auth (SEM CONFIRMAR EMAIL)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: false, // Não confirma ainda
      user_metadata: {
        plan: planName,
        name: email.split('@')[0]
      }
    })

    if (authError || !authData.user) {
      console.error('❌ Erro ao criar usuário:', authError)
      throw new Error('Erro ao criar conta: ' + authError?.message)
    }

    console.log('✅ Usuário criado:', authData.user.id)

    // ✅ 3. Criar pagamento no Mercado Pago
    const paymentData: any = {
      transaction_amount: plan.price,
      description: `GranaEvo - Plano ${planName}`,
      payment_method_id: paymentMethod === 'pix' ? 'pix' : 'credit_card',
      payer: {
        email: email,
      },
      notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/webhook-mercadopago`,
      metadata: {
        user_id: authData.user.id,
        plan_id: plan.id,
        email: email
      }
    }

    // Se for cartão, adicionar token
    if (paymentMethod === 'credit_card' && cardToken) {
      paymentData.token = cardToken
      paymentData.installments = 1
      paymentData.issuer_id = '' // Será preenchido pelo MP
    }

    console.log('💳 Criando pagamento no Mercado Pago...')

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
        'X-Idempotency-Key': req.headers.get('X-Idempotency-Key') || crypto.randomUUID()
      },
      body: JSON.stringify(paymentData)
    })

    const mpData = await mpResponse.json()

    if (!mpResponse.ok) {
      console.error('❌ Erro Mercado Pago:', mpData)
      throw new Error(mpData.message || 'Erro ao processar pagamento')
    }

    console.log('✅ Pagamento criado:', mpData.id)

    // ✅ 4. Salvar subscription no Supabase
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 24)

    const { error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: authData.user.id,
        plan_id: plan.id,
        payment_id: String(mpData.id),
        payment_method: paymentMethod,
        payment_status: mpData.status, // pending, approved, etc
        expires_at: expiresAt.toISOString()
      })

    if (subError) {
      console.error('❌ Erro ao salvar subscription:', subError)
      throw new Error('Erro ao salvar dados')
    }

    console.log('✅ Subscription salva com sucesso')

    // ✅ 5. Retornar resposta
    const response: any = {
      success: true,
      paymentId: mpData.id,
      paymentMethod: paymentMethod,
      status: mpData.status,
      userId: authData.user.id
    }

    // Se for PIX, retornar QR Code
    if (paymentMethod === 'pix' && mpData.point_of_interaction?.transaction_data) {
      response.qrCode = mpData.point_of_interaction.transaction_data.qr_code
      response.qrCodeBase64 = mpData.point_of_interaction.transaction_data.qr_code_base64
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('❌ Erro geral:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }), 
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})