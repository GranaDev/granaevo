import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cakto-signature',
}

// ✅ Hash SHA-256 via Web Crypto API (Deno nativo — sem dependência externa)
async function hashSensitiveData(value: string | null): Promise<string | null> {
  if (!value) return null
  const encoder = new TextEncoder()
  const data = encoder.encode(value)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  console.log('🔔 ========== WEBHOOK CAKTO RECEBIDO ==========')
  console.log('📅 Timestamp:', new Date().toISOString())
  console.log('🌐 Headers:', Object.fromEntries(req.headers))

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    // Ler body
    const rawBody = await req.text()
    console.log('📦 Raw Body:', rawBody)

    // Parsear payload
    let payload
    try {
      payload = JSON.parse(rawBody)
      console.log('✅ Payload parseado:', JSON.stringify(payload, null, 2))
    } catch (e) {
      console.error('❌ Erro ao parsear JSON:', e.message)
      throw new Error('Payload inválido')
    }

    // ✅ CORREÇÃO: sem fallback hardcoded — se env var não existir, rejeita tudo
    const webhookSecret = Deno.env.get('CAKTO_WEBHOOK_SECRET') 
    if (!webhookSecret) {
      console.error('❌ CAKTO_WEBHOOK_SECRET não configurado nas env vars')
      return new Response(
        JSON.stringify({ error: 'Webhook não configurado' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    const receivedSecret = payload.secret
    if (receivedSecret !== webhookSecret) {
      console.error('❌ Secret inválido!')
      console.error('Recebido:', receivedSecret)
      return new Response(
        JSON.stringify({ error: 'Invalid secret' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }
    console.log('✅ Secret válido')

    // Extrair dados do evento
    const eventType = payload.event || 'unknown'
    const orderData = payload.data || payload
    const caktoOrderId = orderData.id || orderData.orderId || orderData.order_id || 'unknown'

    // Extrair informações do cliente
    const customer = orderData.customer || {}
    const email = (customer.email || orderData.email || '').toLowerCase().trim()
    const name = customer.name || orderData.customer_name || orderData.name || 'Usuário'

    // CPF - Remove tudo que não é número
    const rawCpf = (customer.docNumber || customer.cpf || orderData.cpf || '').replace(/\D/g, '')
    const cpf = rawCpf.length === 11 ? rawCpf : null

    // Telefone - Remove tudo que não é número e valida tamanho
    const rawPhone = (customer.phone || orderData.phone || '').replace(/\D/g, '')
    const phone = (rawPhone.length >= 10 && rawPhone.length <= 11) ? rawPhone : null

    console.log('🏷️ Tipo de evento:', eventType)
    console.log('🆔 Order ID:', caktoOrderId)
    console.log('📊 Status do pedido:', orderData.status)
    console.log('👤 Cliente:', { email, name, cpf: cpf ? '[PRESENTE]' : 'null', phone: phone ? '[PRESENTE]' : 'null' })

    // Salvar evento bruto
    const { data: eventLog, error: logError } = await supabase
      .from('payment_events')
      .insert({
        cakto_order_id: String(caktoOrderId),
        event_type: eventType,
        event_data: {
          ...payload,
          extracted_customer: {
            email,
            name,
            // ✅ CPF e telefone NÃO são logados em texto puro — apenas presença
            cpf_present: !!cpf,
            phone_present: !!phone,
          }
        },
        processed: false,
      })
      .select()
      .single()

    if (logError) {
      console.error('⚠️ Erro ao salvar log:', logError)
      throw new Error(`Erro ao salvar evento: ${logError.message}`)
    } else {
      console.log('✅ Evento salvo em payment_events:', eventLog.id)
    }

    // Processar evento
    let result
    const eventLower = eventType.toLowerCase()
    const statusLower = (orderData.status || '').toLowerCase()

    try {
      if (
        eventLower.includes('approved') ||
        eventLower.includes('paid') ||
        eventLower === 'purchase.approved' ||
        eventLower === 'order.paid' ||
        eventLower === 'pagamento_aprovado' ||
        eventLower === 'compra_aprovada' ||
        statusLower === 'paid' ||
        statusLower === 'approved' ||
        statusLower === 'pago' ||
        statusLower === 'aprovado'
      ) {
        console.log('💚 ===== PROCESSANDO APROVAÇÃO =====')
        console.log(`Razão: evento="${eventType}" status="${orderData.status}"`)
        result = await handleApproval(supabase, orderData, caktoOrderId, { email, name, cpf, phone })
      }
      else if (
        eventLower.includes('refund') ||
        eventLower.includes('reembolso') ||
        statusLower === 'refunded' ||
        statusLower === 'reembolsado'
      ) {
        console.log('💰 ===== PROCESSANDO REEMBOLSO =====')
        result = await handleRefund(supabase, orderData, caktoOrderId)
      }
      else if (
        eventLower.includes('cancel') ||
        eventLower.includes('cancelado') ||
        statusLower === 'cancelled' ||
        statusLower === 'canceled' ||
        statusLower === 'cancelado'
      ) {
        console.log('🚫 ===== PROCESSANDO CANCELAMENTO =====')
        result = await handleCancellation(supabase, orderData, caktoOrderId)
      }
      else if (
        eventLower.includes('dispute') ||
        eventLower.includes('chargeback') ||
        eventLower.includes('disputa') ||
        statusLower === 'disputed' ||
        statusLower === 'chargeback'
      ) {
        console.log('⚠️ ===== PROCESSANDO DISPUTA =====')
        result = await handleDispute(supabase, orderData, caktoOrderId)
      }
      else {
        console.log(`ℹ️ Evento "${eventType}" com status "${orderData.status}" registrado mas não processado`)
        result = {
          message: 'Evento registrado sem ação',
          event_type: eventType,
          status: orderData.status,
          note: 'Aguardando pagamento ou evento não implementado'
        }
      }

      await supabase
        .from('payment_events')
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          error_message: null
        })
        .eq('id', eventLog.id)

      console.log('✅ ========== WEBHOOK PROCESSADO COM SUCESSO ==========')

    } catch (processingError) {
      console.error('❌ Erro ao processar evento:', processingError)

      await supabase
        .from('payment_events')
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          error_message: processingError.message
        })
        .eq('id', eventLog.id)

      throw processingError
    }

    return new Response(
      JSON.stringify({
        success: true,
        event: eventType,
        status: orderData.status,
        order_id: caktoOrderId,
        event_log_id: eventLog.id,
        result
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('❌ ========== ERRO NO WEBHOOK ==========')
    console.error('Mensagem:', error.message)
    console.error('Stack:', error.stack)

    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ==========================================
// APROVAÇÃO
// ==========================================
async function handleApproval(
  supabase: any,
  orderData: any,
  caktoOrderId: string,
  customerData: { email: string, name: string, cpf: string | null, phone: string | null }
) {
  console.log('💚 Processando aprovação...')

  let { email, name, cpf, phone } = customerData

  if (!email) {
    throw new Error('Email não encontrado no payload')
  }

  // Validar CPF
  if (cpf) {
    cpf = cpf.replace(/\D/g, '')
    if (cpf.length !== 11) {
      console.warn('⚠️ CPF inválido, será salvo como null')
      cpf = null
    }
  }

  // Validar telefone
  if (phone) {
    phone = phone.replace(/\D/g, '')
    if (phone.length < 10 || phone.length > 11) {
      console.warn('⚠️ Telefone inválido, será salvo como null')
      phone = null
    }
  }

  // ✅ CORREÇÃO: hash antes de salvar — CPF e telefone nunca vão ao banco em texto puro
  const cpfHash   = await hashSensitiveData(cpf)
  const phoneHash = await hashSensitiveData(phone)

  console.log('✅ Dados validados:', {
    email,
    name,
    cpf:   cpf   ? '[HASH GERADO]' : 'null',
    phone: phone ? '[HASH GERADO]' : 'null'
  })

  // Produto/Plano
  const offer = orderData.offer || {}
  const product = orderData.product || {}
  const productName = offer.name || product.name || orderData.product_name || 'Unknown'
  const productId = product.id || offer.id || orderData.product_id

  let planName = 'Individual'
  const nameLower = productName.toLowerCase()
  if (nameLower.includes('casal')) planName = 'Casal'
  else if (nameLower.includes('família') || nameLower.includes('familia')) planName = 'Família'

  console.log('📋 Produto:', productName)
  console.log('📋 Plano identificado:', planName)

  // Buscar plano
  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('id, name')
    .eq('name', planName)
    .single()

  if (planError || !plan) {
    console.error('❌ Plano não encontrado:', planName, planError)
    throw new Error(`Plano "${planName}" não encontrado no banco de dados`)
  }

  console.log('✅ Plano encontrado:', plan)

  // Verificar se já existe subscription com este cakto_order_id
  const { data: existingByOrderId } = await supabase
    .from('subscriptions')
    .select('id, password_created, user_id, payment_status')
    .eq('cakto_order_id', caktoOrderId)
    .maybeSingle()

  if (existingByOrderId) {
    console.log('📝 Atualizando subscription existente (por order_id):', existingByOrderId.id)

    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        payment_status: 'approved',
        payment_method: orderData.paymentMethod || orderData.payment_method || 'unknown',
        is_active: true,
        user_email: email,
        user_name: name,
        user_cpf:   cpfHash,   // ✅ hash
        user_phone: phoneHash, // ✅ hash
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingByOrderId.id)

    if (updateError) {
      console.error('❌ Erro ao atualizar subscription:', updateError)
      throw updateError
    }

    console.log('✅ Subscription atualizada com sucesso')

    if (!existingByOrderId.password_created) {
      await enviarEmailBoasVindas(email, name, planName)
    }

    return { action: 'updated', subscription_id: existingByOrderId.id }
  }

  // Verificar se já existe subscription ativa com este email
  const { data: existingByEmail } = await supabase
    .from('subscriptions')
    .select('id, password_created, user_id, payment_status, is_active, cakto_order_id')
    .eq('user_email', email)
    .eq('is_active', true)
    .eq('payment_status', 'approved')
    .maybeSingle()

  if (existingByEmail) {
    console.log('📝 Já existe subscription ativa para este email:', existingByEmail.id)

    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        cakto_order_id:   caktoOrderId,
        cakto_product_id: productId,
        payment_method:   orderData.paymentMethod || orderData.payment_method || 'unknown',
        user_name:  name,
        user_cpf:   cpfHash,   // ✅ hash
        user_phone: phoneHash, // ✅ hash
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingByEmail.id)

    if (updateError) {
      console.error('❌ Erro ao atualizar subscription por email:', updateError)
      throw updateError
    }

    console.log('✅ Subscription existente atualizada com novo order_id')
    return { action: 'updated_existing', subscription_id: existingByEmail.id, note: 'Subscription já existia para este email' }
  }

  // Criar nova subscription
  console.log('🆕 Criando nova subscription')

  const { data: newSub, error: insertError } = await supabase
    .from('subscriptions')
    .insert({
      plan_id:          plan.id,
      user_email:       email,
      user_name:        name,
      user_cpf:         cpfHash,   // ✅ hash
      user_phone:       phoneHash, // ✅ hash
      cakto_order_id:   caktoOrderId,
      cakto_product_id: productId,
      payment_method:   orderData.paymentMethod || orderData.payment_method || 'unknown',
      payment_status:   'approved',
      is_active:        true,
      password_created: false,
    })
    .select()
    .single()

  if (insertError) {
    console.error('❌ Erro ao criar subscription:', insertError)
    throw insertError
  }

  console.log('✅ Subscription criada:', newSub.id)
  console.log('📧 Cliente cadastrado:', email)

  await enviarEmailBoasVindas(email, name, planName)

  console.log('🔗 Link de primeiro acesso: https://granaevo.vercel.app/primeiroacesso.html')

  return { action: 'created', subscription_id: newSub.id, email, name }
}

// ==========================================
// ENVIAR EMAIL DE BOAS-VINDAS
// ==========================================
async function enviarEmailBoasVindas(email: string, name: string, planName: string) {
  try {
    console.log('📧 Enviando email de boas-vindas...')

    const emailResponse = await fetch(
      `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-welcome-email`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify({ email, name, planName }),
      }
    )

    if (emailResponse.ok) {
      const emailResult = await emailResponse.json()
      console.log('✅ Email de boas-vindas enviado:', emailResult.email_id)
    } else {
      const errorData = await emailResponse.json()
      console.error('⚠️ Falha ao enviar email (não crítico):', errorData)
    }
  } catch (emailError) {
    console.error('⚠️ Erro ao enviar email (não crítico):', emailError)
  }
}

// ==========================================
// REEMBOLSO
// ==========================================
async function handleRefund(supabase: any, orderData: any, caktoOrderId: string) {
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('cakto_order_id', caktoOrderId)
    .maybeSingle()

  if (!sub) {
    console.warn('⚠️ Subscription não encontrada para reembolso:', caktoOrderId)
    return { action: 'not_found', message: 'Subscription não encontrada' }
  }

  const { error: updateError } = await supabase
    .from('subscriptions')
    .update({
      is_active:         false,
      payment_status:    'refunded',
      refunded_at:       new Date().toISOString(),
      refund_reason:     orderData.refund_reason || orderData.refundReason || 'Solicitado via Cakto',
      access_revoked_at: new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    })
    .eq('id', sub.id)

  if (updateError) throw updateError

  if (sub.user_id) {
    await supabase.from('fraud_logs').insert({
      user_id:         sub.user_id,
      subscription_id: sub.id,
      payment_id:      caktoOrderId,
      event_type:      'refund',
      reason:          'Reembolso processado pela Cakto',
      metadata:        orderData,
    })
  }

  console.log('✅ Reembolso processado para subscription:', sub.id)
  return { action: 'refunded', subscription_id: sub.id }
}

// ==========================================
// CANCELAMENTO
// ==========================================
async function handleCancellation(supabase: any, orderData: any, caktoOrderId: string) {
  const { error: updateError } = await supabase
    .from('subscriptions')
    .update({
      payment_status: 'cancelled',
      is_active:      false,
      updated_at:     new Date().toISOString(),
    })
    .eq('cakto_order_id', caktoOrderId)

  if (updateError) throw updateError

  console.log('✅ Cancelamento processado para order:', caktoOrderId)
  return { action: 'cancelled', order_id: caktoOrderId }
}

// ==========================================
// DISPUTA / CHARGEBACK
// ==========================================
async function handleDispute(supabase: any, orderData: any, caktoOrderId: string) {
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('cakto_order_id', caktoOrderId)
    .maybeSingle()

  if (!sub) {
    console.warn('⚠️ Subscription não encontrada para disputa:', caktoOrderId)
    return { action: 'not_found' }
  }

  const { error: updateError } = await supabase
    .from('subscriptions')
    .update({
      is_active:         false,
      payment_status:    'disputed', // ✅ agora existe no ENUM após ALTER TYPE
      access_revoked_at: new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    })
    .eq('id', sub.id)

  if (updateError) throw updateError

  if (sub.user_id) {
    await supabase.from('fraud_logs').insert({
      user_id:         sub.user_id,
      subscription_id: sub.id,
      payment_id:      caktoOrderId,
      event_type:      'dispute',
      reason:          'Disputa/Chargeback detectado',
      metadata:        orderData,
    })
  }

  console.log('✅ Disputa processada para subscription:', sub.id)
  return { action: 'disputed', subscription_id: sub.id }
}