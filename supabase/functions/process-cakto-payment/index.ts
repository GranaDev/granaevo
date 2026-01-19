import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CAKTO_CLIENT_ID = Deno.env.get('CAKTO_CLIENT_ID')!
const CAKTO_CLIENT_SECRET = Deno.env.get('CAKTO_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
}

// Função para obter token de acesso da Cakto
async function getCaktoAccessToken(): Promise<string> {
  const response = await fetch('https://api.cakto.com.br/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CAKTO_CLIENT_ID,
      client_secret: CAKTO_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Erro ao obter token Cakto: ${error}`)
  }

  const data = await response.json()
  return data.access_token
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, password, userName, planName, paymentMethod, cardToken, cpf } = await req.json()
    
    console.log('📥 Requisição recebida:', { email, planName, paymentMethod })

    // Validações básicas
    if (!email || !password || !planName || !cpf) {
      throw new Error('Dados incompletos: email, senha, plano e CPF são obrigatórios')
    }

    if (password.length < 6) {
      throw new Error('A senha deve ter pelo menos 6 caracteres')
    }

    // ✅ 1. Buscar plano no banco
    const { data: plan, error: planError } = await supabaseAdmin
      .from('plans')
      .select('*')
      .eq('name', planName)
      .single()

    if (planError) {
      console.error('❌ Erro ao buscar plano:', planError)
      throw new Error('Plano não encontrado no banco de dados')
    }

    console.log('✅ Plano encontrado:', plan.name, 'R$', plan.price)

    // ✅ 2. Verificar se email já existe
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers()
    const emailExists = existingUsers.users.some(u => u.email === email)
    
    if (emailExists) {
      throw new Error('Este email já está cadastrado!')
    }

    // ✅ 3. Criar usuário no Supabase Auth (ANTES do pagamento)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        name: userName || email.split('@')[0],
        plan: planName,
        cpf: cpf
      }
    })

    if (authError) {
      console.error('❌ Erro ao criar usuário no Auth:', authError)
      throw new Error(`Erro ao criar conta: ${authError.message}`)
    }

    const userId = authData.user.id
    console.log('✅ Usuário criado no Auth:', userId, email)

    // ✅ 4. Obter token de acesso da Cakto
    const accessToken = await getCaktoAccessToken()

    // ✅ 5. Preparar dados de pagamento
    const idempotencyKey = req.headers.get('X-Idempotency-Key') || `${email}-${Date.now()}`
    
    const paymentData: any = {
      amount: Math.round(plan.price * 100), // Cakto usa centavos
      currency: 'BRL',
      description: `Plano ${planName} - GranaEvo`,
      customer: {
        email: email,
        name: userName || email.split('@')[0],
        document: cpf.replace(/\D/g, '')
      },
      metadata: {
        user_id: userId,
        plan_name: planName,
        plan_id: plan.id
      }
    }

    let paymentEndpoint = ''
    
    // Se for PIX
    if (paymentMethod === 'pix') {
      paymentEndpoint = 'https://api.cakto.com.br/v1/charges/pix'
      paymentData.payment_method = 'pix'
      paymentData.expires_in = 3600 // 1 hora
    }
    // Se for cartão
    else if (paymentMethod === 'credit_card' && cardToken) {
      paymentEndpoint = 'https://api.cakto.com.br/v1/charges/card'
      paymentData.payment_method = 'credit_card'
      paymentData.card_token = cardToken
      paymentData.installments = 1
      paymentData.capture = true // Captura automática
    } else {
      throw new Error('Método de pagamento inválido')
    }

    console.log('💳 Criando pagamento na Cakto...')

    // ✅ 6. Criar pagamento na Cakto
    const caktoResponse = await fetch(paymentEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(paymentData)
    })

    const payment = await caktoResponse.json()

    if (!caktoResponse.ok || !payment.id) {
      console.error('❌ Erro na Cakto:', payment)
      
      // Rollback: deletar usuário criado
      await supabaseAdmin.auth.admin.deleteUser(userId)
      
      throw new Error(payment.message || 'Erro ao processar pagamento na Cakto')
    }

    console.log('✅ Pagamento criado na Cakto:', payment.id, 'Status:', payment.status)

    // ✅ 7. Salvar assinatura no banco
    const { error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan_id: plan.id,
        payment_id: payment.id.toString(),
        payment_method: paymentMethod,
        payment_status: payment.status,
        user_email: email,
        user_name: userName || email.split('@')[0],
        is_active: payment.status === 'approved', // Ativo se já aprovado
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() // 1 ano (vitalício)
      })

    if (subError) {
      console.error('❌ Erro ao salvar assinatura:', subError)
      
      // Rollback: deletar usuário
      await supabaseAdmin.auth.admin.deleteUser(userId)
      
      throw new Error(`Erro ao salvar assinatura: ${subError.message}`)
    }

    console.log('✅ Assinatura salva no banco')

    // ✅ 8. Criar perfil inicial
    const profileName = userName || email.split('@')[0]
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({
        user_id: userId,
        name: profileName,
        photo_url: null
      })

    if (profileError) {
      console.error('⚠️ Erro ao criar perfil:', profileError)
    } else {
      console.log('✅ Perfil inicial criado')
    }

    // ✅ 9. Preparar resposta
    const response: any = {
      success: true,
      paymentId: payment.id,
      paymentMethod: paymentMethod,
      status: payment.status
    }

    // Se for PIX, adicionar QR Code
    if (paymentMethod === 'pix' && payment.pix) {
      response.qrCodeBase64 = payment.pix.qr_code_base64
      response.qrCode = payment.pix.qr_code_text
      response.expiresAt = payment.pix.expires_at
    }

    console.log('✅ Processamento concluído com sucesso!')

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