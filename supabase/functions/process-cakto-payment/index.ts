import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { orderId, action } = await req.json()

    if (!orderId) {
      throw new Error('orderId é obrigatório')
    }

    // Buscar dados do pedido na Cakto
    const accessToken = await getCaktoAccessToken()
    
    const orderResponse = await fetch(
      `https://api.cakto.com.br/api/orders/${orderId}/`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!orderResponse.ok) {
      throw new Error(`Erro ao buscar pedido: ${orderResponse.statusText}`)
    }

    const orderData = await orderResponse.json()

    // Processar baseado na ação
    let result
    switch (action) {
      case 'approve':
        result = await processApproval(supabaseClient, orderData)
        break
      case 'refund':
        result = await processRefund(supabaseClient, orderData)
        break
      case 'cancel':
        result = await processCancellation(supabaseClient, orderData)
        break
      default:
        throw new Error('Ação inválida')
    }

    return new Response(
      JSON.stringify({ success: true, result }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      },
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      },
    )
  }
})

async function getCaktoAccessToken(): Promise<string> {
  const clientId = Deno.env.get('CAKTO_CLIENT_ID')
  const clientSecret = Deno.env.get('CAKTO_CLIENT_SECRET')

  const response = await fetch('https://api.cakto.com.br/oauth/token/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!response.ok) {
    throw new Error('Falha ao obter token da Cakto')
  }

  const data = await response.json()
  return data.access_token
}

async function processApproval(supabase: any, orderData: any) {
  // Mesma lógica do webhook handleApprovedPurchase
  // (copiar código da função handleApprovedPurchase aqui)
  return { message: 'Aprovação processada' }
}

async function processRefund(supabase: any, orderData: any) {
  // Mesma lógica do webhook handleRefund
  return { message: 'Reembolso processado' }
}

async function processCancellation(supabase: any, orderData: any) {
  // Mesma lógica do webhook handleCancellation
  return { message: 'Cancelamento processado' }
}