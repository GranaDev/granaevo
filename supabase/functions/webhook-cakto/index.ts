import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CAKTO_WEBHOOK_SECRET = Deno.env.get('CAKTO_WEBHOOK_SECRET')

serve(async (req) => {
  try {
    const rawBody = await req.text()
    const body = JSON.parse(rawBody)

    console.log('🔔 Webhook recebido:', JSON.stringify(body, null, 2))

    // Opcional: Verificar assinatura do webhook
    // const signature = req.headers.get('x-cakto-signature')
    // if (CAKTO_WEBHOOK_SECRET && signature) {
    //   // Implementar verificação HMAC aqui
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
    
    // ID do pagamento (pode variar conforme estrutura da Cakto)
    const paymentId = data.id || 
                     data.charge_id || 
                     data.transaction_id || 
                     data.payment_id

    const customerEmail = data.customer?.email || 
                         data.email || 
                         data.customer_email

    console.log(`📊 Evento: ${eventType}`)
    console.log(`💳 Payment ID: ${paymentId}`)
    console.log(`📧 Email: ${customerEmail}`)

    if (!paymentId) {
      console.error('❌ Payment ID não encontrado')
      return new Response('OK', { status: 200 })
    }

    // Buscar subscription
    let subscription = null

    // Tentar por payment_id
    const { data: subByPayment, error: errorByPayment } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('payment_id', String(paymentId))
      .single()

    if (!errorByPayment && subByPayment) {
      subscription = subByPayment
    } 
    // Tentar por email
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
        
        // Atualizar payment_id
        await supabaseAdmin
          .from('subscriptions')
          .update({ payment_id: String(paymentId) })
          .eq('id', subscription.id)
      }
    }

    if (!subscription) {
      console.error('❌ Subscription não encontrada')
      return new Response('OK', { status: 200 })
    }

    console.log('✅ Subscription encontrada:', subscription.id)

    // Processar evento
    const status = data.status || ''
    
    switch (status.toLowerCase()) {
      case 'approved':
      case 'paid':
      case 'confirmed':
        console.log('✅ PAGAMENTO APROVADO - Liberando acesso...')
        
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

        console.log('✅ Acesso liberado:', subscription.user_id)
        break

      case 'refunded':
      case 'refund':
        console.log('⚠️ REEMBOLSO - Revogando acesso')
        
        // Registrar log
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
            if (error) console.warn('Tabela fraud_logs não existe:', error)
          })

        // Desativar subscription
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
            banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString() // 100 anos
          }
        )

        console.log('🚫 Acesso revogado (reembolso):', subscription.user_id)
        break

      case 'chargeback':
      case 'contested':
        console.log('🚨 CHARGEBACK - Revogando acesso')
        
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
            if (error) console.warn('Tabela fraud_logs não existe:', error)
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
        console.log('ℹ️ Aguardando confirmação')
        
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

    return new Response('OK', { status: 200 })

  } catch (error: any) {
    console.error('❌ Erro no webhook:', error)
    return new Response('ERROR', { status: 200 })
  }
})