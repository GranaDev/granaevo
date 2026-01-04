import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Headers CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function generateRandomPassword(length = 12) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%'
  let password = ''
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return password
}

serve(async (req) => {
  // Tratar requisições OPTIONS (preflight CORS)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log('🔔 Webhook recebido do Mercado Pago')

    const { type, data } = await req.json()

    // Ignorar notificações que não são de pagamento
    if (type !== 'payment') {
      console.log('ℹ️ Notificação ignorada (não é pagamento):', type)
      return new Response('OK', { status: 200, headers: corsHeaders })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    console.log('💳 ID do pagamento:', data.id)

    // Buscar assinatura associada a este pagamento
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('*, profiles(*)')
      .eq('payment_id', data.id)
      .single()

    if (subError || !subscription) {
      console.log('⚠️ Assinatura não encontrada para payment_id:', data.id)
      return new Response('OK', { status: 200, headers: corsHeaders })
    }

    const oldStatus = subscription.payment_status
    console.log(`📊 Status anterior: ${oldStatus} → novo: ${data.status}`)

    // Atualizar status do pagamento
    await supabase
      .from('subscriptions')
      .update({ payment_status: data.status })
      .eq('payment_id', data.id)

    // Se pagamento foi aprovado AGORA (mudou de pending para approved)
    if (data.status === 'approved' && oldStatus !== 'approved') {
      console.log('✅ Pagamento aprovado! Ativando conta...')

      // Buscar dados do usuário
      const { data: { user } } = await supabase.auth.admin.getUserById(subscription.user_id)

      if (user) {
        // Gerar nova senha
        const randomPassword = generateRandomPassword()

        // Confirmar email do usuário
        await supabase.auth.admin.updateUserById(subscription.user_id, {
          email_confirm: true,
          password: randomPassword
        })

        // Criar perfil se não existir
        if (!subscription.profiles || subscription.profiles.length === 0) {
          await supabase
            .from('profiles')
            .insert({
              user_id: subscription.user_id,
              name: user.user_metadata?.name || 'Perfil Principal'
            })
        }

        console.log('📧 Enviando email de boas-vindas...')

        // Enviar email de boas-vindas
        await supabase.functions.invoke('send-welcome-email', {
          body: {
            email: user.email,
            name: user.user_metadata?.name || 'Usuário',
            password: randomPassword,
            plan: user.user_metadata?.plan || 'Premium'
          }
        })

        console.log('✅ Conta ativada com sucesso!')
      }
    }

    // Se pagamento foi rejeitado
    else if (data.status === 'rejected' || data.status === 'cancelled') {
      console.log('❌ Pagamento rejeitado/cancelado')
      // Aqui você pode enviar email informando o problema
    }

    return new Response('OK', { status: 200, headers: corsHeaders })

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    return new Response('Error', { status: 500, headers: corsHeaders })
  }
})