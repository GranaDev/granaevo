// /api/check-user-access.js — Proxy para check-user-access Edge Function
// Requer sessão autenticada (JWT do usuário no Authorization header).

import { checkRate } from './_rate-limit.js'

const EDGE_URL    = `${process.env.SUPABASE_URL}/functions/v1/check-user-access`
const ANON_KEY    = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET = process.env.PROXY_SECRET ?? ''
const RATE_MAX    = 20

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN,
  'https://granaevo.com',
  'https://www.granaevo.com',
  'https://granaevo.vercel.app',
].filter(Boolean)

export default async function handler(req, res) {
  const origin        = req.headers['origin'] ?? ''
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? ALLOWED_ORIGINS[0])
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  if (!allowedOrigin) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method Not Allowed' })
  if (!EDGE_URL || !ANON_KEY)    return res.status(503).json({ error: 'Serviço indisponível' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`check-access:${ip}`, RATE_MAX))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => {
        total += c.length
        if (total > 4096) { req.destroy(); return reject(new Error('TOO_LARGE')) }
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

  if (typeof body?.user_id !== 'string') {
    return res.status(400).json({ error: 'user_id obrigatório' })
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
      body:   JSON.stringify({ user_id: body.user_id }),
      signal: AbortSignal.timeout(10_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch {
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
