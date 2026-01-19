import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CAKTO_CLIENT_ID = Deno.env.get('CAKTO_CLIENT_ID')!
const CAKTO_CLIENT_SECRET = Deno.env.get('CAKTO_CLIENT_SECRET')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function getCaktoAccessToken(): Promise<string> {
  const response = await fetch('https://api.cakto.com.br/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CAKTO_CLIENT_ID,
      client_secret: CAKTO_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  })

  if (!response.ok) {
    throw new Error('Erro ao obter token Cakto')
  }

  const data = await response.json()
  return data.access_token
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { paymentId } = await req.json()

    if (!paymentId) {
      throw new Error('Payment ID não fornecido')
    }

    console.log('🔍 Verificando pagamento:', paymentId)

    // ✅ Obter token de acesso
    const accessToken = await getCaktoAccessToken()

    // ✅ Consultar status na Cakto
    const caktoResponse = await fetch(`https://api.cakto.com.br/v1/charges/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    })

    const caktoData = await caktoResponse.json()

    if (!caktoResponse.ok) {
      throw new Error('Erro ao consultar Cakto')
    }

    console.log('📊 Status:', caktoData.status)

    const isPaid = caktoData.status === 'approved' || caktoData.status === 'paid'

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
        .update({ 
          payment_status: 'approved',
          is_active: true
        })
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
        status: caktoData.status,
        statusMessage: getStatusMessage(caktoData.status)
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
    'paid': 'Pagamento confirmado!',
    'processing': 'Pagamento em análise',
    'declined': 'Pagamento recusado',
    'cancelled': 'Pagamento cancelado',
    'refunded': 'Pagamento estornado',
    'chargeback': 'Pagamento contestado'
  }
  return messages[status] || 'Status desconhecido'
}