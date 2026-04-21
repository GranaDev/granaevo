import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ---------------------------------------------------------------------------
// HKDF + AES-256-GCM — descriptografia com chave derivada por usuário
//
// v2: chave derivada via HKDF(masterKey, userId) — atual
// v1: chave global direta — legado (dados antigos, lazy migration)
// sem prefixo: texto simples legado — retorna como estão
// ---------------------------------------------------------------------------
async function deriveUserKey(userId: string): Promise<CryptoKey | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null
  const masterBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0))
  const masterKey   = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(userId),
      info: new TextEncoder().encode('granaevo-data-v2'),
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function decryptData(encrypted: string, userId: string): Promise<string | null> {
  const keyBase64 = Deno.env.get('DATA_ENCRYPTION_KEY')
  if (!keyBase64) return null

  let key: CryptoKey
  let payload: string

  try {
    if (encrypted.startsWith('v2:')) {
      // Chave derivada por usuário (HKDF) — formato atual
      const derived = await deriveUserKey(userId)
      if (!derived) return null
      key     = derived
      payload = encrypted.slice(3)
    } else if (encrypted.startsWith('v1:')) {
      // Chave global — legado, lazy migrated na próxima escrita
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

// ---------------------------------------------------------------------------
// CORS — restrito ao domínio configurado.
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

  if (req.method !== 'GET') {
    return json({ success: false, error: 'Método não permitido' }, 405, corsHeaders)
  }

  // ── 1. Verificar proxy secret ────────────────────────────────────────────
  const proxySecret = Deno.env.get('PROXY_SECRET')
  if (proxySecret) {
    const received = req.headers.get('x-proxy-secret') ?? ''
    if (!timingSafeEqual(received, proxySecret)) {
      console.warn('[get-user-data] Proxy secret inválido — acesso bloqueado')
      return json({ success: false, error: 'Não autorizado' }, 401, corsHeaders)
    }
  }

  // ── 2. Verificar JWT e extrair userId ────────────────────────────────────
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

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user?.id) {
    console.warn('[get-user-data] JWT inválido:', authError?.message)
    return json({ success: false, error: 'Token inválido ou expirado' }, 401, corsHeaders)
  }

  const userId = user.id

  try {
    // ── 3. Buscar dados do banco ─────────────────────────────────────────────
    const { data, error } = await supabaseAdmin
      .from('user_data')
      .select('data_json')
      .eq('user_id', userId)
      .single()

    // Registro não existe — cliente deve criar com o save endpoint
    if (error?.code === 'PGRST116') {
      return json({ success: false, error: 'NOT_FOUND' }, 404, corsHeaders)
    }

    if (error) throw error

    if (!data?.data_json) {
      return json({ success: false, error: 'NOT_FOUND' }, 404, corsHeaders)
    }

    // ── 4. Descriptografar se necessário (lazy migration) ────────────────────
    // Dados com _enc: "v1:..." → descriptografar.
    // Dados sem _enc → texto simples antigo → retornar como estão.
    let dataJson = data.data_json as Record<string, unknown>

    if (typeof dataJson._enc === 'string') {
      const plaintext = await decryptData(dataJson._enc, userId)
      if (!plaintext) {
        console.error('[get-user-data] Falha ao descriptografar para userId:', userId.slice(0, 8))
        return json({ success: false, error: 'Erro ao descriptografar dados' }, 500, corsHeaders)
      }
      try {
        dataJson = JSON.parse(plaintext)
      } catch {
        console.error('[get-user-data] JSON inválido após descriptografar para userId:', userId.slice(0, 8))
        return json({ success: false, error: 'Erro ao processar dados' }, 500, corsHeaders)
      }
    }

    return json({ success: true, data_json: dataJson }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[get-user-data] Erro:', error?.message)
    return json({ success: false, error: 'Erro interno ao carregar dados' }, 500, corsHeaders)
  }
})
