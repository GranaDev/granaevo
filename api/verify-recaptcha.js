// /api/verify-recaptcha.js — Proxy para verify-recaptcha Edge Function
// Oculta a URL real da Edge Function do frontend.

import { checkRate } from './_rate-limit.js'

const _SUPABASE_URL  = process.env.SUPABASE_URL ?? ''
const EDGE_URL       = `${_SUPABASE_URL}/functions/v1/verify-recaptcha`
const ANON_KEY       = process.env.SUPABASE_ANON_KEY ?? ''
// Origens de produção sempre permitidas; env var adiciona origens extras (ex.: dev local)
const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://granaevo.com',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])
const RATE_MAX = 10

export default async function handler(req, res) {
  const origin     = req.headers['origin'] ?? ''
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0]

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }

  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method Not Allowed' })
  if (!_SUPABASE_URL || !ANON_KEY)  return res.status(503).json({ error: 'Serviço indisponível' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`verify-captcha:${ip}`, RATE_MAX))) {
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

  if (typeof body?.token !== 'string' || body.token.length < 50) {
    return res.status(400).json({ success: false })
  }

  try {
    const r = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ANON_KEY}`,
        'apikey': ANON_KEY,
      },
      body: JSON.stringify({ token: body.token.trim() }),
      signal: AbortSignal.timeout(10_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch {
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
