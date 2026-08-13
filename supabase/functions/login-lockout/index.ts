// supabase/functions/login-lockout/index.ts
// ---------------------------------------------------------------------------
// [ACHADO-02] Backstop DURÁVEL do lockout de login (auditoria 2026-08-12).
//
// POR QUE ESTA FUNÇÃO EXISTE
// ---------------------------------------------------------------------------
// O lockout por conta vive no Redis (api/auth-session.js). Quando o Upstash cai,
// `_checkRedis`/`_redisCmd` degradam para um Map POR INSTÂNCIA serverless — e
// como o gate de captcha lê `readCounter(kFail)` da mesma fonte, uma única
// indisponibilidade desliga o lockout E o captcha adaptativo ao mesmo tempo.
//
// O banco já tinha a tabela, o índice, o cron e a função `record_failed_login`.
// Faltava exatamente uma coisa: um chamador. Em produção, `login_lockouts` tinha
// 0 linhas e `max(last_attempt_at) = NULL` — a proteção nunca havia registrado
// nada, nem uma vez.
//
// POR QUE UMA EDGE FUNCTION E NÃO UMA CHAMADA DIRETA DO PROXY
// ---------------------------------------------------------------------------
// `record_failed_login` é `service_role`, e `api/auth-session.js` (Vercel) só
// tem a publishable key — de propósito: nenhuma chave privilegiada vive no
// proxy. Conceder a RPC a `anon` para encurtar o caminho seria entregar um botão
// de "trancar a conta de qualquer pessoa" a quem soubesse um e-mail: um DoS pior
// que a falha que isto vem cobrir.
//
// SEM JWT DE USUÁRIO — E ISSO É O PONTO
// ---------------------------------------------------------------------------
// Todas as outras edges exigem `x-proxy-secret` + `auth.getUser()`. Esta exige
// SÓ o proxy-secret, porque é chamada justamente quando NÃO há usuário
// autenticado: a senha acabou de falhar. Exigir JWT aqui tornaria a função
// inalcançável no único momento em que ela serve para algo.
//
// A compensação é o identificador ser um formato FECHADO: 32 hex minúsculos, o
// `chaveConta()` (SHA-256 do e-mail) que o Redis já usa. Nada além disso entra
// na tabela. Isso garante duas coisas de uma vez — que nenhum e-mail em claro
// chega ao banco, e que quem chama não escolhe livremente o que gravar.
// ---------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
}

/** Comparação de tempo constante — evita oráculo de timing sobre o segredo. */
function timingSafeEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

const PROXY_SECRET = Deno.env.get('PROXY_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''

// `chaveConta()` de api/auth-session.js: sha256(email).hex.slice(0, 32).
const ID_RE = /^[0-9a-f]{32}$/
const TIPO  = 'email_sha256'

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

Deno.serve(async (req: Request) => {
  if (!PROXY_SECRET) return json({ error: 'config' }, 500)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', PROXY_SECRET))
    return json({ error: 'Forbidden' }, 403)
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)

  let corpo: { acao?: string; id?: string }
  try { corpo = await req.json() } catch { return json({ error: 'body' }, 400) }

  const id = typeof corpo?.id === 'string' ? corpo.id : ''
  if (!ID_RE.test(id)) return json({ error: 'id' }, 400)

  const supabaseAdmin = createClient(SUPABASE_URL, getSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    if (corpo.acao === 'record') {
      const { data, error } = await supabaseAdmin.rpc('record_failed_login', {
        p_identifier: id, p_identifier_type: TIPO,
      })
      if (error) throw error
      const l = Array.isArray(data) ? data[0] : data
      return json({ ok: true, is_locked: l?.is_locked === true, locked_until: l?.locked_until ?? null })
    }

    if (corpo.acao === 'check') {
      const { data, error } = await supabaseAdmin.rpc('check_login_lockout', {
        p_identifier: id, p_identifier_type: TIPO,
      })
      if (error) throw error
      const l = Array.isArray(data) ? data[0] : data
      return json({ ok: true, is_locked: l?.is_locked === true, locked_until: l?.locked_until ?? null })
    }

    if (corpo.acao === 'clear') {
      const { error } = await supabaseAdmin.rpc('clear_login_lockout', {
        p_identifier: id, p_identifier_type: TIPO,
      })
      if (error) throw error
      return json({ ok: true })
    }
  } catch (e) {
    // Sem stack nem detalhe interno para o chamador. O proxy trata qualquer
    // não-200 como "banco não respondeu" e segue com a decisão do Redis.
    console.error('[login-lockout] rpc falhou:', (e as Error)?.message ?? 'erro')
    return json({ error: 'rpc' }, 502)
  }

  return json({ error: 'acao' }, 400)
})
