// supabase/functions/send-signup-code/index.ts
/**
 * GranaEvo — send-signup-code
 *
 * Envia um código de 6 dígitos ao e-mail para PROVAR A POSSE antes de criar a
 * conta. Espelha `send-password-reset-code` e `verify-guest-invite`, que já
 * fazem isto em produção há meses — não é padrão novo, é o mesmo padrão.
 *
 * POR QUE ESTA FUNÇÃO EXISTE (auditoria 2026-07-16):
 * `create-user-account` chamava `admin.createUser({ email_confirm: true })`.
 * Isso não "pula" a confirmação — é AFIRMAR ao banco que o e-mail foi
 * verificado quando ninguém verificou nada. `email_confirmed_at` passava a
 * mentir, e com ele todo código que confiasse no e-mail.
 *
 * O estrago medido: CINCO caminhos independentes decidiam acesso/plano/dado por
 * `user_email = auth.email()`, escritos em meses diferentes, cada um parecendo
 * correto isolado. E a defesa certa JÁ EXISTIA (policy exigindo
 * `email_confirmed_at IS NOT NULL`) — morta em silêncio por causa daqui.
 *
 * Fechar os 5 caminhos resolveu o hoje. Isto resolve o amanhã.
 *
 * ANTI-ENUMERAÇÃO: a resposta é SEMPRE a mesma ('sent'), exista o e-mail ou
 * não. Quem chama não descobre quem tem conta. (O 409 de e-mail já cadastrado
 * continua no create-account, onde o usuário legítimo precisa da mensagem — é
 * uma escolha de UX pós-pagamento já registrada e aceita: memória sec_audit
 * 2026-07-12, achado F3.)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// Sem early-return em length — elimina timing oracle.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

async function hashCode(code: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
const PLANOS   = new Set(['individual', 'casal', 'familia'])

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')    return json({ error: 'Método não permitido' }, 405)

  // Proxy secret: fail-closed. Bloqueia chamada direta à edge.
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[send-signup-code] PROXY_SECRET não configurada — bloqueado')
    return json({ error: 'Configuração interna inválida' }, 503)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[send-signup-code] Proxy secret inválido — chamada direta bloqueada')
    return json({ error: 'Não autorizado' }, 401)
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }

  const email = String(body.email ?? '').toLowerCase().trim()
  const plan  = String(body.plan  ?? '').toLowerCase().trim()
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json({ error: 'E-mail inválido' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    console.error('[send-signup-code] Env ausente')
    return json({ error: 'Serviço indisponível' }, 503)
  }
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  // Resposta neutra: idêntica ao sucesso. Usada quando o e-mail JÁ TEM conta —
  // sem isto, este endpoint viraria um enumerador de usuários (é público, só
  // precisa do proxy secret que o site tem).
  const neutra = () => json({ status: 'sent', expires_in: '15 minutos' })

  // Já existe conta? Então não manda código de cadastro. Responde igual.
  try {
    const { data: achados, error: rpcErr } = await db.rpc('get_auth_user_by_email', { p_email: email })
    if (rpcErr) throw rpcErr
    // A RPC declara RETURNS TABLE, então `data` é um ARRAY — e `if ([])` é
    // TRUTHY em JS. Checar a verdade sem o `.length` faria TODO cadastro cair na
    // resposta neutra e ninguém mais criaria conta.
    if (Array.isArray(achados) && achados.length > 0) {
      console.log('[send-signup-code] E-mail já cadastrado — resposta neutra')
      return neutra()
    }
  } catch (e) {
    // RPC indisponível não pode virar bypass: falha fechado.
    console.error('[send-signup-code] Falha ao checar e-mail existente:', (e as Error)?.message)
    return json({ error: 'Serviço indisponível' }, 503)
  }

  // Código de 6 dígitos, CSPRNG. 15 min de janela + 5 tentativas (a verificação
  // conta) = força bruta praticamente zero, mesmo padrão do reset de senha.
  const rnd = new Uint32Array(1)
  crypto.getRandomValues(rnd)
  const code     = String(100_000 + (rnd[0] % 900_000))
  const codeHash = await hashCode(code)
  const expiresAt = new Date(Date.now() + 15 * 60_000)

  // Invalida códigos anteriores do mesmo e-mail: só o último vale.
  await db.from('signup_email_codes')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('email', email)
    .eq('used', false)

  const { error: insErr } = await db.from('signup_email_codes').insert({
    email,
    code_hash:  codeHash,
    plan:       PLANOS.has(plan) ? plan : null,
    expires_at: expiresAt.toISOString(),
  })
  if (insErr) {
    console.error('[send-signup-code] Erro ao gravar código:', insErr.message)
    return json({ error: 'Erro interno' }, 500)
  }

  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) {
    console.error('[send-signup-code] RESEND_API_KEY não configurada — e-mail bloqueado')
    return json({ error: 'Serviço indisponível' }, 503)
  }

  // O código NUNCA é logado nem devolvido na resposta — só vai pelo e-mail.
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#0f1117;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px 24px;color:#e6e8ee">
  <h1 style="font-size:20px;margin:0 0 8px">Seu código de cadastro</h1>
  <p style="color:#9ca3af;font-size:14px;line-height:1.6;margin:0 0 24px">
    Use o código abaixo para confirmar seu e-mail e criar sua conta no GranaEvo.
  </p>
  <div style="background:#1a1b2e;border:1px solid #2a2c42;border-radius:12px;padding:20px;text-align:center">
    <div style="font-size:34px;font-weight:700;letter-spacing:9px;color:#00cc7a">${code}</div>
  </div>
  <p style="color:#9ca3af;font-size:13px;line-height:1.6;margin:24px 0 0">
    O código vale por <strong style="color:#e6e8ee">15 minutos</strong>.
  </p>
  <p style="color:#7e8794;font-size:12px;line-height:1.6;margin:16px 0 0">
    Se você não pediu este código, ignore este e-mail — nenhuma conta foi criada
    e ninguém tem acesso ao seu endereço.
  </p>
</div></body></html>`

  const resp = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'GranaEvo <contato@granaevo.com>',
      to:      [email],
      subject: `${code} é o seu código de cadastro — GranaEvo`,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!resp.ok) {
    console.error('[send-signup-code] Resend falhou:', resp.status)
    return json({ error: 'Não foi possível enviar o e-mail agora' }, 502)
  }

  console.log('[send-signup-code] Código enviado (raw não logado)')
  return neutra()
})
