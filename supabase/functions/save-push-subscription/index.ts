import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { recusarEndpointPush } from '../_shared/push-endpoint.ts'

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

const PROXY_SECRET = Deno.env.get('PROXY_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY  = getSecretKey()

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

  // SEC-002: o endpoint precisa ser de um push service DE VERDADE. Antes, qualquer
  // string não-vazia era aceita — e `send-radar-push` faz POST para o que estiver
  // gravado, então o campo era o destino de uma requisição de saída do backend.
  // A regra mora em _shared/push-endpoint.ts porque vale aqui E no envio; copiada
  // nos dois lugares, ela divergiria.
  const recusa = recusarEndpointPush(endpoint)
  if (recusa !== null) {
    console.warn(`[save-push-subscription] endpoint recusado (${recusa}) — user: ${user.id.slice(0, 8)}`)
    // Resposta genérica: o motivo vai para o log do servidor, não para quem tentou.
    return new Response(JSON.stringify({ error: 'endpoint inválido' }), { status: 400 })
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
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}
