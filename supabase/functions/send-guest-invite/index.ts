// supabase/functions/send-guest-invite/index.ts
/**
 * GranaEvo — send-guest-invite
 *
 * CORREÇÃO ES256: supabaseAdmin.auth.getUser(token) em vez de
 * createClient(url, anonKey) + getUser() com token no global header.
 * O Admin client usa SERVICE_ROLE_KEY (aceita pelo gateway) e delega
 * a validação do token ES256 ao servidor Auth via JWKS.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

function getCorsHeaders(req: Request): Record<string, string> {
  const origin  = req.headers.get('origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// Quantos CONVIDADOS cada plano permite (além do dono)
const GUEST_LIMITS: Record<string, number> = {
  "Individual": 0,
  "Casal":      1,
  "Família":    3,
};

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req)

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Método não permitido." }, 405);
  }

  // ── 1. Extrai o header Authorization ─────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!token || token.length < 20) {
    return json({ success: false, error: "Token de autenticação ausente." }, 401);
  }

  // ── 2. Lê variáveis de ambiente ───────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey   = Deno.env.get("RESEND_API_KEY");

  if (!supabaseUrl || !serviceKey) {
    console.error("[send-guest-invite] Variáveis de ambiente Supabase ausentes");
    return json({ success: false, error: "Configuração interna incompleta." }, 500);
  }

  if (!resendKey) {
    console.error("[send-guest-invite] RESEND_API_KEY ausente");
    return json({ success: false, error: "Configuração de email incompleta." }, 500);
  }

  // ── 3. Admin client ───────────────────────────────────────────────────────
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken:   false,
      persistSession:     false,
      detectSessionInUrl: false,
    },
  });

  // ── 4. Verifica o JWT via Admin client (funciona com ES256 e HS256) ───────
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

  if (userError || !user || !user.id || !user.email) {
    console.error("[send-guest-invite] JWT inválido:", userError?.message ?? "user null");
    return json({ success: false, error: "Sessão inválida ou expirada." }, 401);
  }

  // ── 5. Parse do body ──────────────────────────────────────────────────────
  let guestName: string;
  let guestEmail: string;
  try {
    const body = await req.json();
    guestName  = (body?.guestName  ?? "").trim();
    guestEmail = (body?.guestEmail ?? "").trim().toLowerCase();
  } catch {
    return json({ success: false, error: "Body JSON inválido." }, 400);
  }

  if (!guestName || guestName.length < 2 || guestName.length > 100) {
    return json({ success: false, error: "Nome do convidado inválido (2-100 caracteres)." }, 400);
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!guestEmail || !emailRegex.test(guestEmail)) {
    return json({ success: false, error: "Email do convidado inválido." }, 400);
  }

  const ownerEmail = user.email.toLowerCase().trim();

  // ── 6. Não pode convidar a si mesmo ──────────────────────────────────────
  if (guestEmail === ownerEmail) {
    return json({ success: false, error: "Você não pode convidar seu próprio email." }, 400);
  }

  try {
    // ── 7. Verificar plano do dono ────────────────────────────────────────
    const { data: sub, error: subError } = await supabaseAdmin
      .from("subscriptions")
      .select("plans(name)")
      .eq("user_id", user.id)
      .eq("payment_status", "approved")
      .eq("is_active", true)
      .maybeSingle();

    if (subError || !sub) {
      console.error("[send-guest-invite] Assinatura não encontrada:", subError?.message);
      return json({ success: false, error: "Assinatura não encontrada ou inativa." }, 403);
    }

    const planName: string = (sub as any).plans.name;
    const guestLimit = GUEST_LIMITS[planName] ?? 0;

    if (guestLimit === 0) {
      return json({
        success: false,
        error: `PLAN_BLOCK:${planName}:Você possui o plano ${planName}, que permite apenas 01 email por conta. Faça upgrade para adicionar convidados.`,
      }, 403);
    }

    // ── 8. Contar membros ativos atuais ───────────────────────────────────
    const { data: currentMembers, error: membersError } = await supabaseAdmin
      .from("account_members")
      .select("id, member_email")
      .eq("owner_user_id", user.id)
      .eq("is_active", true);

    if (membersError) {
      console.error("[send-guest-invite] Erro ao listar membros:", membersError.message);
      return json({ success: false, error: "Erro ao verificar membros. Tente novamente." }, 500);
    }

    const memberCount = currentMembers?.length ?? 0;

    if (memberCount >= guestLimit) {
      const emails       = currentMembers?.map((m: any) => m.member_email).join(", ") ?? "";
      const totalAllowed = guestLimit + 1;
      return json({
        success: false,
        error: `LIMIT_REACHED:${planName}:${totalAllowed}:${emails}`,
      }, 403);
    }

    // ── 9. Verificar se já é membro ───────────────────────────────────────
    const alreadyMember = currentMembers?.find((m: any) => m.member_email === guestEmail);
    if (alreadyMember) {
      return json({ success: false, error: "Este email já é membro desta conta." }, 409);
    }

    // ── 10. Rate limit: máx 4 convites por 24h por dono ──────────────────
    const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const { data: recentInvites } = await supabaseAdmin
      .from("guest_invitations")
      .select("id")
      .eq("owner_user_id", user.id)
      .gte("created_at", oneDayAgo);

    if ((recentInvites?.length ?? 0) >= 4) {
      return json({
        success: false,
        error: "Você atingiu o limite de 4 convites em 24h. Tente novamente mais tarde.",
      }, 429);
    }

    // ── 11. Invalidar convites pendentes anteriores para este email ────────
    await supabaseAdmin
      .from("guest_invitations")
      .update({ used: true })
      .eq("owner_user_id", user.id)
      .eq("guest_email", guestEmail)
      .eq("used", false);

    // ── 12. Gerar código de 6 dígitos e salvar ────────────────────────────
    const rnd       = new Uint32Array(1)
    crypto.getRandomValues(rnd)
    const code      = String(100_000 + (rnd[0] % 900_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + 43_200_000).toISOString(); // 12h
    const ownerName = (user.user_metadata?.name as string) || ownerEmail.split("@")[0];

    const { data: invitation, error: invError } = await supabaseAdmin
      .from("guest_invitations")
      .insert({
        owner_user_id: user.id,
        owner_email:   ownerEmail,
        owner_name:    ownerName,
        guest_name:    guestName,
        guest_email:   guestEmail,
        code,
        expires_at:    expiresAt,
      })
      .select()
      .single();

    if (invError || !invitation) {
      console.error("[send-guest-invite] Erro ao criar convite:", invError?.message);
      return json({ success: false, error: "Erro ao criar convite. Tente novamente." }, 500);
    }

    // ── 13. Enviar email via Resend ───────────────────────────────────────
    const emailHtml = buildInviteEmail(guestName, ownerName, planName, invitation.id);

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    "GranaEvo <noreply@granaevo.com>",
        to:      [guestEmail],
        subject: `🎉 ${ownerName} te convidou para o GranaEvo!`,
        html:    emailHtml,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error("[send-guest-invite] Resend error:", errText);
      await supabaseAdmin.from("guest_invitations").delete().eq("id", invitation.id);
      return json({ success: false, error: "Erro ao enviar email de convite." }, 500);
    }

    console.log(`[send-guest-invite] Convite enviado para ${guestEmail} por ${user.id.slice(0, 8)}...`);

    return new Response(
      JSON.stringify({ success: true, code, expiresAt, invitationId: invitation.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[send-guest-invite] Erro inesperado:", errMsg);
    return json({ success: false, error: "Erro interno. Tente novamente." }, 500);
  }
});

// ─── HTML escaping seguro para prevenir XSS em emails ─────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
}

// ─── Template de email do convite ─────────────────────────────────────────────
function buildInviteEmail(
  guestName:  string,
  ownerName:  string,
  planName:   string,
  invId:      string
): string {
  const safeGuestName = escapeHtml(guestName)
  const safeOwnerName = escapeHtml(ownerName)
  const safePlanName  = escapeHtml(planName)
  const safeInvId     = encodeURIComponent(invId)
  const inviteUrl = `https://granaevo.com/convidados?ref=${safeInvId}`;

  return `<!DOCTYPE html>
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
    @media (max-width:600px) {
      .body,.header,.footer { padding-left:24px; padding-right:24px; }
      .h1 { font-size:22px; }
    }
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
        <div class="h1">Olá, ${safeGuestName}! 🎉</div>
        <p class="text">
          Você recebeu um convite exclusivo para acessar a conta <strong>GranaEvo</strong> de um amigo ou familiar.
          Com o GranaEvo vocês poderão organizar as finanças juntos, de forma simples e segura.
        </p>
        <div class="divider"></div>
        <div class="invite-box">
          <div class="invite-icon">💌</div>
          <div class="invite-from">Convite enviado por</div>
          <div class="invite-name">${safeOwnerName}</div>
          <div style="margin:12px 0; color:#64748b; font-size:14px;">Plano ativo:</div>
          <span class="invite-plan">${safePlanName}</span>
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
            Você precisará do <strong>código de 6 dígitos</strong> fornecido por <strong>${safeOwnerName}</strong>
            para ativar sua conta. Solicite-o diretamente a ele(a) antes de prosseguir.<br><br>
            Se você não solicitou este convite, ignore este email com segurança.
          </div>
        </div>
      </div>
      <div class="footer">
        <div class="footer-brand">GranaEvo</div>
        <div class="footer-copy">
          © 2026 GranaEvo. Todos os direitos reservados.<br>
          Você recebeu este email porque alguém utilizou seu endereço em um convite.
        </div>
      </div>
    </div>
    <div class="outer"><span>Evolua suas finanças com inteligência · granaevo.com</span></div>
  </div>
</div>
</body>
</html>`;
}