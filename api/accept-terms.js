// /api/accept-terms.js — Proxy para accept-terms Edge Function (VUL-008 FIX)
// Registra o aceite dos Termos de Uso (LGPD). user_id sempre vem do JWT na EF.

import { checkRate } from './_rate-limit.js'

const _SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const EDGE_URL      = `${_SUPABASE_URL}/functions/v1/accept-terms`
const ANON_KEY      = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET  = process.env.PROXY_SECRET ?? ''

const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

const RATE_MAX = 5 // por minuto por IP — ação de baixa frequência

export default async function handler(req, res) {
  const origin  = req.headers['origin'] ?? ''
  const allowed = ALLOWED_ORIGINS.has(origin)
  const corsOrigin = allowed ? origin : [...ALLOWED_ORIGINS][0]

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin',  corsOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(204).end()
  }

  res.setHeader('Access-Control-Allow-Origin', corsOrigin)

  if (!allowed)                               return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')                  return res.status(405).json({ error: 'Method Not Allowed' })
  if (!_SUPABASE_URL || !ANON_KEY || !PROXY_SECRET) return res.status(503).json({ error: 'Serviço indisponível' })

  const authHeader = req.headers['authorization'] ?? ''
  if (!authHeader.startsWith('Bearer '))       return res.status(401).json({ error: 'Unauthorized' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`accept-terms:${ip}`, RATE_MAX))) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
  }

  // Drena body sem usar conteúdo (user_id vem do JWT na EF)
  try {
    await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > 1024) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', resolve)
      req.on('error', reject)
    })
  } catch { /* ignora — body não é usado */ }

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
      body:   JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return res.status(502).json({ error: 'Gateway temporariamente indisponível' })
  }

  res.setHeader('Content-Type', 'application/json')
  return res.status(upstream.status).send(await upstream.text())
}
