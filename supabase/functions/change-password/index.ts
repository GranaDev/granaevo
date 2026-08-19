// supabase/functions/change-password/index.ts
// Trocar a senha DENTRO da conta autenticada (tela Configurações → Alterar Senha).
//
// ⚠️ NÃO confundir com `verify-and-reset-password`, que é o "Esqueci a senha".
// A diferença é a PROVA DE POSSE, e ela define tudo:
//
//   Alterar senha (aqui)   → prova = a senha ATUAL, que o usuário sabe.
//   Esqueci a senha        → prova = código enviado por e-mail. Exigir a senha
//                            atual ali seria absurdo: ele não a sabe.
//
// ── POR QUE ESTA FUNÇÃO EXISTE (auditoria 2026-08-18/19) ─────────────────────
// A tela chamava `supabase.auth.updateUser({ password })` DIRETO no GoTrue, do
// browser. Isso trazia três defeitos de uma vez:
//
// 1. FUNCIONALIDADE (bug real, latente). O projeto tem
//    `security_update_password_require_reauthentication = true`. A doc do
//    Supabase: *"Users will need to be recently logged in to change their
//    password without requiring reauthentication (session created within the
//    last 24 hours)"*. Sessão com mais de 24h → o GoTrue exige um `nonce` que
//    NENHUM ponto do código produzia → a troca falhava com "Não foi possível
//    alterar a senha. Tente novamente.", e tentar de novo nunca resolvia,
//    porque a sessão continuava velha. Num PWA, onde a sessão persiste por
//    dias, esse é o caso COMUM, não o raro.
//
//    A saída é `admin.updateUserById` com service_role: operação administrativa
//    não está sujeita à idade da sessão. É a mesma estratégia que
//    `verify-and-reset-password` já usa em produção.
//
// 2. SEGURANÇA — senha vazada. `_shared/hibp.ts` estava ligado em
//    `create-user-account` e `verify-and-reset-password`. Este era o TERCEIRO
//    caminho de definir senha, e o único sem HIBP. O recurso nativo do Supabase
//    (`password_hibp_enabled`) exige plano Pro — medido: HTTP 402. Chamar o
//    HIBP aqui entrega o mesmo resultado de graça, e fecha os 3 caminhos.
//
// 3. SEGURANÇA — sessão sequestrada. Sem pedir a senha atual, quem obtivesse
//    uma sessão (aparelho desbloqueado, token roubado) trocava a senha e
//    EXPULSAVA o dono da própria conta. A senha é o único fator que a sessão
//    roubada não carrega. Mesmo raciocínio do step-up de `delete-account`.
//
// E a regra que vale acima de tudo: a política de senha (8+, maiúscula, dígito)
// vivia SÓ em JavaScript. `supabase.auth.updateUser({password:'aaaaaa'})` no
// console passava. Aqui ela é revalidada no servidor — o cliente deixa de ser
// fronteira.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { isPasswordPwned } from '../_shared/hibp.ts'

function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
}

// Publishable (só como `apikey` do step-up de senha no GoTrue — pública por design).
function getPublishableKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_publishable_')) return k
  } catch { /* env ausente/inválida → throw abaixo */ }
  throw new Error('SUPABASE_PUBLISHABLE_KEYS ausente ou inválida')
}

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

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB = enc.encode(a)
  const bB = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

/**
 * A MESMA regra que as três telas já exibem — agora no servidor.
 * `login.js:1150` (reset), `login.js:1424` (medidor) e
 * `db-configuracoes.js` (alterar) exigem: >= 8, uma maiúscula, um dígito.
 *
 * NÃO exijo minúscula de propósito: nenhuma das telas exige, e um servidor mais
 * restrito que a UI recusaria senha que a tela acabou de aprovar — erro que o
 * usuário não teria como entender.
 *
 * O teto de 200 evita que uma senha gigante vire trabalho de bcrypt no GoTrue.
 */
function senhaFraca(s: string): string | null {
  if (typeof s !== 'string')       return 'Senha inválida.'
  if (s.length < 8)                return 'A nova senha deve ter pelo menos 8 caracteres.'
  if (s.length > 200)              return 'A nova senha é longa demais (máx. 200 caracteres).'
  if (!/[A-Z]/.test(s))            return 'A nova senha deve conter ao menos uma letra maiúscula.'
  if (!/[0-9]/.test(s))            return 'A nova senha deve conter ao menos um número.'
  return null
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)
  const rid = (req.headers.get('x-request-id') ?? '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80) || 'sem-rid'

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST')    return json({ ok: false, error: 'method' }, 405, cors)

  // ── 1. proxy-secret ────────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) return json({ ok: false, error: 'config' }, 500, cors)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    return json({ ok: false, error: 'unauthorized' }, 401, cors)
  }

  // ── 2. JWT real ────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  if (!token || token.length < 20) return json({ ok: false, error: 'auth' }, 401, cors)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseAdmin = createClient(supabaseUrl, getSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) return json({ ok: false, error: 'auth' }, 401, cors)

  const accountEmail = (user.email ?? '').trim().toLowerCase()
  if (!accountEmail) return json({ ok: false, error: 'sem_email' }, 400, cors)

  // ── 3. Corpo ───────────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ ok: false, error: 'body' }, 400, cors) }

  const senhaAtual = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const senhaNova  = typeof body.newPassword     === 'string' ? body.newPassword     : ''

  if (!senhaAtual || senhaAtual.length < 6 || senhaAtual.length > 200) {
    return json({ ok: false, error: 'current_required', message: 'Informe sua senha atual.' }, 400, cors)
  }
  const motivo = senhaFraca(senhaNova)
  if (motivo) return json({ ok: false, error: 'weak', message: motivo }, 400, cors)

  if (senhaAtual === senhaNova) {
    return json({ ok: false, error: 'same', message: 'A nova senha precisa ser diferente da atual.' }, 400, cors)
  }

  // ── 3.5 Backstop de rate limit (defesa-em-profundidade) ────────────────────
  // O limite primário está no proxy Vercel (Redis, ip + uid). Este contador no
  // banco sobrevive a um vazamento do PROXY_SECRET: mesmo que alguém chame esta
  // função direto com um JWT válido, o teto continua valendo.
  //
  // FAIL-CLOSED, pelo mesmo motivo de `chat-parse` (auditoria 2026-08-18):
  // `getUser` acima JÁ teve de dar certo, então o banco está de pé. Um erro
  // aqui é falha específica da RPC — e o recurso protegido é tentativa de
  // adivinhar a senha atual, que é justamente o que não se quer liberar.
  try {
    const { data: ok, error: rlErr } = await supabaseAdmin.rpc('check_rate_limit', {
      p_key: `chpwd:${user.id}`,
      p_max: 10,
      p_window_seconds: 3600,
    })
    if (rlErr) {
      console.error(`[change-password][rid=${rid}] check_rate_limit falhou, recusando:`, rlErr.message)
      return json({ ok: false, error: 'rate', message: 'Muitas tentativas. Tente mais tarde.' }, 429, cors)
    }
    if (ok === false) {
      return json({ ok: false, error: 'rate', message: 'Muitas tentativas. Aguarde 1 hora.' }, 429, cors)
    }
  } catch (e) {
    console.error(`[change-password][rid=${rid}] check_rate_limit lançou, recusando:`,
                  e instanceof Error ? e.message : String(e))
    return json({ ok: false, error: 'rate', message: 'Muitas tentativas. Tente mais tarde.' }, 429, cors)
  }

  // ── 4. STEP-UP: prova de posse da senha ATUAL ──────────────────────────────
  // Validamos contra o GoTrue — a mesma engine do login — para nunca comparar
  // hash na mão. A sessão criada aqui é descartada; o signOut do passo 7 a mata.
  const grantRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': getPublishableKey() },
    body: JSON.stringify({ email: accountEmail, password: senhaAtual }),
  }).catch(() => null)

  if (!grantRes || !grantRes.ok) {
    // Mensagem genérica: não vira oráculo de "quase acertou".
    console.warn(`[change-password][rid=${rid}] senha atual incorreta para ${user.id.slice(0, 8)}`)
    return json({ ok: false, error: 'current_invalid', message: 'Senha atual incorreta.' }, 401, cors)
  }

  // ── 5. HIBP — o que o plano Pro faria, de graça ────────────────────────────
  // FAIL-OPEN por design (ver _shared/hibp.ts): HIBP fora do ar não pode
  // impedir alguém de trocar a própria senha. Disponibilidade > esta defesa.
  if (await isPasswordPwned(senhaNova)) {
    return json({
      ok: false,
      error: 'pwned',
      message: 'Essa senha já apareceu em vazamentos de dados públicos. Escolha outra.',
    }, 400, cors)
  }

  // ── 6. Troca via ADMIN ─────────────────────────────────────────────────────
  // `admin.updateUserById` e não `updateUser`: operação administrativa não está
  // sujeita a `security_update_password_require_reauthentication`, que é o que
  // quebrava a tela para quem tinha sessão de mais de 24h.
  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    password: senhaNova,
  })

  if (updErr) {
    console.error(`[change-password][rid=${rid}] admin update falhou:`, updErr.status, updErr.message)
    return json({ ok: false, error: 'update_failed', message: 'Não foi possível alterar a senha. Tente novamente.' }, 500, cors)
  }

  // ── 7. Encerra as OUTRAS sessões ───────────────────────────────────────────
  // Decisão do dono (2026-08-19): trocar a senha derruba os outros aparelhos.
  // É o comportamento esperado de quem troca senha por suspeita de invasão.
  //
  // `'others'` e NÃO `'global'`: global derrubaria também quem acabou de trocar,
  // que reapareceria na tela de login sem entender por quê. Ver a armadilha
  // registrada em gotrue_logout_global_2026_07_30 — o padrão do GoTrue é global.
  //
  // Best-effort: a senha JÁ mudou neste ponto. Falhar aqui não pode desfazer a
  // troca nem devolver erro ao usuário — seria dizer "não funcionou" para algo
  // que funcionou, e ele tentaria de novo com a senha antiga (que já não vale).
  let sessoesEncerradas = true
  try {
    // @ts-ignore — signOut(jwt, scope) no admin client
    await supabaseAdmin.auth.admin.signOut(token, 'others')
  } catch (e) {
    sessoesEncerradas = false
    console.warn(`[change-password][rid=${rid}] signOut(others) falhou (best effort):`,
                 e instanceof Error ? e.message : String(e))
  }

  console.log(`[change-password][rid=${rid}] senha alterada para ${user.id.slice(0, 8)}`)
  return json({ ok: true, sessoesEncerradas }, 200, cors)
})
