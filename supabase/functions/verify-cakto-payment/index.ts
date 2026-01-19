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
    const { orderId } = await req.json()

    if (!orderId) {
      throw new Error('orderId é obrigatório')
    }

    // Obter token da Cakto
    const accessToken = await getCaktoAccessToken()

    // Buscar pedido na API da Cakto
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

    return new Response(
      JSON.stringify({ 
        success: true, 
        order: orderData 
      }),
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