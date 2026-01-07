import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    console.log('🔔 Webhook recebido do Mercado Pago')
    console.log('📍 URL:', req.url)
    console.log('📍 Method:', req.method)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const mpToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')

    if (!supabaseUrl || !supabaseKey || !mpToken) {
      throw new Error('Variáveis de ambiente não configuradas')
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // Ler body
    const body = await req.json()
    console.log('📦 Body completo:', JSON.stringify(body, null, 2))

    // Mercado Pago envia diferentes tipos de notificação
    if (body.type !== 'payment') {
      console.log('ℹ️ Notificação ignorada, tipo:', body.type)
      return new Response('ok', { 
        status: 200,
        headers: corsHeaders 
      })
    }

    const paymentId = body.data?.id

    if (!paymentId) {
      console.error('❌ Payment ID não encontrado no body')
      throw new Error('Payment ID não encontrado')
    }

    console.log('💳 Payment ID:', paymentId)

    // Buscar detalhes do pagamento no Mercado Pago
    console.log('🔍 Consultando Mercado Pago...')
    
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${mpToken}`
      }
    })

    if (!mpResponse.ok) {
      const errorText = await mpResponse.text()
      console.error('❌ Erro ao consultar MP:', errorText)
      throw new Error('Erro ao consultar Mercado Pago')
    }

    const payment = await mpResponse.json()
    console.log('💰 Pagamento:', JSON.stringify(payment, null, 2))
    console.log('📊 Status:', payment.status)

    // Atualizar subscription
    console.log('💾 Atualizando subscription...')
    
    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        payment_status: payment.status,
        updated_at: new Date().toISOString()
      })
      .eq('mercadopago_payment_id', paymentId.toString())

    if (updateError) {
      console.error('❌ Erro ao atualizar subscription:', updateError)
      throw updateError
    }

    console.log('✅ Subscription atualizada')

    // Se pagamento foi aprovado, enviar email de boas-vindas
    if (payment.status === 'approved') {
      console.log('✅ Pagamento aprovado! Processando...')

      // Buscar dados do usuário
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('mercadopago_payment_id', paymentId.toString())
        .single()

      if (!subscription) {
        console.error('❌ Subscription não encontrada')
        throw new Error('Subscription não encontrada')
      }

      console.log('👤 User ID:', subscription.user_id)

      // Buscar dados do usuário
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
        subscription.user_id
      )

      if (userError || !userData) {
        console.error('❌ Erro ao buscar usuário:', userError)
        throw new Error('Usuário não encontrado')
      }

      const email = userData.user.email
      const name = userData.user.user_metadata?.name || 
                   payment.payer?.first_name || 
                   email.split('@')[0]

      console.log('📧 Enviando email para:', email)

      try {
        const emailResponse = await fetch(
          `${supabaseUrl}/functions/v1/send-welcome-email`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({ 
              userId: subscription.user_id, 
              email, 
              name 
            })
          }
        )

        const emailData = await emailResponse.json()
        console.log('📧 Resposta email:', JSON.stringify(emailData, null, 2))

        if (!emailResponse.ok) {
          console.error('⚠️ Erro ao enviar email:', emailData)
          // Não falhar o webhook por causa do email
        } else {
          console.log('✅ Email enviado com sucesso!')
        }
      } catch (emailError) {
        console.error('⚠️ Erro ao enviar email (não crítico):', emailError)
        // Não falhar o webhook por causa do email
      }
    } else {
      console.log('ℹ️ Pagamento não aprovado. Status:', payment.status)
    }

    console.log('✅ Webhook processado com sucesso')

    return new Response('ok', { 
      status: 200,
      headers: corsHeaders 
    })

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    console.error('❌ Stack:', error.stack)
    
    // IMPORTANTE: Sempre retornar 200 para o Mercado Pago
    // Caso contrário, ele tentará reenviar indefinidamente
    return new Response('error', { 
      status: 200,
      headers: corsHeaders 
    })
  }
})