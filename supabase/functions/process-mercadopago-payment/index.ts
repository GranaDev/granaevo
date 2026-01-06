import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Max-Age': '86400',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    })
  }

  try {
    console.log('🚀 Iniciando process-mercadopago-payment')
    
    // Pegar Idempotency Key do header
    const idempotencyKey = req.headers.get('X-Idempotency-Key')
    console.log('🔑 Idempotency Key recebido:', idempotencyKey)
    
    if (!idempotencyKey) {
      throw new Error('Header X-Idempotency-Key can\'t be null')
    }
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const mpToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')
    
    console.log('🔑 Verificando variáveis:', {
      hasUrl: !!supabaseUrl,
      hasKey: !!supabaseKey,
      hasMP: !!mpToken
    })
    
    if (!supabaseUrl || !supabaseKey || !mpToken) {
      throw new Error('Variáveis de ambiente faltando')
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey)

    const body = await req.json()
    console.log('📥 Body recebido:', JSON.stringify(body, null, 2))
    
    const { email, name, planName, paymentMethod, cardToken } = body

    if (!email || !name || !planName || !paymentMethod) {
      throw new Error('Campos obrigatórios faltando')
    }

    console.log('📊 Dados validados:', { email, name, planName, paymentMethod })

    // Buscar plano
    console.log('🔍 Buscando plano:', planName)
    
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('name', planName)
      .single()

    if (planError) {
      console.error('❌ Erro ao buscar plano:', planError)
      throw new Error(`Erro ao buscar plano: ${planError.message}`)
    }

    if (!plan) {
      throw new Error('Plano não encontrado')
    }

    console.log('✅ Plano encontrado:', plan)

    // Verificar se usuário já existe
    console.log('👤 Verificando usuário existente...')
    
    const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers()
    
    if (listError) {
      console.error('❌ Erro ao listar usuários:', listError)
      throw new Error(`Erro ao verificar usuário: ${listError.message}`)
    }

    const userExists = existingUsers?.users?.find(u => u.email === email)
    console.log('🔍 Usuário existe?', !!userExists)

    let userId = userExists?.id
    let temporaryPassword = null

    // Se não existe, criar conta
    if (!userExists) {
      console.log('➕ Criando novo usuário...')
      
      temporaryPassword = Math.random().toString(36).slice(-8) + 'Aa1!'
      
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { name: name }
      })

      if (createError) {
        console.error('❌ Erro ao criar usuário:', createError)
        throw new Error(`Erro ao criar usuário: ${createError.message}`)
      }

      userId = newUser.user.id
      console.log('✅ Usuário criado:', userId)
    }

    // Criar pagamento no Mercado Pago
    console.log('💳 Preparando pagamento no Mercado Pago...')
    
    const paymentData = {
      transaction_amount: parseFloat(plan.price),
      description: `GranaEvo - Plano ${planName}`,
      payment_method_id: paymentMethod === 'pix' ? 'pix' : 'visa',
      payer: {
        email: email,
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(1).join(' ') || name.split(' ')[0],
      },
      notification_url: `${supabaseUrl}/functions/v1/mercadopago-webhook`,
      metadata: {
        user_id: userId,
        plan_id: plan.id,
        email: email
      }
    }

    // Se for cartão, adicionar token
    if (paymentMethod === 'credit_card') {
      if (!cardToken) {
        throw new Error('Token do cartão não fornecido')
      }
      paymentData.token = cardToken
      paymentData.installments = 1
    }

    console.log('📤 Enviando para Mercado Pago:', JSON.stringify(paymentData, null, 2))

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mpToken}`,
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(paymentData)
    })

    const mpData = await mpResponse.json()
    
    console.log('📦 Resposta Mercado Pago:', JSON.stringify(mpData, null, 2))

    if (!mpResponse.ok) {
      console.error('❌ Erro do Mercado Pago:', mpData)
      throw new Error(mpData.message || 'Erro no Mercado Pago')
    }

    // Salvar subscription
    console.log('💾 Salvando subscription...')
    
    const { error: subError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan_id: plan.id,
        payment_method: paymentMethod,
        payment_status: mpData.status === 'approved' ? 'approved' : 'pending',
        mercadopago_payment_id: mpData.id.toString(),
        amount_paid: mpData.transaction_amount
      })

    if (subError) {
      console.error('❌ Erro ao salvar subscription:', subError)
      throw new Error(`Erro ao salvar assinatura: ${subError.message}`)
    }

    console.log('✅ Subscription salva')

    // Se PIX, retornar QR Code
    if (paymentMethod === 'pix') {
      console.log('📱 Retornando dados PIX')
      
      return new Response(
        JSON.stringify({
          success: true,
          paymentMethod: 'pix',
          qrCode: mpData.point_of_interaction?.transaction_data?.qr_code,
          qrCodeBase64: mpData.point_of_interaction?.transaction_data?.qr_code_base64,
          paymentId: mpData.id
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Se cartão aprovado, enviar email
    if (mpData.status === 'approved') {
      console.log('✅ Pagamento aprovado, enviando email...')
      
      try {
        const emailResponse = await fetch(`${supabaseUrl}/functions/v1/send-welcome-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({ 
            userId, 
            email, 
            name,
            temporaryPassword 
          })
        })
        
        const emailData = await emailResponse.json()
        console.log('📧 Resposta envio email:', emailData)
      } catch (emailError) {
        console.error('⚠️ Erro ao enviar email (não crítico):', emailError)
      }
    }

    console.log('✅ Processo concluído com sucesso')

    return new Response(
      JSON.stringify({
        success: true,
        paymentMethod: 'credit_card',
        status: mpData.status,
        paymentId: mpData.id
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Erro geral:', error)
    console.error('❌ Stack:', error.stack)
    
    return new Response(
      JSON.stringify({ 
        error: error.message,
        details: error.stack 
      }),
      { 
        status: 400, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json' 
        } 
      }
    )
  }
})