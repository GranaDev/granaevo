import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-4646534918736333-123104-db4e913a378f25709b38d0620e35fcf2-758074021'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { paymentId, email } = await req.json()

    if (!paymentId) {
      throw new Error('Payment ID não fornecido')
    }

    console.log('🔍 Verificando pagamento:', paymentId)

    // ✅ Consultar status no Mercado Pago
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`
      }
    })

    const mpData = await mpResponse.json()

    if (!mpResponse.ok) {
      throw new Error('Erro ao consultar Mercado Pago')
    }

    console.log('📊 Status:', mpData.status)

    const isPaid = mpData.status === 'approved'

    // ✅ Se foi aprovado, liberar acesso
    if (isPaid) {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )

      // Buscar subscription
      const { data: subscription, error: subError } = await supabaseAdmin
        .from('subscriptions')
        .select('*, plans(*)')
        .eq('payment_id', paymentId)
        .single()

      if (subError || !subscription) {
        throw new Error('Subscription não encontrada')
      }

      // Atualizar status
      await supabaseAdmin
        .from('subscriptions')
        .update({ payment_status: 'approved' })
        .eq('payment_id', paymentId)

      // ✅ LIBERAR ACESSO: Confirmar email do usuário
      await supabaseAdmin.auth.admin.updateUserById(subscription.user_id, {
        email_confirm: true
      })

      console.log('✅ Acesso liberado para:', subscription.user_id)
    }

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status: mpData.status,
        statusMessage: getStatusMessage(mpData.status)
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

function getStatusMessage(status: string): string {
  const messages: Record<string, string> = {
    'pending': 'Aguardando pagamento...',
    'approved': 'Pagamento aprovado!',
    'in_process': 'Pagamento em análise',
    'rejected': 'Pagamento rejeitado',
    'cancelled': 'Pagamento cancelado',
    'refunded': 'Pagamento estornado'
  }
  return messages[status] || 'Status desconhecido'
}