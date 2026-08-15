import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { buildRestoredBlob, buildBlobSemPerfil, buildBlobComPerfil } from './_restore-core.js'
import { mfaBloqueia } from '../_shared/mfa-gate.ts'

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS).
// SEM fallback na legada: as chaves antigas (anon e service_role) foram
// DESATIVADAS em 2026-07-23 e devolvem 401 "Legacy API keys are disabled".
// Um fallback para uma chave morta não é rede de segurança — é um 401 confuso
// no lugar de um erro de configuração legível. Se a env sumir, falhe alto.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
    if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
  } catch { /* JSON inválido: cai no throw abaixo */ }
  throw new Error('SUPABASE_SECRET_KEYS ausente ou inválida')
}

// ---------------------------------------------------------------------------
// user-data-backup — Edge Function para listagem e restauração de snapshots
//
// GET  → lista últimos 5 snapshots do usuário (metadados apenas, SEM data_json)
// POST { action: "restore", snapshot_date: "YYYY-MM-DD" } → restaura snapshot
//
// Segurança:
//   • Proxy secret obrigatório (x-proxy-secret)
//   • JWT validado via auth.getUser() (ES256, não decode manual)
//   • Gate de 2º fator (mfaBloqueia) — ver o bloco [SEC-004] abaixo
//   • Autorização: usuário só acessa/restaura seus próprios dados
//   • data_json nunca retornado via API (apenas metadados)
//   • snapshot_date validado com regex estrita antes de qualquer query
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc    = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}

function json(body: unknown, status = 200, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// Valida formato YYYY-MM-DD + data calendário válida
function isValidSnapshotDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !isNaN(d.getTime())
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'Método não permitido' }, 405, cors)
  }

  // ── 1. Proxy secret ────────────────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[user-data-backup] PROXY_SECRET não configurada')
    return json({ error: 'Configuração inválida' }, 500, cors)
  }
  if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
    console.warn('[user-data-backup] Proxy secret inválido')
    return json({ error: 'Não autorizado' }, 401, cors)
  }

  // ── 2. JWT ─────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  if (!token || token.length < 20) {
    return json({ error: 'Não autenticado' }, 401, cors)
  }

  // ── 3. Validação JWT com assinatura real (auth.getUser) ────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey  = getSecretKey()

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: { user }, error: authError } = await admin.auth.getUser(token)
  if (authError || !user?.id) {
    console.warn('[user-data-backup] JWT inválido:', authError?.message ?? 'user null')
    return json({ error: 'Token inválido' }, 401, cors)
  }

  // ── 3.5 [SEC-004] Gate do 2º fator — a mesma trava de get/save-user-data ───
  //
  // O cabeçalho do _shared/mfa-gate.ts diz por que o gate existe: as policies
  // `exige_aal2` cobrem o que o cliente alcança por PostgREST, mas estas edges
  // falam com o banco usando service_role, que BYPASSA RLS.
  //
  // Esta função se encaixa nessa descrição palavra por palavra — e escapou.
  // Ela lê e ESCREVE em `user_data`, a mesma tabela e o mesmo blob financeiro,
  // com o mesmo service_role. O resultado era um MFA com a porta dos fundos
  // aberta: uma sessão aal1 (a de um aparelho que já estava logado quando o 2FA
  // foi ligado, ou um access token roubado) não conseguia LER nem GRAVAR pelo
  // caminho normal, mas conseguia RESTAURAR — que é sobrescrever a vida
  // financeira inteira da conta por um retrato de até 5 dias atrás.
  //
  // O GET entra no gate junto: datas e tamanhos de snapshot não são o blob, mas
  // são o mapa que diz QUAL data reverter para causar o maior estrago.
  //
  // Falha FECHADO, como nas outras duas (ver o comentário no mfa-gate).
  if (await mfaBloqueia(admin, token, user.id, 'user-data-backup')) {
    console.warn('[user-data-backup] 2FA exigido e sessão não elevada:', user.id.slice(0, 8))
    return json({ error: 'Verificação em duas etapas necessária', mfa_required: true }, 403, cors)
  }

  // ── 3b. Convidado → DONO (mesma resolução de get-user-data/save-user-data) ─
  // Um convidado (account_members) NÃO tem user_data nem snapshots próprios: os
  // dados que ele enxerga são os do titular. Sem esta resolução, o convidado
  // via um histórico de backup VAZIO — e, se conseguisse disparar a restauração,
  // ela rodaria contra um user_id sem linha nenhuma e mentiria "restaurado".
  // Isto é leitura/escrita nos dados do DONO por um membro ativo — exatamente o
  // que o app já faz no load e no save; a autorização é o vínculo ativo em
  // account_members, conferido aqui no servidor.
  let effectiveUserId = user.id
  let effectiveEmail  = user.email ?? ''
  const { data: memberEntry } = await admin
    .from('account_members')
    .select('owner_user_id, owner_email')
    .eq('member_user_id', user.id)
    .eq('is_active', true)
    .maybeSingle()

  if (memberEntry?.owner_user_id) {
    effectiveUserId = memberEntry.owner_user_id
    effectiveEmail  = memberEntry.owner_email ?? effectiveEmail
    console.log(`[user-data-backup] Convidado ${user.id.slice(0, 8)} → dono ${effectiveUserId.slice(0, 8)}`)
  }

  const userId    = effectiveUserId
  const userEmail = effectiveEmail

  // ── GET: listar snapshots (apenas metadados — SEM data_json) ───────────────
  if (req.method === 'GET') {
    const { data, error } = await admin
      .from('user_data_snapshots')
      .select('id, snapshot_date, size_bytes, created_at')
      .eq('user_id', userId)
      .order('snapshot_date', { ascending: false })
      .limit(5)

    if (error) {
      console.error('[user-data-backup] Erro ao listar snapshots:', error.message)
      return json({ error: 'Erro interno' }, 500, cors)
    }

    return json({
      snapshots: (data ?? []).map(s => ({
        id:            s.id,
        snapshot_date: s.snapshot_date,
        size_bytes:    s.size_bytes,
        created_at:    s.created_at,
      }))
    }, 200, cors)
  }

  // ── POST: restaurar snapshot ───────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body JSON inválido' }, 400, cors)
  }

  // ── POST { action: "snapshot" } — fotografa AGORA, antes de destruir ───────
  //
  // Existe por um achado de 2026-08-15: a tela de "Resetar Perfil" prometia
  // ("Backup automático será criado", "⏳ Salvando backup…") um backup que nunca
  // era criado. O cliente gravava um RÓTULO no localStorage e chamava
  // `salvarDados()` — que não gera snapshot. Quem gera é `take_daily_snapshot()`,
  // uma vez por dia, às 03:15 UTC. Quem resetasse às 13:30 e depois restaurasse
  // "antes do reset" recebia o estado de dez horas antes.
  //
  // Sem `snapshot_date` no corpo de propósito: a foto é sempre de HOJE e sempre
  // do estado ATUAL. Deixar o cliente escolher a data seria deixá-lo escolher
  // qual backup sobrescrever — e o cliente não decide nada aqui.
  if (body.action === 'snapshot') {
    const { data: ok, error: snapErr } = await admin
      .rpc('snapshot_sob_demanda', { p_user_id: userId })

    if (snapErr || ok !== true) {
      // FALHA FECHADA, e é o ponto todo desta ação: quem chama está prestes a
      // apagar dados e depende desta foto. Devolver erro faz o cliente ABORTAR
      // a operação destrutiva. Um "ok" otimista aqui reproduziria exatamente o
      // defeito original — a promessa sem a coisa.
      console.error('[user-data-backup] snapshot sob demanda falhou:',
                    snapErr?.message ?? 'RPC devolveu false', '| user:', userId.slice(0, 8))
      return json({ error: 'Não foi possível criar o backup' }, 500, cors)
    }

    console.log('[user-data-backup] snapshot sob demanda criado. user:', userId.slice(0, 8))
    return json({ success: true, snapshot_date: new Date().toISOString().slice(0, 10) }, 200, cors)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXCLUSÃO DE PERFIL — ver docs/exclusao-de-perfil-desenho.md
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // SÓ O DONO. `memberEntry` preenchido significa que quem pediu é CONVIDADO de
  // outra conta — e convidado não exclui perfil nenhum, nem o próprio. Sem esta
  // porta, um membro de uma conta família apagaria o perfil de outro membro.
  //
  // A checagem é aqui, no servidor, contra `account_members`. Nunca contra um
  // `isOwner` vindo do cliente: o cliente é onde o atacante mora.
  const ACOES_DE_PERFIL = ['delete-profile', 'restore-profile', 'list-deleted-profiles']
  if (typeof body.action === 'string' && ACOES_DE_PERFIL.includes(body.action)) {
    if (memberEntry?.owner_user_id) {
      console.warn('[user-data-backup] convidado tentou', body.action, '· user:', user.id.slice(0, 8))
      return json({ error: 'Apenas o titular da conta pode gerenciar perfis' }, 403, cors)
    }

    const chave = Deno.env.get('DATA_ENCRYPTION_KEY') ?? ''

    // ── LISTAR os excluídos que ainda dá para restaurar ─────────────────────
    if (body.action === 'list-deleted-profiles') {
      const { data, error } = await admin.rpc('listar_perfis_excluidos', { p_user_id: userId })
      if (error) {
        console.error('[user-data-backup] listar_perfis_excluidos:', error.message)
        return json({ error: 'Erro interno' }, 500, cors)
      }
      return json(data ?? { ok: true, perfis: [] }, 200, cors)
    }

    // `profile_id` é o único dado do cliente aqui, e ele nunca entra em SQL por
    // concatenação: vai como parâmetro tipado para a RPC. A forma é validada
    // antes de qualquer uso — id de perfil é numérico e curto.
    const rawId = (body as Record<string, unknown>).profile_id
    const profileId = typeof rawId === 'string' ? rawId.trim() : ''
    if (!/^\d{1,12}$/.test(profileId)) {
      return json({ error: 'profile_id inválido' }, 400, cors)
    }

    const { data: linha, error: erroLinha } = await admin
      .from('user_data')
      .select('data_json')
      .eq('user_id', userId)
      .maybeSingle()

    if (erroLinha || !linha?.data_json) {
      console.error('[user-data-backup] blob ausente para', userId.slice(0, 8))
      return json({ error: 'Erro interno' }, 500, cors)
    }

    // ── EXCLUIR ─────────────────────────────────────────────────────────────
    //
    // ORDEM, e ela é a proteção inteira contra perda:
    //   1. monta o blob sem o perfil (em memória — nada gravado ainda)
    //   2. grava o BACKUP com o slot
    //   3. só então regrava o blob
    //   4. e por último desativa o perfil
    //
    // Falha em qualquer ponto deixa o perfil VIVO. O pior caso é um backup
    // órfão, que expira sozinho em 7 dias e não custa nada a ninguém.
    if (body.action === 'delete-profile') {
      let blobNovo
      try {
        blobNovo = await buildBlobSemPerfil({
          keyBase64: chave, currentDataJson: linha.data_json,
          profileId, userId, now: new Date().toISOString(),
        })
      } catch (e) {
        console.error('[user-data-backup] delete-profile, blob:', (e as Error)?.message)
        return json({ error: 'Não foi possível preparar a exclusão' }, 409, cors)
      }

      const { data: res, error: erroRpc } = await admin.rpc('excluir_perfil', {
        p_user_id: userId, p_profile_id: profileId, p_member_data: blobNovo.slot,
      })
      if (erroRpc || res?.ok !== true) {
        console.error('[user-data-backup] excluir_perfil:', erroRpc?.message ?? res?.erro)
        return json({ error: res?.erro === 'PERFIL_NAO_ENCONTRADO'
          ? 'Perfil não encontrado' : 'Não foi possível excluir o perfil' },
          res?.erro === 'PERFIL_NAO_ENCONTRADO' ? 404 : 500, cors)
      }

      // Idempotência: já estava excluído, o blob já não o tem. Não regrava.
      if (res?.ja_excluido === true) {
        return json({ success: true, ja_excluido: true, expira_em: res.expira_em }, 200, cors)
      }

      const { error: erroBlob } = await admin
        .from('user_data')
        .update({ data_json: blobNovo.dataToStore, last_modified: new Date().toISOString() })
        .eq('user_id', userId)

      if (erroBlob) {
        // Backup gravado, blob intacto, perfil ainda ativo: estado consistente.
        console.error('[user-data-backup] delete-profile, gravar blob:', erroBlob.message)
        return json({ error: 'Não foi possível excluir o perfil' }, 500, cors)
      }

      const { data: desativou } = await admin.rpc('desativar_perfil', {
        p_user_id: userId, p_profile_id: profileId,
      })
      if (desativou !== true) {
        // Blob já sem o perfil e a linha ainda ativa: o perfil aparece vazio.
        // Recuperável restaurando — e o backup está gravado, que é o que importa.
        console.error('[user-data-backup] desativar_perfil recusou · user:', userId.slice(0, 8))
      }

      console.log('[user-data-backup] perfil excluído:', profileId, '· user:', userId.slice(0, 8))
      return json({
        success: true, expira_em: res.expira_em, nome: res.nome,
        reservas_afetadas: blobNovo.afetadas,
      }, 200, cors)
    }

    // ── RESTAURAR ───────────────────────────────────────────────────────────
    //
    // A RPC é quem decide se pode: ela confere a vaga (ativos + 1 <= limite) e
    // reativa na MESMA transação, sob advisory lock. É o que impede burlar o
    // limite do plano excluindo e recriando perfis.
    //
    // Ela NÃO consome o backup: se a escrita do blob falhar aqui embaixo, dá
    // para tentar de novo. O backup expira sozinho em 7 dias de qualquer jeito.
    if (body.action === 'restore-profile') {
      const { data: res, error: erroRpc } = await admin.rpc('restaurar_perfil', {
        p_user_id: userId, p_profile_id: profileId,
      })
      if (erroRpc) {
        console.error('[user-data-backup] restaurar_perfil:', erroRpc.message)
        return json({ error: 'Erro interno' }, 500, cors)
      }
      if (res?.ok !== true) {
        if (res?.erro === 'PROFILE_LIMIT_REACHED') {
          return json({
            error: 'PROFILE_LIMIT_REACHED', code: 'PROFILE_LIMIT_REACHED',
            ativos: res.ativos, limite: res.limite,
          }, 409, cors)
        }
        return json({ error: 'Backup não encontrado ou expirado' }, 404, cors)
      }

      try {
        const { dataToStore } = await buildBlobComPerfil({
          keyBase64: chave, currentDataJson: linha.data_json,
          slot: res.member_data, userId, now: new Date().toISOString(),
        })
        const { error: erroBlob } = await admin
          .from('user_data')
          .update({ data_json: dataToStore, last_modified: new Date().toISOString() })
          .eq('user_id', userId)
        if (erroBlob) throw new Error(erroBlob.message)
      } catch (e) {
        // O perfil já foi reativado pela RPC, mas o conteúdo não voltou ao blob.
        // Ele aparece VAZIO — e o backup continua lá, então restaurar de novo
        // conserta. Melhor que deixar o perfil sumido.
        console.error('[user-data-backup] restore-profile, blob:', (e as Error)?.message)
        return json({ error: 'Perfil reativado, mas os dados não voltaram. Tente novamente.' }, 500, cors)
      }

      console.log('[user-data-backup] perfil restaurado:', profileId, '· user:', userId.slice(0, 8))
      return json({ success: true, nome: res.nome }, 200, cors)
    }
  }

  if (body.action !== 'restore') {
    return json({ error: 'Ação inválida' }, 400, cors)
  }

  if (!isValidSnapshotDate(body.snapshot_date)) {
    return json({ error: 'snapshot_date inválido (esperado YYYY-MM-DD)' }, 400, cors)
  }

  const snapshotDate = body.snapshot_date as string

  // Busca snapshot — RLS + eq(user_id) dupla garantia
  const { data: snapshot, error: snapErr } = await admin
    .from('user_data_snapshots')
    .select('data_json, snapshot_date, size_bytes')
    .eq('user_id', userId)
    .eq('snapshot_date', snapshotDate)
    .maybeSingle()

  if (snapErr) {
    console.error('[user-data-backup] Erro ao buscar snapshot:', snapErr.message)
    return json({ error: 'Erro interno' }, 500, cors)
  }

  if (!snapshot?.data_json) {
    return json({ error: 'Snapshot não encontrado' }, 404, cors)
  }

  const now = new Date().toISOString()

  // ── Restore POR PERFIL (RF-09) ──────────────────────────────────────────────
  // Quando o cliente manda `profile_id`, restauramos SÓ o slot daquele perfil: o
  // núcleo lê o blob ATUAL + o do snapshot (decifrando ambos), troca somente esse
  // slot e re-cifra — os demais perfis da conta ficam intactos byte-a-byte. É a
  // correção do RF-09: um convidado restaurando não reverte mais o trabalho de
  // todos. Sem `profile_id`, cai no restore da conta inteira (fallback/rollback).
  const rawProfileId = body.profile_id
  const profileId =
    typeof rawProfileId === 'string' && rawProfileId.length > 0 && rawProfileId.length <= 64
      ? rawProfileId
      : null
  if (rawProfileId !== undefined && profileId === null) {
    return json({ error: 'profile_id inválido' }, 400, cors)
  }

  if (profileId) {
    // Lê o blob ATUAL + carimbo para concorrência otimista (CAS).
    const { data: atual, error: curErr } = await admin
      .from('user_data')
      .select('data_json, last_modified')
      .eq('user_id', userId)
      .maybeSingle()

    if (curErr) {
      console.error('[user-data-backup] Erro ao ler blob atual:', curErr.message)
      return json({ error: 'Erro interno' }, 500, cors)
    }
    if (!atual?.data_json) {
      console.error(`[user-data-backup] RESTORE SEM DESTINO (slot): ${userId.slice(0, 8)}`)
      return json({
        error:   'restore_sem_destino',
        message: 'Não foi possível aplicar o backup: os dados da conta não foram encontrados. Fale com o suporte — seu backup continua guardado.',
      }, 409, cors)
    }

    let dataToStore: unknown
    let outcome = 'replaced'
    try {
      const built = await buildRestoredBlob({
        keyBase64:        Deno.env.get('DATA_ENCRYPTION_KEY') ?? '',
        currentDataJson:  atual.data_json,
        snapshotDataJson: snapshot.data_json,
        profileId,
        userId,
        now,
      })
      dataToStore = built.dataToStore
      outcome     = built.outcome
    } catch (e) {
      const msg = (e as Error)?.message ?? 'erro'
      // Nada foi gravado: preferimos falhar alto a corromper o blob.
      console.error(`[user-data-backup] Merge por-perfil falhou (${msg}) user ${userId.slice(0, 8)}`)
      if (msg === 'perfil_ausente_no_snapshot') {
        return json({ error: 'perfil_ausente', message: 'Este perfil não existe nesse backup.' }, 404, cors)
      }
      return json({
        error:   'restore_falhou',
        message: 'Não foi possível aplicar o backup com segurança. Seu backup continua guardado — fale com o suporte.',
      }, 500, cors)
    }

    // CAS: só grava se o blob NÃO mudou desde a leitura (defesa contra 2ª aba /
    // outro device). O cliente já congela gravações antes de restaurar; isto é o
    // cinto de segurança. Reaplicar por cima de uma escrita concorrente
    // corromperia a corrida — melhor abortar e pedir para tentar de novo.
    let upd = admin
      .from('user_data')
      .update({ data_json: dataToStore, email: userEmail, last_modified: now })
      .eq('user_id', userId)
    upd = atual.last_modified === null
      ? upd.is('last_modified', null)
      : upd.eq('last_modified', atual.last_modified)
    const { data: linhas, error: restoreErr } = await upd.select('user_id')

    if (restoreErr) {
      console.error('[user-data-backup] Erro ao restaurar (slot):', restoreErr.message)
      return json({ error: 'Erro ao restaurar dados' }, 500, cors)
    }
    if (!linhas || linhas.length === 0) {
      return json({
        error:   'conflito_concorrencia',
        message: 'Os dados mudaram durante a restauração. Recarregue e tente novamente.',
      }, 409, cors)
    }

    console.log(
      `[user-data-backup] Restore por-perfil (${outcome}): user ${userId.slice(0, 8)} perfil ${profileId} → snapshot ${snapshotDate}`
    )
    return json({
      success:       true,
      snapshot_date: snapshotDate,
      restored_at:   now,
      scope:         'profile',
      profile_id:    profileId,
    }, 200, cors)
  }

  // ── Restore da CONTA INTEIRA (fallback/rollback — o cliente não usa mais) ────
  // Sobrescreve user_data com o blob do snapshot. Mantido para rollback (deploy
  // antigo do cliente) e suporte. `.select('user_id')` NÃO é decoração: sem ele,
  // um UPDATE que não encontra linha retorna SEM erro, e a função respondia
  // `success: true` para uma restauração que não gravou nada.
  const { data: linhas, error: restoreErr } = await admin
    .from('user_data')
    .update({
      data_json:     snapshot.data_json,
      email:         userEmail,
      last_modified: now,
    })
    .eq('user_id', userId)
    .select('user_id')

  if (restoreErr) {
    console.error('[user-data-backup] Erro ao restaurar:', restoreErr.message)
    return json({ error: 'Erro ao restaurar dados' }, 500, cors)
  }

  if (!linhas || linhas.length === 0) {
    console.error(`[user-data-backup] RESTORE SEM DESTINO: nenhuma linha user_data para ${userId.slice(0, 8)}`)
    return json({
      error:   'restore_sem_destino',
      message: 'Não foi possível aplicar o backup: os dados da conta não foram encontrados. Fale com o suporte — seu backup continua guardado.',
    }, 409, cors)
  }

  console.log(
    `[user-data-backup] Restaurado (conta inteira): user ${userId.slice(0, 8)} → snapshot ${snapshotDate}`
  )

  return json({
    success:       true,
    snapshot_date: snapshotDate,
    restored_at:   now,
  }, 200, cors)
})
