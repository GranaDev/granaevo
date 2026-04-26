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
 *   - Janelas deslizantes por minuto agrupadas no threshold.window
 */

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const RESEND_KEY  = process.env.RESEND_API_KEY
const ALERT_EMAIL = process.env.SECURITY_ALERT_EMAIL ?? 'oliveiralucas00224@gmail.com'

// Tipo de evento → { quantos eventos na janela disparam alerta, janela em segundos }
const THRESHOLDS = {
  rate_limit_burst:  { count: 40,  window: 300  }, // 40 rate limits em 5min → scanning/botnet
  jwt_forgery:       { count: 10,  window: 300  }, // 10 JWTs inválidos em 5min → tentativa de bypass
  webhook_tamper:    { count:  3,  window:  60  }, // 3 secrets inválidos em 1min → probe no webhook
  login_lockout:     { count:  5,  window: 600  }, // 5 lockouts em 10min → credential stuffing
  upload_abuse:      { count: 15,  window: 300  }, // 15 uploads rejeitados em 5min → storage abuse
}

const LABELS = {
  rate_limit_burst: '⚠️  Rate Limit Burst (possível scan/botnet)',
  jwt_forgery:      '🔴 Tentativa de JWT Forgery',
  webhook_tamper:   '🔴 Webhook Secret Inválido (possível fraude de pagamento)',
  login_lockout:    '⚠️  Múltiplos Lockouts (possível credential stuffing)',
  upload_abuse:     '⚠️  Abuso de Upload de Fotos',
}

/**
 * Registra um evento de segurança e envia alerta se o threshold for atingido.
 * Chamada fire-and-forget — nunca aguarde o retorno desta função.
 *
 * @param {string} eventType  Chave de THRESHOLDS (ex: 'jwt_forgery')
 * @param {object} [meta]     Dados adicionais para o email (IP, endpoint, etc.)
 */
export async function trackSecurityEvent(eventType, meta = {}) {
  if (!REDIS_URL || !REDIS_TOKEN) return

  const cfg     = THRESHOLDS[eventType]
  if (!cfg) return

  const window  = cfg.window
  const bucket  = Math.floor(Date.now() / 1000 / window) // bucket por janela
  const key     = `sec:alert:${eventType}:${bucket}`

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

    // Alerta exatamente quando atinge o threshold — evita spam a cada evento seguinte
    if (count === cfg.count) {
      await _sendAlert(eventType, count, meta)
    }
  } catch { /* silêncio — monitoramento nunca quebra o fluxo principal */ }
}

async function _sendAlert(eventType, count, meta) {
  if (!RESEND_KEY) return

  const label   = LABELS[eventType] ?? eventType
  const subject = `[GranaEvo Security] ${label}`
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
  ].join('\n')

  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({
        from:    'GranaEvo Security <noreply@granaevo.com>',
        to:      [ALERT_EMAIL],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch { /* falha no envio não quebra nada */ }
}
