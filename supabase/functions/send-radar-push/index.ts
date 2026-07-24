// supabase/functions/send-radar-push/index.ts
//
// RADAR GRANAEVO — entregador de Web Push.
// Servidor→servidor (sem CORS). Disparado pela Vercel Cron via
// /api/user-data?radar=1, que repassa com x-proxy-secret (mesmo padrão do
// cron-health-alert). Lê radar_notifications vencidas (agendadas pelo
// CLIENTE sob RLS), entrega via Web Push (VAPID) e marca como sent/failed.
// Este código nunca calcula nem interpreta dados financeiros — só entrega
// payloads prontos.
//
// Env necessárias: SUPABASE_URL, SUPABASE_SECRET_KEYS (fallback: SUPABASE_SERVICE_ROLE_KEY),
//                  PROXY_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import webpush from "npm:web-push@3.6.7";

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS)
// com fallback na service_role legada — rollback = redeploy do commit anterior
// enquanto a legada existir. Migração de API keys 2026-07-23.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")?.default;
    if (typeof k === "string" && k.startsWith("sb_secret_")) return k;
  } catch { /* env ausente/inválida → usa a legada */ }
  console.warn("[keys] SUPABASE_SECRET_KEYS indisponível — usando service_role legada (fallback)");
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a), bB = enc.encode(b);
  const len = Math.max(aB.length, bB.length);
  let diff = aB.length ^ bB.length;
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });

const BATCH_MAX = 300;   // teto de notificações por execução
const STALE_HOURS = 36;  // pendente vencida há mais que isso → failed (não spamma atrasado)

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── 1. Fail-closed: proxy secret obrigatório ────────────────────────────────
  const proxySecret = Deno.env.get("PROXY_SECRET");
  if (!proxySecret) {
    console.error("[send-radar-push] PROXY_SECRET ausente — bloqueado");
    return json({ error: "Configuração interna inválida" }, 500);
  }
  if (!timingSafeEqual(req.headers.get("x-proxy-secret") ?? "", proxySecret)) {
    console.warn("[send-radar-push] Proxy secret inválido — chamada direta bloqueada");
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = getSecretKey();
  const vapidPub    = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPriv   = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[send-radar-push] Variáveis Supabase ausentes");
    return json({ error: "Configuração interna incompleta" }, 500);
  }
  if (!vapidPub || !vapidPriv) {
    console.error("[send-radar-push] Chaves VAPID ausentes — configure VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY");
    return json({ error: "Push não configurado" }, 500);
  }

  webpush.setVapidDetails("https://www.granaevo.com", vapidPub, vapidPriv);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  // O proxy da Vercel tem timeout curto (12s) e um lote grande de pushes pode
  // demorar mais. Responde 202 imediatamente e processa em background —
  // EdgeRuntime.waitUntil mantém a função viva até o processamento terminar.
  const trabalho = processarFila(admin);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(trabalho.catch((e) => console.error("[send-radar-push] Erro em background:", (e as Error).message)));
    return json({ ok: true, accepted: true }, 202);
  }
  // Fallback (ambiente sem waitUntil): processa inline
  return json(await trabalho);
});

async function processarFila(admin: ReturnType<typeof createClient>) {
  const nowIso   = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_HOURS * 3_600_000).toISOString();

  // ── 2. Expira pendências velhas (não notifica com dias de atraso) ───────────
  const { error: staleErr } = await admin
    .from("radar_notifications")
    .update({ status: "failed" })
    .eq("status", "pending")
    .lt("fire_at", staleIso);
  if (staleErr) console.error("[send-radar-push] Falha ao expirar antigas:", staleErr.message);

  // ── 3. Busca o que está vencido agora ───────────────────────────────────────
  const { data: due, error: dueErr } = await admin
    .from("radar_notifications")
    .select("id, user_id, tipo, title, body, url")
    .eq("status", "pending")
    .lte("fire_at", nowIso)
    .order("fire_at", { ascending: true })
    .limit(BATCH_MAX);

  if (dueErr) {
    console.error("[send-radar-push] Erro ao buscar fila:", dueErr.message);
    return { ok: false, error: "Erro ao buscar fila" };
  }
  const rows = due ?? [];
  if (rows.length === 0) return { ok: true, sent: 0, failed: 0 };

  // ── 4. Subscriptions ativas dos usuários envolvidos ─────────────────────────
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: subs, error: subErr } = await admin
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth_key")
    .in("user_id", userIds)
    .eq("is_active", true);

  if (subErr) {
    console.error("[send-radar-push] Erro ao buscar subscriptions:", subErr.message);
    return { ok: false, error: "Erro ao buscar subscriptions" };
  }

  const subsPorUser = new Map<string, Array<{ id: string; endpoint: string; p256dh: string; auth_key: string }>>();
  for (const s of subs ?? []) {
    if (!subsPorUser.has(s.user_id)) subsPorUser.set(s.user_id, []);
    subsPorUser.get(s.user_id)!.push(s);
  }

  // ── 5. Entrega — SILÊNCIO INTELIGENTE (RF-03): 1 push por usuário por rodada ─
  // Se o usuário tem vários avisos vencidos agora, agrupa num ÚNICO push (título =
  // contagem, corpo = os títulos concatenados) em vez de disparar N notificações.
  // Um aviso só já traz o usuário pro app; N seguidos é o "massante" que o item
  // pediu pra matar. PRIVACIDADE mantida: os títulos nunca têm R$.
  const sentIds: string[] = [];
  const failedIds: string[] = [];
  const deadEndpoints = new Set<string>();

  const porUser = new Map<string, typeof rows>();
  for (const n of rows) {
    if (!porUser.has(n.user_id)) porUser.set(n.user_id, []);
    porUser.get(n.user_id)!.push(n);
  }

  for (const [userId, avisos] of porUser) {
    const alvos = subsPorUser.get(userId) ?? [];
    if (alvos.length === 0) { for (const a of avisos) failedIds.push(a.id); continue; }

    let payload: string;
    if (avisos.length === 1) {
      const n = avisos[0];
      // Payload validado de novo aqui (defesa em profundidade; o SW valida a 3ª vez)
      payload = JSON.stringify({
        title: String(n.title ?? "GranaEvo").slice(0, 80),
        body:  String(n.body ?? "").slice(0, 200),
        tag:   `radar-${String(n.tipo ?? "evento").slice(0, 30)}`,
        url:   typeof n.url === "string" && n.url.startsWith("/") ? n.url.slice(0, 200) : "/dashboard",
      });
    } else {
      const titulos = avisos.map((a) => String(a.title ?? "").trim()).filter(Boolean);
      let corpo = "", usados = 0;
      for (const t of titulos) {
        const proximo = corpo ? `${corpo} · ${t}` : t;
        if (proximo.length > 180) break;
        corpo = proximo; usados++;
      }
      if (usados < titulos.length) corpo = `${corpo} · +${titulos.length - usados}`.slice(0, 200);
      payload = JSON.stringify({
        title: `${avisos.length} avisos do GranaEvo`.slice(0, 80),
        body:  (corpo || "Você tem novidades. Abra pra ver.").slice(0, 200),
        tag:   "radar-resumo",
        url:   "/dashboard",
      });
    }

    let entregou = false;
    const envios = alvos.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
          { TTL: 43_200, urgency: "normal" },
        );
        entregou = true;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) deadEndpoints.add(s.endpoint); // subscription morta
      }
    });
    await Promise.allSettled(envios);

    for (const a of avisos) (entregou ? sentIds : failedIds).push(a.id);
  }

  // ── 6. Marca resultados + desativa endpoints mortos ─────────────────────────
  if (sentIds.length > 0) {
    const { error } = await admin
      .from("radar_notifications")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .in("id", sentIds);
    if (error) console.error("[send-radar-push] Falha ao marcar sent:", error.message);
  }
  if (failedIds.length > 0) {
    const { error } = await admin
      .from("radar_notifications")
      .update({ status: "failed" })
      .in("id", failedIds);
    if (error) console.error("[send-radar-push] Falha ao marcar failed:", error.message);
  }
  if (deadEndpoints.size > 0) {
    const { error } = await admin
      .from("push_subscriptions")
      .update({ is_active: false })
      .in("endpoint", [...deadEndpoints]);
    if (error) console.error("[send-radar-push] Falha ao desativar endpoints:", error.message);
  }

  console.log(`[send-radar-push] ok — sent=${sentIds.length} failed=${failedIds.length} deadSubs=${deadEndpoints.size}`);
  return { ok: true, sent: sentIds.length, failed: failedIds.length, deadSubs: deadEndpoints.size };
}
