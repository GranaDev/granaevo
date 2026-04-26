import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ---------------------------------------------------------------------------
// process-cakto-payment — FUNÇÃO ADMINISTRATIVA
//
// Disparo manual de aprovação / reembolso / cancelamento de pedidos Cakto.
// NÃO deve ser exposta ao front-end. Requer ADMIN_SECRET no header.
//
// Fluxo normal: use webhook-cakto (chamado automaticamente pela Cakto).
// Esta função é para correção manual via ferramenta admin / n8n / dashboard.
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

// Função administrativa — nunca chamada pelo browser.
// [SEC-FIX] 'none' não é um valor CORS válido — removido. Endpoint admin-only.
const corsHeaders = {
  'Content-Type': 'application/json',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Método não permitido' }, 405)
  }

  // ── Autenticação administrativa obrigatória ──────────────────────────────
  const adminSecret = Deno.env.get('ADMIN_SECRET')
  if (!adminSecret) {
    console.error('[process-cakto-payment] ADMIN_SECRET não configurado')
    return json({ success: false, error: 'Serviço não configurado' }, 500)
  }

  const received = req.headers.get('x-admin-secret') ?? ''
  if (!timingSafeEqual(received, adminSecret)) {
    console.warn('[process-cakto-payment] Acesso não autorizado')
    return json({ success: false, error: 'Não autorizado' }, 401)
  }

  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  let body: { orderId?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Body JSON inválido' }, 400)
  }

  const { orderId, action } = body

  if (!orderId || typeof orderId !== 'string') {
    return json({ success: false, error: 'orderId é obrigatório' }, 400)
  }

  // [SEC-FIX R4-002] Validação de orderId — impede path traversal na URL da Cakto.
  // Espelha a mesma regex usada em verify-cakto-payment.
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) {
    return json({ success: false, error: 'orderId inválido' }, 400)
  }

  if (!action || !['approve', 'refund', 'cancel'].includes(action)) {
    return json({ success: false, error: 'action deve ser approve, refund ou cancel' }, 400)
  }

  console.log(`[process-cakto-payment] Ação "${action}" para orderId: ${orderId}`)

  try {
    // Buscar dados do pedido na Cakto
    const accessToken = await getCaktoAccessToken()

    const orderResponse = await fetch(
      `https://api.cakto.com.br/api/orders/${orderId}/`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
      }
    )

    if (!orderResponse.ok) {
      throw new Error(`Erro ao buscar pedido Cakto: ${orderResponse.status} ${orderResponse.statusText}`)
    }

    const orderData = await orderResponse.json()

    let result
    switch (action) {
      case 'approve': result = await processApproval(supabaseClient, orderData, orderId);    break
      case 'refund':  result = await processRefund(supabaseClient, orderData, orderId);      break
      case 'cancel':  result = await processCancellation(supabaseClient, orderData, orderId); break
    }

    console.log(`[process-cakto-payment] Concluído: ${JSON.stringify(result)}`)
    return json({ success: true, result })

  } catch (error: any) {
    console.error('[process-cakto-payment] Erro:', error?.message)
    return json({ success: false, error: error?.message ?? 'Erro interno' }, 500)
  }
})

async function getCaktoAccessToken(): Promise<string> {
  const clientId     = Deno.env.get('CAKTO_CLIENT_ID')
  const clientSecret = Deno.env.get('CAKTO_CLIENT_SECRET')

  const response = await fetch('https://api.cakto.com.br/oauth/token/', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  })

  if (!response.ok) throw new Error('Falha ao obter token da Cakto')
  const data = await response.json()
  return data.access_token
}

async function processApproval(supabase: any, _orderData: any, orderId: string) {
  const { error } = await supabase
    .from('subscriptions')
    .update({ payment_status: 'approved', is_active: true, updated_at: new Date().toISOString() })
    .eq('cakto_order_id', orderId)
  if (error) throw error
  return { action: 'approved', order_id: orderId }
}

async function processRefund(supabase: any, _orderData: any, orderId: string) {
  const { error } = await supabase
    .from('subscriptions')
    .update({
      payment_status:    'refunded',
      is_active:         false,
      refunded_at:       new Date().toISOString(),
      access_revoked_at: new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    })
    .eq('cakto_order_id', orderId)
  if (error) throw error
  return { action: 'refunded', order_id: orderId }
}

async function processCancellation(supabase: any, _orderData: any, orderId: string) {
  const { error } = await supabase
    .from('subscriptions')
    .update({ payment_status: 'cancelled', is_active: false, updated_at: new Date().toISOString() })
    .eq('cakto_order_id', orderId)
  if (error) throw error
  return { action: 'cancelled', order_id: orderId }
}
