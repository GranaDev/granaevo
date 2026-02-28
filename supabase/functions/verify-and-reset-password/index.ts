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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { email, code, newPassword } = await req.json()

    if (!email || !code || !newPassword) {
      throw new Error('Email, código e nova senha são obrigatórios')
    }

    const normalizedEmail = email.toLowerCase().trim()
    console.log('🔐 Verificando código para:', normalizedEmail)

    // 1. Buscar código válido
    const { data: resetCode, error: codeError } = await supabase
      .from('password_reset_codes')
      .select('*')
      .eq('email', normalizedEmail)
      .eq('code', code)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (codeError) {
      console.error('Erro ao buscar código:', codeError)
      throw codeError
    }

    if (!resetCode) {
      return new Response(
        JSON.stringify({ 
          status: 'invalid_code',
          message: 'Código inválido, expirado ou já utilizado'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    console.log('✅ Código válido encontrado')

    // 2. Buscar usuário no Auth
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('user_email', normalizedEmail)
      .eq('is_active', true)
      .maybeSingle()

    if (!subscription || !subscription.user_id) {
      throw new Error('Usuário não encontrado')
    }

    console.log('👤 Atualizando senha do usuário:', subscription.user_id)

    // 3. Atualizar senha usando Admin API
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      subscription.user_id,
      { password: newPassword }
    )

    if (updateError) {
      console.error('❌ Erro ao atualizar senha:', updateError)
      throw updateError
    }

    console.log('✅ Senha atualizada com sucesso')

    // 4. Marcar código como usado
    await supabase
      .from('password_reset_codes')
      .update({ 
        used: true, 
        used_at: new Date().toISOString() 
      })
      .eq('id', resetCode.id)

    console.log('✅ Código marcado como usado')

    return new Response(
      JSON.stringify({ 
        status: 'success',
        message: 'Senha alterada com sucesso!'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ status: 'error', message: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})