// /api/auth-session.js — BFF de sessão (modelo híbrido httpOnly)
//
// Objetivo de segurança:
//   O REFRESH TOKEN (credencial longeva e perigosa) nunca chega ao JavaScript.
//   Vive exclusivamente num cookie HttpOnly; Secure; SameSite=Strict, com Path
//   restrito a este endpoint — inalcançável por XSS. O ACCESS TOKEN (curto, ~1h)
//   é devolvido no corpo da resposta para o client guardar APENAS em memória e
//   usar via o callback `accessToken` do supabase-js (PostgREST/Realtime/Storage).
//
// Ações (POST, campo `action` no body):
//   login   { email, password, remember? } → password grant; seta cookie; retorna access
//   refresh {}                              → refresh grant via cookie; rotaciona cookie
//   logout  {}                              → revoga sessão; limpa cookie
//
// Substitui supabase.auth.signInWithPassword / autoRefreshToken / signOut no client.

import { checkRate, checkRateWindow, isIPBlocked } from './_rate-limit.js'
import { logger } from './_logger.js'

const PATH         = '/api/auth-session'
const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const ANON_KEY     = process.env.SUPABASE_ANON_KEY ?? ''

const COOKIE_NAME      = 'ge_rt'
const COOKIE_PATH      = '/api/auth-session'
const REMEMBER_MAX_AGE = 60 * 60 * 24 * 30   // 30 dias quando "lembrar de mim"

const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://assistente.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

// Rate limits por IP (por minuto), exceto login (janela maior anti brute-force)
const RL_LOGIN_MAX     = 8
const RL_LOGIN_WIN      = 600   // 8 logins / 10 min por IP
const RL_REFRESH_MAX   = 30     // refresh é frequente (a cada ~1h por aba, mais picos)
const RL_LOGOUT_MAX    = 15
const MAX_BODY_BYTES   = 4096
const EMAIL_RE         = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

// ── Cookie helpers ────────────────────────────────────────────────────────────
function buildRefreshCookie(value, { maxAge, clear } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Path=${COOKIE_PATH}`,
  ]
  if (clear)                         parts.push('Max-Age=0')
  else if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`)
  // sem Max-Age = cookie de sessão (some ao fechar o browser) — usado quando !remember
  return parts.join('; ')
}

function readRefreshCookie(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      const v = part.slice(idx + 1).trim()
      return v || null
    }
  }
  return null
}

// ── Chamadas ao GoTrue (Supabase Auth REST) ────────────────────────────────────
async function gotrue(pathname, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'apikey': ANON_KEY }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${SUPABASE_URL}/auth/v1/${pathname}`, {
    method:  'POST',
    headers,
    body:    body ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(12_000),
  })
}

// Resposta de sucesso: devolve só o que o client guarda em memória — nunca o refresh.
function sessionPayload(grant) {
  return {
    access_token: grant.access_token,
    expires_at:   grant.expires_at,   // epoch segundos
    expires_in:   grant.expires_in,
    token_type:   grant.token_type ?? 'bearer',
    user:         grant.user ?? null,
  }
}

export default async function handler(req, res) {
  const origin  = req.headers['origin'] ?? ''
  const allowed = ALLOWED_ORIGINS.has(origin)

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Max-Age', '86400')
    return res.status(204).end()
  }

  if (!allowed)               return res.status(403).json({ error: 'Forbidden' })
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method !== 'POST')  return res.status(405).json({ error: 'Method Not Allowed' })
  if (!SUPABASE_URL || !ANON_KEY)
    return res.status(503).json({ error: 'Serviço indisponível' })

  // CSRF defesa-em-profundidade: Sec-Fetch + Origin já validado
  const fs = req.headers['sec-fetch-site'] ?? ''
  if (fs && fs !== 'same-origin' && fs !== 'none') return res.status(403).json({ error: 'Forbidden' })

  const ct = req.headers['content-type'] ?? ''
  if (!ct.includes('application/json'))
    return res.status(415).json({ error: 'Content-Type deve ser application/json' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (await isIPBlocked(ip)) {
    logger.warn('ip_blocked', PATH, { ip })
    return res.status(403).json({ error: 'Forbidden' })
  }

  // ── Lê body (pequeno) ─────────────────────────────────────────
  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) {
    return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' })
  }

  let body
  try { body = JSON.parse(raw || '{}') } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  const action = typeof body?.action === 'string' ? body.action : ''

  // ── LOGIN ─────────────────────────────────────────────────────
  if (action === 'login') {
    if (!await checkRateWindow(`auth-login:${ip}`, RL_LOGIN_MAX, RL_LOGIN_WIN)) {
      logger.warn('rate_limit', PATH, { ip, action })
      res.setHeader('Retry-After', String(RL_LOGIN_WIN))
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' })
    }

    const email    = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const remember = body?.remember === true

    if (!EMAIL_RE.test(email) || !password || password.length > 128)
      return res.status(400).json({ error: 'invalid_credentials' })

    let grantRes
    try {
      grantRes = await gotrue('token?grant_type=password', { body: { email, password } })
    } catch (e) {
      const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
      return res.status(code).json({ error: 'Gateway indisponível' })
    }

    if (!grantRes.ok) {
      // Não vaza se o email existe — sempre mensagem genérica
      logger.warn('login_failed', PATH, { ip })
      return res.status(401).json({ error: 'invalid_credentials' })
    }

    const grant = await grantRes.json()
    if (!grant?.access_token || !grant?.refresh_token)
      return res.status(502).json({ error: 'Resposta de autenticação inválida' })

    res.setHeader('Set-Cookie', buildRefreshCookie(grant.refresh_token,
      remember ? { maxAge: REMEMBER_MAX_AGE } : {}))
    return res.status(200).json(sessionPayload(grant))
  }

  // ── REFRESH ───────────────────────────────────────────────────
  if (action === 'refresh') {
    if (!await checkRate(`auth-refresh:${ip}`, RL_REFRESH_MAX)) {
      res.setHeader('Retry-After', '60')
      return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
    }

    // Sem cookie = simplesmente deslogado. Responde 200 com sessão vazia (não 401)
    // para não poluir o console com erro vermelho em toda página pública/deslogada.
    const refreshToken = readRefreshCookie(req.headers['cookie'] ?? '')
    if (!refreshToken) return res.status(200).json({ session: null })

    let grantRes
    try {
      grantRes = await gotrue('token?grant_type=refresh_token', { body: { refresh_token: refreshToken } })
    } catch (e) {
      // Erro real de gateway (rede/timeout/5xx) → transitório, NÃO desloga
      const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
      return res.status(code).json({ error: 'Gateway indisponível' })
    }

    if (!grantRes.ok) {
      // Refresh inválido/revogado → limpa o cookie e sinaliza "deslogado" (200, sem erro)
      res.setHeader('Set-Cookie', buildRefreshCookie('', { clear: true }))
      return res.status(200).json({ session: null })
    }

    const grant = await grantRes.json()
    if (!grant?.access_token || !grant?.refresh_token) {
      res.setHeader('Set-Cookie', buildRefreshCookie('', { clear: true }))
      return res.status(200).json({ session: null })
    }

    // Rotação: Supabase emite novo refresh a cada uso — re-grava o cookie.
    // Preserva a longevidade: se o cookie atual era persistente (remember), mantém.
    const wasPersistent = (req.headers['cookie'] ?? '').includes(`${COOKIE_NAME}=`) && body?.remember !== false
    res.setHeader('Set-Cookie', buildRefreshCookie(grant.refresh_token,
      body?.remember === true || wasPersistent ? { maxAge: REMEMBER_MAX_AGE } : {}))
    return res.status(200).json(sessionPayload(grant))
  }

  // ── LOGOUT ────────────────────────────────────────────────────
  if (action === 'logout') {
    if (!await checkRate(`auth-logout:${ip}`, RL_LOGOUT_MAX)) {
      res.setHeader('Retry-After', '60')
      return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
    }

    const refreshToken = readRefreshCookie(req.headers['cookie'] ?? '')
    // Revoga server-side (best effort) — o access token é passado pelo client p/ autorizar o logout
    const authHdr = req.headers['authorization'] ?? ''
    const accessToken = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : null
    if (accessToken) {
      try { await gotrue('logout', { token: accessToken }) } catch { /* best effort */ }
    }
    // Limpa o cookie independentemente do resultado da revogação
    res.setHeader('Set-Cookie', buildRefreshCookie('', { clear: true }))
    if (!refreshToken && !accessToken) return res.status(200).json({ ok: true })
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'action inválida: use login, refresh ou logout' })
}
