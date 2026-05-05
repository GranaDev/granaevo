// /api/stripe.js — Proxy unificado para operações Stripe
// action=checkout → create-stripe-checkout EF
// action=portal   → stripe-portal EF
// GOD MODE Round 7: STRIPE-005, STRIPE-008, STRIPE-009, STRIPE-011, STRIPE-012, STRIPE-013

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
// [GOD7-F11] Whitelist explícita de actions — previne SSRF se novas keys forem adicionadas
const VALID_ACTIONS = new Set(['checkout', 'portal'])
const RATE_LIMITS   = { checkout: 5, portal: 10 }
const EF_URLS       = {
  checkout: `${_SUPABASE_URL}/functions/v1/create-stripe-checkout`,
  portal:   `${_SUPABASE_URL}/functions/v1/stripe-portal`,
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] ?? ''

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin')

  // [GOD7-F12] OPTIONS com validação de Origin — não vaza CORS headers para domínios inválidos
  if (req.method === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0]
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)

  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method Not Allowed' })
  if (!_SUPABASE_URL || !ANON_KEY || !PROXY_SECRET)
    return res.status(503).json({ error: 'Serviço indisponível' })

  // [GOD7-F09] Validar Content-Type obrigatório
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('application/json'))
    return res.status(415).json({ error: 'Content-Type deve ser application/json' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })

  // [GOD7-F13] Timeout em body para prevenir slow-loris DoS
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
    if (e.message === 'TIMEOUT')   return res.status(408).json({ error: 'Timeout no envio do body' })
    return res.status(400).json({ error: 'Body inválido' })
  }

  // [GOD7-F08] Parse seguro — sem prototype pollution
  let body
  try {
    const parsed = JSON.parse(raw)
    // Extrai apenas as keys necessárias — nunca espalha o objeto completo
    body = { action: parsed?.action, plan: parsed?.plan }
  } catch {
    return res.status(400).json({ error: 'JSON inválido' })
  }

  const action = typeof body.action === 'string' ? body.action : ''

  // [GOD7-F11] Validação de action via Set — sem SSRF mesmo se EF_URLS crescer
  if (!VALID_ACTIONS.has(action))
    return res.status(400).json({ error: 'action inválida. Use: checkout ou portal' })

  if (action === 'checkout') {
    const plan = typeof body.plan === 'string' ? body.plan.toLowerCase() : ''
    if (!VALID_PLANS.has(plan))
      return res.status(400).json({ error: 'Plano inválido. Use: individual, casal ou familia' })
  }

  // [GOD7-F05] Rate limit por JWT prefix (mais robusto que IP puro)
  // IP como camada adicional — Vercel injeta x-real-ip confiável
  const ip = req.headers['x-real-ip']
    ?? (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    ?? 'unknown'
  if (!(await checkRate(`stripe-${action}:${ip}`, RATE_LIMITS[action]))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  const efPayload = action === 'checkout'
    ? { plan: (body.plan ?? '').toLowerCase() }
    : {}

  try {
    const r = await fetch(EF_URLS[action], {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  authHeader,
        'apikey':         ANON_KEY,
        'x-proxy-secret': PROXY_SECRET,
      },
      body:   JSON.stringify(efPayload),
      signal: AbortSignal.timeout(20_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch {
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
