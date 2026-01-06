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
    console.log('🔍 Verificando pagamento PIX')

    const mpToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!mpToken || !supabaseUrl || !supabaseKey) {
      throw new Error('Variáveis de ambiente faltando')
    }

    const supabase = createClient(supabaseUrl, supabaseKey)
    const body = await req.json()
    const { paymentId, email } = body

    if (!paymentId) {
      throw new Error('Payment ID não fornecido')
    }

    console.log('🔑 Consultando Mercado Pago, Payment ID:', paymentId)

    // Consultar status do pagamento no Mercado Pago
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${mpToken}`
      }
    })

    if (!mpResponse.ok) {
      throw new Error('Erro ao consultar Mercado Pago')
    }

    const payment = await mpResponse.json()
    console.log('💳 Status do pagamento:', payment.status)

    const statusMessages = {
      'pending': 'Aguardando pagamento',
      'approved': 'Pagamento aprovado',
      'authorized': 'Pagamento autorizado',
      'in_process': 'Pagamento em processamento',
      'in_mediation': 'Pagamento em mediação',
      'rejected': 'Pagamento rejeitado',
      'cancelled': 'Pagamento cancelado',
      'refunded': 'Pagamento estornado',
      'charged_back': 'Pagamento com chargeback'
    }

    // Se o pagamento foi aprovado
    if (payment.status === 'approved') {
      console.log('✅ Pagamento aprovado!')

      // Atualizar status na subscription
      const { error: updateError } = await supabase
        .from('subscriptions')
        .update({
          payment_status: 'approved',
          updated_at: new Date().toISOString()
        })
        .eq('mercadopago_payment_id', paymentId.toString())

      if (updateError) {
        console.error('⚠️ Erro ao atualizar subscription:', updateError)
      }

      // Buscar dados do usuário para enviar email
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('mercadopago_payment_id', paymentId.toString())
        .single()

      if (subscription?.user_id && email) {
        console.log('📧 Enviando email de boas-vindas...')

        try {
          await fetch(`${supabaseUrl}/functions/v1/send-welcome-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({
              userId: subscription.user_id,
              email: email,
              name: payment.payer?.first_name || 'Usuário'
            })
          })
        } catch (emailError) {
          console.error('⚠️ Erro ao enviar email:', emailError)
        }
      }

      return new Response(
        JSON.stringify({
          paid: true,
          status: payment.status,
          statusMessage: statusMessages[payment.status] || payment.status
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200 
        }
      )
    }

    // Se ainda não foi pago
    return new Response(
      JSON.stringify({
        paid: false,
        status: payment.status,
        statusMessage: statusMessages[payment.status] || payment.status
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    
    return new Response(
      JSON.stringify({ 
        error: error.message,
        paid: false
      }),
      { 
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})