import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PROXY_SECRET = Deno.env.get('PROXY_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req: Request) => {
  const proxySecret = req.headers.get('x-proxy-secret') ?? ''
  if (!PROXY_SECRET || !timingSafeEqual(proxySecret, PROXY_SECRET)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 })
  }
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }
  const token = authHeader.slice(7)
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }
  let body: { endpoint?: string }
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400 })
  }
  if (!body.endpoint) {
    return new Response(JSON.stringify({ error: 'endpoint obrigatório' }), { status: 400 })
  }
  await supabaseAdmin
    .from('push_subscriptions')
    .update({ is_active: false })
    .eq('user_id', user.id)
    .eq('endpoint', body.endpoint)

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
})

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = b.padEnd(a.length, '\0')
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ dummy.charCodeAt(i)
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
