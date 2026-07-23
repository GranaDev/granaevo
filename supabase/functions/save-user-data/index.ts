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

// ---------------------------------------------------------------------------
// HKDF + AES-256-GCM — chave derivada por usuário
// Formato no banco: { _enc: "v2:base64(iv[12] + ciphertext + authTag[16])" }
// ---------------------------------------------------------------------------
async function deriveUserKey(userId: string): Promise<CryptoKey | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null
  const masterBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
  const masterKey   = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(userId), info: new TextEncoder().encode('granaevo-data-v2') },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptData(plaintext: string, userId: string): Promise<string | null> {
  const key = await deriveUserKey(userId)
  if (!key) return null
  const iv      = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const cipher  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined = new Uint8Array(iv.byteLength + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.byteLength)
  return 'v2:' + btoa(String.fromCharCode(...combined))
}

// Decifra (mesmo esquema do get-user-data) — usado SÓ pela guarda anti-wipe,
// para inspecionar os dados atuais antes de sobrescrever.
async function decryptData(encrypted: string, userId: string): Promise<string | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null
  let key: CryptoKey
  let payload: string
  try {
    if (encrypted.startsWith('v2:')) {
      const derived = await deriveUserKey(userId)
      if (!derived) return null
      key     = derived
      payload = encrypted.slice(3)
    } else if (encrypted.startsWith('v1:')) {
      const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
      key     = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
      payload = encrypted.slice(3)
    } else {
      return null
    }
    const combined = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
    const iv       = combined.slice(0, 12)
    const cipher   = combined.slice(12)
    const plain    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

// Um perfil "tem dados" se qualquer coleção financeira não está vazia.
function profileHasData(p: any): boolean {
  if (!p || typeof p !== 'object') return false
  const ne = (k: string) => Array.isArray(p[k]) && p[k].length > 0
  return ne('transacoes') || ne('metas') || ne('contasFixas') ||
         ne('cartoesCredito') || ne('assinaturas')
}

// Extrai o array de profiles do blob armazenado (decifrando se necessário).
// Retorna null quando não dá para inspecionar com segurança (sem decifrar etc.).
async function extractStoredProfiles(stored: any, userId: string): Promise<any[] | null> {
  try {
    let obj = stored
    if (stored && typeof stored._enc === 'string') {
      const plain = await decryptData(stored._enc, userId)
      if (!plain) return null
      obj = JSON.parse(plain)
    }
    return Array.isArray(obj?.profiles) ? obj.profiles : null
  } catch {
    return null
  }
}


// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

function getCorsHeaders(origin: string): Record<string, string> {
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
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

function json(body: unknown, status = 200, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  const origin      = req.headers.get('origin') ?? ''
  const corsHeaders = getCorsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Método não permitido' }, 405, corsHeaders)
  }

  // ── 1. Verificar proxy secret ────────────────────────────────────────────
  // PROXY_SECRET é obrigatória — sem ela, qualquer requisição seria aceita.
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (!proxySecret) {
    console.error('[save-user-data] PROXY_SECRET não configurada — requisição bloqueada')
    return json({ success: false, error: 'Configuração interna inválida' }, 500, corsHeaders)
  }
  const received = req.headers.get('x-proxy-secret') ?? ''
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn('[save-user-data] Proxy secret inválido — acesso bloqueado')
    return json({ success: false, error: 'Não autorizado' }, 401, corsHeaders)
  }

  // ── 2. Extrair token JWT ─────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

  if (!token || token.length < 20) {
    return json({ success: false, error: 'Não autenticado' }, 401, corsHeaders)
  }

  // ── 3. Cliente admin + verificação JWT com assinatura real ────────────────
  // [SEC-FIX R4-001] Substituído decodeJwtPayload (sem verificação de assinatura)
  // por supabaseAdmin.auth.getUser(token) que valida ES256 via JWKS — mesma
  // abordagem usada em check-user-access e upload-profile-photo.
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey  = getSecretKey()

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user?.id) {
    console.warn('[save-user-data] JWT inválido ou expirado:', authError?.message ?? 'user null')
    return json({ success: false, error: 'Token inválido' }, 401, corsHeaders)
  }

  const userId    = user.id
  const userEmail = user.email ?? ''

  // ── 4. Resolver ID efetivo — convidados salvam nos dados do dono ─────────
  // O save opera sempre no registro do dono. O convidado nunca cria
  // um registro separado — isso garantiria que o save do convidado
  // apareça para o dono e vice-versa.
  let effectiveUserId    = userId
  let effectiveUserEmail = userEmail
  const { data: memberEntry } = await supabaseAdmin
    .from('account_members')
    .select('owner_user_id, owner_email')
    .eq('member_user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (memberEntry?.owner_user_id) {
    effectiveUserId    = memberEntry.owner_user_id
    effectiveUserEmail = memberEntry.owner_email ?? userEmail
    console.log('[save-user-data] Convidado — salvando no registro do dono:', effectiveUserId.slice(0, 8))
  }

  try {
    // ── 5. Ler e validar corpo ───────────────────────────────────────────────
    let body: { profiles?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ success: false, error: 'Body JSON inválido' }, 400, corsHeaders)
    }

    if (!Array.isArray(body?.profiles)) {
      return json({ success: false, error: 'profiles deve ser um array' }, 400, corsHeaders)
    }

    // 20: o limite REAL por plano (1/2/4) é imposto pelo trigger
    // `enforce_profile_limit_stripe` na tabela `profiles`. Este teto só impede
    // que um save forjado infle o blob com perfis órfãos — abuso de
    // armazenamento, não de plano. Era 200; 20 é 5× o maior plano e 10× o
    // máximo observado em produção.
    // MANTER EM SINCRONIA com MAX_PROFILES em api/user-data.js.
    const MAX_PROFILES = 20
    const profiles = body.profiles as unknown[]
    if (profiles.length > MAX_PROFILES) {
      return json({ success: false, error: `Número de perfis excede o limite de ${MAX_PROFILES}` }, 400, corsHeaders)
    }

    // ── 6. Montar payload e criptografar ────────────────────────────────────
    // Usa effectiveUserId/Email — para convidados, isso é o ID/email do dono
    const dataToSave = {
      version:  '1.0',
      user:     { userId: effectiveUserId, email: effectiveUserEmail },
      profiles,
      metadata: {
        lastSync:      new Date().toISOString(),
        totalProfiles: profiles.length,
      },
    }

    const encrypted   = await encryptData(JSON.stringify(dataToSave), effectiveUserId)
    const dataToStore = encrypted ? { _enc: encrypted } : dataToSave

    const now = new Date().toISOString()

    // ── 7. INSERT ou UPDATE — funciona independente de constraints ──────────
    const { data: existing, error: selectErr } = await supabaseAdmin
      .from('user_data')
      .select('user_id, data_json')
      .eq('user_id', effectiveUserId)
      .maybeSingle()

    if (selectErr) {
      console.error('[save-user-data] Erro ao verificar registro existente:', selectErr.message)
      throw selectErr
    }

    // ── 6.5 GUARDA ANTI-WIPE (autoritativa, server-side) ────────────────────
    // Bug recorrente: após um load falho, o cliente reenvia perfis VAZIOS e
    // sobrescrevia dados reais. Esta checagem é IMUNE a bundle/Service Worker
    // desatualizado no cliente. Rejeita o save quando o registro atual TEM dados
    // e o payload zeraria todos OU esvaziaria um perfil que tinha dados.
    // (Remoção legítima de um perfil — perfil ausente no payload — NÃO bloqueia.)
    if (existing?.data_json) {
      const incomingHasAnyData = (profiles as any[]).some(profileHasData)
      const existingProfiles   = await extractStoredProfiles(existing.data_json, effectiveUserId)
      let wouldWipe = false

      if (existingProfiles === null) {
        // Não deu para inspecionar (cifrado e não decifrou, ou shape inesperado).
        // Conservador: se há blob cifrado atual e o payload não traz NENHUM dado,
        // é provável wipe (e sobrescrever destruiria o ciphertext) → bloqueia.
        const existingHasEnc = typeof (existing.data_json as any)?._enc === 'string'
        if (existingHasEnc && !incomingHasAnyData) wouldWipe = true
      } else if (existingProfiles.length > 0) {
        const hadDataIds = new Set(
          existingProfiles.filter(profileHasData).map((p: any) => String(p?.id)),
        )
        if (hadDataIds.size > 0) {
          const incomingById = new Map((profiles as any[]).map(p => [String(p?.id), p]))
          wouldWipe = profiles.length === 0 // zerou todos os perfis
          if (!wouldWipe) {
            for (const id of hadDataIds) {
              const incoming = incomingById.get(id)
              // Só bloqueia o caso do BUG: perfil ainda presente, porém esvaziado.
              // (Remoção legítima de um perfil — ausente no payload — não bloqueia.)
              if (incoming && !profileHasData(incoming)) { wouldWipe = true; break }
            }
          }
        }
      }

      if (wouldWipe) {
        console.error(
          '[save-user-data] BLOQUEIO ANTI-WIPE: payload esvaziaria dados existentes — save rejeitado. user:',
          effectiveUserId.slice(0, 8),
        )
        return json({ success: false, error: 'WIPE_BLOCKED', code: 'WIPE_BLOCKED' }, 409, corsHeaders)
      }
    }

    if (existing) {
      const { error: updateErr } = await supabaseAdmin
        .from('user_data')
        .update({ email: effectiveUserEmail, data_json: dataToStore, last_modified: now })
        .eq('user_id', effectiveUserId)
      if (updateErr) {
        console.error('[save-user-data] Erro no UPDATE:', updateErr.message)
        throw updateErr
      }
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('user_data')
        .insert({ user_id: effectiveUserId, email: effectiveUserEmail, data_json: dataToStore, last_modified: now })
      if (insertErr) {
        console.error('[save-user-data] Erro no INSERT:', insertErr.message)
        throw insertErr
      }
    }

    return json({ success: true }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[save-user-data] Erro:', error?.message)
    return json({ success: false, error: 'Erro interno ao salvar dados' }, 500, corsHeaders)
  }
})
