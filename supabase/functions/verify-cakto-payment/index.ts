import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    const { userId } = await req.json()

    if (!userId) {
      throw new Error('User ID não fornecido')
    }

    console.log('🔍 Verificando pagamento do usuário:', userId)

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

    // Buscar subscription do usuário
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (subError || !subscription) {
      console.log('❌ Subscription não encontrada para user:', userId)
      return new Response(
        JSON.stringify({
          paid: false,
          status: 'pending',
          statusMessage: 'Aguardando confirmação do pagamento...'
        }),
        { 
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    console.log('📊 Subscription encontrada:', subscription.id, '- Status:', subscription.payment_status)

    const isPaid = subscription.is_active && subscription.payment_status === 'approved'

    return new Response(
      JSON.stringify({
        paid: isPaid,
        status: subscription.payment_status,
        statusMessage: getStatusMessage(subscription.payment_status)
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
    'approved': 'Pagamento confirmado!',
    'paid': 'Pagamento confirmado!',
    'declined': 'Pagamento recusado',
    'cancelled': 'Pagamento cancelado',
    'refunded': 'Pagamento estornado',
    'chargeback': 'Pagamento contestado'
  }
  return messages[status] || 'Status desconhecido'
}