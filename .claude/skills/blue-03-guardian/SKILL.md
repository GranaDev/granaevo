# BLUE-03: ZERO TRUST GUARDIAN — Auth, JWT & Payment Shield

## IDENTIDADE
Guardião da autenticação, sessões e pagamentos.
Cada request é suspeito até prova em contrário.
Especialidade: JWT hardening, session management, Cakto webhook security.

## IMPLEMENTAÇÕES OBRIGATÓRIAS

### Rate Limiter Avançado — Inquebrável
```typescript
// lib/rate-limit.ts
import { createClient } from '@supabase/supabase-js'

interface RateLimitConfig {
  limit: number
  window: number  // segundos
  lockoutProgressive?: number[]  // [900, 3600, 86400] = 15min, 1h, 24h
}

export async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number; lockoutUntil?: Date }> {
  
  // Chave inclui IP + fingerprint — não apenas IP
  const now = Date.now()
  const windowStart = now - (config.window * 1000)
  
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  
  // Contar requests na janela atual
  const { count } = await supabase
    .from('rate_limit_log')
    .select('*', { count: 'exact', head: true })
    .eq('key', key)
    .gte('created_at', new Date(windowStart).toISOString())
  
  if ((count ?? 0) >= config.limit) {
    // Calcular lockout progressivo
    const lockoutLevel = Math.min(
      Math.floor((count ?? 0) / config.limit) - 1,
      (config.lockoutProgressive?.length ?? 1) - 1
    )
    const lockoutSeconds = config.lockoutProgressive?.[lockoutLevel] ?? config.window
    
    return {
      allowed: false,
      remaining: 0,
      lockoutUntil: new Date(now + lockoutSeconds * 1000)
    }
  }
  
  // Registrar request atual
  await supabase.from('rate_limit_log').insert({
    key,
    created_at: new Date().toISOString()
  })
  
  return { allowed: true, remaining: config.limit - (count ?? 0) - 1 }
}

export function getRateLimitKey(req: Request): string {
  // NUNCA confiar em X-Forwarded-For sem validação
  const cfIP = req.headers.get('cf-connecting-ip')  // Cloudflare (confiável)
  const ip = cfIP ?? 'unknown'
  
  // Fingerprint baseado em múltiplos fatores
  const ua = req.headers.get('user-agent') ?? ''
  const accept = req.headers.get('accept-language') ?? ''
  const encoding = req.headers.get('accept-encoding') ?? ''
  
  const fingerprint = btoa(`${ua}:${accept}:${encoding}`).slice(0, 16)
  
  return `${ip}:${fingerprint}`
}
```

### JWT Validator Absoluto
```typescript
// lib/jwt-validator.ts
import { jwtVerify, JWTPayload } from 'jose'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

interface ValidatedPayload extends JWTPayload {
  sub: string
  role: string
  iat: number
  exp: number
}

export async function validateJWT(token: string | null): Promise<{
  valid: boolean
  payload?: ValidatedPayload
  reason?: string
}> {
  if (!token) return { valid: false, reason: 'NO_TOKEN' }
  
  // [CAMADA 1] Formato: deve ter exatamente 3 partes
  const parts = token.split('.')
  if (parts.length !== 3) return { valid: false, reason: 'INVALID_FORMAT' }
  
  // [CAMADA 2] Header deve ter alg: HS256 EXATAMENTE
  try {
    const header = JSON.parse(atob(parts[0]))
    if (header.alg !== 'HS256') {
      return { valid: false, reason: 'INVALID_ALGORITHM' }
    }
    // Rejeitar kid injection
    if (header.kid !== undefined) {
      return { valid: false, reason: 'KID_NOT_ALLOWED' }
    }
    // Rejeitar JWK injection
    if (header.jwk !== undefined || header.jku !== undefined) {
      return { valid: false, reason: 'JWK_NOT_ALLOWED' }
    }
  } catch {
    return { valid: false, reason: 'INVALID_HEADER' }
  }
  
  // [CAMADA 3] Verificar assinatura e claims com jose
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      clockTolerance: 0  // Zero tolerância para clock skew
    })
    
    // [CAMADA 4] sub obrigatório e UUID válido
    if (!payload.sub || !/^[0-9a-f-]{36}$/.test(payload.sub)) {
      return { valid: false, reason: 'INVALID_SUB' }
    }
    
    // [CAMADA 5] exp obrigatório e não expirado
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false, reason: 'EXPIRED' }
    }
    
    // [CAMADA 6] iat não pode ser no futuro
    if (!payload.iat || payload.iat > Math.floor(Date.now() / 1000) + 60) {
      return { valid: false, reason: 'FUTURE_IAT' }
    }
    
    return { valid: true, payload: payload as ValidatedPayload }
    
  } catch (err) {
    return { valid: false, reason: 'VERIFICATION_FAILED' }
  }
}
```

### Webhook Cakto — Defesa Absoluta
```typescript
// lib/cakto-webhook.ts
import { timingSafeEqual } from 'crypto'

const CAKTO_SECRET = process.env.CAKTO_WEBHOOK_SECRET!

export async function verifyCaktoWebhook(
  rawBody: string,
  signature: string | null
): Promise<{ valid: boolean; reason?: string }> {
  
  // [CAMADA 1] Assinatura presente
  if (!signature) return { valid: false, reason: 'NO_SIGNATURE' }
  
  // [CAMADA 2] Calcular HMAC esperado
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(CAKTO_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  )
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const expectedHex = Array.from(new Uint8Array(expected))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  
  // [CAMADA 3] Comparação constant-time — impede timing attack
  const sigBytes = encoder.encode(signature.toLowerCase())
  const expBytes = encoder.encode(expectedHex.toLowerCase())
  
  if (sigBytes.length !== expBytes.length) return { valid: false, reason: 'INVALID_SIGNATURE' }
  
  // Node.js timingSafeEqual para garantia máxima
  const isValid = timingSafeEqual(
    Buffer.from(signature.toLowerCase()),
    Buffer.from(expectedHex.toLowerCase())
  )
  
  if (!isValid) return { valid: false, reason: 'INVALID_SIGNATURE' }
  
  return { valid: true }
}

// Schema de validação do payload
export function validateWebhookPayload(payload: unknown): {
  valid: boolean
  data?: CaktoWebhookPayload
  reason?: string
} {
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, reason: 'NOT_OBJECT' }
  }
  
  const p = payload as Record<string, unknown>
  
  // Campos obrigatórios com tipos estritos
  if (typeof p.payment_id !== 'string' || p.payment_id.length < 10) {
    return { valid: false, reason: 'INVALID_PAYMENT_ID' }
  }
  if (!['approved', 'pending', 'failed', 'refunded', 'chargeback'].includes(p.status as string)) {
    return { valid: false, reason: 'INVALID_STATUS' }
  }
  if (typeof p.amount !== 'number' || p.amount <= 0 || p.amount > 10000) {
    return { valid: false, reason: 'INVALID_AMOUNT' }
  }
  if (typeof p.customer_email !== 'string' || !p.customer_email.includes('@')) {
    return { valid: false, reason: 'INVALID_EMAIL' }
  }
  
  return { valid: true, data: p as CaktoWebhookPayload }
}
```

## CRITÉRIO DE APROVAÇÃO
JWT com alg:none retornando erro em < 1ms
Cakto webhook com assinatura inválida retornando 200 silencioso (não 401)
Rate limit bloqueando sem bypass via header
Lockout progressivo funcionando (15min → 1h → 24h)
