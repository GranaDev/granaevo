// /api/check-email.js — Proxy para check-email-status Edge Function
// Rate limit + Origin check antes de chegar na Edge Function.

const EDGE_URL       = `${process.env.SUPABASE_URL}/functions/v1/check-email-status`
const ANON_KEY       = process.env.SUPABASE_ANON_KEY
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'https://granaevo.com'

const RATE_STORE = new Map(); const RATE_MAX = 10; const RATE_WINDOW_MS = 60_000
function checkRate(k) {
  const now = Date.now(); const r = RATE_STORE.get(k)
  if (!r || now - r.t > RATE_WINDOW_MS) { RATE_STORE.set(k, { c: 1, t: now }); return true }
  if (r.c >= RATE_MAX) return false; r.c++; return true
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }

  const origin = req.headers['origin'] ?? ''
  if (origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method Not Allowed' })
  if (!EDGE_URL || !ANON_KEY)    return res.status(503).json({ error: 'Serviço indisponível' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown').toString().split(',')[0].trim()
  if (!checkRate(`ip:${ip}`)) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'Muitas requisições' }) }

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > 4096) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) { return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' }) }

  let body; try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }
  if (typeof body?.email !== 'string') return res.status(400).json({ error: 'email obrigatório' })

  try {
    const r = await fetch(EDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY }, body: raw, signal: AbortSignal.timeout(10_000) })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
}
