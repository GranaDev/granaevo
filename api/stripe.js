// /api/stripe.js — Proxy unificado Stripe
// checkout: NÃO requer JWT — usuário paga antes de criar conta
// portal:   REQUER JWT — gerenciar assinatura existente

import { checkRate } from './_rate-limit.js'

const _SUPABASE_URL   = process.env.SUPABASE_URL ?? ''
const ANON_KEY        = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET    = process.env.PROXY_SECRET ?? ''
const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

const VALID_PLANS   = new Set(['individual', 'casal', 'familia'])
const VALID_ACTIONS = new Set(['checkout', 'portal', 'details', 'updatePlan', 'previewPlan', 'changeRemovalList'])
const RATE_LIMITS   = { checkout: 5, portal: 10, details: 20, updatePlan: 3, previewPlan: 10, changeRemovalList: 5 }
const EF_URLS       = {
  checkout:          `${_SUPABASE_URL}/functions/v1/create-stripe-checkout`,
  portal:            `${_SUPABASE_URL}/functions/v1/stripe-portal`,
  details:           `${_SUPABASE_URL}/functions/v1/stripe-subscription-details`,
  updatePlan:        `${_SUPABASE_URL}/functions/v1/update-stripe-plan`,
  previewPlan:       `${_SUPABASE_URL}/functions/v1/preview-stripe-plan`,
  changeRemovalList: `${_SUPABASE_URL}/functions/v1/update-stripe-plan`,
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] ?? ''

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  // [GOD6-L01] Valida origin antes de definir CORS header — header antes da check
  // vazava um domínio permitido para origins não-autorizadas (cosmético mas confuso).
  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden' })
  res.setHeader('Access-Control-Allow-Origin', origin)
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method Not Allowed' })
  if (!_SUPABASE_URL || !ANON_KEY || !PROXY_SECRET)
    return res.status(503).json({ error: 'Serviço indisponível' })

  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('application/json'))
    return res.status(415).json({ error: 'Content-Type deve ser application/json' })

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      const timeout = setTimeout(() => { req.destroy(); reject(new Error('TIMEOUT')) }, 10_000)
      req.on('data', c => {
        total += c.length
        if (total > 2048) { clearTimeout(timeout); req.destroy(); return reject(new Error('TOO_LARGE')) }
        chunks.push(c)
      })
      req.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf8')) })
      req.on('error', e => { clearTimeout(timeout); reject(e) })
    })
  } catch (e) {
    if (e.message === 'TOO_LARGE') return res.status(413).json({ error: 'Body muito grande' })
    if (e.message === 'TIMEOUT')   return res.status(408).json({ error: 'Timeout' })
    return res.status(400).json({ error: 'Body inválido' })
  }

  let body
  try {
    const parsed = JSON.parse(raw)
    body = {
      action:           parsed?.action,
      plan:             parsed?.plan,
      email:            parsed?.email,
      newPlan:          parsed?.newPlan,
      profilesToRemove: Array.isArray(parsed?.profilesToRemove) ? parsed.profilesToRemove : [],
    }
  } catch {
    return res.status(400).json({ error: 'JSON inválido' })
  }

  const action = typeof body.action === 'string' ? body.action : ''
  if (!VALID_ACTIONS.has(action))
    return res.status(400).json({ error: 'action inválida. Use: checkout, portal, details ou updatePlan' })

  const authHeader = req.headers['authorization'] ?? ''

  // Ações autenticadas (todas exceto checkout)
  const AUTHED_ACTIONS = new Set(['portal', 'details', 'updatePlan', 'previewPlan', 'changeRemovalList'])
  if (AUTHED_ACTIONS.has(action)) {
    if (!authHeader.startsWith('Bearer '))
      return res.status(401).json({ error: 'Autenticação obrigatória' })
  }

  // Checkout: valida plano
  if (action === 'checkout') {
    const plan = typeof body.plan === 'string' ? body.plan.toLowerCase() : ''
    if (!VALID_PLANS.has(plan))
      return res.status(400).json({ error: 'Plano inválido. Use: individual, casal ou familia' })
  }

  // updatePlan e previewPlan: valida novo plano
  if (action === 'updatePlan' || action === 'previewPlan') {
    const newPlan = typeof body.newPlan === 'string' ? body.newPlan.toLowerCase() : ''
    if (!VALID_PLANS.has(newPlan))
      return res.status(400).json({ error: 'newPlan inválido. Use: individual, casal ou familia' })
  }

  // changeRemovalList: valida array de perfis
  if (action === 'changeRemovalList') {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const profiles = body.profilesToRemove ?? []
    if (!Array.isArray(profiles) || profiles.length > 10 || profiles.some(id => !UUID_RE.test(id)))
      return res.status(400).json({ error: 'profilesToRemove inválido' })
  }

  const ip = req.headers['x-real-ip']
    ?? (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    ?? 'unknown'

  if (!(await checkRate(`stripe-${action}:${ip}`, RATE_LIMITS[action]))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  // Monta payload para a Edge Function
  const efPayload = action === 'checkout'
    ? { plan: (body.plan ?? '').toLowerCase(), email: body.email ?? '' }
    : action === 'updatePlan'
    ? { newPlan: (body.newPlan ?? '').toLowerCase(), profilesToRemove: body.profilesToRemove ?? [] }
    : action === 'previewPlan'
    ? { newPlan: (body.newPlan ?? '').toLowerCase() }
    : action === 'changeRemovalList'
    ? { action: 'changeRemovalList', profilesToRemove: body.profilesToRemove ?? [] }
    : {}

  const efHeaders = {
    'Content-Type':   'application/json',
    'apikey':         ANON_KEY,
    'x-proxy-secret': PROXY_SECRET,
  }
  // Passa JWT se disponível (melhora rastreamento, mas não é obrigatório para checkout)
  if (authHeader.startsWith('Bearer ')) efHeaders['Authorization'] = authHeader

  try {
    const r = await fetch(EF_URLS[action], {
      method:  'POST',
      headers: efHeaders,
      body:    JSON.stringify(efPayload),
      signal:  AbortSignal.timeout(20_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch {
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
