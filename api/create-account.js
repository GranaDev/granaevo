// /api/create-account.js — Proxy seguro de criação de conta
// Rate limit: 3 criações por IP por hora.
// NÃO usa service_role key — delega criação à Edge Function create-user-account
// via proxy secret. A service_role fica exclusivamente nos secrets do Supabase.

import { checkRateWindow } from './_rate-limit.js'
import { logger }          from './_logger.js'

const PATH = '/api/create-account'

const SUPABASE_URL      = process.env.SUPABASE_URL      ?? ''
const ANON_KEY          = process.env.SUPABASE_ANON_KEY ?? ''
const PROXY_SECRET      = process.env.PROXY_SECRET      ?? ''
const EDGE_URL          = `${SUPABASE_URL}/functions/v1/create-user-account`
const ALLOWED_ORIGINS   = new Set([
  'https://www.granaevo.com',
  'https://assistente.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

const VALID_PLANS = new Set(['individual', 'casal', 'familia'])

// Regex de email permissivo mas seguro
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

export default async function handler(req, res) {
  const origin = req.headers['origin'] ?? ''

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Vary', 'Origin')

  // CORS preflight
  if (req.method === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }

  const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0]
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)

  // Validações de método e origem
  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden' })
  if (req.method !== 'POST')        return res.status(405).json({ error: 'Method Not Allowed' })
  if (!SUPABASE_URL || !ANON_KEY || !PROXY_SECRET)
    return res.status(503).json({ error: 'Serviço indisponível' })

  // Content-Type
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('application/json'))
    return res.status(415).json({ error: 'Content-Type deve ser application/json' })

  // Lê body com limite de 2048 bytes e timeout de 10s
  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      const timeout = setTimeout(() => { req.destroy(); reject(new Error('TIMEOUT')) }, 10_000)
      req.on('data', c => {
        total += c.length
        if (total > 2048) { clearTimeout(timeout); req.destroy(); return reject(new Error('TOO_LARGE')) }
        chunks.push(c)
      })
      req.on('end',   () => { clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf8')) })
      req.on('error', e  => { clearTimeout(timeout); reject(e) })
    })
  } catch (e) {
    if (e.message === 'TOO_LARGE') return res.status(413).json({ error: 'Body muito grande' })
    if (e.message === 'TIMEOUT')   return res.status(408).json({ error: 'Timeout' })
    return res.status(400).json({ error: 'Body inválido' })
  }

  // Parse JSON com proteção contra prototype pollution
  let parsed
  try { parsed = JSON.parse(raw) } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  // Extrai apenas os campos esperados (anti-prototype pollution)
  const email    = typeof parsed?.email    === 'string' ? parsed.email.trim().toLowerCase()   : ''
  const password = typeof parsed?.password === 'string' ? parsed.password                      : ''
  const plan     = typeof parsed?.plan     === 'string' ? parsed.plan.trim().toLowerCase()    : ''
  const _hp_email = typeof parsed?._hp_email === 'string' ? parsed._hp_email : null
  const _hp_url   = typeof parsed?._hp_url   === 'string' ? parsed._hp_url   : null

  // Honeypot server-side — bots preenchem campos ocultos; retorna 200 silencioso
  if (_hp_email !== '' && _hp_email !== null && _hp_email !== undefined) {
    return res.status(200).json({ ok: true })
  }
  if (_hp_url !== '' && _hp_url !== null && _hp_url !== undefined) {
    return res.status(200).json({ ok: true })
  }

  // Validações de negócio
  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Email inválido.' })

  if (!password || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'A senha deve ter entre 8 e 128 caracteres.' })

  if (!/[A-Z]/.test(password))
    return res.status(400).json({ error: 'A senha deve ter pelo menos uma letra maiúscula.' })

  if (!/[0-9]/.test(password))
    return res.status(400).json({ error: 'A senha deve ter pelo menos um número.' })

  if (!VALID_PLANS.has(plan))
    return res.status(400).json({ error: 'Plano inválido.' })

  // Rate limit: 3 criações de conta por IP por hora
  const ip = (req.headers['x-real-ip']
    ?? (req.headers['x-forwarded-for'] ?? '').split(',')[0]
    ?? 'unknown').toString().trim()

  if (!(await checkRateWindow(`create-account:${ip}`, 3, 3600))) {
    logger.warn('rate_limit', PATH, { ip, window: 3600 })
    res.setHeader('Retry-After', '3600')
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde antes de criar uma nova conta.' })
  }

  // Delega criação à Edge Function — service_role fica nos secrets do Supabase,
  // nunca em variáveis de ambiente do Vercel.
  try {
    const efRes = await fetch(EDGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${ANON_KEY}`,
        'apikey':         ANON_KEY,
        'x-proxy-secret': PROXY_SECRET,
      },
      body:   JSON.stringify({ email, password, plan }),
      signal: AbortSignal.timeout(15_000),
    })

    // Repassa a resposta da EF diretamente ao frontend — status e body preservados:
    // 200 { ok: true }            → conta criada
    // 409 { error: 'email_exists' } → email já cadastrado
    // 500 / 502                   → erros genéricos (sem vazar detalhes internos)
    const body = await efRes.text()
    res.setHeader('Content-Type', 'application/json')
    return res.status(efRes.status).send(body)
  } catch (err) {
    logger.error('gateway_error', PATH, { ip, error: err?.message })
    return res.status(502).json({ error: 'Serviço temporariamente indisponível.' })
  }
}
