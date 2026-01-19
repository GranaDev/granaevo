import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// IMPORTANTE: Na Cakto, você pega o Bearer Token no painel
// Vá em: Configurações → API → Token de Acesso
const CAKTO_API_KEY = Deno.env.get('CAKTO_API_KEY')!
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, password, userName, planName, paymentMethod, cpf } = await req.json()
    
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

    // ✅ 3. Criar usuário no Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: false, // Só confirmar após pagamento aprovado
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

    // ✅ 4. Preparar dados de pagamento para Cakto
    // ESTRUTURA CORRETA DA API CAKTO:
    const caktoPayload = {
      product: {
        name: `GranaEvo - ${planName}`,
        price: plan.price
      },
      customer: {
        name: userName || email.split('@')[0],
        email: email,
        document: cpf.replace(/\D/g, '')
      },
      payment: {
        method: paymentMethod === 'pix' ? 'pix' : 'credit_card'
      },
      metadata: {
        user_id: userId,
        plan_id: plan.id,
        plan_name: planName
      }
    }

    console.log('💳 Criando pagamento na Cakto...')

    // ✅ 5. Criar pagamento na Cakto
    const caktoResponse = await fetch('https://api.cakto.com.br/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CAKTO_API_KEY}`
      },
      body: JSON.stringify(caktoPayload)
    })

    const payment = await caktoResponse.json()

    if (!caktoResponse.ok || !payment.id) {
      console.error('❌ Erro na Cakto:', payment)
      
      // Rollback: deletar usuário criado
      await supabaseAdmin.auth.admin.deleteUser(userId)
      
      throw new Error(payment.message || payment.error || 'Erro ao processar pagamento na Cakto')
    }

    console.log('✅ Pagamento criado na Cakto:', payment.id, 'Status:', payment.status)

    // ✅ 6. Salvar assinatura no banco
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
        is_active: false, // Só ativar quando webhook confirmar
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() // 1 ano
      })

    if (subError) {
      console.error('❌ Erro ao salvar assinatura:', subError)
      
      // Rollback: deletar usuário
      await supabaseAdmin.auth.admin.deleteUser(userId)
      
      throw new Error(`Erro ao salvar assinatura: ${subError.message}`)
    }

    console.log('✅ Assinatura salva no banco')

    // ✅ 7. Criar perfil inicial
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

    // ✅ 8. Preparar resposta
    const response: any = {
      success: true,
      paymentId: payment.id,
      paymentMethod: paymentMethod,
      status: payment.status || 'pending'
    }

    // Se for PIX, adicionar QR Code
    if (paymentMethod === 'pix' && payment.pix) {
      response.qrCodeBase64 = payment.pix.qr_code_base64 || payment.pix.qrCodeBase64
      response.qrCode = payment.pix.qr_code || payment.pix.qrCode || payment.pix.code
      response.expiresAt = payment.pix.expires_at || payment.pix.expiresAt
    }

    // Se cartão foi aprovado imediatamente
    if (paymentMethod === 'credit_card' && payment.status === 'approved') {
      // Liberar acesso imediatamente
      await supabaseAdmin
        .from('subscriptions')
        .update({ is_active: true })
        .eq('payment_id', payment.id.toString())

      await supabaseAdmin.auth.admin.updateUserById(userId, {
        email_confirm: true
      })

      response.approved = true
    }

    console.log('✅ Processamento concluído com sucesso!')

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('❌ Erro geral:', error)
    console.error('❌ Stack trace:', error.stack)
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Erro desconhecido ao processar pagamento',
        details: error.stack || 'Sem detalhes adicionais'
      }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})