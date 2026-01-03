import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, handleCors } from '../_shared/cors.ts'

const MERCADO_PAGO_ACCESS_TOKEN = Deno.env.get('MERCADO_PAGO_ACCESS_TOKEN')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

function generateRandomPassword(length = 12) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%'
  let password = ''
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return password
}

serve(async (req) => {
  // Handle CORS
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  try {
    const { email, name, plan_id, plan_name, payment_data } = await req.json()

    console.log('📥 Recebendo pagamento:', { email, name, plan_name })

    // 1. Criar pagamento no Mercado Pago
    console.log('💳 Enviando para Mercado Pago...')
    const paymentResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
      },
      body: JSON.stringify(payment_data)
    })

    const payment = await paymentResponse.json()
    console.log('💳 Resposta Mercado Pago:', payment.status)

    if (!paymentResponse.ok) {
      console.error('❌ Erro do Mercado Pago:', payment)
      return new Response(
        JSON.stringify({ error: payment.message || 'Erro ao processar pagamento' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // 2. Se pagamento aprovado, criar usuário
    if (payment.status === 'approved') {
      console.log('✅ Pagamento aprovado, criando usuário...')

      const randomPassword = generateRandomPassword()

      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: email,
        password: randomPassword,
        email_confirm: true,
        user_metadata: {
          name: name,
          plan: plan_name
        }
      })

      if (authError) {
        console.error('❌ Erro ao criar usuário:', authError)
        return new Response(
          JSON.stringify({ error: 'Erro ao criar usuário' }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        )
      }

      console.log('👤 Usuário criado:', authData.user.id)

      // 3. Criar assinatura
      await supabase
        .from('subscriptions')
        .insert({
          user_id: authData.user.id,
          plan_id: plan_id,
          payment_id: payment.id,
          payment_status: 'approved'
        })

      // 4. Criar perfil
      await supabase
        .from('profiles')
        .insert({
          user_id: authData.user.id,
          name: name
        })

      console.log('📧 Enviando email...')

      // 5. Enviar email
      try {
        await supabase.functions.invoke('send-welcome-email', {
          body: {
            email: email,
            name: name,
            password: randomPassword,
            plan: plan_name
          }
        })
        console.log('✅ Email enviado!')
      } catch (emailError) {
        console.error('⚠️ Erro ao enviar email:', emailError)
        // Não bloqueia o processo se email falhar
      }

      console.log('✅ Processo completo!')
    }
    // Pagamento pendente
    else if (payment.status === 'in_process' || payment.status === 'pending') {
      console.log('⏳ Pagamento pendente')
      
      const randomPassword = generateRandomPassword()

      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: email,
        password: randomPassword,
        email_confirm: false,
        user_metadata: {
          name: name,
          plan: plan_name
        }
      })

      if (!authError && authData.user) {
        await supabase
          .from('subscriptions')
          .insert({
            user_id: authData.user.id,
            plan_id: plan_id,
            payment_id: payment.id,
            payment_status: payment.status
          })
      }
    }

    return new Response(
      JSON.stringify({ status: payment.status, payment_id: payment.id }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    )

  } catch (error) {
    console.error('❌ Erro geral:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Erro interno' }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})