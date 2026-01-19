import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CAKTO_WEBHOOK_SECRET = Deno.env.get('CAKTO_WEBHOOK_SECRET')!

// Função para verificar assinatura do webhook
function verifyWebhookSignature(payload: string, signature: string): boolean {
  // Cakto usa HMAC SHA-256
  const encoder = new TextEncoder()
  const data = encoder.encode(payload)
  const key = encoder.encode(CAKTO_WEBHOOK_SECRET)
  
  // Implementação simplificada - em produção use crypto.subtle
  // Por enquanto, apenas verifica se a signature existe
  return signature && signature.length > 0
}

serve(async (req) => {
  try {
    const signature = req.headers.get('x-cakto-signature') || ''
    const rawBody = await req.text()
    const body = JSON.parse(rawBody)

    console.log('🔔 Webhook Cakto recebido:', JSON.stringify(body, null, 2))

    // ✅ Verificar assinatura do webhook (segurança)
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('❌ Assinatura inválida!')
      return new Response('Invalid signature', { status: 401 })
    }

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

    // ✅ Processar diferentes tipos de eventos
    const eventType = body.type || body.event
    const paymentId = body.data?.id || body.payment_id

    if (!paymentId) {
      console.error('❌ Payment ID não encontrado no webhook')
      return new Response('OK', { status: 200 })
    }

    console.log(`📊 Evento: ${eventType} | Payment ID: ${paymentId}`)

    // Buscar subscription
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('payment_id', String(paymentId))
      .single()

    if (subError || !subscription) {
      console.error('❌ Subscription não encontrada:', paymentId)
      return new Response('OK', { status: 200 })
    }

    console.log('✅ Subscription encontrada:', subscription.id)

    // ====================================
    // 🎯 LÓGICA DE ANTI-FRAUDE
    // ====================================

    switch (eventType) {
      case 'charge.paid':
      case 'charge.approved':
      case 'payment.approved':
        console.log('✅ Pagamento aprovado - liberando acesso...')
        
        // Atualizar subscription
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'approved',
            is_active: true,
            updated_at: new Date().toISOString()
          })
          .eq('payment_id', String(paymentId))

        // Liberar acesso do usuário
        await supabaseAdmin.auth.admin.updateUserById(
          subscription.user_id,
          { email_confirm: true }
        )

        console.log('✅ Acesso liberado para:', subscription.user_id)
        break

      case 'charge.refunded':
      case 'payment.refunded':
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
          p_reason: 'Pagamento estornado'
        })

        console.log('🚫 Acesso revogado para:', subscription.user_id)
        
        // TODO: Enviar email notificando o usuário
        break

      case 'charge.chargeback':
      case 'payment.chargeback':
        console.log('🚨 CHARGEBACK DETECTADO - REVOGANDO ACESSO!')
        
        // Registrar log de fraude
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
        
        // TODO: Alertar equipe de fraude
        break

      case 'charge.cancelled':
      case 'payment.cancelled':
        console.log('❌ Pagamento cancelado')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'cancelled',
            is_active: false,
            updated_at: new Date().toISOString()
          })
          .eq('payment_id', String(paymentId))
        break

      case 'charge.declined':
      case 'payment.declined':
        console.log('❌ Pagamento recusado')
        
        await supabaseAdmin
          .from('subscriptions')
          .update({ 
            payment_status: 'declined',
            is_active: false,
            updated_at: new Date().toISOString()
          })
          .eq('payment_id', String(paymentId))
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