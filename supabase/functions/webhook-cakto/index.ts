import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // Pega o body do webhook
    const payload = await req.json()
    console.log('📦 Webhook recebido:', JSON.stringify(payload, null, 2))

    // Verificar assinatura do webhook (segurança)
    const webhookSecret = Deno.env.get('CAKTO_WEBHOOK_SECRET')
    const signature = req.headers.get('x-cakto-signature')
    
    // TODO: Implementar validação de assinatura quando a Cakto fornecer
    // Por enquanto, vamos apenas logar
    console.log('🔐 Signature recebida:', signature)

    // Extrair dados do evento
    const eventType = payload.event || payload.type
    const orderData = payload.data || payload

    const {
      id: caktoOrderId,
      customer,
      status,
      payment_method,
      items,
    } = orderData

    // Salvar evento no log
    const { error: logError } = await supabaseClient
      .from('payment_events')
      .insert({
        cakto_order_id: caktoOrderId,
        event_type: eventType,
        event_data: payload,
        processed: false,
      })

    if (logError) {
      console.error('❌ Erro ao salvar evento:', logError)
    }

    // Processar baseado no tipo de evento
    switch (eventType) {
      case 'purchase.approved':
      case 'order.approved':
        await handleApprovedPurchase(supabaseClient, orderData)
        break

      case 'purchase.refunded':
      case 'order.refunded':
        await handleRefund(supabaseClient, orderData)
        break

      case 'purchase.cancelled':
      case 'order.cancelled':
        await handleCancellation(supabaseClient, orderData)
        break

      default:
        console.log(`ℹ️ Evento ${eventType} registrado mas não processado`)
    }

    // Marcar evento como processado
    await supabaseClient
      .from('payment_events')
      .update({ 
        processed: true, 
        processed_at: new Date().toISOString() 
      })
      .eq('cakto_order_id', caktoOrderId)
      .eq('event_type', eventType)

    return new Response(
      JSON.stringify({ success: true, message: 'Webhook processado' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      },
    )

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      },
    )
  }
})

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

async function handleApprovedPurchase(supabase: any, orderData: any) {
  console.log('✅ Processando compra aprovada...')

  const {
    id: caktoOrderId,
    customer,
    payment_method,
    items,
  } = orderData

  // Extrair informações do cliente
  const customerEmail = customer.email
  const customerName = customer.name || customer.full_name
  const customerCPF = customer.cpf || customer.document
  const customerPhone = customer.phone || customer.mobile

  // Pegar o primeiro item (produto)
  const product = items[0]
  const productName = product.name

  // Mapear nome do produto para plan_id
  let planName = 'Individual'
  if (productName.toLowerCase().includes('casal')) {
    planName = 'Casal'
  } else if (productName.toLowerCase().includes('família') || productName.toLowerCase().includes('familia')) {
    planName = 'Família'
  }

  // Buscar plan_id
  const { data: planData } = await supabase
    .from('plans')
    .select('id')
    .eq('name', planName)
    .single()

  if (!planData) {
    throw new Error(`Plano ${planName} não encontrado`)
  }

  // Gerar token de acesso
  const { data: tokenData } = await supabase
    .rpc('generate_access_token')

  const accessToken = tokenData

  // Data de expiração do token (48 horas)
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + 48)

  // Verificar se já existe subscription para este pedido
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('cakto_order_id', caktoOrderId)
    .single()

  if (existing) {
    console.log('⚠️ Subscription já existe para este pedido, atualizando...')
    
    // Atualizar
    const { error } = await supabase
      .from('subscriptions')
      .update({
        payment_status: 'approved',
        payment_method: payment_method,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)

    if (error) throw error

  } else {
    // Criar nova subscription
    const { error } = await supabase
      .from('subscriptions')
      .insert({
        plan_id: planData.id,
        user_email: customerEmail,
        user_name: customerName,
        user_cpf: customerCPF?.replace(/\D/g, ''), // Remove formatação
        user_phone: customerPhone?.replace(/\D/g, ''),
        cakto_order_id: caktoOrderId,
        cakto_product_id: product.id,
        payment_method: payment_method,
        payment_status: 'approved',
        access_token: accessToken,
        access_token_expires_at: expiresAt.toISOString(),
        access_token_used: false,
        is_active: true,
        expires_at: null, // Acesso vitalício
      })

    if (error) throw error

    console.log(`✅ Subscription criada com sucesso para ${customerEmail}`)
    console.log(`🔑 Token de acesso: ${accessToken}`)

    // TODO: Enviar email com link de primeiro acesso
    // Link seria: https://granaevo.vercel.app/primeiroacesso?token=${accessToken}
  }
}

async function handleRefund(supabase: any, orderData: any) {
  console.log('💰 Processando reembolso...')

  const { id: caktoOrderId } = orderData

  // Buscar subscription
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('cakto_order_id', caktoOrderId)
    .single()

  if (!subscription) {
    console.log('⚠️ Subscription não encontrada para reembolso')
    return
  }

  // Atualizar subscription
  const { error } = await supabase
    .from('subscriptions')
    .update({
      is_active: false,
      refunded_at: new Date().toISOString(),
      refund_reason: 'Solicitado pelo cliente via Cakto',
      access_revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', subscription.id)

  if (error) throw error

  // Registrar no fraud_logs
  await supabase
    .from('fraud_logs')
    .insert({
      user_id: subscription.user_id,
      subscription_id: subscription.id,
      payment_id: caktoOrderId,
      event_type: 'refund',
      reason: 'Reembolso processado via Cakto',
      metadata: orderData,
    })

  console.log(`✅ Reembolso processado para subscription ${subscription.id}`)

  // TODO: Enviar email notificando revogação de acesso
}

async function handleCancellation(supabase: any, orderData: any) {
  console.log('🚫 Processando cancelamento...')

  const { id: caktoOrderId } = orderData

  // Atualizar status para cancelled
  const { error } = await supabase
    .from('subscriptions')
    .update({
      payment_status: 'cancelled',
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq('cakto_order_id', caktoOrderId)

  if (error) throw error

  console.log(`✅ Cancelamento processado para pedido ${caktoOrderId}`)
}