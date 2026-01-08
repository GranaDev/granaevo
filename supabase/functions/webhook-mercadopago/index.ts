import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-4646534918736333-123104-db4e913a378f25709b38d0620e35fcf2-758074021'

serve(async (req) => {
  try {
    const body = await req.json()

    console.log('🔔 Webhook recebido:', JSON.stringify(body, null, 2))

    // Mercado Pago envia diferentes tipos de notificações
    if (body.type === 'payment' && body.data?.id) {
      const paymentId = body.data.id

      console.log('💳 Processando pagamento:', paymentId)

      // ✅ Consultar detalhes do pagamento no MP
      const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`
        }
      })

      const payment = await mpResponse.json()

      if (!mpResponse.ok) {
        throw new Error('Erro ao buscar pagamento no MP')
      }

      console.log('📊 Status do pagamento:', payment.status)

      // ✅ Se foi aprovado, liberar acesso
      if (payment.status === 'approved') {
        const supabaseAdmin = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // Buscar subscription pelo payment_id
        const { data: subscription, error: subError } = await supabaseAdmin
          .from('subscriptions')
          .select('*')
          .eq('payment_id', String(paymentId))
          .single()

        if (subError || !subscription) {
          console.error('❌ Subscription não encontrada:', paymentId)
          return new Response('Subscription not found', { status: 404 })
        }

        console.log('✅ Subscription encontrada:', subscription.id)

        // Atualizar status da subscription
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'approved',
            updated_at: new Date().toISOString()
          })
          .eq('payment_id', String(paymentId))

        // ✅ LIBERAR ACESSO: Confirmar email do usuário
        const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
          subscription.user_id,
          { email_confirm: true }
        )

        if (authError) {
          console.error('❌ Erro ao liberar acesso:', authError)
        } else {
          console.log('✅ Acesso liberado para usuário:', subscription.user_id)
        }
      }
      
      // ✅ Se foi rejeitado/cancelado, atualizar status
      else if (['rejected', 'cancelled'].includes(payment.status)) {
        const supabaseAdmin = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        await supabaseAdmin
          .from('subscriptions')
          .update({ payment_status: payment.status })
          .eq('payment_id', String(paymentId))

        console.log('⚠️ Pagamento não aprovado:', payment.status)
      }
    }

    // ✅ Sempre retornar 200 OK para o Mercado Pago
    return new Response('OK', { status: 200 })

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    // Mesmo com erro, retornar 200 para não ficar reenviando
    return new Response('ERROR', { status: 200 })
  }
})