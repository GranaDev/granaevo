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

/**
 * ID de correlação do request (Passo 27).
 *
 * Hoje o proxy loga de um lado e a edge function do outro, sem nada em comum:
 * investigar um erro é cruzar horário na mão e torcer. Com um id repassado
 * proxy → edge, as duas pontas da MESMA requisição se acham por busca exata.
 *
 * Ordem de preferência, e o porquê:
 *   1. `x-request-id` que já veio — preserva a cadeia se houver outro salto;
 *   2. `x-vercel-id` — a Vercel já gera um por request; reusar faz o log da
 *      aplicação bater com o log da plataforma, sem inventar um segundo id;
 *   3. aleatório — último caso.
 *
 * Saneado a 80 chars e só [A-Za-z0-9:_-]: o valor vem de header (entrada do
 * cliente) e vai para dentro de linha de log — sem isso, dá para injetar quebra
 * de linha e forjar entradas falsas no log.
 */
export function requestIdDe(req) {
  const bruto = req?.headers?.['x-request-id'] || req?.headers?.['x-vercel-id'] || ''
  const limpo = String(bruto).replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80)
  if (limpo) return limpo
  try { return globalThis.crypto.randomUUID() } catch { /* fallback abaixo */ }
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
