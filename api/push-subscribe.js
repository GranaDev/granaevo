/**
 * GranaEvo — /api/push-subscribe
 *
 * Gerencia subscriptions de Web Push Notifications.
 *   POST { endpoint, p256dh, auth, userAgent? } → salva subscription
 *   DELETE { endpoint }                          → desativa subscription
 *
 * Proteções:
 *   - Autenticação JWT obrigatória
 *   - Rate limit: 10 req/min por IP (subscribe frequente = abuso)
 *   - Body size: 4KB max
 *   - CORS + Origin validation
 *   - Campos sanitizados antes de repassar para EF
 */

import { checkRate } from './_rate-limit.js'

const SUPABASE_URL  = process.env.SUPABASE_URL ?? ''
const ANON_KEY      = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET  = process.env.PROXY_SECRET ?? ''
const MAX_BYTES     = 4096
const RATE_MAX      = 10  // 10 req/min por IP

const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

// Endpoint da Edge Function por ação
function _efUrl(action) {
  return `${SUPABASE_URL}/functions/v1/${action}-push-subscription`
}

export default async function handler(req, res) {
  const origin  = req.headers['origin'] ?? ''
  const allowed = ALLOWED_ORIGINS.has(origin)

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : [...ALLOWED_ORIGINS][0])

  if (!allowed)                                     return res.status(403).json({ error: 'Forbidden' })
  if (!['POST', 'DELETE'].includes(req.method))     return res.status(405).json({ error: 'Method Not Allowed' })
  if (!SUPABASE_URL || !ANON_KEY || !PROXY_SECRET)  return res.status(503).json({ error: 'Serviço indisponível' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer '))            return res.status(401).json({ error: 'Unauthorized' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`push-sub:${ip}`, RATE_MAX))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  // Lê body com limite
  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => {
        total += c.length
        if (total > MAX_BYTES) { req.destroy(); return reject(new Error('TOO_LARGE')) }
        chunks.push(c)
      })
      req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) {
    return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' })
  }

  let body
  try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  if (typeof body?.endpoint !== 'string' || !body.endpoint.startsWith('https://')) {
    return res.status(400).json({ error: 'endpoint inválido' })
  }

  // Para POST, validar campos adicionais
  if (req.method === 'POST') {
    if (typeof body.p256dh !== 'string' || body.p256dh.length < 10) {
      return res.status(400).json({ error: 'p256dh inválido' })
    }
    if (typeof body.auth !== 'string' || body.auth.length < 10) {
      return res.status(400).json({ error: 'auth inválido' })
    }
  }

  // Monta payload seguro (anti-mass-assignment)
  const action = req.method === 'DELETE' ? 'delete' : 'save'
  const safeBody = req.method === 'DELETE'
    ? { endpoint: body.endpoint.slice(0, 512) }
    : {
        endpoint:  body.endpoint.slice(0, 512),
        p256dh:    body.p256dh.slice(0, 256),
        auth:      body.auth.slice(0, 64),
        userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 256) : undefined,
      }

  try {
    const efRes = await fetch(_efUrl(action), {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   authHeader,
        'apikey':          ANON_KEY,
        'x-proxy-secret':  PROXY_SECRET,
        'x-forwarded-for': ip,
      },
      body:   JSON.stringify(safeBody),
      signal: AbortSignal.timeout(10_000),
    })
    res.setHeader('Content-Type', 'application/json')
    return res.status(efRes.status).send(await efRes.text())
  } catch {
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
