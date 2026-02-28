import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_ATTEMPTS = 5

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseAdmin = createClient(supabaseUrl, serviceKey)

    const { step, email, code, password, acceptedTerms, ipAddress, userAgent } = await req.json()

    const emailNorm = email?.toLowerCase().trim()
    if (!emailNorm || !code) throw new Error('Email e código são obrigatórios.')

    // ── Buscar convite válido
    const { data: invitation, error: invError } = await supabaseAdmin
      .from('guest_invitations')
      .select('*')
      .eq('guest_email', emailNorm)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (invError || !invitation) {
      throw new Error('Convite não encontrado, já utilizado ou expirado.')
    }

    // ── Verificar tentativas excessivas
    if ((invitation.verification_attempts ?? 0) >= MAX_ATTEMPTS) {
      throw new Error('Muitas tentativas incorretas. Este convite foi bloqueado por segurança.')
    }

    // ── Verificar código
    if (invitation.code !== code.trim()) {
      await supabaseAdmin
        .from('guest_invitations')
        .update({ verification_attempts: (invitation.verification_attempts ?? 0) + 1 })
        .eq('id', invitation.id)
      throw new Error('Código inválido. Verifique com quem te convidou.')
    }

    // ── STEP 1: Verificação
    if (step === 'verify') {
      return new Response(
        JSON.stringify({
          success: true,
          guestName: invitation.guest_name,
          ownerName: invitation.owner_name,
          invitationId: invitation.id,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // ── STEP 2: Criar conta
    if (step === 'create') {
      if (!password || password.length < 6) {
        throw new Error('A senha deve ter no mínimo 6 caracteres.')
      }
      if (!acceptedTerms) {
        throw new Error('Você precisa aceitar os Termos de Uso.')
      }

      // ✅ NOVA VERIFICAÇÃO: checar apenas nas suas próprias tabelas

      // 1) Já é convidado ativo de alguma conta?
      const { data: existingMember } = await supabaseAdmin
        .from('account_members')
        .select('id, owner_email')
        .eq('member_email', emailNorm)
        .eq('is_active', true)
        .maybeSingle()

      if (existingMember) {
        throw new Error('Este email já é convidado de outra conta. Entre em contato com o suporte.')
      }

      // 2) Tem convite já utilizado anteriormente (conta já criada por convite)?
      const { data: usedInvite } = await supabaseAdmin
        .from('guest_invitations')
        .select('id')
        .eq('guest_email', emailNorm)
        .eq('used', true)
        .limit(1)
        .maybeSingle()

      if (usedInvite) {
        throw new Error('Este email já aceitou um convite anteriormente. Tente fazer login diretamente.')
      }

      // 3) (Opcional) Tem assinatura própria? Descomente se tiver tabela subscriptions
      // const { data: existingSub } = await supabaseAdmin
      //   .from('subscriptions')
      //   .select('id')
      //   .eq('email', emailNorm)
      //   .eq('status', 'active')
      //   .maybeSingle()
      // if (existingSub) {
      //   throw new Error('Este email já possui uma assinatura ativa. Faça login normalmente.')
      // }

      // ✅ Criar usuário no Supabase Auth
      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: emailNorm,
        password,
        email_confirm: true,
        user_metadata: {
          name: invitation.guest_name,
          is_guest: true,
          owner_user_id: invitation.owner_user_id,
        },
      })

      // ✅ Tratar erro de email duplicado no auth separadamente
      if (createError) {
        console.error('Erro ao criar usuário:', createError)
        if (createError.message?.includes('already been registered') || 
            createError.message?.includes('already exists') ||
            createError.code === 'email_exists') {
          throw new Error('Este email já possui login cadastrado. Se você esqueceu sua senha, use a recuperação de senha na tela de login.')
        }
        throw createError
      }

      if (!newUser?.user) {
        throw new Error('Erro inesperado ao criar conta. Tente novamente.')
      }

      console.log('✅ Usuário criado:', newUser.user.id, '→', emailNorm)

      // ✅ Registrar em account_members
      const { error: memberError } = await supabaseAdmin.from('account_members').insert({
        owner_user_id: invitation.owner_user_id,
        owner_email: invitation.owner_email,
        member_user_id: newUser.user.id,
        member_email: emailNorm,
        member_name: invitation.guest_name,
        invitation_id: invitation.id,
        joined_at: new Date().toISOString(),
        is_active: true,
      })

      if (memberError) {
        console.error('Erro ao inserir account_member:', memberError)
        await supabaseAdmin.auth.admin.deleteUser(newUser.user.id)
        throw new Error('Erro ao vincular conta ao dono. Tente novamente.')
      }

      console.log('✅ Membro vinculado ao dono:', invitation.owner_email)

      // ✅ Registrar aceite de termos (não crítico)
      await supabaseAdmin.from('terms_acceptance').insert({
        user_id: newUser.user.id,
        email: emailNorm,
        accepted: true,
        ip_address: ipAddress ?? null,
        user_agent: userAgent ?? null,
      }).then(({ error }) => {
        if (error) console.warn('Aviso: erro ao salvar terms_acceptance:', error.message)
      })

      // ✅ Marcar convite como usado
      await supabaseAdmin
        .from('guest_invitations')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('id', invitation.id)

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Conta criada com sucesso! Você já pode fazer login.',
          userId: newUser.user.id,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    throw new Error('Step inválido. Use "verify" ou "create".')

  } catch (error: any) {
    console.error('❌ verify-guest-invite:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})