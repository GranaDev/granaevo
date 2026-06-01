import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PROXY_SECRET = Deno.env.get('PROXY_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req: Request) => {
  // Verificar proxy secret
  const proxySecret = req.headers.get('x-proxy-secret') ?? ''
  if (!PROXY_SECRET || !timingSafeEqual(proxySecret, PROXY_SECRET)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 })
  }

  // Autenticar usuário
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }
  const token = authHeader.slice(7)

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  let body: { endpoint?: string; p256dh?: string; auth?: string; userAgent?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 })
  }

  const { endpoint, p256dh, auth, userAgent } = body
  if (!endpoint || typeof endpoint !== 'string' || !p256dh || !auth) {
    return new Response(JSON.stringify({ error: 'Campos obrigatórios: endpoint, p256dh, auth' }), { status: 400 })
  }

  // Limite: máximo 10 dispositivos por usuário
  const { count } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('is_active', true)

  if ((count ?? 0) >= 10) {
    // Remove a subscription mais antiga para dar espaço
    const { data: oldest } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .order('last_used_at', { ascending: true })
      .limit(1)
      .single()
    if (oldest) {
      await supabaseAdmin.from('push_subscriptions').delete().eq('id', oldest.id)
    }
  }

  const { error: upsertError } = await supabaseAdmin
    .from('push_subscriptions')
    .upsert({
      user_id:      user.id,
      endpoint,
      p256dh,
      auth_key:     auth,
      user_agent:   userAgent?.slice(0, 256) ?? null,
      last_used_at: new Date().toISOString(),
      is_active:    true,
    }, { onConflict: 'endpoint' })

  if (upsertError) {
    return new Response(JSON.stringify({ error: 'Erro ao salvar subscription' }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Faz a comparação completa mesmo assim para evitar timing attacks por tamanho
    const dummy = b.padEnd(a.length, '\0')
    let diff = 0
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ dummy.charCodeAt(i)
    }
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
