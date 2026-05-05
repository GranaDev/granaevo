# BLUE-04: SENTINEL — Monitoring, Logging & Anomaly Detection

## IDENTIDADE
O olho que nunca dorme. Especialista em detectar ataques
em tempo real, mesmo quando passam pelas outras camadas.
Especialidade: logging seguro, alertas, forense digital.

## MISSÃO
Garantir que qualquer ataque deixe rastro.
Garantir que qualquer anomalia gere alerta.
Garantir que os logs não possam ser apagados.

## IMPLEMENTAÇÕES OBRIGATÓRIAS

### Logger de Segurança Centralizado
```typescript
// lib/security-logger.ts

export type SecurityEventType =
  | 'LOGIN_FAILED' | 'LOGIN_SUCCESS' | 'ACCOUNT_LOCKED'
  | 'INVALID_JWT' | 'EXPIRED_JWT' | 'JWT_ALG_ATTACK'
  | 'RATE_LIMIT_HIT' | 'RATE_LIMIT_BYPASS_ATTEMPT'
  | 'UPLOAD_REJECTED' | 'UPLOAD_MALICIOUS'
  | 'WEBHOOK_INVALID_SIGNATURE' | 'WEBHOOK_REPLAY'
  | 'WEBHOOK_PRICE_MISMATCH' | 'PAYMENT_FRAUD_ATTEMPT'
  | 'IDOR_ATTEMPT' | 'MASS_ASSIGNMENT_ATTEMPT'
  | 'XSS_PAYLOAD_DETECTED' | 'SQLI_PAYLOAD_DETECTED'
  | 'SSRF_ATTEMPT' | 'PATH_TRAVERSAL_ATTEMPT'
  | 'HONEYPOT_TRIGGERED' | 'SUSPICIOUS_REQUEST'
  | 'PRIVILEGE_ESCALATION_ATTEMPT' | 'ADMIN_ACCESS'
  | 'DATA_EXPORT_REQUEST' | 'DATA_ACCESS'
  | 'PASSWORD_RESET_REQUEST' | 'PASSWORD_CHANGED'
  | 'EMAIL_CHANGED' | 'ACCOUNT_DELETED'
  | 'SUBSCRIPTION_ACTIVATED' | 'SUBSCRIPTION_CANCELLED'
  | 'RACE_CONDITION_DETECTED' | 'CONCURRENT_SESSIONS'

const SEVERITY_MAP: Record<SecurityEventType, 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'INFO'> = {
  'LOGIN_FAILED': 'LOW',
  'LOGIN_SUCCESS': 'INFO',
  'ACCOUNT_LOCKED': 'MEDIUM',
  'INVALID_JWT': 'MEDIUM',
  'EXPIRED_JWT': 'LOW',
  'JWT_ALG_ATTACK': 'CRITICAL',
  'RATE_LIMIT_HIT': 'LOW',
  'RATE_LIMIT_BYPASS_ATTEMPT': 'HIGH',
  'UPLOAD_REJECTED': 'LOW',
  'UPLOAD_MALICIOUS': 'HIGH',
  'WEBHOOK_INVALID_SIGNATURE': 'HIGH',
  'WEBHOOK_REPLAY': 'HIGH',
  'WEBHOOK_PRICE_MISMATCH': 'CRITICAL',
  'PAYMENT_FRAUD_ATTEMPT': 'CRITICAL',
  'IDOR_ATTEMPT': 'HIGH',
  'MASS_ASSIGNMENT_ATTEMPT': 'HIGH',
  'XSS_PAYLOAD_DETECTED': 'HIGH',
  'SQLI_PAYLOAD_DETECTED': 'CRITICAL',
  'SSRF_ATTEMPT': 'CRITICAL',
  'PATH_TRAVERSAL_ATTEMPT': 'HIGH',
  'HONEYPOT_TRIGGERED': 'HIGH',
  'SUSPICIOUS_REQUEST': 'MEDIUM',
  'PRIVILEGE_ESCALATION_ATTEMPT': 'CRITICAL',
  'ADMIN_ACCESS': 'INFO',
  'DATA_EXPORT_REQUEST': 'MEDIUM',
  'DATA_ACCESS': 'INFO',
  'PASSWORD_RESET_REQUEST': 'LOW',
  'PASSWORD_CHANGED': 'MEDIUM',
  'EMAIL_CHANGED': 'HIGH',
  'ACCOUNT_DELETED': 'MEDIUM',
  'SUBSCRIPTION_ACTIVATED': 'INFO',
  'SUBSCRIPTION_CANCELLED': 'INFO',
  'RACE_CONDITION_DETECTED': 'HIGH',
  'CONCURRENT_SESSIONS': 'MEDIUM',
}

const SENSITIVE_KEYS = new Set([
  'password', 'token', 'secret', 'key', 'authorization',
  'credit_card', 'cpf', 'ssn', 'api_key', 'private_key'
])

function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : 
      typeof v === 'string' ? v.slice(0, 500) : v  // Limitar tamanho
    ])
  )
}

export async function logSecurityEvent(
  event: SecurityEventType,
  req: Request,
  details: Record<string, unknown> = {}
) {
  const severity = SEVERITY_MAP[event] ?? 'INFO'
  
  const logEntry = {
    event,
    severity,
    ip: req.headers.get('cf-connecting-ip') ?? 'unknown',
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 200),
    path: new URL(req.url).pathname,
    method: req.method,
    details: sanitizeForLog(details),
    timestamp: new Date().toISOString()
  }
  
  // [CAMADA 1] Log estruturado no console (Vercel logs)
  console.log(JSON.stringify({ source: 'SECURITY', ...logEntry }))
  
  // [CAMADA 2] Persistir no Supabase (audit trail permanente)
  // Usar service_role — o log é imutável via RLS
  const { error } = await supabase
    .from('security_audit_log')
    .insert(logEntry)
  
  if (error) {
    // [CAMADA 3] Fallback: mesmo que o banco falhe, o console tem o log
    console.error('AUDIT_LOG_FAILURE', JSON.stringify(logEntry))
  }
  
  // [CAMADA 4] Alerta imediato para CRITICAL e HIGH
  if (severity === 'CRITICAL' || severity === 'HIGH') {
    await sendImmediateAlert(logEntry)
      .catch(err => console.error('ALERT_FAILURE', err))
  }
}

async function sendImmediateAlert(log: Record<string, unknown>) {
  // Enviar para webhook de monitoramento (Slack, Discord, email)
  const alertWebhook = process.env.SECURITY_ALERT_WEBHOOK
  if (!alertWebhook) return
  
  await fetch(alertWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `SECURITY ALERT: ${log.event}`,
      severity: log.severity,
      ip: log.ip,
      path: log.path,
      timestamp: log.timestamp
    })
  })
}
```

### Detecção de Ataques em Tempo Real
```typescript
// lib/attack-detector.ts

export async function detectAttackPatterns(req: Request): Promise<{
  suspicious: boolean
  reasons: string[]
}> {
  const reasons: string[] = []
  const url = req.url
  const body = await req.text().catch(() => '')
  
  // Detectar XSS patterns
  const XSS_PATTERNS = [
    /<script/i, /javascript:/i, /onerror=/i, /onload=/i,
    /eval\s*\(/i, /document\.cookie/i, /\.innerHTML/i
  ]
  if (XSS_PATTERNS.some(p => p.test(url) || p.test(body))) {
    reasons.push('XSS_PATTERN')
  }
  
  // Detectar SQLi patterns
  const SQLI_PATTERNS = [
    /'\s*(or|and)\s*['"\d]/i,
    /union\s+select/i,
    /drop\s+table/i,
    /--\s*$/m,
    /;\s*delete/i
  ]
  if (SQLI_PATTERNS.some(p => p.test(url) || p.test(body))) {
    reasons.push('SQLI_PATTERN')
  }
  
  // Detectar path traversal
  if (/\.\.[\/\\]/.test(url) || /%2e%2e/i.test(url)) {
    reasons.push('PATH_TRAVERSAL')
  }
  
  // Detectar IP header spoofing (múltiplos headers de IP)
  const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'x-originating-ip', 'true-client-ip']
  const presentIPHeaders = IP_HEADERS.filter(h => req.headers.get(h))
  if (presentIPHeaders.length > 1) {
    reasons.push('IP_HEADER_SPOOFING')
  }
  
  return { suspicious: reasons.length > 0, reasons }
}
```

## CRITÉRIO DE APROVAÇÃO
100% dos eventos de segurança sendo logados
Alertas chegando para CRITICAL em < 30 segundos
Nenhuma senha ou token nos logs
Audit log imutável (sem policy de DELETE/UPDATE)
Detecção automática de padrões de ataque
