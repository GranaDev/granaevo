/**
 * Rate limiting distribuído — Upstash Redis quando disponível, in-memory como fallback.
 *
 * Para produção com 50k usuários, configure as variáveis de ambiente:
 *   UPSTASH_REDIS_REST_URL  — URL REST do Redis no Upstash Console
 *   UPSTASH_REDIS_REST_TOKEN — Token de autenticação do Redis no Upstash Console
 *
 * Sem essas variáveis, o módulo usa um Map em memória (funcional mas não persiste
 * entre instâncias Vercel serverless — adequado para desenvolvimento e tráfego baixo).
 *
 * Algoritmo: sliding window via INCR + EXPIRE no Redis.
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN)

// Detecta ambiente de produção
const IS_PRODUCTION = process.env.NODE_ENV === 'production' ||
                      process.env.VERCEL_ENV === 'production'

// Avisa se Redis não está configurado em produção (log visível no Vercel)
if (IS_PRODUCTION && !USE_REDIS) {
  console.warn(JSON.stringify({
    level: 'warn', event: 'redis_not_configured', path: '/api/_rate-limit',
    timestamp: new Date().toISOString(),
    reason: 'Rate limiting multi-instância inativo. Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.',
  }))
}

// ── Fallback in-memory ────────────────────────────────────────────────────────
const _store          = new Map()
const _DEFAULT_WINDOW = 60_000  // janela padrão para checkRate()
// Cap reduzido: 5k entradas ~512KB — mais conservador em memória serverless
const _MAX_STORE = 5_000

// windowMs: permite que checkRateWindow() repasse sua janela customizada.
function _checkMemory(key, max, windowMs = _DEFAULT_WINDOW) {
  // Log de fallback em produção para visibilidade de operação
  if (IS_PRODUCTION) {
    console.warn(JSON.stringify({
      level: 'warn', event: 'rate_limit_fallback_memory', path: '/api/_rate-limit',
      timestamp: new Date().toISOString(), key,
    }))
  }

  const now = Date.now()
  const r   = _store.get(key)
  if (!r || now - r.t > windowMs) {
    // Aplica cap antes de inserir nova chave
    if (!r && _store.size >= _MAX_STORE) {
      // Limpa entradas expiradas usando a janela correta de cada chave
      for (const [k, v] of _store) {
        if (now - v.t > (v.w ?? _DEFAULT_WINDOW)) _store.delete(k)
        if (_store.size < _MAX_STORE) break
      }
      // Se ainda cheio após limpeza, rejeita novo IP
      if (_store.size >= _MAX_STORE) return false
    }
    // Armazena a janela junto à entrada — cleanup usa janela real da chave
    _store.set(key, { c: 1, t: now, w: windowMs })
    return true
  }
  if (r.c >= max) return false
  r.c++; return true
}

// Cleanup mais agressivo: a cada 30s (era 120s)
// Reduz acúmulo de entradas em casos de pico de tráfego
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _store) {
    if (now - v.t > (v.w ?? _DEFAULT_WINDOW) * 2) _store.delete(k)
  }
}, 30_000)

// ── Upstash Redis (sliding window INCR + EXPIRE) ──────────────────────────────
async function _checkRedis(key, max, windowSecs = 60) {
  const windowMs = windowSecs * 1_000
  try {
    // Pipeline: INCR + EXPIRE em uma única round-trip
    const pipeline = [
      ['INCR', key],
      ['EXPIRE', key, windowSecs, 'NX'],  // NX: só define se ainda não existe
    ]
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(pipeline),
      signal:  AbortSignal.timeout(3_000), // evita hang se Redis for lento
    })
    if (!res.ok) return _checkMemory(key, max, windowMs)
    const data = await res.json()
    const count = data?.[0]?.result ?? 1
    return count <= max
  } catch {
    return _checkMemory(key, max, windowMs)
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Verifica se a chave está dentro do limite (janela padrão de 60s).
 * @param {string} key  Chave única (ex: `send:127.0.0.1`)
 * @param {number} max  Número máximo de requisições por janela
 * @returns {Promise<boolean>} true se permitido, false se bloqueado
 */
export async function checkRate(key, max) {
  const allowed = await (USE_REDIS ? _checkRedis(key, max) : _checkMemory(key, max))
  if (!allowed) {
    import('./_alert.js').then(({ trackSecurityEvent }) => {
      trackSecurityEvent('rate_limit_burst', { key }).catch(() => {})
    }).catch(() => {})
  }
  return allowed
}

/**
 * Verifica se a chave está dentro do limite com janela de tempo customizável.
 * @param {string} key         Chave única (ex: `create-account:127.0.0.1`)
 * @param {number} max         Número máximo de requisições na janela
 * @param {number} windowSecs  Tamanho da janela em segundos (ex: 3600 para 1 hora)
 * @returns {Promise<boolean>} true se permitido, false se bloqueado
 */
export async function checkRateWindow(key, max, windowSecs) {
  const windowMs = (windowSecs ?? 60) * 1_000
  const allowed  = await (USE_REDIS
    ? _checkRedis(key, max, windowSecs)
    : _checkMemory(key, max, windowMs))
  if (!allowed) {
    import('./_alert.js').then(({ trackSecurityEvent }) => {
      trackSecurityEvent('rate_limit_burst', { key }).catch(() => {})
    }).catch(() => {})
  }
  return allowed
}

/**
 * Verifica rate limit combinado por IP e por userId.
 * Bloqueia se QUALQUER um dos dois exceder o limite.
 * Ideal para endpoints como upload de foto (proteção dupla).
 *
 * @param {string} ip          Endereço IP do cliente
 * @param {string|null} userId UUID do usuário autenticado (ou null para anon)
 * @param {number} max         Número máximo de requisições na janela
 * @param {number} windowSecs  Tamanho da janela em segundos
 * @returns {Promise<boolean>} true se permitido, false se bloqueado por qualquer chave
 */
export async function checkRateWithUser(ip, userId, max, windowSecs = 60) {
  const [ipOk, userOk] = await Promise.all([
    checkRateWindow(`ip:${ip}`, max, windowSecs),
    userId
      ? checkRateWindow(`user:${userId}`, max, windowSecs)
      : Promise.resolve(true),
  ])
  return ipOk && userOk
}

/** true se Redis está configurado e sendo utilizado */
export const isRedisEnabled = USE_REDIS

// ── Blocklist persistente de IPs ──────────────────────────────────────────────
const BLOCKLIST_PREFIX = 'blocklist:ip:'
const BLOCKLIST_DEFAULT_TTL = 3_600 // 1 hora em segundos

// In-memory como fallback quando Redis não está disponível
const _blockedIPs = new Map() // ip → expiry timestamp (ms)

setInterval(() => {
  const now = Date.now()
  for (const [ip, expiry] of _blockedIPs) {
    if (now > expiry) _blockedIPs.delete(ip)
  }
}, 60_000)

/**
 * Verifica se um IP está na blocklist persistente.
 * @param {string} ip
 * @returns {Promise<boolean>}
 */
export async function isIPBlocked(ip) {
  if (!ip || ip === 'unknown') return false
  if (USE_REDIS) {
    try {
      const res = await fetch(`${REDIS_URL}/exists/${BLOCKLIST_PREFIX}${ip}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
        signal:  AbortSignal.timeout(2_000),
      })
      if (!res.ok) return _blockedIPs.has(ip) && Date.now() < (_blockedIPs.get(ip) ?? 0)
      const data = await res.json()
      return (data?.result ?? 0) > 0
    } catch {
      return _blockedIPs.has(ip) && Date.now() < (_blockedIPs.get(ip) ?? 0)
    }
  }
  return _blockedIPs.has(ip) && Date.now() < (_blockedIPs.get(ip) ?? 0)
}

/**
 * Adiciona um IP à blocklist persistente.
 * @param {string} ip
 * @param {number} [ttlSecs=3600] TTL em segundos
 * @returns {Promise<void>}
 */
export async function blockIP(ip, ttlSecs = BLOCKLIST_DEFAULT_TTL) {
  if (!ip || ip === 'unknown') return
  _blockedIPs.set(ip, Date.now() + ttlSecs * 1_000)
  if (!USE_REDIS) return
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([
        ['SET', `${BLOCKLIST_PREFIX}${ip}`, '1'],
        ['EXPIRE', `${BLOCKLIST_PREFIX}${ip}`, ttlSecs],
      ]),
      signal: AbortSignal.timeout(2_000),
    })
  } catch { /* silêncio — in-memory já foi setado como fallback */ }
}
