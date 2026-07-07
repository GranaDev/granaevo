// /api/check-user-access.js — Proxy para check-user-access Edge Function
// Requer JWT válido no Authorization header.
// O proxy NÃO lê nem usa dados do body — toda autenticação é via JWT,
// validado server-side pela Edge Function com supabaseAdmin.auth.getUser().
// Isso elimina o vetor de log poisoning via user_id manipulável no body.

import { checkRate }          from './_rate-limit.js'
import { trackSecurityEvent } from './_alert.js'
import { logger }             from './_logger.js'

const PATH = '/api/check-user-access'

const EDGE_URL     = `${process.env.SUPABASE_URL}/functions/v1/check-user-access`
const ANON_KEY     = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET = process.env.PROXY_SECRET ?? ''
const RATE_MAX     = 20

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN,
  'https://granaevo.com',
  'https://www.granaevo.com',
  'https://assistente.granaevo.com',
  'https://granaevo.vercel.app',
].filter(Boolean)

export default async function handler(req, res) {
  const origin        = req.headers['origin'] ?? ''
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin',  allowedOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Vary', 'Origin')
    return res.status(204).end()
  }

  // [CR-06] CORS e Cache-Control apenas após validar origin — não vaza header em 403
  if (!allowedOrigin) return res.status(403).json({ error: 'Forbidden' })

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Vary', 'Origin')
  if (req.method !== 'POST')                   return res.status(405).json({ error: 'Method Not Allowed' })
  if (!EDGE_URL || !ANON_KEY || !PROXY_SECRET) return res.status(503).json({ error: 'Serviço indisponível' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer '))       return res.status(401).json({ error: 'Unauthorized' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`check-access:${ip}`, RATE_MAX))) {
    logger.warn('rate_limit', PATH, { ip })
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  // Drena o body sem ler — evita hang em conexões que enviam corpo.
  // O proxy não usa nenhum dado do body: a EF autentica exclusivamente via JWT.
  await new Promise(resolve => {
    req.on('data', () => {})
    req.on('end', resolve)
    req.on('error', resolve)  // erro de leitura ignorado — body é irrelevante
  })

  try {
    const r = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   authHeader,   // JWT validado pela EF via auth.getUser()
        'apikey':          ANON_KEY,
        'x-proxy-secret':  PROXY_SECRET,
        'x-forwarded-for': ip,           // IP real para lockout progressivo na EF
      },
      body:   '{}',  // body vazio — EF não usa dados do proxy, apenas o JWT
      signal: AbortSignal.timeout(10_000),
    })

    // Tracking baseado em IP — user_id verificado é responsabilidade da EF,
    // não do proxy. Isso previne log poisoning via body manipulado.
    if (r.status === 429) {
      trackSecurityEvent('login_lockout', { ip }).catch(() => {})
      logger.warn('login_lockout', PATH, { ip })
    }
    if (r.status === 401) {
      trackSecurityEvent('jwt_forgery', { ip }).catch(() => {})
      logger.warn('jwt_forgery', PATH, { ip })
    }

    res.setHeader('Content-Type', 'application/json')
    return res.status(r.status).send(await r.text())
  } catch (err) {
    logger.error('gateway_error', PATH, { ip, error: err?.message })
    return res.status(502).json({ error: 'Gateway indisponível' })
  }
}
