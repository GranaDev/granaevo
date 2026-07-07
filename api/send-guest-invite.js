// /api/send-guest-invite.js — Proxy para send-guest-invite Edge Function
// Requer sessão autenticada (JWT do usuário), não usa anon key como auth principal.

import { checkRate } from './_rate-limit.js'
import { logger }    from './_logger.js'

const PATH = '/api/send-guest-invite'

const _SUPABASE_URL  = process.env.SUPABASE_URL ?? ''
const EDGE_URL       = `${_SUPABASE_URL}/functions/v1/send-guest-invite`
const ANON_KEY       = process.env.SUPABASE_ANON_KEY
const PROXY_SECRET   = process.env.PROXY_SECRET ?? ''
// Suporta múltiplas origens separadas por vírgula (www e não-www)
const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://assistente.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])
const MAX_BODY_BYTES = 4096
const RATE_MAX       = 5

export default async function handler(req, res) {
  const origin     = req.headers['origin'] ?? ''
  const allowed    = ALLOWED_ORIGINS.has(origin)
  const corsOrigin = allowed ? origin : [...ALLOWED_ORIGINS][0]

  res.setHeader('Vary', 'Origin')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin',  corsOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age',       '86400')
    return res.status(204).end()
  }

  res.setHeader('Access-Control-Allow-Origin', corsOrigin)

  if (!allowed)                    return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')                           return res.status(405).json({ error: 'Method Not Allowed' })
  if (!_SUPABASE_URL || !ANON_KEY || !PROXY_SECRET)   return res.status(503).json({ error: 'Serviço indisponível' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`guest-invite:${ip}`, RATE_MAX))) {
    logger.warn('rate_limit', PATH, { ip })
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) {
    return e.message === 'TOO_LARGE'
      ? res.status(413).json({ error: 'Payload muito grande' })
      : res.status(400).json({ error: 'Body inválido' })
  }

  let body
  try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  if (typeof body?.guestEmail !== 'string' || typeof body?.guestName !== 'string') {
    return res.status(400).json({ error: 'guestEmail e guestName são obrigatórios' })
  }
  // [MED-03] Validação de formato de email no proxy — evita invocar EF com payload inválido
  const _emailRe = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/
  if (!body.guestEmail.trim() || !_emailRe.test(body.guestEmail.trim())) {
    return res.status(400).json({ error: 'guestEmail inválido' })
  }
  if (!body.guestName.trim() || body.guestName.trim().length < 2) {
    return res.status(400).json({ error: 'guestName inválido' })
  }

  let upstream
  try {
    upstream = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   authHeader,
        'apikey':          ANON_KEY,
        'x-proxy-secret':  PROXY_SECRET,
        'x-forwarded-for': ip,
      },
      body:   JSON.stringify({ guestName: body.guestName, guestEmail: body.guestEmail }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    logger.error('gateway_error', PATH, { ip, error: err?.message })
    return res.status(502).json({ error: 'Gateway temporariamente indisponível' })
  }

  const upstreamBody = await upstream.text()
  res.setHeader('Content-Type', 'application/json')
  return res.status(upstream.status).send(upstreamBody)
}
