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
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { email } = await req.json()

    if (!email) {
      return new Response(
        JSON.stringify({ status: 'error', message: 'Email é obrigatório' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()

    // ── Busca subscription ───────────────────────────────────────────
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        id,
        user_id,
        plan_id,
        payment_status,
        password_created,
        user_name,
        user_email,
        is_active,
        plans(name)
      `)
      .eq('user_email', normalizedEmail)
      .eq('is_active', true)
      .order('created_at', { ascending: false })

    if (subError) {
      console.error('Erro ao buscar subscription:', subError.message)
      throw subError
    }

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ status: 'not_found' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    const subscription = subscriptions[0]

    // ── Pagamento não aprovado ───────────────────────────────────────
    if (subscription.payment_status !== 'approved') {
      return new Response(
        JSON.stringify({ status: 'payment_pending' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── [FIX-01] Senha já criada — mas verifica se user_id está vinculado ──
    if (subscription.password_created) {
      // Descobre se o user_id ainda está NULL (falha silenciosa anterior)
      const needsLink = !subscription.user_id

      let needsLinkConfirmed = needsLink

      // Dupla verificação: mesmo com password_created = true e user_id preenchido,
      // confirma que o usuário realmente existe no Auth (registro pode ter corrompido)
      if (!needsLink && subscription.user_id) {
        const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.getUserById(subscription.user_id)
        if (authErr || !authUser?.user) {
          // user_id aponta para usuário inexistente — precisa revincular
          needsLinkConfirmed = true
        }
      }

      return new Response(
        JSON.stringify({
          status: 'password_exists',
          needs_link: needsLinkConfirmed,
          data: needsLinkConfirmed ? {
            subscription_id: subscription.id,
            email: normalizedEmail,
          } : null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── [FIX-02] password_created = false, mas user_id já está preenchido ──
    // Isso indica que o signUp funcionou mas o UPDATE de password_created falhou.
    // Corrige aqui mesmo, no backend, antes de devolver 'ready'.
    if (!subscription.password_created && subscription.user_id) {
      console.warn(`[check-email-status] Corrigindo password_created para subscription ${subscription.id}`)

      await supabaseAdmin
        .from('subscriptions')
        .update({
          password_created:    true,
          password_created_at: new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        })
        .eq('id', subscription.id)

      // Retorna como se a senha já existisse — usuário deve fazer login
      return new Response(
        JSON.stringify({
          status: 'password_exists',
          needs_link: false,
          data: null,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── Tudo OK — pode criar senha ───────────────────────────────────
    return new Response(
      JSON.stringify({
        status: 'ready',
        data: {
          subscription_id: subscription.id,
          user_name:       subscription.user_name || 'Usuário',
          plan_name:       subscription.plans?.name || 'Plano não identificado',
          email:           normalizedEmail,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('Erro em check-email-status:', error.message)
    return new Response(
      JSON.stringify({ status: 'error', message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})