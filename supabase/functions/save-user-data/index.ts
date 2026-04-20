import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ---------------------------------------------------------------------------
// AES-256-GCM — criptografia dos dados em repouso
// Formato: { _enc: "v1:base64(iv[12] + ciphertext + authTag[16])" }
// ---------------------------------------------------------------------------
async function encryptData(plaintext: string): Promise<string | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null
  const keyBytes  = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
  const key       = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const iv        = crypto.getRandomValues(new Uint8Array(12))
  const encoded   = new TextEncoder().encode(plaintext)
  const cipher    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const combined  = new Uint8Array(iv.byteLength + cipher.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(cipher), iv.byteLength)
  return 'v1:' + btoa(String.fromCharCode(...combined))
}

// ---------------------------------------------------------------------------
// CORS — restrito ao domínio configurado via ALLOWED_ORIGIN.
// Fallback para '*' se não estiver definida (dev local).
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

// ---------------------------------------------------------------------------
// Comparação de strings em tempo constante — evita timing attack
// ---------------------------------------------------------------------------
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
  // Esta função é chamada EXCLUSIVAMENTE pelo proxy Vercel (/api/save-user-data).
  // O proxy injeta x-proxy-secret; chamadas diretas sem o secret são bloqueadas.
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (proxySecret) {
    const received = req.headers.get('x-proxy-secret') ?? ''
    if (!timingSafeEqual(received, proxySecret)) {
      console.warn('[save-user-data] Proxy secret inválido — acesso bloqueado')
      return json({ success: false, error: 'Não autorizado' }, 401, corsHeaders)
    }
  }

  // ── 2. Verificar JWT e extrair userId ────────────────────────────────────
  // userId vem EXCLUSIVAMENTE do JWT verificado — nunca do corpo da requisição.
  // Impede que um atacante sobrescreva dados de outro usuário enviando userId arbitrário.
  const authHeader = req.headers.get('Authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

  if (!token || token.length < 20) {
    return json({ success: false, error: 'Não autenticado' }, 401, corsHeaders)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  // Valida o JWT via Admin API (funciona com ES256 e HS256)
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user?.id) {
    console.warn('[save-user-data] JWT inválido:', authError?.message)
    return json({ success: false, error: 'Token inválido ou expirado' }, 401, corsHeaders)
  }

  const userId    = user.id
  const userEmail = user.email ?? ''

  try {
    // ── 3. Ler e validar corpo ───────────────────────────────────────────────
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

    // ── 4. Montar payload e criptografar ────────────────────────────────────
    const dataToSave = {
      version:  '1.0',
      user:     { userId, email: userEmail },
      profiles,
      metadata: {
        lastSync:      new Date().toISOString(),
        totalProfiles: profiles.length,
      },
    }

    const encrypted  = await encryptData(JSON.stringify(dataToSave))
    const dataToStore = encrypted ? { _enc: encrypted } : dataToSave

    // ── 5. Upsert atômico — substitui double SELECT + UPDATE/INSERT ──────────
    const { error: dbError } = await supabaseAdmin
      .from('user_data')
      .upsert(
        { user_id: userId, email: userEmail, data_json: dataToStore, last_modified: new Date().toISOString() },
        { onConflict: 'user_id', ignoreDuplicates: false }
      )

    if (dbError) throw dbError

    return json({ success: true }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[save-user-data] Erro:', error?.message)
    return json({ success: false, error: 'Erro interno ao salvar dados' }, 500, corsHeaders)
  }
})
