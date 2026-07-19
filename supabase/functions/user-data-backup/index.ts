import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// ---------------------------------------------------------------------------
// user-data-backup — Edge Function para listagem e restauração de snapshots
//
// GET  → lista últimos 5 snapshots do usuário (metadados apenas, SEM data_json)
// POST { action: "restore", snapshot_date: "YYYY-MM-DD" } → restaura snapshot
//
// Segurança:
//   • Proxy secret obrigatório (x-proxy-secret)
//   • JWT validado via auth.getUser() (ES256, não decode manual)
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
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: { user }, error: authError } = await admin.auth.getUser(token)
  if (authError || !user?.id) {
    console.warn('[user-data-backup] JWT inválido:', authError?.message ?? 'user null')
    return json({ error: 'Token inválido' }, 401, cors)
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

  // Restaura: sobrescreve user_data com o blob do snapshot.
  //
  // `.select('user_id')` NÃO é decoração: sem ele, um UPDATE que não encontra
  // linha alguma retorna SEM erro, e esta função respondia `success: true` para
  // uma restauração que não gravou nada. O usuário via "Backup restaurado!",
  // a página recarregava igual, e ele concluía que perdeu os dados de vez —
  // no exato momento em que mais precisa confiar na ferramenta.
  // Agora a resposta só é de sucesso se uma linha REALMENTE foi escrita.
  const now = new Date().toISOString()
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
    // Existe snapshot mas não existe destino: estado inconsistente. Falhar alto
    // é melhor do que fingir sucesso — o usuário precisa saber para pedir ajuda
    // enquanto o snapshot ainda está dentro da janela de retenção (5 dias).
    console.error(`[user-data-backup] RESTORE SEM DESTINO: nenhuma linha user_data para ${userId.slice(0, 8)}`)
    return json({
      error:   'restore_sem_destino',
      message: 'Não foi possível aplicar o backup: os dados da conta não foram encontrados. Fale com o suporte — seu backup continua guardado.',
    }, 409, cors)
  }

  console.log(
    `[user-data-backup] Restaurado: user ${userId.slice(0, 8)} → snapshot ${snapshotDate}`
  )

  return json({
    success:       true,
    snapshot_date: snapshotDate,
    restored_at:   now,
  }, 200, cors)
})
