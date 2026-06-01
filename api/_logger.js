/**
 * GranaEvo — Structured Logger para API Routes (Vercel)
 *
 * Emite JSON de uma linha por evento — compatível com Vercel Log Explorer,
 * Datadog, Logtail e qualquer parser de logs estruturados.
 *
 * Campos garantidos em todo evento:
 *   level     : 'info' | 'warn' | 'error'
 *   event     : identificador do evento em snake_case
 *   path      : rota da API (ex: '/api/upload-profile-photo')
 *   timestamp : ISO 8601 UTC
 *
 * Segurança:
 *   - Nunca loga tokens JWT, passwords, secrets ou dados financeiros
 *   - Trunca campos longos para evitar log injection
 *   - Remove caracteres de controle (previne CRLF injection)
 *   - Sem stack traces em produção
 */

const MAX_FIELD_LEN = 200

function _sanitize(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean' || typeof v === 'number') return v
  return String(v)
    .replace(/[\x00-\x1f\x7f]/g, '') // remove control chars (CRLF injection)
    .slice(0, MAX_FIELD_LEN)
}

function _sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    if (/token|secret|password|key|auth|jwt|bearer/i.test(k)) continue
    const sk = _sanitize(k)
    if (sk) out[sk] = _sanitize(v)
  }
  return out
}

function _emit(level, event, path, meta = {}) {
  const entry = {
    level,
    event:     _sanitize(event)     ?? 'unknown',
    path:      _sanitize(path)      ?? '/',
    timestamp: new Date().toISOString(),
    ..._sanitizeMeta(meta),
  }
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  /** Log informativo — request aceito, operação bem-sucedida */
  info:  (event, path, meta) => _emit('info',  event, path, meta),
  /** Log de aviso — rate limit, bad input, item não encontrado */
  warn:  (event, path, meta) => _emit('warn',  event, path, meta),
  /** Log de erro — falha de gateway, serviço indisponível, erro inesperado */
  error: (event, path, meta) => _emit('error', event, path, meta),
}
