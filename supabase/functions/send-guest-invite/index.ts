import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Quantos CONVIDADOS cada plano permite (além do dono)
const GUEST_LIMITS: Record<string, number> = {
  'Individual': 0,
  'Casal': 1,
  'Família': 3,
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Não autorizado')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    })
    const supabaseAdmin = createClient(supabaseUrl, serviceKey)

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !user) throw new Error('Sessão inválida')

    const { guestName, guestEmail } = await req.json()
    if (!guestName || !guestEmail) throw new Error('Nome e email são obrigatórios')

    const guestEmailNorm = guestEmail.toLowerCase().trim()
    const ownerEmail = user.email!.toLowerCase().trim()

    // ── 1. Não pode convidar a si mesmo
    if (guestEmailNorm === ownerEmail) {
      throw new Error('Você não pode convidar seu próprio email.')
    }

    // ── 2. Verificar plano do dono
    const { data: sub, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('plans(name)')
      .eq('user_id', user.id)
      .eq('payment_status', 'approved')
      .eq('is_active', true)
      .maybeSingle()

    if (subError || !sub) throw new Error('Assinatura não encontrada ou inativa.')

    const planName: string = (sub as any).plans.name
    const guestLimit = GUEST_LIMITS[planName] ?? 0

    if (guestLimit === 0) {
      throw new Error(
        `PLAN_BLOCK:${planName}:Você possui o plano ${planName}, que permite apenas 01 email por conta. Faça upgrade para adicionar convidados.`
      )
    }

    // ── 3. Contar membros ativos atuais
    const { data: currentMembers } = await supabaseAdmin
      .from('account_members')
      .select('id, member_email')
      .eq('owner_user_id', user.id)
      .eq('is_active', true)

    const memberCount = currentMembers?.length ?? 0

    if (memberCount >= guestLimit) {
      const emails = currentMembers?.map((m: any) => m.member_email).join(', ') || ''
      const totalAllowed = guestLimit + 1
      throw new Error(`LIMIT_REACHED:${planName}:${totalAllowed}:${emails}`)
    }

    // ── 4. Verificar se já é membro
    const alreadyMember = currentMembers?.find((m: any) => m.member_email === guestEmailNorm)
    if (alreadyMember) throw new Error('Este email já é membro desta conta.')

    // ── 5. Rate limit: máx 4 convites por 24h por dono
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString()
    const { data: recentInvites } = await supabaseAdmin
      .from('guest_invitations')
      .select('id')
      .eq('owner_user_id', user.id)
      .gte('created_at', oneDayAgo)

    if ((recentInvites?.length ?? 0) >= 4) {
      throw new Error('Você atingiu o limite de 4 convites em 24h. Tente novamente mais tarde.')
    }

    // ── 6. Invalidar convites pendentes anteriores para este email
    await supabaseAdmin
      .from('guest_invitations')
      .update({ used: true })
      .eq('owner_user_id', user.id)
      .eq('guest_email', guestEmailNorm)
      .eq('used', false)

    // ── 7. Gerar código de 6 dígitos e salvar
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 43200000).toISOString() // 12h

    const ownerName = user.user_metadata?.name || ownerEmail.split('@')[0]

    const { data: invitation, error: invError } = await supabaseAdmin
      .from('guest_invitations')
      .insert({
        owner_user_id: user.id,
        owner_email: ownerEmail,
        owner_name: ownerName,
        guest_name: guestName,
        guest_email: guestEmailNorm,
        code,
        expires_at: expiresAt,
      })
      .select()
      .single()

    if (invError || !invitation) throw invError ?? new Error('Erro ao criar convite')

    // ── 8. Enviar email via Resend
    const resendKey = Deno.env.get('RESEND_API_KEY')!
    const emailHtml = buildInviteEmail(guestName, ownerName, planName, invitation.id)

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'GranaEvo <noreply@granaevo.com>',
        to: [guestEmailNorm],
        subject: `🎉 ${ownerName} te convidou para o GranaEvo!`,
        html: emailHtml,
      }),
    })

    if (!emailRes.ok) {
      const errText = await emailRes.text()
      console.error('Resend error:', errText)
      throw new Error('Erro ao enviar email de convite.')
    }

    return new Response(
      JSON.stringify({ success: true, code, expiresAt, invitationId: invitation.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error: any) {
    console.error('❌ send-guest-invite:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})

function buildInviteEmail(guestName: string, ownerName: string, planName: string, invId: string): string {
  const inviteUrl = `https://granaevo.com/convidados?ref=${invId}`
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Convite GranaEvo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#060810; font-family:'Outfit',-apple-system,sans-serif; color:#e2e8f0; }
    .bg { background:#060810; padding:48px 16px; }
    .wrapper { max-width:620px; margin:0 auto; }
    .top-label { text-align:center; padding-bottom:28px; }
    .top-label span { font-size:13px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:#10b981; opacity:.7; }
    .card { background:linear-gradient(160deg,#0d1117 0%,#111827 60%,#0a0f1a 100%); border:1px solid rgba(16,185,129,.18); border-radius:24px; overflow:hidden; box-shadow:0 32px 64px rgba(0,0,0,.7); }
    .header { position:relative; padding:52px 48px 44px; text-align:center; background:linear-gradient(135deg,#064e35 0%,#065f46 40%,#047857 100%); overflow:hidden; }
    .header-grid { position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px); background-size:32px 32px; }
    .logo-wrap { position:relative; display:inline-block; margin-bottom:20px; z-index:2; }
    .logo-ring { position:absolute; inset:-6px; border-radius:22px; background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.2); }
    .logo-img { position:relative; width:72px; height:72px; border-radius:16px; display:block; background:#fff; object-fit:contain; }
    .brand { position:relative; z-index:2; font-size:30px; font-weight:900; color:#fff; display:block; margin-bottom:6px; }
    .tagline { position:relative; z-index:2; font-size:14px; color:rgba(255,255,255,.75); }
    .body { padding:48px 48px 40px; }
    .eyebrow { display:inline-block; font-size:11px; font-weight:700; letter-spacing:2.5px; text-transform:uppercase; color:#10b981; margin-bottom:10px; }
    .h1 { font-size:28px; font-weight:800; color:#f1f5f9; margin-bottom:16px; line-height:1.25; }
    .text { font-size:16px; line-height:1.75; color:#94a3b8; }
    .text strong { color:#e2e8f0; font-weight:600; }
    .divider { height:1px; background:linear-gradient(90deg,transparent,rgba(16,185,129,.25),transparent); margin:32px 0; }
    .invite-box { background:rgba(16,185,129,.06); border:1px solid rgba(16,185,129,.25); border-radius:18px; padding:32px; text-align:center; margin:28px 0; }
    .invite-icon { font-size:3rem; margin-bottom:16px; }
    .invite-from { font-size:13px; color:#64748b; margin-bottom:8px; text-transform:uppercase; letter-spacing:1.5px; font-weight:600; }
    .invite-name { font-size:26px; font-weight:900; color:#10b981; margin-bottom:8px; }
    .invite-plan { display:inline-block; padding:6px 16px; background:rgba(16,185,129,.15); border:1px solid rgba(16,185,129,.3); border-radius:50px; font-size:13px; color:#10b981; font-weight:600; }
    .cta-section { text-align:center; margin:36px 0; }
    .cta-sub { font-size:14px; color:#64748b; margin-bottom:18px; }
    .cta-btn { display:inline-block; background:linear-gradient(135deg,#10b981 0%,#059669 100%); color:#fff !important; text-decoration:none; padding:16px 44px; border-radius:12px; font-weight:700; font-size:16px; box-shadow:0 8px 24px rgba(16,185,129,.35); }
    .cta-note { font-size:12px; color:#475569; margin-top:14px; }
    .info-box { background:rgba(10,11,20,.5); border:1px solid rgba(16,185,129,.15); border-left:3px solid #10b981; border-radius:12px; padding:20px 24px; margin-top:24px; }
    .info-label { font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#10b981; margin-bottom:10px; }
    .info-text { font-size:14px; color:#94a3b8; line-height:1.65; }
    .footer { padding:32px 48px; border-top:1px solid rgba(255,255,255,.05); background:rgba(0,0,0,.2); text-align:center; }
    .footer-brand { font-size:18px; font-weight:900; color:#10b981; margin-bottom:12px; }
    .footer-copy { font-size:12px; color:#334155; line-height:1.6; }
    .outer { text-align:center; padding-top:28px; }
    .outer span { font-size:12px; color:#1e293b; }
    @media (max-width:600px) { .body,.header,.footer { padding-left:24px; padding-right:24px; } .h1 { font-size:22px; } }
  </style>
</head>
<body>
<div class="bg">
  <div class="wrapper">
    <div class="top-label"><span>G R A N A E V O</span></div>
    <div class="card">
      <div class="header">
        <div class="header-grid"></div>
        <div class="logo-wrap">
          <div class="logo-ring"></div>
          <img class="logo-img" src="https://raw.githubusercontent.com/GranaDev/granaevo/main/icon/granaevo-logo.jpg" alt="GranaEvo">
        </div>
        <span class="brand">GranaEvo</span>
        <span class="tagline">Domine suas finanças com inteligência</span>
      </div>
      <div class="body">
        <span class="eyebrow">Convite Especial ✦</span>
        <div class="h1">Olá, ${guestName}! 🎉</div>
        <p class="text">
          Você recebeu um convite exclusivo para acessar a conta <strong>GranaEvo</strong> de um amigo ou familiar. 
          Com o GranaEvo vocês poderão organizar as finanças juntos, de forma simples e segura.
        </p>
        <div class="divider"></div>
        <div class="invite-box">
          <div class="invite-icon">💌</div>
          <div class="invite-from">Convite enviado por</div>
          <div class="invite-name">${ownerName}</div>
          <div style="margin:12px 0; color:#64748b; font-size:14px;">Plano ativo:</div>
          <span class="invite-plan">${planName}</span>
        </div>
        <div class="cta-section">
          <div class="cta-sub">Clique abaixo para aceitar o convite e criar sua senha de acesso</div>
          <a href="${inviteUrl}" class="cta-btn">✅ Aceitar Convite →</a>
          <div class="cta-note">⏰ Este convite expira em 12 horas</div>
        </div>
        <div class="divider"></div>
        <div class="info-box">
          <div class="info-label">⚠️ Importante</div>
          <div class="info-text">
            Você precisará do <strong>código de 6 dígitos</strong> fornecido por <strong>${ownerName}</strong> 
            para ativar sua conta. Solicite-o diretamente a ele(a) antes de prosseguir.<br><br>
            Se você não solicitou este convite, ignore este email com segurança.
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-brand">GranaEvo</div>
        <div class="footer-copy">© 2026 GranaEvo. Todos os direitos reservados.<br>
        Você recebeu este email porque alguém utilizou seu endereço em um convite.</div>
      </div>
    </div>
    <div class="outer"><span>Evolua suas finanças com inteligência · granaevo.vercel.app</span></div>
  </div>
</div>
</body>
</html>`
}