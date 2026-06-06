/**
 * GranaEvo — Sistema de Alertas de Segurança
 *
 * Detecta padrões de ataque via contadores no Redis (Upstash).
 * Quando um threshold é atingido, envia email via Resend.
 *
 * Design:
 *   - Fire-and-forget: nunca bloqueia o request principal
 *   - Alerta exatamente na threshold (não a cada evento depois)
 *   - Degradação graciosa: sem Redis/Resend → silêncio
 *   - Dead-letter queue: alertas com falha são salvos no Redis para retry
 *   - Log estruturado em cada evento para rastreabilidade no Vercel
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const RESEND_KEY  = process.env.RESEND_API_KEY
const ALERT_EMAILS = (process.env.SECURITY_ALERT_EMAIL ?? '')
  .split(',').map(e => e.trim()).filter(Boolean)

const ALERT_RECIPIENTS = ALERT_EMAILS
const DEAD_LETTER_KEY  = 'alerts:dead_letter'
const DEAD_LETTER_TTL  = 86_400 // 24 horas em segundos

// IPs são bloqueados por 1 hora ao atingir threshold em eventos críticos
const BLOCKLIST_PREFIX    = 'blocklist:ip:'
const BLOCKLIST_TTL       = 3_600 // 1 hora em segundos
const _BLOCK_ON_THRESHOLD = new Set(['jwt_forgery', 'webhook_tamper', 'proxy_bypass'])

// Tipo de evento → { quantos eventos na janela disparam alerta, janela em segundos }
const THRESHOLDS = {
  rate_limit_burst:  { count: 40,  window: 300  }, // 40 rate limits em 5min → scanning/botnet
  jwt_forgery:       { count: 10,  window: 300  }, // 10 JWTs inválidos em 5min → tentativa de bypass
  webhook_tamper:    { count:  3,  window:  60  }, // 3 secrets inválidos em 1min → probe no webhook
  login_lockout:     { count:  5,  window: 600  }, // 5 lockouts em 10min → credential stuffing
  upload_abuse:      { count: 15,  window: 300  }, // 15 uploads rejeitados em 5min → storage abuse
  proxy_bypass:      { count:  5,  window: 120  }, // 5 tentativas sem proxy-secret em 2min → scan direto de EF
}

const LABELS = {
  rate_limit_burst: '⚠️  Rate Limit Burst (possível scan/botnet)',
  jwt_forgery:      '🔴 Tentativa de JWT Forgery',
  webhook_tamper:   '🔴 Webhook Secret Inválido (possível fraude de pagamento)',
  login_lockout:    '⚠️  Múltiplos Lockouts (possível credential stuffing)',
  upload_abuse:     '⚠️  Abuso de Upload de Fotos',
  proxy_bypass:     '🔴 Tentativa de Acesso Direto às Edge Functions (bypass de proxy Vercel)',
}

// ── Blocklist de IPs ──────────────────────────────────────────────────────────

/** Bloqueia um IP no Redis por BLOCKLIST_TTL segundos. Fire-and-forget. */
async function _blockIPInRedis(ip) {
  if (!REDIS_URL || !REDIS_TOKEN || !ip || ip === 'unknown') return
  try {
    await fetch(`${REDIS_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([
        ['SET', `${BLOCKLIST_PREFIX}${ip}`, '1'],
        ['EXPIRE', `${BLOCKLIST_PREFIX}${ip}`, BLOCKLIST_TTL],
      ]),
      signal: AbortSignal.timeout(2_000),
    })
    console.log(JSON.stringify({
      level: 'security', event: 'ip_blocked', ip, ttl: BLOCKLIST_TTL,
      timestamp: new Date().toISOString(),
    }))
  } catch { /* silêncio */ }
}

// ── Dead-letter queue ─────────────────────────────────────────────────────────

/** Salva alerta que falhou no Redis para retry posterior. */
async function _saveDeadLetter(eventType, count, meta) {
  if (!REDIS_URL || !REDIS_TOKEN) return
  try {
    const payload = JSON.stringify({ eventType, count, meta, timestamp: Date.now() })
    await fetch(`${REDIS_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([
        ['LPUSH', DEAD_LETTER_KEY, payload],
        ['EXPIRE', DEAD_LETTER_KEY, DEAD_LETTER_TTL],
        ['LTRIM', DEAD_LETTER_KEY, 0, 49], // máximo 50 itens no dead-letter
      ]),
      signal: AbortSignal.timeout(2_000),
    })
  } catch { /* silêncio — dead-letter não quebra o fluxo */ }
}

/** Tenta reenviar alertas do dead-letter queue (máx 5 por chamada). */
async function _retryDeadLetter() {
  if (!REDIS_URL || !REDIS_TOKEN || !RESEND_KEY || ALERT_RECIPIENTS.length === 0) return
  try {
    // Lê até 5 itens sem remover (LRANGE não é destrutivo)
    const lrangeRes = await fetch(`${REDIS_URL}/lrange/${DEAD_LETTER_KEY}/0/4`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal:  AbortSignal.timeout(2_000),
    })
    if (!lrangeRes.ok) return
    const { result: items } = await lrangeRes.json()
    if (!Array.isArray(items) || items.length === 0) return

    for (const raw of items) {
      try {
        const { eventType, count, meta } = JSON.parse(raw)
        const delivered = await _sendAlert(eventType, count, meta, true)
        if (delivered) {
          // Remove exatamente este item do dead-letter
          await fetch(`${REDIS_URL}/lrem/${DEAD_LETTER_KEY}/1/${encodeURIComponent(raw)}`, {
            method:  'GET',
            headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
            signal:  AbortSignal.timeout(1_000),
          })
        }
      } catch { /* falha silenciosa por item */ }
    }
  } catch { /* silêncio */ }
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Registra um evento de segurança e envia alerta se o threshold for atingido.
 * Chamada fire-and-forget — nunca aguarde o retorno desta função.
 *
 * @param {string} eventType  Chave de THRESHOLDS (ex: 'jwt_forgery')
 * @param {object} [meta]     Dados adicionais para o email (IP, endpoint, etc.)
 */
export async function trackSecurityEvent(eventType, meta = {}) {
  if (!REDIS_URL || !REDIS_TOKEN) return

  const cfg = THRESHOLDS[eventType]
  if (!cfg) return

  // Tenta reenviar alertas do dead-letter em background (sem bloquear)
  _retryDeadLetter().catch(() => {})

  const window = cfg.window
  const bucket = Math.floor(Date.now() / 1000 / window) // bucket por janela
  const key    = `sec:alert:${eventType}:${bucket}`

  try {
    const pipeline = [
      ['INCR', key],
      ['EXPIRE', key, window * 2], // expiração 2× a janela para diagnóstico
    ]
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(pipeline),
      signal:  AbortSignal.timeout(2_000),
    })
    if (!res.ok) return

    const data  = await res.json()
    const count = data?.[0]?.result ?? 0

    // Log estruturado — visível no Vercel Functions Logs
    console.log(JSON.stringify({
      level:     'security',
      eventType,
      count,
      threshold: cfg.count,
      window:    cfg.window,
      meta,
      timestamp: new Date().toISOString(),
    }))

    // Alerta exatamente quando atinge o threshold — evita spam
    if (count === cfg.count) {
      const delivered = await _sendAlert(eventType, count, meta, false)
      if (!delivered) {
        await _saveDeadLetter(eventType, count, meta)
      }
      // Bloqueia o IP ao atingir threshold em eventos críticos de ataque direto
      if (_BLOCK_ON_THRESHOLD.has(eventType) && meta?.ip) {
        _blockIPInRedis(meta.ip).catch(() => {})
      }
    }
  } catch { /* silêncio — monitoramento nunca quebra o fluxo principal */ }
}

/**
 * Envia email de alerta via Resend.
 * @param {string}  eventType   Tipo de evento de segurança
 * @param {number}  count       Quantidade de ocorrências
 * @param {object}  meta        Metadados do evento
 * @param {boolean} isRetry     Se true, vem do dead-letter (inclui sufixo no subject)
 * @returns {Promise<boolean>}  true se o email foi enviado com sucesso
 */
async function _sendAlert(eventType, count, meta, isRetry = false) {
  if (!RESEND_KEY || ALERT_RECIPIENTS.length === 0) return false

  const label   = LABELS[eventType] ?? eventType
  const subject = `[GranaEvo Security]${isRetry ? ' [RETRY]' : ''} ${label}`
  const metaStr = Object.entries(meta)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n') || '  (sem metadados)'

  const text = [
    `🚨 ALERTA DE SEGURANÇA — GranaEvo`,
    ``,
    `Evento:      ${eventType}`,
    `Descrição:   ${label}`,
    `Ocorrências: ${count} na janela de ${THRESHOLDS[eventType]?.window ?? '?'}s`,
    `Timestamp:   ${new Date().toISOString()}`,
    isRetry ? `Status:      REENVIO (falha original na dead-letter queue)` : '',
    ``,
    `Metadados:`,
    metaStr,
    ``,
    `Links úteis:`,
    `  Vercel Logs:    https://vercel.com/granadev/granaevo/logs`,
    `  Supabase Logs:  https://supabase.com/dashboard/project/fvrhqqeofqedmhadzzqw/logs/edge-logs`,
    `  Redis (Upstash): https://console.upstash.com`,
    ``,
    `— GranaEvo Security Monitor`,
  ].filter(l => l !== '').join('\n')

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({
        from:    'GranaEvo Security <noreply@granaevo.com>',
        to:      ALERT_RECIPIENTS,
        subject,
        text,
      }),
      signal: AbortSignal.timeout(5_000),
    })

    const delivered = emailRes.ok
    console.log(JSON.stringify({
      level:     'security_alert',
      eventType,
      delivered,
      isRetry,
      timestamp: new Date().toISOString(),
    }))
    return delivered
  } catch {
    return false
  }
}
