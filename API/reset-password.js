// /api/reset-password.js — Proxy unificado para send-password-reset-code e verify-and-reset-password
// Controlado pelo parâmetro `step` no body: "send" | "verify_code" | "reset_password"

const SUPABASE_URL   = process.env.SUPABASE_URL   ?? ''
const ANON_KEY       = process.env.SUPABASE_ANON_KEY ?? ''
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN  ?? 'https://granaevo.com'

const ENDPOINTS = {
  send:           `${SUPABASE_URL}/functions/v1/send-password-reset-code`,
  verify_code:    `${SUPABASE_URL}/functions/v1/verify-and-reset-password`,
  reset_password: `${SUPABASE_URL}/functions/v1/verify-and-reset-password`,
}

// Rate limits: mais restrito para "send" (evita spam de email)
const RATE_LIMITS = { send: 3, verify_code: 10, reset_password: 5 }
const RATE_STORE  = new Map(); const RATE_WINDOW_MS = 60_000

function checkRate(k, max) {
  const now = Date.now(); const r = RATE_STORE.get(k)
  if (!r || now - r.t > RATE_WINDOW_MS) { RATE_STORE.set(k, { c: 1, t: now }); return true }
  if (r.c >= max) return false; r.c++; return true
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
  if (!SUPABASE_URL || !ANON_KEY) return res.status(503).json({ error: 'Serviço indisponível' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown').toString().split(',')[0].trim()

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > 8192) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) { return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' }) }

  let body; try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  const step = body?.step ?? body?.action ?? 'send'
  if (!ENDPOINTS[step]) return res.status(400).json({ error: 'step inválido: use send, verify_code ou reset_password' })

  const rateMax = RATE_LIMITS[step] ?? 5
  if (!checkRate(`${step}:${ip}`, rateMax)) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  // Para "send", remover campo "step" antes de repassar (Edge Function não o conhece)
  let upstreamBody = raw
  if (step === 'send' && body.step) {
    const { step: _s, ...rest } = body
    upstreamBody = JSON.stringify(rest)
  } else if (body.step) {
    const { step: _s, ...rest } = body
    upstreamBody = JSON.stringify(rest)
  }

  try {
    const r = await fetch(ENDPOINTS[step], {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY },
      body:    upstreamBody,
      signal:  AbortSignal.timeout(15_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
}
