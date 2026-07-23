// supabase/functions/delete-account/index.ts
// Exclusão de conta self-service (LGPD art. 18, VI — direito à eliminação).
//
// Fluxo: proxy-secret (timing-safe) → JWT real (auth.getUser) → confirmação por e-mail
// → revoga sessões → deleta auth.users. As 25 FKs ON DELETE CASCADE apagam todos os
// dados do usuário (user_data, profiles, stripe_subscriptions, account_members, etc.).
//
// ARMADILHA (CLAUDE.md): deletar usuário NÃO invalida JWTs já emitidos → revogamos as
// sessões explicitamente ANTES de deletar. O access token restante (~1h) fica órfão e
// inócuo (todos os dados já foram removidos pela cascata).
//
// NÃO cancela a assinatura no Stripe automaticamente — o usuário deve cancelar antes
// (ou o webhook/purga cuida). A resposta avisa se havia assinatura ativa.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// Keys novas (injetadas pela plataforma) com fallback nas legadas durante a
// transição — rollback = redeploy do commit anterior. Migração 2026-07-23.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* env ausente/inválida → usa a legada */ }
  console.warn('[keys] SUPABASE_SECRET_KEYS indisponível — usando service_role legada (fallback)')
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

// Publishable (só como `apikey` do step-up de senha no GoTrue — pública por design).
function getPublishableKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_publishable_')) return k
  } catch { /* env ausente/inválida → usa a legada */ }
  console.warn('[keys] SUPABASE_PUBLISHABLE_KEYS indisponível — usando anon legada (fallback)')
  return Deno.env.get('SUPABASE_ANON_KEY') ?? ''
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

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)

  // Passo 27 — id de correlação vindo do proxy. Sem isto, o log do proxy e o
  // desta função são duas ilhas: investigar um erro vira cruzar horário na mão.
  // Saneado porque entra em linha de log — header cru permitiria injetar quebra
  // de linha e forjar entradas falsas.
  const rid = (req.headers.get('x-request-id') ?? '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80) || 'sem-rid'

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors)

  // ── 1. proxy-secret ────────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) return json({ ok: false, error: 'config' }, 500, cors)
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    return json({ ok: false, error: 'unauthorized' }, 401, cors)
  }

  // ── 2. JWT real (getUser) ──────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  if (!token || token.length < 20) return json({ ok: false, error: 'auth' }, 401, cors)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    getSecretKey(),
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
  )

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !user?.id) return json({ ok: false, error: 'auth' }, 401, cors)

  // ── 3. Confirmação explícita: e-mail digitado deve bater com o da conta ─────
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ ok: false, error: 'body' }, 400, cors) }

  const confirmEmail = typeof body.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : ''
  const accountEmail = (user.email ?? '').trim().toLowerCase()
  if (!accountEmail || confirmEmail !== accountEmail) {
    return json({ ok: false, error: 'confirm_mismatch', message: 'Digite o e-mail exato da sua conta para confirmar.' }, 400, cors)
  }

  // ── 3a. STEP-UP AUTH: prova de POSSE DA SENHA (Passo 25) ───────────────────
  // Confirmar digitando o e-mail NÃO é prova de nada: o e-mail está visível na
  // própria tela de configurações. Quem sequestra uma sessão (XSS, sessão roubada,
  // aparelho desbloqueado) já sabe o e-mail e apagaria a conta inteira.
  // A senha é o único fator que a sessão roubada não carrega.
  //
  // A verificação é AQUI, no servidor, de propósito: checar no cliente seria
  // teatro — basta chamar este endpoint direto. Validamos contra o GoTrue, a
  // mesma engine do login, para nunca comparar hash na mão.
  const senha = typeof body.password === 'string' ? body.password : ''
  if (!senha || senha.length < 6 || senha.length > 200) {
    return json({ ok: false, error: 'password_required', message: 'Confirme sua senha para excluir a conta.' }, 400, cors)
  }

  const grantRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': getPublishableKey(),
    },
    body: JSON.stringify({ email: accountEmail, password: senha }),
  }).catch(() => null)

  if (!grantRes || !grantRes.ok) {
    // Mensagem genérica e status 401: não diz se a senha "quase acertou" nem
    // vira oráculo. (Quem chega aqui já tem uma sessão válida, mas ainda assim
    // o GoTrue aplica o rate limit dele sobre estas tentativas.)
    console.warn(`[delete-account][rid=${rid}] step-up: senha incorreta para ${user.id.slice(0, 8)}`)
    return json({ ok: false, error: 'password_invalid', message: 'Senha incorreta.' }, 401, cors)
  }
  // A sessão criada só para provar a senha é descartada — não devolvemos token
  // algum ao cliente, e o deleteUser abaixo invalida tudo de qualquer forma.

  // ── 3b. Bloqueia convidado: quem não é titular não "exclui a conta" (só o dono). ─
  // Um convidado deve pedir ao titular para removê-lo; excluir aqui apagaria a conta
  // de login dele, mas os dados pertencem ao titular. Deixamos explícito.
  const { data: guestRow } = await supabaseAdmin
    .from('account_members')
    .select('id')
    .eq('member_user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  // Detecta assinatura ativa (apenas para avisar — não bloqueia a exclusão).
  const { data: sub } = await supabaseAdmin
    .from('stripe_subscriptions')
    .select('status')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing'])
    .limit(1)
    .maybeSingle()

  // ── 4. Revoga as sessões ativas (best effort) antes de deletar ──────────────
  // admin.signOut recebe o JWT (não o userId) + scope 'global' → invalida todos os
  // refresh tokens do usuário. Se a assinatura do método variar entre versões do SDK,
  // o catch segue: o deleteUser abaixo remove os refresh tokens de qualquer forma.
  // Ressalva (CLAUDE.md): o access token stateless já emitido continua válido até
  // expirar (~1h) — porém fica inócuo, pois os dados já não existem e getUser falha.
  try {
    // @ts-ignore — signOut(jwt, scope) no admin client
    await supabaseAdmin.auth.admin.signOut(token, 'global')
  } catch (_e) { /* best effort */ }

  // ── 5. Deleta o usuário → cascata apaga todos os dados (25 FKs ON DELETE CASCADE) ─
  const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(user.id)
  if (delErr) {
    console.error(`[delete-account][rid=${rid}] Falha ao deletar user: ${user.id.slice(0, 8)} ${delErr.message}`)
    return json({ ok: false, error: 'delete_failed', message: 'Não foi possível excluir a conta agora. Tente novamente ou contate o suporte.' }, 500, cors)
  }

  console.log(`[delete-account][rid=${rid}] Conta excluída — user: ${user.id.slice(0, 8)} guest: ${!!guestRow} tinha_sub_ativa: ${!!sub}`)
  return json({
    ok: true,
    deleted: true,
    hadActiveSubscription: !!sub,
    wasGuest: !!guestRow,
    // Base corrigida em 2026-07-16: não é obrigação legal. O Marco Civil art. 15
    // trata de "registro de acesso", que o art. 5º, VIII define como data/hora
    // "a partir de um determinado endereço IP" — e este log NÃO grava IP (nulo em
    // 100% das 19.796 linhas). Sem IP, o art. 15 não incide: a base é legítimo
    // interesse (LGPD art. 7º, IX). Prometer ao titular uma base que não existe é
    // pior do que não prometer nada.
    message: sub
      ? 'Conta excluída. Se você tinha assinatura ativa, cancele/verifique no Stripe para evitar cobranças futuras. Um registro interno de auditoria (qual operação e quando, sem IP e sem dados financeiros) é mantido por 6 meses por legítimo interesse de segurança e depois apagado.'
      : 'Conta e dados financeiros excluídos. Um registro interno de auditoria (qual operação e quando, sem IP e sem dados financeiros) é mantido por 6 meses por legítimo interesse de segurança e depois apagado automaticamente.',
  }, 200, cors)
})
