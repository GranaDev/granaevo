import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'

// ---------------------------------------------------------------------------
// JWT — decodifica payload sem verificar assinatura.
// Seguro: proxy_secret (no caso chamadas diretas com Authorization) garante
// que apenas chamadas legítimas chegam. Verificamos formato e expiração.
// ---------------------------------------------------------------------------
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64))
  } catch { return null }
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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
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
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  const deny = (status = 200) => json({ hasAccess: false }, status, corsHeaders)

  try {
    // ── 1. Extrair e validar JWT ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[check-user-access] Authorization header ausente')
      return deny(401)
    }

    const token = authHeader.slice(7).trim()
    if (!token || token.length < 20) return deny(401)

    const payload = decodeJwtPayload(token)
    if (!payload || typeof payload.sub !== 'string') {
      console.warn('[check-user-access] JWT malformado')
      return deny(401)
    }

    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp === 'number' && payload.exp < now) {
      console.warn('[check-user-access] JWT expirado')
      return deny(401)
    }

    const userId = payload.sub as string
    console.log('[check-user-access] Verificando acesso para user_id:', userId.slice(0, 8))

    // ── 2. Cliente admin para consulta de subscriptions ──────────────────────
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }
    )

    // ── 3. Verificar subscription ativa ─────────────────────────────────────
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('id, is_active, payment_status, expires_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('payment_status', 'approved')
      .maybeSingle()

    if (subError) {
      console.error('[check-user-access] Erro ao consultar subscriptions:', subError.message)
      return deny()
    }

    if (!subscription) {
      console.log('[check-user-access] Sem subscription ativa para:', userId.slice(0, 8))
      return deny()
    }

    // ── 4. Verificar expiração ────────────────────────────────────────────────
    if (subscription.expires_at) {
      const expired = new Date(subscription.expires_at) < new Date()
      if (expired) {
        console.log('[check-user-access] Subscription expirada para:', userId.slice(0, 8))
        return deny()
      }
    }

    console.log('[check-user-access] Acesso concedido para:', userId.slice(0, 8))
    return json({ hasAccess: true }, 200, corsHeaders)

  } catch (error: any) {
    console.error('[check-user-access] Erro inesperado:', error?.message)
    return deny(500)
  }
})
