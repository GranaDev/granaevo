// /api/stripe.js — Proxy unificado para operações Stripe
// action=checkout → create-stripe-checkout EF
// action=portal   → stripe-portal EF
// Mantém proxy secret para proteger as Edge Functions de chamadas diretas.

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
const RATE_LIMITS   = { checkout: 5, portal: 10 }
const EF_URLS       = {
  checkout: `${_SUPABASE_URL}/functions/v1/create-stripe-checkout`,
  portal:   `${_SUPABASE_URL}/functions/v1/stripe-portal`,
}

export default async function handler(req, res) {
  const origin     = req.headers['origin'] ?? ''
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0]

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method Not Allowed' })
  if (!_SUPABASE_URL || !ANON_KEY || !PROXY_SECRET)
    return res.status(503).json({ error: 'Serviço indisponível' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })

  // Lê body
  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => {
        total += c.length
        if (total > 2048) { req.destroy(); return reject(new Error('TOO_LARGE')) }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) {
    return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' })
  }

  let body
  try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  const action = body?.action
  if (action !== 'checkout' && action !== 'portal')
    return res.status(400).json({ error: 'action inválida. Use: checkout ou portal' })

  // Validação específica por action
  if (action === 'checkout') {
    const plan = (body.plan ?? '').toLowerCase()
    if (!VALID_PLANS.has(plan))
      return res.status(400).json({ error: 'Plano inválido. Use: individual, casal ou familia' })
  }

  // Rate limit por IP
  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()
  if (!(await checkRate(`stripe-${action}:${ip}`, RATE_LIMITS[action]))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  // Monta payload para a Edge Function
  const efPayload = action === 'checkout'
    ? { plan: body.plan.toLowerCase() }
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
