// /api/create-checkout.js — Proxy para create-stripe-checkout Edge Function
// Adiciona rate limit por IP e proxy-secret antes de chamar a EF.

import { checkRate } from './_rate-limit.js'

const _SUPABASE_URL   = process.env.SUPABASE_URL ?? ''
const EDGE_URL        = `${_SUPABASE_URL}/functions/v1/create-stripe-checkout`
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
const RATE_MAX = 5 // checkout é mais sensível — limite menor

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

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`create-checkout:${ip}`, RATE_MAX))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => {
        total += c.length
        if (total > 1024) { req.destroy(); return reject(new Error('TOO_LARGE')) }
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

  const VALID_PLANS = new Set(['individual', 'casal', 'familia'])
  if (typeof body?.plan !== 'string' || !VALID_PLANS.has(body.plan.toLowerCase())) {
    return res.status(400).json({ error: 'Plano inválido. Use: individual, casal ou familia' })
  }

  try {
    const r = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  authHeader,
        'apikey':         ANON_KEY,
        'x-proxy-secret': PROXY_SECRET,
      },
      body:   JSON.stringify({ plan: body.plan.toLowerCase() }),
      signal: AbortSignal.timeout(20_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch {
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
