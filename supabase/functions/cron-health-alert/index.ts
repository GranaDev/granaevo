// supabase/functions/cron-health-alert/index.ts
//
// Monitor M2 — alerta de cron falho.
// Servidor→servidor (sem CORS). Disparado pela Vercel Cron via /api/user-data?cron-health=1,
// que repassa com x-proxy-secret. Lê os jobs que falharam nas últimas 24h (RPC
// get_cron_failures_24h, EXECUTE só service_role) e, havendo falhas, envia e-mail via Resend.
//
// Env necessárias: SUPABASE_URL, SUPABASE_SECRET_KEYS (fallback: SUPABASE_SERVICE_ROLE_KEY),
//                  PROXY_SECRET, RESEND_API_KEY, SECURITY_ALERT_EMAIL (lista separada por vírgula).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS).
// SEM fallback na legada: as chaves antigas (anon e service_role) foram
// DESATIVADAS em 2026-07-23 e devolvem 401 "Legacy API keys are disabled".
// Um fallback para uma chave morta não é rede de segurança — é um 401 confuso
// no lugar de um erro de configuração legível. Se a env sumir, falhe alto.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")?.default;
    if (typeof k === "string" && k.startsWith("sb_secret_")) return k;
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a), bB = enc.encode(b);
  const len = Math.max(aB.length, bB.length);
  let diff = aB.length ^ bB.length;
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── 1. Fail-closed: proxy secret obrigatório ────────────────────────────────
  const proxySecret = Deno.env.get("PROXY_SECRET");
  if (!proxySecret) {
    console.error("[cron-health-alert] PROXY_SECRET ausente — bloqueado");
    return json({ error: "Configuração interna inválida" }, 500);
  }
  if (!timingSafeEqual(req.headers.get("x-proxy-secret") ?? "", proxySecret)) {
    console.warn("[cron-health-alert] Proxy secret inválido — chamada direta bloqueada");
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = getSecretKey();
  if (!supabaseUrl || !serviceKey) {
    console.error("[cron-health-alert] Variáveis Supabase ausentes");
    return json({ error: "Configuração interna incompleta" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  // ── 2. Consulta as falhas das últimas 24h ───────────────────────────────────
  const { data: failures, error } = await supabaseAdmin.rpc("get_cron_failures_24h");
  if (error) {
    console.error("[cron-health-alert] Erro ao consultar saúde do cron:", error.message);
    return json({ error: "Erro ao consultar saúde do cron" }, 500);
  }

  const rows = Array.isArray(failures) ? failures : [];

  // ── 2b. B-4 · Eventos de SEGURANÇA na última hora ───────────────────────────
  // `fraud_logs` e `login_lockouts` registravam e ninguém lia: força bruta ou
  // sequência de fraude ficavam esperando alguém abrir o painel.
  //
  // Pega carona nesta função de propósito. Uma rota nova em api/ seria a 11ª de
  // 12, e a 13ª CONGELA todo o deploy da Vercel em silêncio — já custou um dia
  // em 2026-07-25. O alerta de segurança não vale um slot desses.
  //
  // Fail-open: se a RPC falhar, o alerta de cron continua. Monitor que derruba
  // o outro monitor é pior que monitor nenhum.
  let seguranca: Record<string, unknown>[] = [];
  try {
    const { data, error: secErr } = await supabaseAdmin.rpc("get_security_events_recent", {
      p_minutos: 60,
      p_limiar: 5,
    });
    if (secErr) console.warn("[cron-health-alert] RPC de segurança falhou:", secErr.message);
    else if (Array.isArray(data)) seguranca = data;
  } catch (e) {
    console.warn("[cron-health-alert] RPC de segurança indisponível:", (e as Error).message);
  }

  if (rows.length === 0 && seguranca.length === 0) {
    return json({ ok: true, failures: 0, seguranca: 0 }); // tudo saudável — sem e-mail
  }

  // ── 3. Há falhas → alerta por e-mail (Resend) ───────────────────────────────
  const resendKey  = Deno.env.get("RESEND_API_KEY");
  const recipients = (Deno.env.get("SECURITY_ALERT_EMAIL") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (!resendKey || recipients.length === 0) {
    console.error("[cron-health-alert] Falhas detectadas mas RESEND_API_KEY/SECURITY_ALERT_EMAIL ausentes:", JSON.stringify(rows).slice(0, 500));
    return json({ ok: false, failures: rows.length, emailed: false, error: "Canal de e-mail não configurado" }, 200);
  }

  const rowsHtml = rows.map((r: Record<string, unknown>) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#f1f5f9;font-weight:600">${escapeHtml(String(r.jobname ?? "?"))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#ef4444;text-align:center">${escapeHtml(String(r.fails ?? "?"))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px">${escapeHtml(String(r.last_message ?? "").slice(0, 300))}</td>
    </tr>`).join("");

  // Bloco de segurança: só existe no e-mail quando há o que dizer. Alerta que
  // chega com seção vazia todo dia é alerta que se aprende a não abrir.
  //
  // `alvos` separa os dois ataques que a mesma contagem esconde: 30 bloqueios
  // em 1 alvo é alguém insistindo numa conta; 30 em 30 alvos é varredura.
  const segHtml = seguranca.length === 0 ? "" : `
    <div style="padding:0 32px 8px"><h2 style="color:#fbbf24;font-size:15px;margin:16px 0 8px">🔐 Eventos de segurança (última hora)</h2></div>
    <div style="padding:0 32px 24px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Origem</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-size:11px;text-transform:uppercase">Eventos</th>
          <th style="padding:8px 12px;text-align:center;color:#64748b;font-size:11px;text-transform:uppercase">Alvos distintos</th>
          <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Mais recente</th>
        </tr></thead>
        <tbody>${seguranca.map((r) => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#f1f5f9;font-weight:600">${escapeHtml(String(r.fonte ?? "?"))}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#fbbf24;text-align:center">${escapeHtml(String(r.eventos ?? "?"))}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#94a3b8;text-align:center">${escapeHtml(String(r.alvos ?? "?"))}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px">${escapeHtml(String(r.mais_recente ?? ""))}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;

  const cronHtml = rows.length === 0 ? "" : `
      <div style="padding:24px 32px;color:#94a3b8;font-size:14px;line-height:1.6">
        <p>${rows.length} job(s) agendado(s) falharam nas últimas 24h. Verifique no Supabase.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <thead><tr>
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Job</th>
            <th style="padding:8px 12px;text-align:center;color:#64748b;font-size:11px;text-transform:uppercase">Falhas</th>
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Última mensagem</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

  // O título diz o que aconteceu de pior: segurança manda no cabeçalho quando
  // aparece, porque é o que muda a urgência de quem abre o e-mail.
  const titulo = seguranca.length > 0
    ? "🔐 GranaEvo — Eventos de segurança"
    : "⚠️ GranaEvo — Cron Job com Falha";

  const html = `<!DOCTYPE html><html><body style="background:#060810;font-family:system-ui,sans-serif;padding:32px">
    <div style="max-width:640px;margin:0 auto;background:#0d1117;border:1px solid #ef444433;border-radius:16px;overflow:hidden">
      <div style="background:#7f1d1d;padding:24px 32px"><h1 style="margin:0;color:#fff;font-size:20px">${titulo}</h1></div>
      ${segHtml}${cronHtml}
    </div></body></html>`;

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "GranaEvo Alertas <noreply@granaevo.com>",
        to: recipients,
        // O assunto tem que dizer QUAL alarme tocou sem abrir o e-mail. Um
        // assunto fixo de "cron falhando" num alerta de força bruta é ruído
        // disfarçado de sinal — e alerta que mente é alerta que se ignora.
        subject: seguranca.length > 0
          ? `🔐 [GranaEvo] ${seguranca.reduce((s, r) => s + Number(r.eventos ?? 0), 0)} evento(s) de segurança na última hora`
          : `⚠️ [GranaEvo] ${rows.length} cron job(s) falhando`,
        html,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!emailRes.ok) {
      console.error("[cron-health-alert] Resend falhou:", await emailRes.text());
      return json({ ok: false, failures: rows.length, emailed: false }, 200);
    }
  } catch (e) {
    console.error("[cron-health-alert] Erro ao enviar e-mail:", (e as Error).message);
    return json({ ok: false, failures: rows.length, emailed: false }, 200);
  }

  console.log(`[cron-health-alert] Alerta enviado — ${rows.length} job(s) com falha`);
  return json({ ok: true, failures: rows.length, emailed: true });
});
