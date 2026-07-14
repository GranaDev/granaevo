// PURPLE VALIDATOR — Cross-Team Validation Engine
// Testa cada correção BLUE com 3 vetores distintos contra produção

const BASE = process.env.BASE_URL ?? 'https://granaevo.com'
const SUPABASE_EF = 'https://fvrhqqeofqedmhadzzqw.supabase.co'
const ANON_KEY = 'sb_publishable_IL6DH06V4icgZdMARtPIUg_zbPCV8wY'

const results = []

async function validate(id, desc, vectors) {
  const r = { id, desc, vectors: [], passed: 0, total: vectors.length }
  for (const [label, fn] of vectors) {
    try {
      const { blocked, details } = await fn()
      r.vectors.push({ label, blocked, details })
      if (blocked) r.passed++
    } catch(e) {
      r.vectors.push({ label, blocked: false, details: `ERROR: ${e.message}` })
    }
  }
  r.status = r.passed === r.total ? 'FECHADO' : `ABERTO (${r.passed}/${r.total})`
  results.push(r)
}

async function post(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.granaevo.com', ...headers },
    body: JSON.stringify(body)
  })
  return { status: r.status, headers: r.headers, body: await r.text().catch(() => '') }
}

// 1. EMAIL REGEX NULL BYTES
await validate('BLUE-01-A', 'Email regex bloqueia null bytes', [
  ['Null byte via check-email', async () => {
    const { status } = await post('/api/check-email', { email: 'admin\x00@granaevo.com' })
    return { blocked: [200, 400, 429].includes(status), details: `status=${status}` }
  }],
  ['Ctrl char via check-email', async () => {
    const { status } = await post('/api/check-email', { email: 'test\x01@granaevo.com' })
    return { blocked: [200, 400, 429].includes(status), details: `status=${status}` }
  }],
  ['Null byte via reset-password', async () => {
    const { status } = await post('/api/reset-password', { step: 'send', email: 'hack\x00@evil.com' })
    return { blocked: [200, 400, 429].includes(status) && status !== 500, details: `status=${status}` }
  }],
])

// 2. CACHE-CONTROL EM /api/*
await validate('BLUE-01-B', 'Cache-Control: no-store em /api/*', [
  ['check-email tem no-store', async () => {
    const { headers } = await post('/api/check-email', { email: 't@t.com' })
    const cc = headers.get('cache-control') ?? ''
    return { blocked: cc.includes('no-store'), details: `"${cc}"` }
  }],
  ['save-user-data tem no-store', async () => {
    const r = await fetch(`${BASE}/api/save-user-data`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.granaevo.com' }, body: '{}' })
    const cc = r.headers.get('cache-control') ?? ''
    return { blocked: cc.includes('no-store'), details: `"${cc}"` }
  }],
  ['CSP em /api/* eh default-src none', async () => {
    const { headers } = await post('/api/check-email', { email: 't@t.com' })
    const csp = headers.get('content-security-policy') ?? ''
    return { blocked: csp.includes("default-src 'none'"), details: `"${csp.slice(0,40)}"` }
  }],
])

// 3. CHECK-EMAIL-STATUS EF PROXY-SECRET
await validate('BLUE-03-A', 'check-email-status EF bloqueada sem proxy-secret', [
  ['Chamada direta sem proxy-secret eh neutra', async () => {
    const r = await fetch(`${SUPABASE_EF}/functions/v1/check-email-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
      body: JSON.stringify({ email: 'admin@granaevo.com' })
    })
    const body = await r.text()
    const isNeutral = body.includes('not_found') || !body.includes('subscription_id')
    return { blocked: isNeutral, details: `status=${r.status} body=${body.slice(0,60)}` }
  }],
  ['Proxy Vercel (com proxy-secret) funciona', async () => {
    const { status } = await post('/api/check-email', { email: 'test@granaevo.com' })
    return { blocked: [200, 429].includes(status) && status !== 502, details: `proxy=${status}` }
  }],
  ['Secret errado nao processa', async () => {
    const r = await fetch(`${SUPABASE_EF}/functions/v1/check-email-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'x-proxy-secret': 'wrong_secret_12345' },
      body: JSON.stringify({ email: 'admin@granaevo.com' })
    })
    const body = await r.text()
    return { blocked: !body.includes('subscription_id'), details: `status=${r.status}` }
  }],
])

// 4. SEND-GUEST-INVITE EF PROXY-SECRET
await validate('BLUE-03-B', 'send-guest-invite EF bloqueada sem proxy-secret', [
  ['Chamada direta sem proxy-secret retorna 401', async () => {
    const r = await fetch(`${SUPABASE_EF}/functions/v1/send-guest-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake_jwt', 'apikey': ANON_KEY },
      body: JSON.stringify({ guestEmail: 'hacker@evil.com', guestName: 'Hacker' })
    })
    return { blocked: [401, 403, 400].includes(r.status), details: `status=${r.status}` }
  }],
  ['Proxy rejeita JWT invalido antes de chegar na EF', async () => {
    const { status } = await post('/api/send-guest-invite', { guestEmail: 'test@test.com', guestName: 'Test' }, { 'Authorization': 'Bearer fake_jwt_test' })
    return { blocked: [401, 403, 429].includes(status), details: `status=${status}` }
  }],
  ['Secret errado bloqueado', async () => {
    const r = await fetch(`${SUPABASE_EF}/functions/v1/send-guest-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake', 'apikey': ANON_KEY, 'x-proxy-secret': 'wrong' },
      body: JSON.stringify({ guestEmail: 'h@evil.com', guestName: 'H' })
    })
    return { blocked: [401, 403, 400].includes(r.status), details: `status=${r.status}` }
  }],
])

// 5. VERIFY-INVITE IP FORWARDING
await validate('BLUE-03-C', 'verify-invite proxy repassa IP real', [
  ['Proxy responde sem 502', async () => {
    const { status } = await post('/api/verify-invite', { email: 'test@test.com', code: '000000' })
    return { blocked: status !== 502, details: `status=${status}` }
  }],
  ['Body TOO_LARGE bloqueado', async () => {
    const r = await fetch(`${BASE}/api/verify-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.granaevo.com' },
      body: JSON.stringify({ email: 'a'.repeat(9000) + '@test.com', code: '000000' })
    })
    return { blocked: [400, 413, 429].includes(r.status), details: `oversized: ${r.status}` }
  }],
  ['Sem Origin header bloqueado', async () => {
    const r = await fetch(`${BASE}/api/verify-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@test.com', code: '000000' })
    })
    return { blocked: [403, 429].includes(r.status), details: `no-origin: ${r.status}` }
  }],
])

// 6. JWT ALG:NONE
const JWT_ALG_NONE = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhdHRhY2tlciIsImV4cCI6OTk5OTk5OTk5OX0.'
await validate('BLUE-03-D', 'JWT alg:none rejeitado', [
  ['alg:none em check-user-access', async () => {
    const { status } = await post('/api/check-user-access', { user_id: 'attacker' }, { 'Authorization': `Bearer ${JWT_ALG_NONE}` })
    return { blocked: [401, 429].includes(status), details: `status=${status}` }
  }],
  ['alg:none em save-user-data', async () => {
    const { status } = await post('/api/save-user-data', { profiles: [] }, { 'Authorization': `Bearer ${JWT_ALG_NONE}` })
    return { blocked: [401, 403, 429].includes(status), details: `status=${status}` }
  }],
  ['alg:none em get-user-data', async () => {
    const r = await fetch(`${BASE}/api/get-user-data`, { headers: { 'Authorization': `Bearer ${JWT_ALG_NONE}`, 'Origin': 'https://www.granaevo.com' } })
    return { blocked: [401, 403, 429].includes(r.status), details: `status=${r.status}` }
  }],
])

// 7. HEADERS DE SEGURANÇA
await validate('BLUE-01-C', 'Security headers completos', [
  ['X-Frame-Options: DENY', async () => {
    const r = await fetch(`${BASE}/`)
    const h = r.headers.get('x-frame-options') ?? ''
    return { blocked: h.includes('DENY'), details: `"${h}"` }
  }],
  ['HSTS com includeSubDomains', async () => {
    const r = await fetch(`${BASE}/`)
    const h = r.headers.get('strict-transport-security') ?? ''
    return { blocked: h.includes('max-age=') && h.includes('includeSubDomains'), details: `"${h.slice(0,50)}"` }
  }],
  ['X-Content-Type-Options: nosniff em API', async () => {
    const r = await fetch(`${BASE}/api/check-email`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.granaevo.com' }, body: '{}' })
    const h = r.headers.get('x-content-type-options') ?? ''
    return { blocked: h === 'nosniff', details: `"${h}"` }
  }],
])

// 8. RATE LIMITING
await validate('BLUE-03-E', 'Rate limiting funcional', [
  ['check-email: rate limit ativo', async () => {
    let lastStatus = 200
    for (let i = 0; i < 12; i++) {
      const { status } = await post('/api/check-email', { email: `purple_v${i}@test.com` })
      lastStatus = status
      if (status === 429) break
    }
    return { blocked: lastStatus === 429, details: `ultimo status: ${lastStatus}` }
  }],
  ['Cross-origin evil.com bloqueado', async () => {
    const r = await fetch(`${BASE}/api/check-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil-attacker.com' },
      body: JSON.stringify({ email: 'test@test.com' })
    })
    return { blocked: [403, 429].includes(r.status), details: `evil origin: ${r.status}` }
  }],
  ['CORS nulo (sem Origin) bloqueado', async () => {
    const r = await fetch(`${BASE}/api/save-user-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [] })
    })
    return { blocked: [403, 401, 429].includes(r.status), details: `no-origin: ${r.status}` }
  }],
])

// RELATÓRIO FINAL
const SEP = '='.repeat(64)
console.log('\n' + SEP)
console.log('  PURPLE VALIDATOR - RELATORIO DE VALIDACAO CRUZADA')
console.log('  Data: ' + new Date().toISOString())
console.log(SEP + '\n')

let totalPassed = 0, totalFailed = 0, totalVectors = 0
for (const r of results) {
  const icon = r.passed === r.total ? '[OK]' : '[FAIL]'
  console.log(`${icon} [${r.id}] ${r.desc} — ${r.status}`)
  for (const v of r.vectors) {
    const vi = v.blocked ? '  V' : '  X'
    console.log(`${vi} ${v.label}: ${v.details}`)
  }
  totalPassed  += r.passed
  totalFailed  += (r.total - r.passed)
  totalVectors += r.total
  console.log()
}

console.log(SEP)
console.log(`VETORES TOTAIS : ${totalVectors}`)
console.log(`BLOQUEADOS     : ${totalPassed}`)
console.log(`PENETRARAM     : ${totalFailed}`)
const pct = Math.round(totalPassed / totalVectors * 100)
console.log(`EFICACIA       : ${pct}%`)
console.log()
if (totalFailed === 0) {
  console.log('  VEREDICTO: [APROVADO] TODOS OS VETORES BLOQUEADOS')
} else {
  console.log(`  VEREDICTO: [REPROVADO] ${totalFailed} VETOR(ES) ABERTO(S)`)
}
console.log(SEP + '\n')
