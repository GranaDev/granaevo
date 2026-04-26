import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function json(body: unknown, status = 200, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req)

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
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

  try {
    // ── 4. Ler e validar corpo ───────────────────────────────────────────────
    let body: { profiles?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ success: false, error: 'Body JSON inválido' }, 400, corsHeaders)
    }

    if (!Array.isArray(body?.profiles)) {
      return json({ success: false, error: 'profiles deve ser um array' }, 400, corsHeaders)
    }

    const profiles = body.profiles as unknown[]
    if (profiles.length > 200) {
      return json({ success: false, error: 'Número de perfis excede o limite de 200' }, 400, corsHeaders)
    }

    // ── 5. Montar payload e criptografar ────────────────────────────────────
    const dataToSave = {
      version:  '1.0',
      user:     { userId, email: userEmail },
      profiles,
      metadata: {
        lastSync:      new Date().toISOString(),
        totalProfiles: profiles.length,
      },
    }

    const encrypted   = await encryptData(JSON.stringify(dataToSave), userId)
    const dataToStore = encrypted ? { _enc: encrypted } : dataToSave

    const now = new Date().toISOString()

    // ── 6. INSERT ou UPDATE — funciona independente de constraints ──────────
    // Tenta UPDATE primeiro; se nenhuma linha for afetada, faz INSERT.
    // Evita depender de UNIQUE constraint para onConflict.
    const { data: existing, error: selectErr } = await supabaseAdmin
      .from('user_data')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (selectErr) {
      console.error('[save-user-data] Erro ao verificar registro existente:', selectErr.message)
      throw selectErr
    }

    if (existing) {
      const { error: updateErr } = await supabaseAdmin
        .from('user_data')
        .update({ email: userEmail, data_json: dataToStore, last_modified: now })
        .eq('user_id', userId)
      if (updateErr) {
        console.error('[save-user-data] Erro no UPDATE:', updateErr.message)
        throw updateErr
      }
    } else {
      const { error: insertErr } = await supabaseAdmin
        .from('user_data')
        .insert({ user_id: userId, email: userEmail, data_json: dataToStore, last_modified: now })
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
