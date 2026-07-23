// notify-login — alerta de login em APARELHO NOVO (e-mail via Resend)
// ---------------------------------------------------------------------------
// Chamado pelo cliente (via proxy /api/user-data action:"login-notify") logo
// após um login bem-sucedido. Identifica o aparelho por um hash SHA-256 de
// (user_id + user-agent) — nenhum fingerprint invasivo, nada além do UA que o
// navegador já envia. Se o hash nunca foi visto E o usuário já tinha outro
// aparelho registrado, dispara um e-mail "novo acesso à sua conta".
//
// Limitações honestas (defesa de ALERTA, não de bloqueio):
//  • Quem usa a API direto (fora do app) não chama este endpoint — o alerta
//    cobre o caso comum de credencial vazada usada no app oficial.
//  • O primeiro aparelho de todos NÃO alerta (senão todo cadastro viraria spam).
//
// Blindagem (mesma espinha das demais): proxy-secret timing-safe → JWT real
// (getUser) → validação estrita → erros sem detalhe interno.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS)
// com fallback na service_role legada — rollback = redeploy do commit anterior
// enquanto a legada existir. Migração de API keys 2026-07-23.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* env ausente/inválida → usa a legada */ }
  console.warn('[keys] SUPABASE_SECRET_KEYS indisponível — usando service_role legada (fallback)')
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB = enc.encode(a)
  const bB = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
  })

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Rótulo curto e não-sensível do UA para o e-mail ("Chrome · Android").
function uaLabel(ua: string): string {
  const nav =
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Edg\//.test(ua) ? 'Edge' :
    /SamsungBrowser/.test(ua) ? 'Samsung Internet' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Navegador'
  const so =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' : ''
  return so ? `${nav} em ${so}` : nav
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok')
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405)

  // ── 1. proxy-secret (fail-closed) ──────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) return json({ ok: false, error: 'config' }, 500)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  // ── 2. JWT real ─────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  if (!token || token.length < 20) return json({ ok: false, error: 'auth' }, 401)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    getSecretKey(),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )
  const { data: { user }, error: authError } = await admin.auth.getUser(token)
  if (authError || !user?.id || !user.email) return json({ ok: false, error: 'auth' }, 401)

  // ── 3. Identidade do aparelho (UA repassado pelo proxy) ────────────────────
  const ua = (req.headers.get('x-original-ua') ?? '').slice(0, 400)
  if (ua.length < 10) return json({ ok: true, skipped: 'no-ua' }) // sem UA útil → não alerta
  const deviceHash = await sha256hex(`${user.id}|${ua}`)

  // ── 4. Aparelho conhecido? (upsert atômico; primeira vez de todas não alerta)─
  const { count } = await admin
    .from('user_devices')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)

  const { data: existing } = await admin
    .from('user_devices')
    .select('id')
    .eq('user_id', user.id)
    .eq('device_hash', deviceHash)
    .maybeSingle()

  if (existing?.id) {
    await admin.from('user_devices').update({ last_seen: new Date().toISOString() }).eq('id', existing.id)
    return json({ ok: true, known: true })
  }

  const { error: insErr } = await admin.from('user_devices').insert({
    user_id: user.id,
    device_hash: deviceHash,
    ua_label: uaLabel(ua).slice(0, 120),
  })
  // Corrida (dois logins simultâneos do mesmo aparelho) → unique violation = conhecido.
  if (insErr) return json({ ok: true, known: true })

  const isFirstDevice = (count ?? 0) === 0
  if (isFirstDevice) return json({ ok: true, first: true })

  // ── 5. E-mail de alerta (best-effort — login nunca falha por causa disto) ──
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  if (!resendApiKey) return json({ ok: true, mailed: false })

  const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const aparelho = escapeHtml(uaLabel(ua))
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'GranaEvo <noreply@granaevo.com>',
        to: [user.email],
        subject: 'Novo acesso à sua conta GranaEvo',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
            <h2 style="color:#10b981">Novo acesso detectado</h2>
            <p>Sua conta GranaEvo foi acessada de um aparelho que não reconhecemos:</p>
            <table style="border-collapse:collapse;margin:16px 0">
              <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Aparelho</td><td><strong>${aparelho}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Quando</td><td><strong>${quando}</strong> (horário de Brasília)</td></tr>
            </table>
            <p><strong>Foi você?</strong> Então está tudo certo — pode ignorar este e-mail.</p>
            <p><strong>Não foi você?</strong> Troque sua senha agora e desconecte todos os aparelhos em
              <em>Configurações → Segurança da conta</em>.</p>
            <p style="margin-top:24px"><a href="https://www.granaevo.com/dashboard"
              style="background:#10b981;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir o GranaEvo</a></p>
            <p style="color:#9ca3af;font-size:12px;margin-top:24px">Você recebe este alerta sempre que um novo navegador ou celular entra na sua conta.</p>
          </div>`,
      }),
      signal: AbortSignal.timeout(8_000),
    })
  } catch (_e) { /* best-effort */ }

  return json({ ok: true, mailed: true })
})
