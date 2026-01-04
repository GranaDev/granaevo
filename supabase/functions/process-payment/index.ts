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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    console.log('🚀 [INICIO] Processamento de pagamento iniciado')
    
    const requestBody = await req.json()
    console.log('📥 [BODY] Request recebido')
    
    const { email, name, plan_id, plan_name, payment_data, payment_method } = requestBody
    
    // Validações
    if (!email) throw new Error('Email não fornecido')
    if (!name) throw new Error('Nome não fornecido')
    if (!plan_id) throw new Error('plan_id não fornecido')
    if (!plan_name) throw new Error('plan_name não fornecido')
    if (!payment_data) throw new Error('payment_data não fornecido')

    console.log('✅ [VALIDACAO] Dados básicos validados')

    // Validar Mercado Pago
    if (!MERCADO_PAGO_ACCESS_TOKEN) {
      console.error('❌ [CONFIG] MERCADO_PAGO_ACCESS_TOKEN não configurado')
      throw new Error('ERRO DE CONFIGURAÇÃO: MERCADO_PAGO_ACCESS_TOKEN não está configurado. Configure o secret no Supabase.')
    }

    console.log('✅ [CONFIG] Mercado Pago configurado')

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    console.log('✅ [SUPABASE] Cliente criado')

    // Verificar se usuário já existe
    console.log('🔍 [USER] Verificando se usuário existe:', email)
    const { data: existingAuth } = await supabase.auth.admin.listUsers()
    const userExists = existingAuth?.users?.find(u => u.email === email)

    if (userExists) {
      console.error('❌ [USER] Email já cadastrado:', email)
      throw new Error('Este email já está cadastrado')
    }

    console.log('✅ [USER] Email disponível')

    // Preparar pagamento
    console.log('💳 [MP] Preparando pagamento. Método:', payment_method || 'credit_card')
    
    let paymentPayload: any

    if (payment_method === 'pix') {
      paymentPayload = {
        transaction_amount: payment_data.transaction_amount,
        description: payment_data.description,
        payment_method_id: 'pix',
        payer: {
          email: payment_data.payer.email,
          identification: payment_data.payer.identification
        }
      }
      console.log('📱 [PIX] Payload preparado')
    } else {
      // Validações para cartão
      if (!payment_data.token) {
        throw new Error('Token do cartão não fornecido')
      }
      
      paymentPayload = {
        transaction_amount: payment_data.transaction_amount,
        token: payment_data.token,
        description: payment_data.description,
        installments: payment_data.installments || 1,
        payment_method_id: payment_data.payment_method_id || 'visa',
        payer: {
          email: payment_data.payer.email,
          identification: payment_data.payer.identification
        }
      }
      
      // Adicionar issuer_id se disponível
      if (payment_data.issuer_id) {
        paymentPayload.issuer_id = payment_data.issuer_id
      }
      
      console.log('💳 [CARD] Payload preparado')
    }

    console.log('📤 [MP] Enviando para Mercado Pago...')

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
    
    console.log('💰 [MP] Status da resposta:', paymentResponse.status)

    if (!paymentResponse.ok) {
      console.error('❌ [MP] Erro do Mercado Pago')
      console.error('❌ [MP] Resposta:', JSON.stringify(payment, null, 2))
      
      let errorMsg = 'Erro ao processar pagamento no Mercado Pago'
      
      if (payment.message) {
        errorMsg = payment.message
      } else if (payment.cause && payment.cause.length > 0) {
        errorMsg = payment.cause[0].description || payment.cause[0].code
      } else if (payment.error) {
        errorMsg = payment.error
      }
      
      throw new Error(errorMsg)
    }

    console.log('✅ [MP] Pagamento criado. ID:', payment.id, 'Status:', payment.status)

    // Gerar senha
    const randomPassword = generateRandomPassword()
    console.log('🔑 [PASSWORD] Senha gerada')

    // Criar usuário
    console.log('👤 [AUTH] Criando usuário...')
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: randomPassword,
      email_confirm: true,
      user_metadata: { name, plan: plan_name }
    })

    if (authError) {
      console.error('❌ [AUTH] Erro ao criar usuário:', authError)
      throw new Error('Erro ao criar conta: ' + authError.message)
    }

    if (!authData?.user) {
      console.error('❌ [AUTH] Usuário não foi criado')
      throw new Error('Usuário não foi criado')
    }

    console.log('✅ [AUTH] Usuário criado. ID:', authData.user.id)

    // Criar assinatura
    console.log('📝 [SUBSCRIPTION] Criando assinatura...')
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
      console.error('⚠️ [SUBSCRIPTION] Erro ao criar assinatura:', subError)
    } else {
      console.log('✅ [SUBSCRIPTION] Assinatura criada')
    }

    // Criar perfil
    console.log('👤 [PROFILE] Criando perfil...')
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        user_id: authData.user.id,
        name: name,
        email: email
      })

    if (profileError) {
      console.error('⚠️ [PROFILE] Erro ao criar perfil:', profileError)
    } else {
      console.log('✅ [PROFILE] Perfil criado')
    }

    // Enviar email se aprovado
    if (payment.status === 'approved') {
      console.log('📧 [EMAIL] Pagamento aprovado, enviando email...')
      
      try {
        const emailResult = await supabase.functions.invoke('send-welcome-email', {
          body: { email, name, password: randomPassword, plan: plan_name }
        })
        
        if (emailResult.error) {
          console.error('⚠️ [EMAIL] Erro ao enviar email:', emailResult.error)
        } else {
          console.log('✅ [EMAIL] Email enviado')
        }
      } catch (emailError) {
        console.error('⚠️ [EMAIL] Exceção ao enviar email:', emailError)
      }
    }

    // Preparar resposta
    const response: any = {
      status: payment.status,
      status_detail: payment.status_detail,
      payment_id: payment.id
    }

    // Adicionar dados PIX se aplicável
    if (payment_method === 'pix' && payment.point_of_interaction) {
      response.pix = {
        qr_code: payment.point_of_interaction.transaction_data.qr_code,
        qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
        ticket_url: payment.point_of_interaction.transaction_data.ticket_url
      }
      console.log('✅ [PIX] Dados do QR Code adicionados à resposta')
    }

    console.log('🎉 [FIM] Processamento concluído com sucesso!')

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: corsHeaders }
    )

  } catch (error: any) {
    console.error('❌ [ERRO] Erro no processamento:', error)
    console.error('❌ [ERRO] Stack:', error.stack)
    
    const errorResponse = {
      error: error.message || 'Erro ao processar pagamento',
      details: error.toString(),
      timestamp: new Date().toISOString()
    }
    
    console.error('📤 [ERROR_RESPONSE] Enviando erro:', JSON.stringify(errorResponse, null, 2))
    
    return new Response(
      JSON.stringify(errorResponse),
      { status: 400, headers: corsHeaders }
    )
  }
})