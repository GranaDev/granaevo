/**
 * GranaEvo — /api/upload-profile-photo
 *
 * Proxy Vercel para a Edge Function upload-profile-photo.
 *
 * Proteções aplicadas:
 *   1. Validação de Origin (CSRF)
 *   2. Rate limit distribuído por IP: 20 uploads/hora  → via Upstash Redis
 *   3. Rate limit distribuído por userId: 10 uploads/hora → via Upstash Redis
 *   4. Ambos os limites combinados via checkRateWithUser (falha em qualquer um)
 *   5. Body size limit: 6MB
 *   6. Content-Type obrigatório: multipart/form-data
 *   7. PROXY_SECRET encaminhado com timing-safe para a Edge Function
 *   8. Nenhum header interno da Vercel é repassado ao cliente
 *
 * Melhoria de segurança vs versão anterior:
 *   - Rate limit migrado de Map in-memory (por instância) para Redis distribuído
 *   - Múltiplas instâncias Vercel agora compartilham os contadores corretamente
 */

export const config = {
  api: { bodyParser: false },
}

import { checkRateWindow }    from './_rate-limit.js'
import { trackSecurityEvent } from './_alert.js'
import { logger }             from './_logger.js'

const PATH         = '/api/upload-profile-photo'
const EDGE_URL     = `${process.env.SUPABASE_URL ?? ''}/functions/v1/upload-profile-photo`
const ANON_KEY     = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET = process.env.PROXY_SECRET ?? ''

const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://assistente.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

const RATE_MAX_IP   = 20          // uploads por hora por IP
const RATE_MAX_USER = 10          // uploads por hora por conta
const RATE_WINDOW   = 3_600       // 1 hora em segundos
const MAX_BYTES     = 6 * 1024 * 1024

// Decodifica JWT sem verificar assinatura — APENAS para rate limiting por userId.
// Nunca usar para autenticação/autorização. Auth real: Edge Function via auth.getUser(token).
function _extractUserId(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof p?.sub === 'string' ? p.sub : null
  } catch { return null }
}

export default async function handler(req, res) {
  const origin  = req.headers['origin'] ?? ''
  const allowed = ALLOWED_ORIGINS.has(origin)

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : [...ALLOWED_ORIGINS][0])

  // ── 1. Validações estruturais ────────────────────────────────────────────────
  if (!allowed) {
    logger.warn('bad_origin', PATH, { origin })
    return res.status(403).json({ error: 'Forbidden' })
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }
  if (!EDGE_URL || !ANON_KEY || !PROXY_SECRET) {
    logger.error('service_unavailable', PATH, { reason: 'missing_env' })
    return res.status(503).json({ error: 'Serviço indisponível' })
  }

  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    return res.status(415).json({ error: 'Content-Type inválido' })
  }

  // ── 2. Autenticação presente ─────────────────────────────────────────────────
  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // ── 3. IP real ───────────────────────────────────────────────────────────────
  const realIp = req.headers['x-real-ip']
  const fwdFor = req.headers['x-forwarded-for']
  const ip     = (typeof realIp === 'string' && realIp.trim()
    ? realIp.trim()
    : typeof fwdFor === 'string'
      ? fwdFor.split(',')[0].trim()
      : req.socket?.remoteAddress ?? 'unknown')

  // ── 4. Rate limit distribuído por IP + userId (Redis) ────────────────────────
  // Limites distintos: mais restritivo por conta (10) do que por IP (20)
  // para cobrir IPs compartilhados (redes corporativas, CGNAT)
  const userId = _extractUserId(authHeader.slice(7).trim())
  const [ipOk, userOk] = await Promise.all([
    checkRateWindow(`upload:ip:${ip}`,               RATE_MAX_IP,   RATE_WINDOW),
    userId
      ? checkRateWindow(`upload:user:${userId}`,     RATE_MAX_USER, RATE_WINDOW)
      : Promise.resolve(true),
  ])
  const uploadAllowed = ipOk && userOk

  if (!uploadAllowed) {
    trackSecurityEvent('upload_abuse', { ip, reason: 'rate_limit', userId }).catch(() => {})
    logger.warn('rate_limit', PATH, { ip, userId, window: RATE_WINDOW })
    res.setHeader('Retry-After', String(RATE_WINDOW))
    return res.status(429).json({ error: 'Limite de uploads atingido. Aguarde 1 hora.' })
  }

  // ── 5. Lê body com limite de tamanho ─────────────────────────────────────────
  let buffer
  try {
    buffer = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => {
        total += c.length
        if (total > MAX_BYTES) { req.destroy(); return reject(new Error('TOO_LARGE')) }
        chunks.push(c)
      })
      req.on('end',   () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  } catch (err) {
    if (err.message === 'TOO_LARGE') return res.status(413).json({ error: 'Arquivo muito grande. Máximo 5MB.' })
    logger.error('body_read_error', PATH, { ip })
    return res.status(400).json({ error: 'Erro ao ler requisição' })
  }

  // ── 6. Encaminha para a Edge Function ────────────────────────────────────────
  let edgeResponse
  try {
    edgeResponse = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Authorization':   authHeader,
        'apikey':          ANON_KEY,
        'Content-Type':    contentType,
        'x-proxy-secret':  PROXY_SECRET,
        'x-forwarded-for': ip,
      },
      body:   buffer,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      logger.error('gateway_timeout', PATH, { ip })
      return res.status(504).json({ error: 'Tempo limite excedido no upload' })
    }
    logger.error('gateway_error', PATH, { ip, error: err.message })
    return res.status(502).json({ error: 'Erro no gateway de upload' })
  }

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cache-Control', 'no-store')

  if (edgeResponse.status === 400 || edgeResponse.status === 415) {
    trackSecurityEvent('upload_abuse', { ip, reason: 'ef_rejected', status: edgeResponse.status }).catch(() => {})
    logger.warn('upload_rejected_by_ef', PATH, { ip, status: edgeResponse.status })
  }

  res.status(edgeResponse.status)
     .setHeader('Content-Type', 'application/json')
     .send(await edgeResponse.text())
}
