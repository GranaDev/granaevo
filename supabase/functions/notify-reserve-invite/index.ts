// supabase/functions/notify-reserve-invite/index.ts
//
// Empurra os avisos de reserva compartilhada para os OUTROS membros da conta. O
// cliente NAO pode inserir em radar_notifications para outro usuario (RLS so
// deixa inserir p/ si mesmo), entao isto roda com service_role.
//
// DOIS EVENTOS (o nome do arquivo ficou estreito; renomear custaria criar uma
// funcao nova e apagar a antiga, com uma janela sem nenhuma das duas no ar):
//   `convite` (padrao) — "Voce foi convidado para a reserva X"
//   `saida`            — "Fulano saiu da reserva X"
//
// ⚠️ O NOME DE QUEM SAIU E RESOLVIDO AQUI, no banco, NUNCA aceito do cliente.
// Este texto vai para a caixa de entrada de OUTRA pessoa e, via push, para a
// tela de bloqueio do celular dela. Aceitar a string do cliente daria a qualquer
// membro da conta um canal para escrever o que quisesse na notificacao alheia.
// O cliente manda so o `perfil_id`; conferimos que o perfil e da conta e lemos o
// `name` de `public.profiles`.
//
// Fluxo: valida JWT (dono ou convidado) -> resolve o dono -> lista os membros
// ATIVOS da conta -> insere 1 aviso pendente por membro (menos quem convidou) ->
// dispara o send-radar-push para entrega IMEDIATA (o cron do Radar so roda 1x/dia).
//
// Privacidade (regra do Radar): NUNCA R$ no payload. So o nome da reserva.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (fallback SERVICE_ROLE), PROXY_SECRET.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
}

const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB = enc.encode(a), bB = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}
function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
// Troca controles/quebras de linha por espaco (evita payload de push quebrado).
// Char-code em vez de regex de classe de controle de proposito (mantem o fonte ASCII).
function clamp(s: unknown, n: number): string {
  const raw = String(s ?? '')
  let out = ''
  for (const ch of raw) {
    const c = ch.charCodeAt(0)
    out += (c < 32 || c === 127) ? ' ' : ch
  }
  return out.trim().slice(0, n)
}

Deno.serve(async (req: Request) => {
  const h = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })
  if (req.method !== 'POST') return json({ error: 'Metodo nao permitido' }, 405, h)

  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[notify-reserve-invite] PROXY_SECRET ausente')
    return json({ error: 'Configuracao invalida' }, 500, h)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    return json({ error: 'Nao autorizado' }, 401, h)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  if (!token || token.length < 20) return json({ error: 'Nao autenticado' }, 401, h)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(supabaseUrl, getSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: { user }, error: authErr } = await admin.auth.getUser(token)
  if (authErr || !user?.id) return json({ error: 'Token invalido' }, 401, h)
  const callerId = user.id

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Body invalido' }, 400, h) }
  const reservaId = clamp(body.reserva_id, 64)
  if (!reservaId) return json({ error: 'reserva_id obrigatorio' }, 400, h)
  const reservaNome = clamp(body.reserva_nome, 40) || 'uma reserva'
  const evento = body.evento === 'saida' ? 'saida' : 'convite'
  const perfilId = Number.isInteger(body.perfil_id) ? Number(body.perfil_id) : null
  if (evento === 'saida' && perfilId === null) {
    return json({ error: 'perfil_id obrigatorio na saida' }, 400, h)
  }

  // Resolve o DONO da conta (o convidado insere no registro do dono).
  let ownerId = callerId
  const { data: asMember } = await admin
    .from('account_members')
    .select('owner_user_id')
    .eq('member_user_id', callerId)
    .eq('is_active', true)
    .maybeSingle()
  if (asMember?.owner_user_id) ownerId = asMember.owner_user_id

  // Membros ATIVOS da conta (com user_id) + o proprio dono, menos quem convidou.
  const { data: membros, error: memErr } = await admin
    .from('account_members')
    .select('member_user_id')
    .eq('owner_user_id', ownerId)
    .eq('is_active', true)
  if (memErr) {
    console.error('[notify-reserve-invite] Erro ao listar membros:', memErr.message)
    return json({ error: 'Erro interno' }, 500, h)
  }

  const alvos = new Set<string>()
  alvos.add(ownerId)
  for (const m of (membros ?? [])) if (m.member_user_id) alvos.add(String(m.member_user_id))
  alvos.delete(callerId) // quem convidou nao se notifica

  // ⚠️ CONTA DE LOGIN UNICO: aqui a lista zerava e NADA era gravado.
  //
  // Achado em 2026-08-15: `radar_notifications` e por USER_ID, mas reserva
  // compartilhada e por PERFIL. Numa conta familia com 4 perfis e um login so —
  // o caso mais comum — os "outros membros" nao existem como user_id: sao
  // perfis do mesmo login. Resultado: o sino NUNCA mostrava nada de reserva
  // nessas contas. A tabela do dono estava com zero linhas desde sempre.
  //
  // O convite continua sendo PARA um perfil, e quem vai abrir aquele perfil e a
  // mesma pessoa. Ela precisa ver o aviso ao trocar de perfil — que e
  // exatamente o que o sino serve para dizer.
  //
  // Entao: se so sobrou o proprio autor, ele recebe. O texto abaixo muda junto,
  // porque "voce foi convidado" seria mentira para quem convidou.
  const soEuNaConta = alvos.size === 0
  if (soEuNaConta) alvos.add(callerId)

  // ── QUEM SAIU: nome lido do BANCO, nunca do corpo da requisicao ───────────
  // `profiles` de uma conta ficam todos sob o user_id do DONO (conferido em
  // producao), entao casar por (id, user_id = ownerId) prova que o perfil e
  // desta conta. Perfil de outra conta nao casa e cai no generico.
  let nomeQuemSaiu = 'Alguem'
  if (evento === 'saida') {
    const { data: perfil } = await admin
      .from('profiles')
      .select('name')
      .eq('id', perfilId)
      .eq('user_id', ownerId)
      .maybeSingle()
    nomeQuemSaiu = clamp(perfil?.name, 40) || 'Alguem'
  }

  const nowIso = new Date().toISOString()
  // O dia entra na chave da SAIDA porque sair e um evento que se repete: quem
  // sai, e um dia volta e sai de novo, precisa avisar de novo. O convite nao —
  // ali a chave por reserva e o proprio dedupe.
  const dia = nowIso.slice(0, 10)

  const linhas = [...alvos].map((uid) => (evento === 'saida' ? {
    user_id:    uid,
    dedupe_key: `saida:${reservaId}:${perfilId}:${dia}:${uid}`.slice(0, 120),
    tipo:       'saida_reserva',
    title:      'Saida de reserva compartilhada',
    // Sem R$ no payload — regra do Radar. So quem saiu e de qual reserva.
    body:       `${nomeQuemSaiu} saiu da reserva "${reservaNome}". O valor que era dele voltou para o saldo dele.`.slice(0, 200),
    url:        '/dashboard#reservas',
    fire_at:    nowIso,
    status:     'pending',
  } : {
    user_id:    uid,
    dedupe_key: `convite:${reservaId}:${uid}`.slice(0, 120),
    tipo:       'convite_reserva',
    title:      'Convite de reserva compartilhada',
    // "Voce foi convidado" seria mentira para quem convidou. Numa conta de
    // login unico o aviso existe para lembrar a pessoa ao trocar de perfil.
    body:       (soEuNaConta
      ? `Um perfil desta conta foi convidado para a reserva "${reservaNome}". Troque de perfil e abra Reservas para aceitar.`
      : `Voce foi convidado para a reserva "${reservaNome}". Abra Reservas para aceitar ou recusar.`
    ).slice(0, 200),
    url:        '/dashboard#reservas',
    fire_at:    nowIso,
    status:     'pending',
  }))

  const { error: insErr } = await admin
    .from('radar_notifications')
    .upsert(linhas, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true })
  if (insErr) {
    console.error('[notify-reserve-invite] Erro ao inserir avisos:', insErr.message)
    return json({ error: 'Erro ao notificar' }, 500, h)
  }

  // Entrega IMEDIATA: dispara o send-radar-push (o cron so roda 1x/dia). Best-effort
  // — se falhar, o cron entrega mais tarde; o aviso ja esta gravado.
  try {
    await fetch(`${supabaseUrl}/functions/v1/send-radar-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-secret': proxySecret },
      body: JSON.stringify({ trigger: evento === 'saida' ? 'saida_reserva' : 'convite_reserva' }),
      signal: AbortSignal.timeout(8_000),
    })
  } catch (e) {
    console.warn('[notify-reserve-invite] send-radar-push nao disparou agora:', (e as Error).message)
  }

  console.log(`[notify-reserve-invite] ${evento} ${reservaId.slice(0, 8)} -> ${alvos.size} membro(s)`)
  return json({ ok: true, notified: alvos.size }, 200, h)
})
