/**
 * link-user-subscription
 *
 * Edge Function que vincula um usuário do auth.users à sua subscription
 * quando o user_id está NULL (falha silenciosa no primeiro acesso).
 *
 * Usa service role key para buscar auth.users pelo email.
 * Chamada pelo frontend em dois cenários:
 *   1. signUp retornou "already registered" — usuário existe, subscription desvinculada
 *   2. check-email-status retornou needs_link = true
 */

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

    const { email, subscription_id } = await req.json()

    if (!email || !subscription_id) {
      return new Response(
        JSON.stringify({ success: false, message: 'email e subscription_id são obrigatórios' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()

    // ── 1. Busca o usuário no auth.users pelo email ──────────────────
    const { data: { users }, error: listErr } = await supabaseAdmin.auth.admin.listUsers()

    if (listErr) {
      console.error('Erro ao listar usuários:', listErr.message)
      throw listErr
    }

    const authUser = users.find(u => u.email?.toLowerCase() === normalizedEmail)

    if (!authUser) {
      return new Response(
        JSON.stringify({ success: false, message: 'Usuário não encontrado no Auth.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      )
    }

    const userId = authUser.id

    // ── 2. Confirma o email se ainda não foi confirmado ──────────────
    if (!authUser.email_confirmed_at) {
      const { error: confirmErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        email_confirm: true,
      })

      if (confirmErr) {
        console.warn('Aviso: falha ao confirmar email:', confirmErr.message)
        // Não bloqueia — continua o vínculo
      }
    }

    // ── 3. Verifica se a subscription pertence a este email ──────────
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('subscriptions')
      .select('id, user_id, user_email, payment_status, is_active')
      .eq('id', subscription_id)
      .eq('user_email', normalizedEmail)
      .maybeSingle()

    if (subErr || !sub) {
      return new Response(
        JSON.stringify({ success: false, message: 'Subscription não encontrada ou email não confere.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 }
      )
    }

    if (sub.payment_status !== 'approved' || !sub.is_active) {
      return new Response(
        JSON.stringify({ success: false, message: 'Subscription inativa ou pagamento não aprovado.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // ── 4. Atualiza a subscription com o user_id correto ─────────────
    const { error: updateErr } = await supabaseAdmin
      .from('subscriptions')
      .update({
        user_id:             userId,
        password_created:    true,
        password_created_at: new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      })
      .eq('id', subscription_id)

    if (updateErr) {
      console.error('Erro ao atualizar subscription:', updateErr.message)
      throw updateErr
    }

    console.log(`[link-user-subscription] Vinculado: user ${userId} → subscription ${subscription_id}`)

    return new Response(
      JSON.stringify({ success: true, user_id: userId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('Erro em link-user-subscription:', error.message)
    return new Response(
      JSON.stringify({ success: false, message: 'Erro interno. Tente novamente.' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})