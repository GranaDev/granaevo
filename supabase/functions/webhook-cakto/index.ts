import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { createHmac } from 'https://deno.land/std@0.177.0/node/crypto.ts'

const CAKTO_WEBHOOK_SECRET = Deno.env.get('CAKTO_WEBHOOK_SECRET')

// Verificar assinatura HMAC do webhook
function verifyWebhookSignature(payload: string, signature: string | null): boolean {
  if (!signature || !CAKTO_WEBHOOK_SECRET) {
    console.warn('⚠️ Verificação de assinatura desabilitada')
    return true // Em produção, retorne false
  }

  try {
    const hmac = createHmac('sha256', CAKTO_WEBHOOK_SECRET)
    hmac.update(payload)
    const computedSignature = hmac.digest('hex')
    
    const isValid = signature === computedSignature
    console.log(isValid ? '✅ Assinatura válida' : '❌ Assinatura inválida')
    return isValid
  } catch (error) {
    console.error('❌ Erro ao verificar assinatura:', error)
    return false
  }
}

serve(async (req) => {
  try {
    const signature = req.headers.get('x-cakto-signature') || 
                     req.headers.get('x-webhook-signature')
    
    const rawBody = await req.text()
    const body = JSON.parse(rawBody)

    console.log('🔔 Webhook Cakto recebido')
    console.log('📦 Dados:', JSON.stringify(body, null, 2))

    // Verificar assinatura (descomente em produção)
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

    // Identificar evento e dados
    const eventType = body.event || body.type || body.evento || ''
    const data = body.data || body
    
    const paymentId = data.id || 
                     data.charge_id || 
                     data.transaction_id || 
                     data.payment_id

    const customerEmail = data.customer?.email || 
                         data.email || 
                         data.customer_email

    const status = data.status || ''

    console.log(`📊 Evento: ${eventType}`)
    console.log(`💳 Payment ID: ${paymentId}`)
    console.log(`📧 Email: ${customerEmail}`)
    console.log(`🎯 Status: ${status}`)

    if (!paymentId) {
      console.error('❌ Payment ID não encontrado no webhook')
      return new Response('OK', { status: 200 })
    }

    // Buscar subscription
    let subscription = null

    // Tentar por payment_id
    const { data: subByPayment } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('payment_id', String(paymentId))
      .single()

    if (subByPayment) {
      subscription = subByPayment
    } 
    // Tentar por email
    else if (customerEmail) {
      const { data: subByEmail } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('user_email', customerEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (subByEmail) {
        subscription = subByEmail
        
        // Atualizar payment_id
        await supabaseAdmin
          .from('subscriptions')
          .update({ payment_id: String(paymentId) })
          .eq('id', subscription.id)
      }
    }

    if (!subscription) {
      console.error('❌ Subscription não encontrada para payment_id:', paymentId)
      return new Response('OK', { status: 200 })
    }

    console.log('✅ Subscription encontrada:', subscription.id)

    // Processar evento baseado no status
    switch (status.toLowerCase()) {
      case 'approved':
      case 'paid':
      case 'confirmed':
        console.log('✅ PAGAMENTO APROVADO - Liberando acesso')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'approved',
            is_active: true,
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)

        await supabaseAdmin.auth.admin.updateUserById(
          subscription.user_id,
          { 
            email_confirm: true,
            banned_until: null
          }
        )

        console.log('✅ Acesso liberado para usuário:', subscription.user_id)
        break

      case 'refunded':
      case 'refund':
        console.log('⚠️ REEMBOLSO DETECTADO - Revogando acesso')
        
        // Log de fraude (opcional)
        await supabaseAdmin
          .from('fraud_logs')
          .insert({
            user_id: subscription.user_id,
            subscription_id: subscription.id,
            payment_id: String(paymentId),
            event_type: 'refund',
            reason: 'Pagamento estornado',
            metadata: body
          })
          .then(({ error }) => {
            if (error) console.warn('⚠️ Tabela fraud_logs não existe')
          })

        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'refunded',
            is_active: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)

        // Banir usuário
        await supabaseAdmin.auth.admin.updateUserById(
          subscription.user_id,
          { 
            banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        )

        console.log('🚫 Acesso revogado (reembolso):', subscription.user_id)
        break

      case 'chargeback':
      case 'contested':
        console.log('🚨 CHARGEBACK DETECTADO - Revogando acesso')
        
        await supabaseAdmin
          .from('fraud_logs')
          .insert({
            user_id: subscription.user_id,
            subscription_id: subscription.id,
            payment_id: String(paymentId),
            event_type: 'chargeback',
            reason: 'Contestação de pagamento',
            metadata: body
          })
          .then(({ error }) => {
            if (error) console.warn('⚠️ Tabela fraud_logs não existe')
          })

        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'chargeback',
            is_active: false,
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)

        await supabaseAdmin.auth.admin.updateUserById(
          subscription.user_id,
          { 
            banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        )

        console.log('🚫 Acesso revogado (chargeback):', subscription.user_id)
        break

      case 'declined':
      case 'rejected':
      case 'failed':
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

      case 'pending':
      case 'processing':
        console.log('ℹ️ Aguardando confirmação do pagamento')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'pending',
            updated_at: new Date().toISOString()
          })
          .eq('id', subscription.id)
        break

      default:
        console.log('ℹ️ Status não tratado:', status)
    }

    console.log('✅ Webhook processado com sucesso')
    return new Response('OK', { status: 200 })

  } catch (error: any) {
    console.error('❌ Erro no webhook:', error)
    return new Response('ERROR', { status: 200 })
  }
})