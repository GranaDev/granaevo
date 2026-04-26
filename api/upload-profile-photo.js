/**
 * GranaEvo — /api/upload-profile-photo
 *
 * Proxy Vercel para a Edge Function upload-profile-photo.
 * Antes deste proxy, o frontend chamava a Edge Function diretamente —
 * sem rate limit, sem CSRF, sem body size enforcement no Vercel.
 *
 * Proteções aplicadas:
 *   1. Validação de Origin (CSRF — bloqueia cross-site requests)
 *   2. Rate limit por IP: 20 uploads/hora
 *   3. Rate limit por userId: 10 uploads/hora
 *   4. Body size limit: 6MB (5MB arquivo + overhead multipart)
 *   5. Content-Type obrigatório: multipart/form-data
 *   6. PROXY_SECRET encaminhado para a Edge Function
 *   7. Nenhum header interno da Vercel é repassado ao cliente
 */

export const config = {
  api: { bodyParser: false }, // multipart/form-data — sem parse automático
}

const EDGE_URL     = `${process.env.SUPABASE_URL ?? ''}/functions/v1/upload-profile-photo`
const ANON_KEY     = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET = process.env.PROXY_SECRET ?? ''

const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

// Janela de 1 hora — uploads são pouco frequentes
const RATE_MAX_IP   = 20
const RATE_MAX_USER = 10
const WINDOW_MS     = 3_600_000
const MAX_STORE     = 5_000
const MAX_BYTES     = 6 * 1024 * 1024 // 6MB

const _store = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _store) { if (now - v.t > WINDOW_MS) _store.delete(k) }
}, WINDOW_MS)

function _checkLimit(key, max) {
  const now = Date.now()
  const r   = _store.get(key)
  if (!r || now - r.t > WINDOW_MS) {
    if (!r && _store.size >= MAX_STORE) {
      // Limpa expirados antes de aceitar nova chave
      for (const [k, v] of _store) { if (now - v.t > WINDOW_MS) _store.delete(k) }
      if (_store.size >= MAX_STORE) return false
    }
    _store.set(key, { c: 1, t: now })
    return true
  }
  if (r.c >= max) return false
  r.c++
  return true
}

function _extractUserId(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof p?.sub === 'string' ? p.sub : null
  } catch { return null }
}

/**
 * @param {import('@vercel/node').VercelRequest}  req
 * @param {import('@vercel/node').VercelResponse} res
 */
export default async function handler(req, res) {
  const origin = req.headers['origin'] ?? ''

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0])
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  // ── 1. Validações estruturais ──────────────────────────────────────────────
  if (!ALLOWED_ORIGINS.has(origin))                  return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')                         return res.status(405).json({ error: 'Method Not Allowed' })
  if (!EDGE_URL || !ANON_KEY)                        return res.status(503).json({ error: 'Serviço indisponível' })

  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) return res.status(415).json({ error: 'Content-Type inválido' })

  // ── 2. Autenticação presente ───────────────────────────────────────────────
  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer '))             return res.status(401).json({ error: 'Unauthorized' })

  // ── 3. IP real ─────────────────────────────────────────────────────────────
  const realIp = req.headers['x-real-ip']
  const fwdFor = req.headers['x-forwarded-for']
  const ip     = (typeof realIp === 'string' && realIp.trim()
    ? realIp.trim()
    : typeof fwdFor === 'string'
      ? fwdFor.split(',')[0].trim()
      : req.socket?.remoteAddress ?? 'unknown')

  // ── 4. Rate limit por IP ───────────────────────────────────────────────────
  if (!_checkLimit(`upload:ip:${ip}`, RATE_MAX_IP)) {
    res.setHeader('Retry-After', '3600')
    return res.status(429).json({ error: 'Limite de uploads por IP atingido. Aguarde 1 hora.' })
  }

  // ── 5. Rate limit por userId ───────────────────────────────────────────────
  const userId = _extractUserId(authHeader.slice(7))
  if (userId && !_checkLimit(`upload:uid:${userId}`, RATE_MAX_USER)) {
    res.setHeader('Retry-After', '3600')
    return res.status(429).json({ error: 'Limite de uploads por conta atingido. Aguarde 1 hora.' })
  }

  // ── 6. Lê body com limite de tamanho ──────────────────────────────────────
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
    return res.status(400).json({ error: 'Erro ao ler requisição' })
  }

  // ── 7. Encaminha para a Edge Function ─────────────────────────────────────
  let edgeResponse
  try {
    edgeResponse = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Authorization':   authHeader,
        'apikey':          ANON_KEY,
        'Content-Type':    contentType, // preserva o boundary do multipart
        'x-proxy-secret':  PROXY_SECRET,
        'x-forwarded-for': ip,
      },
      body:   buffer,
      signal: AbortSignal.timeout(30_000), // upload pode demorar mais que chamadas JSON
    })
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Tempo limite excedido no upload' })
    }
    return res.status(502).json({ error: 'Erro no gateway de upload' })
  }

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cache-Control', 'no-store')

  res.status(edgeResponse.status)
     .setHeader('Content-Type', 'application/json')
     .send(await edgeResponse.text())
}
