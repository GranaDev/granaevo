// mfa-recovery — códigos de recuperação do MFA/TOTP (Passo 31 · B-1)
// ---------------------------------------------------------------------------
// O Supabase Auth não emite códigos de recuperação para TOTP. Esta função é o
// caminho de volta de quem perdeu o celular — e, por isso mesmo, vale tanto
// quanto o próprio segundo fator. Tudo aqui parte dessa premissa.
//
// Ações (POST, campo `action`):
//   generate → apaga os códigos antigos e emite 10 novos. Devolve em CLARO uma
//              única vez; o banco guarda só o SHA-256.
//   consume  → confere um código, queima-o e REMOVE os fatores TOTP do usuário.
//              É o destravamento: o login continua com a sessão aal1 que o BFF
//              já tinha em mãos, agora sem 2º fator pendente.
//   purge    → apaga todos os códigos (chamado quando o usuário desliga o MFA).
//
// POR QUE O `consume` DESLIGA O MFA EM VEZ DE ELEVAR A SESSÃO
//   Só o GoTrue emite um JWT `aal2`, e só mediante um código TOTP válido. Não há
//   como um código nosso produzir uma sessão elevada. A alternativa honesta é a
//   que o GitHub e o Google usam: o código de recuperação derruba o segundo
//   fator, o usuário entra com a senha e reativa o MFA num aparelho novo. A UI
//   diz exatamente isso — o usuário nunca fica sem saber que sua conta ficou
//   com uma camada a menos.
//
// Blindagem:
//   1. x-proxy-secret (timing-safe)  → só o BFF chama
//   2. JWT via getUser()             → o código é sempre do próprio usuário
//   3. comparação timing-safe do hash
//   4. teto de tentativas por usuário/hora  → 6 dígitos de entropia não bastariam
//   5. respostas sem detalhe interno
// ---------------------------------------------------------------------------

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

const PROXY_SECRET = Deno.env.get('PROXY_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = getSecretKey()

const QTD_CODIGOS      = 10
const MAX_TENTATIVAS_H = 10   // consumos errados por usuário por hora

// Base32 de Crockford sem 0/1/8/9/I/L/O/U: nenhum par ambíguo quando o usuário
// copia o código de um papel. Um código = 8 caracteres = 32^8 ≈ 1,1 × 10^12.
const ALFABETO = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// [GOD-TSE] Sem early-return em length — codifica divergência via XOR no diff
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Gera um código no formato XXXX-XXXX usando crypto.getRandomValues.
// O módulo é feito por rejeição de amostra: `% ALFABETO.length` num byte de 0-255
// tornaria as primeiras letras do alfabeto mais prováveis que as últimas, e um
// gerador de credencial não pode ter viés.
function novoCodigo(): string {
  const out: string[] = []
  const buf = new Uint8Array(1)
  while (out.length < 8) {
    crypto.getRandomValues(buf)
    const limite = 256 - (256 % ALFABETO.length)
    if (buf[0] >= limite) continue          // descarta a cauda enviesada
    out.push(ALFABETO[buf[0] % ALFABETO.length])
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4).join('')}`
}

// Normaliza o que o usuário digitou: maiúsculas, sem espaço e sem hífen.
const normalizar = (s: string) => s.toUpperCase().replace(/[\s-]/g, '')

Deno.serve(async (req: Request) => {
  // ── 1. proxy-secret ───────────────────────────────────────────────────────
  if (!PROXY_SECRET || !timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', PROXY_SECRET))
    return json({ error: 'Forbidden' }, 403)
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'config' }, 500)

  // ── 2. JWT ────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)
  const token = authHeader.slice(7).trim()

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: { user }, error: authErr } = await admin.auth.getUser(token)
  if (authErr || !user?.id) return json({ error: 'Unauthorized' }, 401)

  let body: { action?: string; code?: string }
  try { body = await req.json() } catch { return json({ error: 'JSON inválido' }, 400) }
  const action = typeof body.action === 'string' ? body.action : ''

  // ── generate ──────────────────────────────────────────────────────────────
  if (action === 'generate') {
    // Emitir um jogo novo invalida o anterior: ter dois conjuntos válidos
    // dobraria silenciosamente a superfície de destravamento.
    await admin.from('mfa_recovery_codes').delete().eq('user_id', user.id)

    const codes = Array.from({ length: QTD_CODIGOS }, novoCodigo)
    const linhas = await Promise.all(
      codes.map(async c => ({ user_id: user.id, code_hash: await sha256Hex(normalizar(c)) })),
    )
    const { error } = await admin.from('mfa_recovery_codes').insert(linhas)
    if (error) {
      console.error('[mfa-recovery] falha ao gravar códigos:', error.message)
      return json({ error: 'nao_foi_possivel_gerar' }, 500)
    }
    // Única vez que os códigos existem em claro nesta aplicação.
    return json({ ok: true, codes }, 200)
  }

  // ── purge ─────────────────────────────────────────────────────────────────
  if (action === 'purge') {
    await admin.from('mfa_recovery_codes').delete().eq('user_id', user.id)
    return json({ ok: true }, 200)
  }

  // ── consume ───────────────────────────────────────────────────────────────
  if (action === 'consume') {
    const code = normalizar(typeof body.code === 'string' ? body.code : '')
    if (!/^[A-Z2-9]{8}$/.test(code)) return json({ error: 'codigo_invalido' }, 401)

    // Teto por usuário/hora. O BFF já limita por IP; este limite acompanha a
    // CONTA, então trocar de IP não devolve tentativas ao atacante.
    const umaHoraAtras = new Date(Date.now() - 3_600_000).toISOString()
    const { count: usadosRecentes } = await admin
      .from('mfa_recovery_codes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('used_at', umaHoraAtras)
    if ((usadosRecentes ?? 0) >= MAX_TENTATIVAS_H)
      return json({ error: 'rate' }, 429)

    const alvo = await sha256Hex(code)
    const { data: linhas, error: selErr } = await admin
      .from('mfa_recovery_codes')
      .select('id, code_hash')
      .eq('user_id', user.id)
      .is('used_at', null)
    if (selErr) return json({ error: 'indisponivel' }, 500)

    // Percorre TODAS as linhas mesmo depois de achar: sair no primeiro acerto
    // faria o tempo de resposta revelar a posição do código na lista.
    let achado: string | null = null
    for (const l of (linhas ?? [])) {
      if (timingSafeEqual(String(l.code_hash ?? ''), alvo)) achado = String(l.id)
    }
    if (!achado) return json({ error: 'codigo_invalido' }, 401)

    // Queima com guarda `is('used_at', null)`: se duas requisições chegarem
    // juntas com o mesmo código, só uma encontra a linha ainda livre.
    const { data: queimado, error: updErr } = await admin
      .from('mfa_recovery_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('id', achado)
      .is('used_at', null)
      .select('id')
      .maybeSingle()
    if (updErr || !queimado) return json({ error: 'codigo_invalido' }, 401)

    // Destrava: remove os fatores TOTP. A partir daqui a conta volta a ser
    // protegida só pela senha — e a UI diz isso ao usuário, sem eufemismo.
    let removidos = 0
    try {
      const { data: fatores } = await admin.auth.admin.mfa.listFactors({ userId: user.id })
      for (const f of (fatores?.factors ?? [])) {
        if (f?.status !== 'verified') continue
        const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id })
        if (!delErr) removidos++
      }
    } catch (e) {
      console.error('[mfa-recovery] falha ao remover fatores:', String(e))
    }

    if (removidos === 0) {
      // Sem isto o usuário perderia o código E continuaria trancado do lado de
      // fora. Devolver a tentativa é a única resposta correta aqui.
      await admin.from('mfa_recovery_codes').update({ used_at: null }).eq('id', achado)
      return json({ error: 'nao_foi_possivel_destravar' }, 500)
    }

    // O jogo inteiro morre com o fator: os 9 restantes destravariam algo que
    // não existe mais, e ficariam válidos até o usuário reativar o MFA.
    await admin.from('mfa_recovery_codes').delete().eq('user_id', user.id)

    console.warn('[mfa-recovery] MFA desativado por código de recuperação:', user.id.slice(0, 8))
    return json({ ok: true, mfa_disabled: true, factors_removed: removidos }, 200)
  }

  return json({ error: 'action inválida' }, 400)
})
