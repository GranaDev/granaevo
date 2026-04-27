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

// ── Fallback in-memory ────────────────────────────────────────────────────────
const _store     = new Map()
const _WINDOW    = 60_000
// [FINAL-M02] Cap no tamanho do Map — sem limite, um DDoS com IPs únicos esgotava
// a memória da instância serverless. 10k entradas = ~1MB, seguro para qualquer escala.
const _MAX_STORE = 10_000

function _checkMemory(key, max) {
  const now = Date.now()
  const r   = _store.get(key)
  if (!r || now - r.t > _WINDOW) {
    // Aplica cap antes de inserir nova chave
    if (!r && _store.size >= _MAX_STORE) {
      // Limpa entradas expiradas
      for (const [k, v] of _store) {
        if (now - v.t > _WINDOW) _store.delete(k)
        if (_store.size < _MAX_STORE) break
      }
      // Se ainda cheio após limpeza, rejeita novo IP
      if (_store.size >= _MAX_STORE) return false
    }
    _store.set(key, { c: 1, t: now })
    return true
  }
  if (r.c >= max) return false
  r.c++; return true
}

// Limpa entradas expiradas periodicamente para evitar memory leak
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _store) { if (now - v.t > _WINDOW) _store.delete(k) }
}, 120_000)

// ── Upstash Redis (sliding window INCR + EXPIRE) ──────────────────────────────
async function _checkRedis(key, max, windowSecs = 60) {
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
      signal:  AbortSignal.timeout(3_000), // [GOD5-L01] evita hang se Redis for lento
    })
    if (!res.ok) return _checkMemory(key, max) // fallback em erro de rede
    const data = await res.json()
    const count = data?.[0]?.result ?? 1
    return count <= max
  } catch {
    return _checkMemory(key, max)
  }
}

// ── API pública ───────────────────────────────────────────────────────────────
/**
 * Verifica se a chave está dentro do limite.
 * Quando bloqueado, registra automaticamente o evento de segurança.
 * @param {string} key   Chave única (ex: `send:127.0.0.1`)
 * @param {number} max   Número máximo de requisições por janela
 * @returns {Promise<boolean>} true se permitido, false se bloqueado
 */
export async function checkRate(key, max) {
  const allowed = await (USE_REDIS ? _checkRedis(key, max) : _checkMemory(key, max))
  if (!allowed) {
    // Fire-and-forget: track burst para detectar scan/botnet via alertas
    import('./_alert.js').then(({ trackSecurityEvent }) => {
      trackSecurityEvent('rate_limit_burst', { key }).catch(() => {})
    }).catch(() => {})
  }
  return allowed
}

export const isRedisEnabled = USE_REDIS
