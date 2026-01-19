import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CAKTO_CLIENT_ID = Deno.env.get('CAKTO_CLIENT_ID')!
const CAKTO_CLIENT_SECRET = Deno.env.get('CAKTO_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Max-Age': '86400',
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// 🔑 Obter token OAuth2 da Cakto
async function getCaktoAccessToken(): Promise<string> {
  console.log('🔑 Obtendo token OAuth2 da Cakto...')
  
  // Preparar dados no formato URL-encoded
  const params = new URLSearchParams()
  params.append('grant_type', 'client_credentials')
  params.append('client_id', CAKTO_CLIENT_ID)
  params.append('client_secret', CAKTO_CLIENT_SECRET)
  
  const response = await fetch('https://api.cakto.com.br/o/token/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: params.toString()
  })

  const responseText = await response.text()
  
  if (!response.ok) {
    console.error('❌ Erro auth Cakto:', responseText)
    throw new Error(`Erro na autenticação Cakto (${response.status})`)
  }

  const data = JSON.parse(responseText)
  
  if (!data.access_token) {
    throw new Error('Token não retornado pela Cakto')
  }

  console.log('✅ Token OAuth2 obtido com sucesso')
  return data.access_token
}

serve(async (req) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const { email, password, userName, planName, paymentMethod, cpf, cardToken } = await req.json()
    
    console.log('📥 Nova requisição:', { email, planName, paymentMethod })

    // Validações
    if (!email || !password || !planName || !cpf) {
      throw new Error('Dados incompletos: email, senha, plano e CPF são obrigatórios')
    }

    if (password.length < 6) {
      throw new Error('A senha deve ter pelo menos 6 caracteres')
    }

    // 1. Buscar plano
    const { data: plan, error: planError } = await supabaseAdmin
      .from('plans')
      .select('*')
      .eq('name', planName)
      .single()

    if (planError || !plan) {
      console.error('❌ Plano não encontrado:', planError)
      throw new Error('Plano não encontrado no banco de dados')
    }

    console.log('✅ Plano encontrado:', plan.name, '- R$', plan.price)

    // 2. Verificar se email já existe
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers()
    const emailExists = existingUsers.users.some(u => u.email === email)
    
    if (emailExists) {
      throw new Error('Este email já está cadastrado!')
    }

    // 3. Criar usuário no Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: {
        name: userName || email.split('@')[0],
        plan: planName,
        cpf
      }
    })

    if (authError || !authData.user) {
      console.error('❌ Erro ao criar usuário:', authError)
      throw new Error(`Erro ao criar conta: ${authError?.message}`)
    }

    const userId = authData.user.id
    console.log('✅ Usuário criado no Auth:', userId)

    // 4. Obter token OAuth2 da Cakto
    const accessToken = await getCaktoAccessToken()

    // 5. Preparar payload para Cakto (formato da documentação deles)
    const caktoPayload: any = {
      amount: Math.round(plan.price * 100), // Valor em centavos
      description: `GranaEvo - Plano ${planName}`,
      customer: {
        name: userName || email.split('@')[0],
        email: email,
        document: cpf.replace(/\D/g, ''),
        document_type: 'CPF'
      },
      metadata: {
        user_id: userId,
        plan_id: plan.id,
        plan_name: planName
      }
    }

    // Adicionar método de pagamento
    if (paymentMethod === 'pix') {
      caktoPayload.payment_method = 'pix'
    } else if (paymentMethod === 'credit_card' && cardToken) {
      caktoPayload.payment_method = 'credit_card'
      caktoPayload.card = cardToken
    }

    console.log('💳 Criando cobrança na Cakto...')

    // 6. Criar cobrança na Cakto
    const caktoResponse = await fetch('https://api.cakto.com.br/v1/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(caktoPayload)
    })

    const caktoText = await caktoResponse.text()
    console.log('📥 Resposta Cakto:', caktoText.substring(0, 300))

    if (!caktoResponse.ok) {
      console.error('❌ Erro na Cakto:', caktoText)
      
      // Rollback: deletar usuário criado
      await supabaseAdmin.auth.admin.deleteUser(userId)
      
      throw new Error(`Erro ao processar pagamento na Cakto (${caktoResponse.status})`)
    }

    const payment = JSON.parse(caktoText)
    
    if (!payment.id) {
      await supabaseAdmin.auth.admin.deleteUser(userId)
      throw new Error('ID do pagamento não retornado pela Cakto')
    }

    console.log('✅ Cobrança criada na Cakto:', payment.id, '- Status:', payment.status)

    // 7. Salvar assinatura no banco
    const { error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan_id: plan.id,
        payment_id: payment.id.toString(),
        payment_method: paymentMethod,
        payment_status: payment.status || 'pending',
        user_email: email,
        user_name: userName || email.split('@')[0],
        is_active: false,
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      })

    if (subError) {
      console.error('❌ Erro ao salvar assinatura:', subError)
      await supabaseAdmin.auth.admin.deleteUser(userId)
      throw new Error(`Erro ao salvar assinatura: ${subError.message}`)
    }

    console.log('✅ Assinatura salva no banco')

    // 8. Criar perfil inicial
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({
        user_id: userId,
        name: userName || email.split('@')[0],
        photo_url: null
      })

    if (profileError) {
      console.warn('⚠️ Erro ao criar perfil:', profileError)
    } else {
      console.log('✅ Perfil criado')
    }

    // 9. Preparar resposta
    const response: any = {
      success: true,
      paymentId: payment.id,
      paymentMethod,
      status: payment.status || 'pending'
    }

    // Se for PIX, adicionar QR Code
    if (paymentMethod === 'pix' && payment.pix) {
      response.qrCodeBase64 = payment.pix.qr_code_base64 || payment.pix.qrCodeBase64
      response.qrCode = payment.pix.qr_code || payment.pix.code || payment.pix.qrCode
      response.expiresAt = payment.pix.expires_at || payment.pix.expiresAt
      console.log('✅ QR Code PIX gerado')
    }

    // Se cartão foi aprovado imediatamente
    if (paymentMethod === 'credit_card' && payment.status === 'approved') {
      await supabaseAdmin
        .from('subscriptions')
        .update({ is_active: true })
        .eq('payment_id', payment.id.toString())

      await supabaseAdmin.auth.admin.updateUserById(userId, {
        email_confirm: true
      })

      response.approved = true
      console.log('✅ Cartão aprovado - acesso liberado')
    }

    console.log('✅ Processamento concluído com sucesso!')

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
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