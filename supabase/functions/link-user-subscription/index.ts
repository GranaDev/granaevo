// supabase/functions/link-user-subscription/index.ts
/**
 * GranaEvo — link-user-subscription
 *
 * CORREÇÃO ES256: supabaseAdmin.auth.getUser(token) em vez de
 * createClient(url, anonKey) + getUser() com token no global header.
 * O Admin client usa SERVICE_ROLE_KEY (aceita pelo gateway) e delega
 * a validação do token ES256 ao servidor Auth via JWKS.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

const ALLOWED_ORIGINS = [
  "https://granaevo.vercel.app",
  "https://granaevo.com",
  "https://www.granaevo.com",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin  = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-proxy-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const CORS_HEADERS = getCorsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ success: false, message: "Método não permitido." }, 405);
  }

  // ── 0. Proxy secret obrigatório — bloqueia chamadas diretas ──────────────
  // [GOD5-M01] fail-closed: sem PROXY_SECRET configurado, bloqueia tudo.
  const proxySecret = Deno.env.get("PROXY_SECRET")
  if (!proxySecret) {
    console.error("[link-user-subscription] PROXY_SECRET não configurada — requisição bloqueada")
    return json({ success: false, message: "Configuração interna inválida." }, 500)
  }
  const received = req.headers.get("x-proxy-secret") ?? ""
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn("[link-user-subscription] Proxy secret inválido — chamada direta bloqueada")
    return json({ success: false, message: "Não autorizado." }, 401)
  }

  // ── 1. Extrai o JWT do header Authorization ───────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!token || token.length < 20) {
    return json({ success: false, message: "Token de autenticação ausente." }, 401);
  }

  // ── 2. Lê variáveis de ambiente ───────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    console.error("[link-user-subscription] Variáveis de ambiente ausentes");
    return json({ success: false, message: "Configuração interna incompleta." }, 500);
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
  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);

  if (userErr || !user?.id || !user?.email) {
    console.error("[link-user-subscription] JWT inválido:", userErr?.message ?? "user null");
    return json({ success: false, message: "Sessão inválida ou expirada." }, 401);
  }

  const verifiedUserId = user.id;
  const verifiedEmail  = user.email.toLowerCase().trim();

  // ── 5. Parse e validação do body ──────────────────────────────────────────
  let subscription_id: string;
  try {
    const body      = await req.json();
    subscription_id = (body?.subscription_id ?? "").trim();
  } catch {
    return json({ success: false, message: "Body JSON inválido." }, 400);
  }

  if (!subscription_id || !UUID_REGEX.test(subscription_id)) {
    return json({ success: false, message: "subscription_id inválido." }, 400);
  }

  try {
    // Tabela `subscriptions` (Cakto) foi migrada para stripe_subscriptions e arquivada.
    // Esta função agora vincula stripe_subscriptions sem user_id ao usuário autenticado.
    // O subscription_id ainda é aceito no body mas não é usado (legado do fluxo Cakto).

    // ── 6. Busca stripe_subscription vinculável (user_id null, mesmo email) ──
    const { data: stripeSub, error: stripeErr } = await supabaseAdmin
      .from("stripe_subscriptions")
      .select("id, user_id, user_email, status")
      .eq("user_email", verifiedEmail)
      .is("user_id", null)
      .in("status", ["active", "trialing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (stripeErr) {
      console.error("[link-user-subscription] Erro ao buscar stripe_subscriptions:", stripeErr.message);
      return json({ success: false, message: "Erro ao verificar assinatura." }, 500);
    }

    if (!stripeSub) {
      // Verifica se já está vinculada (user_id preenchido)
      const { data: alreadyLinked } = await supabaseAdmin
        .from("stripe_subscriptions")
        .select("id")
        .eq("user_id", verifiedUserId)
        .in("status", ["active", "trialing"])
        .limit(1)
        .maybeSingle();

      if (alreadyLinked) {
        return json({ success: true, already_linked: true });
      }
      console.log("[link-user-subscription] Nenhuma assinatura para vincular:", verifiedEmail);
      return json({ success: false, message: "Assinatura não encontrada." }, 404);
    }

    // ── 7. Idempotência ────────────────────────────────────────────────────
    if (stripeSub.user_id === verifiedUserId) {
      return json({ success: true, already_linked: true });
    }

    // ── 8. Confirma email se necessário ───────────────────────────────────
    if (!user.email_confirmed_at) {
      const { error: confirmErr } = await supabaseAdmin.auth.admin.updateUserById(
        verifiedUserId, { email_confirm: true },
      );
      if (confirmErr) console.warn("[link-user-subscription] Falha ao confirmar email:", confirmErr.message);
    }

    // ── 9. Vincula stripe_subscription ao userId verificado ───────────────
    const { error: updateErr } = await supabaseAdmin
      .from("stripe_subscriptions")
      .update({ user_id: verifiedUserId, updated_at: new Date().toISOString() })
      .eq("id", stripeSub.id);

    if (updateErr) {
      console.error("[link-user-subscription] Erro ao vincular:", updateErr.message);
      return json({ success: false, message: "Erro ao vincular assinatura. Tente novamente." }, 500);
    }

    console.log(`[link-user-subscription] Vinculado: ${verifiedUserId.slice(0, 8)} → stripe_sub ${stripeSub.id.slice(0, 8)}`);
    return json({ success: true, already_linked: false });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[link-user-subscription] Erro inesperado:", errMsg);
    return json({ success: false, message: "Erro interno. Tente novamente." }, 500);
  }
});