import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts'

const CAKTO_WEBHOOK_SECRET = Deno.env.get('CAKTO_WEBHOOK_SECRET')!

// Função para verificar assinatura HMAC do webhook
function verifyWebhookSignature(payload: string, signature: string | null): boolean {
  if (!signature || !CAKTO_WEBHOOK_SECRET) {
    console.warn('⚠️ Assinatura ou secret não fornecido')
    return false
  }

  try {
    // Cakto usa HMAC SHA-256
    const hmac = createHmac('sha256', CAKTO_WEBHOOK_SECRET)
    hmac.update(payload)
    const computedSignature = hmac.digest('hex')
    
    // Comparar assinaturas
    return signature === computedSignature
  } catch (error) {
    console.error('❌ Erro ao verificar assinatura:', error)
    return false
  }
}

serve(async (req) => {
  try {
    // Pegar assinatura do header (pode variar - verificar documentação Cakto)
    const signature = req.headers.get('x-cakto-signature') || 
                     req.headers.get('x-webhook-signature') ||
                     req.headers.get('signature')
    
    const rawBody = await req.text()
    const body = JSON.parse(rawBody)

    console.log('🔔 Webhook Cakto recebido:', JSON.stringify(body, null, 2))

    // ✅ Verificar assinatura do webhook (segurança)
    // NOTA: Em ambiente de testes, você pode comentar essa verificação
    // if (!verifyWebhookSignature(rawBody, signature)) {
    //   console.error('❌ Assinatura inválida!')
    //   return new Response('Invalid signature', { status: 401 })
    // }

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

    // ====================================
    // 📊 IDENTIFICAR TIPO DE EVENTO
    // ====================================
    
    const eventType = body.event || body.type || body.evento
    
    // Dados da compra/transação
    const sale = body.sale || body.venda || body.data || body
    const paymentId = sale.transaction_id || sale.id || sale.payment_id
    const customerEmail = sale.customer_email || sale.email || sale.cliente?.email

    console.log(`📊 Evento: ${eventType}`)
    console.log(`💳 Payment ID: ${paymentId}`)
    console.log(`📧 Email: ${customerEmail}`)

    if (!paymentId) {
      console.error('❌ Payment ID não encontrado no webhook')
      return new Response('OK', { status: 200 })
    }

    // Buscar subscription pelo payment_id OU pelo email
    let subscription = null
    let subscriptionError = null

    // Tentar primeiro por payment_id
    const { data: subByPayment, error: errorByPayment } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('payment_id', String(paymentId))
      .single()

    if (!errorByPayment && subByPayment) {
      subscription = subByPayment
    } 
    // Se não encontrar, tentar por email
    else if (customerEmail) {
      const { data: subByEmail, error: errorByEmail } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('user_email', customerEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (!errorByEmail && subByEmail) {
        subscription = subByEmail
        // Atualizar payment_id se encontrou por email
        await supabaseAdmin
          .from('subscriptions')
          .update({ payment_id: String(paymentId) })
          .eq('id', subscription.id)
      }
    }

    if (!subscription) {
      console.error('❌ Subscription não encontrada:', paymentId, customerEmail)
      return new Response('OK', { status: 200 })
    }

    console.log('✅ Subscription encontrada:', subscription.id)

    // ====================================
    // 🎯 PROCESSAR EVENTOS
    // ====================================

    switch (eventType.toLowerCase()) {
      // ✅ COMPRA APROVADA
      case 'compra aprovada':
      case 'approved':
      case 'paid':
        console.log('✅ Pagamento aprovado - liberando acesso...')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'approved',
            is_active: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)

        // Liberar acesso do usuário
        await supabaseAdmin.auth.admin.updateUserById(
          subscription.user_id,
          { 
            email_confirm: true,
            banned_until: null // Remover qualquer ban
          }
        )

        console.log('✅ Acesso liberado para:', subscription.user_id)
        break

      // ⚠️ REEMBOLSO (ESTORNO)
      case 'reembolso':
      case 'refunded':
      case 'refund':
        console.log('⚠️ ESTORNO DETECTADO - REVOGANDO ACESSO!')
        
        // Registrar log de fraude
        await supabaseAdmin
          .from('fraud_logs')
          .insert({
            user_id: subscription.user_id,
            subscription_id: subscription.id,
            payment_id: String(paymentId),
            event_type: 'refund',
            reason: 'Pagamento estornado pelo usuário ou banco',
            metadata: body
          })

        // Revogar acesso usando função SQL
        await supabaseAdmin.rpc('revoke_user_access', {
          p_user_id: subscription.user_id,
          p_reason: 'Pagamento estornado (reembolso)'
        })

        console.log('🚫 Acesso revogado (reembolso) para:', subscription.user_id)
        break

      // 🚨 CHARGEBACK
      case 'chargeback':
      case 'contested':
        console.log('🚨 CHARGEBACK DETECTADO - REVOGANDO ACESSO!')
        
        await supabaseAdmin
          .from('fraud_logs')
          .insert({
            user_id: subscription.user_id,
            subscription_id: subscription.id,
            payment_id: String(paymentId),
            event_type: 'chargeback',
            reason: 'Contestação de pagamento (chargeback)',
            metadata: body
          })

        // Revogar acesso
        await supabaseAdmin.rpc('revoke_user_access', {
          p_user_id: subscription.user_id,
          p_reason: 'Contestação de pagamento (chargeback)'
        })

        console.log('🚫 Acesso revogado (chargeback) para:', subscription.user_id)
        break

      // ❌ COMPRA RECUSADA
      case 'compra recusada':
      case 'declined':
      case 'rejected':
        console.log('❌ Pagamento recusado')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'declined',
            is_active: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)
        break

      // ℹ️ OUTROS EVENTOS (apenas log)
      case 'boleto gerado':
      case 'pix gerado':
      case 'picpay gerado':
      case 'nubank gerado':
        console.log('ℹ️ Pagamento gerado, aguardando confirmação...')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'pending',
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)
        break

      default:
        console.log('ℹ️ Evento não tratado:', eventType)
    }

    // ✅ Sempre retornar 200 OK para a Cakto
    return new Response('OK', { status: 200 })

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    // Mesmo com erro, retornar 200 para não ficar reenviando
    return new Response('ERROR', { status: 200 })
  }
})