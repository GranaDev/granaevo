// /api/verify-invite.js — Proxy para verify-guest-invite Edge Function
// Esconde a URL da Edge Function do frontend. Frontend chama /api/verify-invite.

import { checkRate } from './_rate-limit.js'

const _SUPABASE_URL  = process.env.SUPABASE_URL ?? ''
const EDGE_URL       = `${_SUPABASE_URL}/functions/v1/verify-guest-invite`
const ANON_KEY       = process.env.SUPABASE_ANON_KEY
const PROXY_SECRET   = process.env.PROXY_SECRET ?? ''
// Origens de produção sempre permitidas; env var adiciona origens extras (ex.: dev local)
const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://granaevo.com',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])
const MAX_BODY_BYTES = 8192
const RATE_MAX       = 3

export default async function handler(req, res) {
  const origin     = req.headers['origin'] ?? ''
  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0]

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  corsOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age',       '86400')
    return res.status(204).end()
  }

  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Cache-Control', 'no-store')

  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method Not Allowed' })

  if (!_SUPABASE_URL || !ANON_KEY || !PROXY_SECRET) {
    return res.status(503).json({ error: 'Serviço indisponível' })
  }

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (!(await checkRate(`verify-invite:${ip}`, RATE_MAX))) {
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

  // Valida campos obrigatórios e extrai apenas o que a EF precisa.
  // Previne que campos extras ou tipos inesperados cheguem à Edge Function.
  if (typeof body?.email !== 'string' || !body.email.trim()) {
    return res.status(400).json({ error: 'Parâmetros inválidos' })
  }
  const codeRaw = body?.code
  if (typeof codeRaw !== 'string' && typeof codeRaw !== 'number') {
    return res.status(400).json({ error: 'Parâmetros inválidos' })
  }

  // Monta payload explícito — nunca encaminha body cru (evita campos extras não esperados)
  const stepRaw = typeof body?.step === 'string' ? body.step : 'verify'
  if (stepRaw !== 'verify' && stepRaw !== 'create') {
    return res.status(400).json({ error: 'step inválido' })
  }

  const invIdRaw = typeof body?.invitationId === 'string'
    ? body.invitationId.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64)
    : undefined

  const safePayload = {
    step:  stepRaw,
    email: body.email,
    code:  String(codeRaw),
    ...(stepRaw === 'create' && {
      password:      typeof body?.password      === 'string'  ? body.password      : '',
      acceptedTerms: typeof body?.acceptedTerms === 'boolean' ? body.acceptedTerms : false,
    }),
    ...(invIdRaw ? { invitationId: invIdRaw } : {}),
    nonce: typeof body?.nonce === 'string' ? body.nonce : undefined,
  }

  let upstream
  try {
    // Envia x-proxy-secret + IP real para que verify-guest-invite possa rate-limit por cliente
    upstream = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   `Bearer ${ANON_KEY}`,
        'apikey':          ANON_KEY,
        'x-proxy-secret':  PROXY_SECRET,
        'x-forwarded-for': ip,
      },
      body:   JSON.stringify(safePayload),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return res.status(502).json({ error: 'Gateway temporariamente indisponível' })
  }

  const upstreamBody = await upstream.text()
  res.setHeader('Content-Type', 'application/json')
  return res.status(upstream.status).send(upstreamBody)
}
