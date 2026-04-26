// supabase/functions/link-user-subscription/index.ts
/**
 * GranaEvo — link-user-subscription
 *
 * CORREÇÃO ES256: supabaseAdmin.auth.getUser(token) em vez de
 * createClient(url, anonKey) + getUser() com token no global header.
 * O Admin client usa SERVICE_ROLE_KEY (aceita pelo gateway) e delega
 * a validação do token ES256 ao servidor Auth via JWKS.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
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
    // ── 6. Busca subscription e valida ownership ──────────────────────────
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .select("id, user_id, user_email, payment_status, is_active")
      .eq("id", subscription_id)
      .maybeSingle();

    if (subErr) {
      console.error("[link-user-subscription] Erro ao buscar subscription:", subErr.code);
      return json({ success: false, message: "Erro ao verificar assinatura." }, 500);
    }

    if (!sub) {
      return json({ success: false, message: "Assinatura não encontrada." }, 404);
    }

    // [SEC-FIX GHOST-004] Email mismatch retorna 404 (não 403) — impede enumeração
    // de subscription UUIDs via diferença entre "não encontrado" e "não autorizado".
    // Um atacante com JWT válido poderia testar UUIDs e saber quais existem via 403.
    if (sub.user_email?.toLowerCase().trim() !== verifiedEmail) {
      console.warn("[link-user-subscription] Email JWT não confere com a subscription (retorno 404 intencional).");
      return json({ success: false, message: "Assinatura não encontrada." }, 404);
    }

    if (sub.payment_status !== "approved" || !sub.is_active) {
      return json({ success: false, message: "Assinatura inativa ou pagamento não aprovado." }, 403);
    }

    // ── 7. Idempotência ────────────────────────────────────────────────────
    if (sub.user_id === verifiedUserId) {
      return json({ success: true, already_linked: true });
    }

    if (sub.user_id && sub.user_id !== verifiedUserId) {
      console.warn("[link-user-subscription] Tentativa de revínculo para outro userId bloqueada.");
      return json({ success: false, message: "Assinatura já vinculada a outro usuário." }, 409);
    }

    // ── 8. Confirma email se necessário ───────────────────────────────────
    if (!user.email_confirmed_at) {
      const { error: confirmErr } = await supabaseAdmin.auth.admin.updateUserById(
        verifiedUserId,
        { email_confirm: true }
      );
      if (confirmErr) {
        console.warn("[link-user-subscription] Falha ao confirmar email:", confirmErr.message);
      }
    }

    // ── 9. Vincula subscription ao userId verificado ───────────────────────
    const { error: updateErr } = await supabaseAdmin
      .from("subscriptions")
      .update({
        user_id:             verifiedUserId,
        password_created:    true,
        password_created_at: new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      })
      .eq("id", subscription_id);

    if (updateErr) {
      console.error("[link-user-subscription] Erro ao atualizar subscription:", updateErr.message);
      return json({ success: false, message: "Erro ao vincular assinatura. Tente novamente." }, 500);
    }

    console.log(
      `[link-user-subscription] Vinculado: ${verifiedUserId.slice(0, 8)}... → sub ${subscription_id.slice(0, 8)}...`
    );

    return json({ success: true, already_linked: false });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error("[link-user-subscription] Erro inesperado:", errMsg);
    return json({ success: false, message: "Erro interno. Tente novamente." }, 500);
  }
});