import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// ✅ Links de checkout da Cakto (já prontos!)
const CAKTO_CHECKOUT_LINKS: Record<string, string> = {
  'Individual': 'https://pay.cakto.com.br/nxbsjtg_731847',
  'Casal': 'https://pay.cakto.com.br/jsatqgw_731852',
  'Família': 'https://pay.cakto.com.br/98h5igj_731853'
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Max-Age': '86400',
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const { email, password, userName, planName, cpf } = await req.json()
    
    console.log('📥 Nova requisição:', { email, planName })

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

    // 3. Criar usuário no Supabase (mas deixar inativo até o pagamento)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: false, // Só confirma após pagamento
      user_metadata: {
        name: userName || email.split('@')[0],
        plan: planName,
        cpf,
        awaiting_payment: true
      }
    })

    if (authError || !authData.user) {
      console.error('❌ Erro ao criar usuário:', authError)
      throw new Error(`Erro ao criar conta: ${authError?.message}`)
    }

    const userId = authData.user.id
    console.log('✅ Usuário criado no Auth:', userId)

    // 4. Salvar assinatura pendente
    const { error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        user_id: userId,
        plan_id: plan.id,
        payment_id: null, // Será preenchido pelo webhook
        payment_method: 'cakto_checkout',
        payment_status: 'pending',
        user_email: email,
        user_name: userName || email.split('@')[0],
        is_active: false,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 dias
      })

    if (subError) {
      console.error('❌ Erro ao salvar assinatura:', subError)
      await supabaseAdmin.auth.admin.deleteUser(userId)
      throw new Error(`Erro ao salvar assinatura: ${subError.message}`)
    }

    console.log('✅ Assinatura pendente criada')

    // 5. Criar perfil inicial
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

    // 6. Obter link de checkout da Cakto
    const checkoutBaseUrl = CAKTO_CHECKOUT_LINKS[planName]
    
    if (!checkoutBaseUrl) {
      throw new Error(`Link de checkout não encontrado para o plano: ${planName}`)
    }

    // 7. Adicionar parâmetros para pré-preencher o checkout
    const checkoutUrl = new URL(checkoutBaseUrl)
    checkoutUrl.searchParams.append('customer_name', userName || email.split('@')[0])
    checkoutUrl.searchParams.append('customer_email', email)
    checkoutUrl.searchParams.append('customer_document', cpf.replace(/\D/g, ''))
    
    // Metadados para identificar no webhook
    checkoutUrl.searchParams.append('metadata[user_id]', userId)
    checkoutUrl.searchParams.append('metadata[plan_id]', plan.id)
    checkoutUrl.searchParams.append('metadata[user_email]', email)

    console.log('✅ URL de checkout gerada')

    return new Response(
      JSON.stringify({ 
        success: true,
        checkoutUrl: checkoutUrl.toString(),
        userId: userId,
        message: 'Conta criada com sucesso. Prossiga para o pagamento.'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    )

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