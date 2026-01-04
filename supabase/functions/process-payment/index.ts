import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MERCADO_PAGO_ACCESS_TOKEN = Deno.env.get('MERCADO_PAGO_ACCESS_TOKEN')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
}

function generateRandomPassword(length = 12) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%'
  let password = ''
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return password
}

serve(async (req) => {
  // CRITICAL: Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    })
  }

  try {
    console.log('🚀 Iniciando processamento de pagamento...')
    
    const requestBody = await req.json()
    const { email, name, plan_id, plan_name, payment_data, payment_method } = requestBody
    
    console.log('📥 Dados recebidos:', { 
      email, 
      name, 
      plan_name,
      payment_method: payment_method || 'credit_card' 
    })

    // Validar dados obrigatórios
    if (!email || !name || !plan_id || !plan_name) {
      throw new Error('Dados incompletos')
    }

    if (!MERCADO_PAGO_ACCESS_TOKEN) {
      throw new Error('Mercado Pago não configurado - verifique MERCADO_PAGO_ACCESS_TOKEN')
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Verificar se usuário já existe
    const { data: existingAuth } = await supabase.auth.admin.listUsers()
    const userExists = existingAuth?.users?.find(u => u.email === email)

    if (userExists) {
      throw new Error('Este email já está cadastrado')
    }

    console.log('💳 Criando pagamento no Mercado Pago...')

    // Preparar dados do pagamento
    let paymentPayload

    if (payment_method === 'pix') {
      // PIX
      paymentPayload = {
        transaction_amount: payment_data.transaction_amount,
        description: payment_data.description,
        payment_method_id: 'pix',
        payer: {
          email: payment_data.payer.email,
          identification: payment_data.payer.identification
        }
      }
    } else {
      // Cartão de Crédito
      paymentPayload = {
        transaction_amount: payment_data.transaction_amount,
        token: payment_data.token,
        description: payment_data.description,
        installments: payment_data.installments || 1,
        payment_method_id: payment_data.payment_method_id,
        issuer_id: payment_data.issuer_id,
        payer: {
          email: payment_data.payer.email,
          identification: payment_data.payer.identification
        }
      }
    }

    console.log('📤 Enviando para MP:', JSON.stringify(paymentPayload, null, 2))

    // Criar pagamento no Mercado Pago
    const paymentResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
        'X-Idempotency-Key': `${email}-${Date.now()}`
      },
      body: JSON.stringify(paymentPayload)
    })

    const payment = await paymentResponse.json()
    
    console.log('💰 Resposta do MP:', {
      status: payment.status,
      id: payment.id,
      status_detail: payment.status_detail
    })

    if (!paymentResponse.ok) {
      console.error('❌ Erro do MP:', payment)
      const errorMsg = payment.message || payment.cause?.[0]?.description || 'Erro ao processar pagamento'
      throw new Error(errorMsg)
    }

    // Gerar senha aleatória
    const randomPassword = generateRandomPassword()

    console.log('👤 Criando usuário no Supabase...')

    // Criar usuário no Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: randomPassword,
      email_confirm: true,
      user_metadata: { 
        name, 
        plan: plan_name 
      }
    })

    if (authError) {
      console.error('❌ Erro ao criar usuário:', authError)
      throw new Error('Erro ao criar conta: ' + authError.message)
    }

    if (!authData?.user) {
      throw new Error('Usuário não foi criado')
    }

    console.log('✅ Usuário criado:', authData.user.id)

    // Criar assinatura
    console.log('📝 Criando assinatura...')
    const { error: subError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: authData.user.id,
        plan_id: plan_id,
        payment_id: payment.id,
        payment_status: payment.status,
        payment_method: payment_method || 'credit_card'
      })

    if (subError) {
      console.error('❌ Erro ao criar assinatura:', subError)
    }

    // Criar perfil
    console.log('👤 Criando perfil...')
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        user_id: authData.user.id,
        name: name,
        email: email
      })

    if (profileError) {
      console.error('❌ Erro ao criar perfil:', profileError)
    }

    // Se pagamento aprovado, enviar email
    if (payment.status === 'approved') {
      console.log('📧 Enviando email de boas-vindas...')
      
      try {
        const emailResult = await supabase.functions.invoke('send-welcome-email', {
          body: { 
            email, 
            name, 
            password: randomPassword, 
            plan: plan_name 
          }
        })
        
        if (emailResult.error) {
          console.error('⚠️ Erro ao enviar email:', emailResult.error)
        } else {
          console.log('✅ Email enviado com sucesso')
        }
      } catch (emailError) {
        console.error('⚠️ Erro ao enviar email:', emailError)
      }
    }

    // Retornar resposta baseada no método de pagamento
    const response: any = {
      status: payment.status,
      status_detail: payment.status_detail,
      payment_id: payment.id
    }

    // Se for PIX, incluir dados do QR Code
    if (payment_method === 'pix' && payment.point_of_interaction) {
      response.pix = {
        qr_code: payment.point_of_interaction.transaction_data.qr_code,
        qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
        ticket_url: payment.point_of_interaction.transaction_data.ticket_url
      }
    }

    console.log('✅ Processamento concluído com sucesso!')

    return new Response(
      JSON.stringify(response),
      { 
        status: 200,
        headers: corsHeaders
      }
    )

  } catch (error: any) {
    console.error('❌ Erro no processamento:', error)
    
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Erro ao processar pagamento',
        details: error.toString()
      }),
      { 
        status: 400,
        headers: corsHeaders
      }
    )
  }
})