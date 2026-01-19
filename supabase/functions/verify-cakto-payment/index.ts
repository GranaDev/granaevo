import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CAKTO_CLIENT_ID = Deno.env.get('CAKTO_CLIENT_ID')!
const CAKTO_CLIENT_SECRET = Deno.env.get('CAKTO_CLIENT_SECRET')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
}

async function getCaktoAccessToken(): Promise<string> {
  console.log('🔑 Obtendo token OAuth2...')
  
  const response = await fetch('https://api.cakto.com.br/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      client_id: CAKTO_CLIENT_ID,
      client_secret: CAKTO_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Erro ao obter token: ${text}`)
  }

  const data = await response.json()
  return data.access_token
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const { paymentId } = await req.json()

    if (!paymentId) {
      throw new Error('Payment ID não fornecido')
    }

    console.log('🔍 Verificando pagamento:', paymentId)

    // Obter token OAuth2
    const accessToken = await getCaktoAccessToken()

    // Consultar cobrança na Cakto
    const caktoResponse = await fetch(`https://api.cakto.com.br/v1/charges/${paymentId}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    })

    const responseText = await caktoResponse.text()
    console.log('📥 Resposta Cakto:', responseText.substring(0, 200))

    if (!caktoResponse.ok) {
      throw new Error(`Erro ao consultar Cakto (${caktoResponse.status})`)
    }

    const caktoData = JSON.parse(responseText)
    console.log('📊 Status do pagamento:', caktoData.status)

    const isPaid = caktoData.status === 'approved' || 
                   caktoData.status === 'paid' || 
                   caktoData.status === 'confirmed'

    // Se foi aprovado, liberar acesso
    if (isPaid) {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        {
          auth: {
            autoRefreshToken: false,
            persistSession: false
          }
        }
      )

      // Buscar subscription
      const { data: subscription, error: subError } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('payment_id', paymentId.toString())
        .single()

      if (subError || !subscription) {
        console.error('❌ Subscription não encontrada:', subError)
        throw new Error('Assinatura não encontrada')
      }

      console.log('✅ Subscription encontrada:', subscription.id)

      // Atualizar subscription
      await supabaseAdmin
        .from('subscriptions')
        .update({ 
          payment_status: 'approved',
          is_active: true,
          updated_at: new Date().toISOString()
        })
        .eq('payment_id', paymentId.toString())

      // Liberar acesso do usuário
      await supabaseAdmin.auth.admin.updateUserById(
        subscription.user_id,
        { 
          email_confirm: true,
          banned_until: null
        }
      )

      console.log('✅ Acesso liberado para:', subscription.user_id)
    }

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status: caktoData.status,
        statusMessage: getStatusMessage(caktoData.status)
      }),
      { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error: any) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ 
        paid: false,
        error: error.message 
      }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})

function getStatusMessage(status: string): string {
  const messages: Record<string, string> = {
    'pending': 'Aguardando pagamento...',
    'processing': 'Processando pagamento...',
    'approved': 'Pagamento aprovado!',
    'paid': 'Pagamento confirmado!',
    'confirmed': 'Pagamento confirmado!',
    'declined': 'Pagamento recusado',
    'cancelled': 'Pagamento cancelado',
    'refunded': 'Pagamento estornado',
    'chargeback': 'Pagamento contestado',
    'expired': 'Pagamento expirado'
  }
  return messages[status] || 'Status desconhecido'
}