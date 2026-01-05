import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    console.log('🔔 Webhook recebido do Mercado Pago')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    console.log('📦 Body:', body)

    // Mercado Pago envia diferentes tipos de notificação
    if (body.type !== 'payment') {
      return new Response('ok', { status: 200 })
    }

    const paymentId = body.data?.id

    if (!paymentId) {
      throw new Error('Payment ID não encontrado')
    }

    // Buscar detalhes do pagamento no MP
    const mpAccessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${mpAccessToken}`
      }
    })

    const payment = await mpResponse.json()

    console.log('💳 Pagamento:', payment)

    // Atualizar subscription
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

    // Se pagamento foi aprovado, enviar email de boas-vindas
    if (payment.status === 'approved') {
      console.log('✅ Pagamento aprovado! Enviando email...')

      const userId = payment.metadata?.user_id
      const email = payment.metadata?.email
      const name = payment.payer?.first_name

      if (userId && email) {
        await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-welcome-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
          },
          body: JSON.stringify({ userId, email, name })
        })
      }
    }

    return new Response('ok', { status: 200 })

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    return new Response('error', { status: 500 })
  }
})