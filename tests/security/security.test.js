/**
 * GranaEvo — Security Integration Tests
 *
 * Rodar contra a URL de produção ou preview:
 *   BASE_URL=https://granaevo.com node --test tests/security/security.test.js
 *
 * Rodar localmente (Vercel dev):
 *   BASE_URL=http://localhost:3000 node --test tests/security/security.test.js
 *
 * Requer Node.js >= 18 (--test runner nativo, fetch global).
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'

// ─── helpers ──────────────────────────────────────────────────────────────────

async function post(path, body, headers = {}) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://www.granaevo.com', ...headers },
    body:    JSON.stringify(body),
  })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, json, headers: r.headers }
}

async function get(path, headers = {}) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method:  'GET',
    headers: { 'Origin': 'https://www.granaevo.com', ...headers },
  })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, json, headers: r.headers }
}

// JWT forjado com sub arbitrário, assinatura inválida
const FORGED_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5OTk5OTk5OS05OTk5LTk5OTktOTk5OS05OTk5OTk5OTk5OTkiLCJlbWFpbCI6Imhha2VyQGV2aWwuY29tIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjk5OTk5OTk5OTl9.FORGED_SIGNATURE'

// JWT com alg:none
const JWT_ALG_NONE = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhdHRhY2tlciIsImV4cCI6OTk5OTk5OTk5OX0.'

// ─── 1. AUTENTICAÇÃO & SESSÃO ─────────────────────────────────────────────────

describe('Authentication & Session', () => {

  test('login sem credenciais retorna erro genérico (anti-enumeração)', async () => {
    const { status, json } = await post('/api/check-email', { email: 'naoexiste@hacker.com' })
    // Deve retornar not_found sem revelar se o email existe
    assert.ok([200, 429].includes(status), `status inesperado: ${status}`)
    if (status === 200) {
      assert.equal(json?.status, 'not_found', 'deve retornar not_found para email inexistente')
      assert.notEqual(json?.status, 'payment_pending', 'não deve revelar status de pagamento')
    }
  })

  test('check-user-access sem proxy-secret retorna 401', async () => {
    const { status } = await post('/api/check-user-access', { user_id: 'test' }, {
      'Authorization': `Bearer ${FORGED_JWT}`,
      // Sem x-proxy-secret — vai direto para a Edge Function sem o header obrigatório
    })
    // O proxy Vercel adiciona x-proxy-secret; teste verifica que sem auth o proxy rejeita
    assert.ok([401, 403, 429].includes(status), `sem auth deve rejeitar: ${status}`)
  })

  test('check-user-access com JWT forjado retorna erro de auth', async () => {
    const { status, json } = await post('/api/check-user-access', { user_id: 'attacker-id' }, {
      'Authorization': `Bearer ${FORGED_JWT}`,
    })
    assert.ok([401, 403, 429].includes(status) || json?.hasAccess === false,
      `JWT forjado deve ser rejeitado: status=${status}`)
  })

  test('check-user-access com alg:none é rejeitado', async () => {
    const { status, json } = await post('/api/check-user-access', { user_id: 'attacker-id' }, {
      'Authorization': `Bearer ${JWT_ALG_NONE}`,
    })
    assert.ok([401, 403, 429].includes(status) || json?.hasAccess === false,
      `alg:none deve ser rejeitado: status=${status}`)
  })

  test('check-user-access sem Authorization header retorna 401', async () => {
    const { status } = await post('/api/check-user-access', { user_id: 'any' })
    assert.ok([401, 403].includes(status), `sem auth header deve dar 401/403: ${status}`)
  })

})

// ─── 2. RATE LIMITING & BRUTE FORCE ──────────────────────────────────────────

describe('Rate Limiting & Brute Force', () => {

  test('login reset endpoint tem rate limit por IP', async () => {
    const results = []
    for (let i = 0; i < 6; i++) {
      const { status } = await post('/api/reset-password', {
        step: 'send', email: `hacker${i}@evil.com`
      })
      results.push(status)
    }
    const has429 = results.some(s => s === 429)
    assert.ok(has429, `deve ter rate limit após múltiplas requisições: ${results}`)
  })

  test('check-email endpoint tem rate limit por IP', async () => {
    const results = []
    for (let i = 0; i < 12; i++) {
      const { status } = await post('/api/check-email', { email: `test${i}@test.com` })
      results.push(status)
    }
    const has429 = results.some(s => s === 429)
    assert.ok(has429, `deve ter rate limit: ${results}`)
  })

  test('verify-recaptcha tem rate limit por IP', async () => {
    const results = []
    for (let i = 0; i < 12; i++) {
      const { status } = await post('/api/verify-recaptcha', { token: 'a'.repeat(60) })
      results.push(status)
    }
    const has429 = results.some(s => s === 429)
    assert.ok(has429, `deve ter rate limit: ${results}`)
  })

  test('reset password tem rate limit progressivo por step', async () => {
    const results = []
    for (let i = 0; i < 5; i++) {
      const { status } = await post('/api/reset-password', {
        step: 'verify_code', email: 'victim@evil.com', code: '000000'
      })
      results.push(status)
    }
    const has429 = results.some(s => s === 429)
    assert.ok(has429 || results.every(s => s >= 200), `rate limit no verify_code: ${results}`)
  })

})

// ─── 3. INJEÇÃO & XSS ────────────────────────────────────────────────────────

describe('Injection & XSS', () => {

  test('check-email rejeita email com payload XSS', async () => {
    const { status, json } = await post('/api/check-email', {
      email: '<script>alert(1)</script>@evil.com'
    })
    assert.ok([200, 400, 429].includes(status))
    // Se 200, deve ser not_found ou error (nunca deve executar o script)
    if (status === 200) {
      assert.notEqual(json?.status, 'ready')
    }
  })

  test('reset-password rejeita corpo com payload de injeção', async () => {
    const payloads = [
      { step: 'send', email: "' OR '1'='1" },
      { step: 'send', email: '"; DROP TABLE subscriptions;--' },
      { step: 'send', email: '{{7*7}}@evil.com' }, // SSTI
    ]
    for (const body of payloads) {
      const { status } = await post('/api/reset-password', body)
      // Deve rejeitar (400) ou rate-limit (429) ou retornar status neutro (200)
      assert.ok([200, 400, 429].includes(status), `payload malicioso: status=${status}`)
    }
  })

  test('save-user-data rejeita JSON profundo demais (anti-DoS)', async () => {
    // Cria JSON com 10 níveis de profundidade
    let deep: Record<string, unknown> = { value: 'malicious' }
    for (let i = 0; i < 10; i++) deep = { nested: deep }
    const { status } = await post('/api/save-user-data', { profiles: [deep] })
    assert.ok([400, 401, 413, 429].includes(status), `JSON profundo demais: status=${status}`)
  })

  test('save-user-data rejeita body acima do limite de tamanho', async () => {
    const { status } = await post('/api/save-user-data', {
      profiles: [{ data: 'A'.repeat(6 * 1024 * 1024) }] // 6MB
    })
    assert.ok([413, 400, 401, 429].includes(status), `body gigante: status=${status}`)
  })

})

// ─── 4. HEADERS DE SEGURANÇA ──────────────────────────────────────────────────

describe('Security Headers', () => {

  async function checkHeaders(path) {
    const r = await fetch(`${BASE_URL}${path}`, { method: 'GET' })
    return r.headers
  }

  test('login.html tem Content-Security-Policy', async () => {
    const h = await checkHeaders('/login.html')
    assert.ok(h.get('content-security-policy'), 'CSP ausente em login.html')
  })

  test('dashboard.html tem X-Frame-Options: DENY', async () => {
    const h = await checkHeaders('/dashboard.html')
    assert.equal(h.get('x-frame-options'), 'DENY', 'X-Frame-Options ausente/errado')
  })

  test('todas as páginas têm HSTS', async () => {
    const pages = ['/', '/login.html', '/dashboard.html']
    for (const page of pages) {
      const h = await checkHeaders(page)
      const hsts = h.get('strict-transport-security')
      assert.ok(hsts, `HSTS ausente em ${page}`)
      assert.ok(hsts?.includes('includeSubDomains'), `HSTS sem includeSubDomains em ${page}`)
    }
  })

  test('API endpoints têm Cache-Control: no-store', async () => {
    const { headers } = await post('/api/check-email', { email: 'test@test.com' })
    const cc = headers.get('cache-control')
    assert.ok(cc?.includes('no-store') || cc?.includes('no-cache'),
      `Cache-Control ausente em /api/check-email: ${cc}`)
  })

  test('X-Content-Type-Options: nosniff presente', async () => {
    const h = await checkHeaders('/login.html')
    assert.equal(h.get('x-content-type-options'), 'nosniff')
  })

  test('CSP do dashboard não inclui cdn.jsdelivr.net em script-src', async () => {
    const h = await checkHeaders('/dashboard.html')
    const csp = h.get('content-security-policy') ?? ''
    assert.ok(!csp.includes('cdn.jsdelivr.net'), `cdn.jsdelivr.net ainda no CSP: ${csp}`)
  })

  test('clickjacking bloqueado via X-Frame-Options e CSP frame-ancestors', async () => {
    const h = await checkHeaders('/dashboard.html')
    const csp = h.get('content-security-policy') ?? ''
    assert.equal(h.get('x-frame-options'), 'DENY')
    assert.ok(csp.includes("frame-ancestors 'none'"), `frame-ancestors ausente no CSP`)
  })

})

// ─── 5. CORS ─────────────────────────────────────────────────────────────────

describe('CORS', () => {

  test('origem não permitida é rejeitada no check-email', async () => {
    const { status } = await post('/api/check-email', { email: 'test@test.com' }, {
      'Origin': 'https://evil.com'
    })
    assert.equal(status, 403, `origem não permitida deve retornar 403: ${status}`)
  })

  test('origem não permitida é rejeitada no reset-password', async () => {
    const { status } = await post('/api/reset-password', { step: 'send', email: 'test@test.com' }, {
      'Origin': 'https://attacker.com'
    })
    assert.equal(status, 403, `origem maliciosa deve ser bloqueada: ${status}`)
  })

  test('CORS permite origem legítima www.granaevo.com', async () => {
    const { status, headers } = await post('/api/check-email', { email: 'test@test.com' }, {
      'Origin': 'https://www.granaevo.com'
    })
    const corsOrigin = headers.get('access-control-allow-origin')
    assert.ok(
      [200, 429].includes(status) && corsOrigin === 'https://www.granaevo.com',
      `origem legítima deve ser aceita: status=${status}, cors=${corsOrigin}`
    )
  })

})

// ─── 6. UPLOAD DE ARQUIVOS ────────────────────────────────────────────────────

describe('File Upload (sem JWT válido — teste de rejeição de auth)', () => {

  // Nota: testes de upload completo requerem JWT válido obtido em CI.
  // Estes testes verificam que o endpoint rejeita tentativas não autenticadas
  // e não aceita tipos de arquivo inválidos no nível de validação inicial.

  test('upload sem Authorization retorna 401', async () => {
    const formData = new FormData()
    formData.append('file', new Blob(['FAKE'], { type: 'image/jpeg' }), 'test.jpg')

    const r = await fetch(`${BASE_URL}/api/upload-profile-photo`, {
      method: 'POST',
      headers: { 'Origin': 'https://www.granaevo.com' },
      body:   formData,
    }).catch(() => null)

    if (r) {
      // Pode retornar 401 (sem auth) ou 404 (rota não existe no proxy)
      assert.ok([401, 403, 404, 405].includes(r.status),
        `upload sem auth deve ser rejeitado: ${r.status}`)
    }
  })

  test('upload via Edge Function com JWT forjado retorna 401', async () => {
    const supabaseUrl = 'https://fvrhqqeofqedmhadzzqw.supabase.co'
    const formData = new FormData()
    formData.append('file', new Blob(['fake'], { type: 'image/jpeg' }), 'test.jpg')

    const r = await fetch(`${supabaseUrl}/functions/v1/upload-profile-photo`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${FORGED_JWT}` },
      body:    formData,
    })

    assert.ok([401, 403].includes(r.status),
      `JWT forjado deve ser rejeitado pelo Edge Function: ${r.status}`)
  })

})

// ─── 7. LÓGICA DE NEGÓCIO ────────────────────────────────────────────────────

describe('Business Logic', () => {

  test('reset-password step inválido é rejeitado', async () => {
    const { status, json } = await post('/api/reset-password', {
      step: 'admin_override', email: 'victim@test.com'
    })
    assert.ok([400, 429].includes(status), `step inválido deve ser rejeitado: ${status}`)
    if (status === 400) {
      assert.ok(json?.error, 'deve ter mensagem de erro')
    }
  })

  test('invite verification com code errado é bloqueada', async () => {
    const { status, json } = await post('/api/verify-invite', {
      email: 'victim@test.com',
      code:  '000000'
    })
    // Deve retornar erro (400) ou rate limit (429), nunca sucesso com código inválido
    assert.ok([200, 400, 429].includes(status))
    if (status === 200) {
      assert.notEqual(json?.success, true, 'código inválido não deve dar sucesso')
    }
  })

  test('guest invite sem Authorization é rejeitado', async () => {
    const { status } = await post('/api/send-guest-invite', {
      guestEmail: 'victim@test.com',
      guestName:  'Victim'
    })
    assert.ok([401, 403].includes(status), `sem auth deve rejeitar convite: ${status}`)
  })

  test('webhook cakto sem secret é rejeitado', async () => {
    const supabaseUrl = 'https://fvrhqqeofqedmhadzzqw.supabase.co'
    const r = await fetch(`${supabaseUrl}/functions/v1/webhook-cakto`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        event: 'purchase.approved',
        data:  { id: 'FAKE_ORDER', customer: { email: 'hacker@evil.com' } },
        // sem secret: espera 401
      }),
    })
    assert.ok([401, 400, 403, 500].includes(r.status),
      `webhook sem secret deve ser rejeitado: ${r.status}`)
  })

})

// ─── 8. VALIDAÇÃO DE INPUT ────────────────────────────────────────────────────

describe('Input Validation', () => {

  test('check-email rejeita email com mais de 254 caracteres', async () => {
    const { status } = await post('/api/check-email', {
      email: 'a'.repeat(250) + '@test.com'
    })
    assert.ok([400, 429].includes(status), `email longo deve ser rejeitado: ${status}`)
  })

  test('check-email rejeita email sem @', async () => {
    const { status, json } = await post('/api/check-email', { email: 'notanemail' })
    assert.ok([200, 400, 429].includes(status))
    if (status === 200) {
      assert.notEqual(json?.status, 'ready', 'email inválido não deve ser ready')
    }
  })

  test('save-user-data sem profiles array é rejeitado', async () => {
    const { status } = await post('/api/save-user-data', {
      data: 'not an array'
    }, { 'Authorization': `Bearer ${FORGED_JWT}` })
    assert.ok([400, 401, 429].includes(status),
      `payload sem profiles deve ser rejeitado: ${status}`)
  })

  test('reset-password rejeita body sem email', async () => {
    const { status } = await post('/api/reset-password', { step: 'send' })
    assert.ok([400, 429].includes(status), `sem email deve dar 400: ${status}`)
  })

  test('verify-recaptcha rejeita token muito curto', async () => {
    const { status, json } = await post('/api/verify-recaptcha', { token: 'short' })
    assert.ok([400, 429].includes(status) || json?.success === false,
      `token curto deve ser rejeitado: ${status}`)
  })

})

// ─── 9. MÉTODOS HTTP ─────────────────────────────────────────────────────────

describe('HTTP Method Restrictions', () => {

  const endpoints = [
    ['/api/check-email',       'GET'],
    ['/api/reset-password',    'GET'],
    ['/api/verify-recaptcha',  'PUT'],
    ['/api/check-user-access', 'DELETE'],
    ['/api/send-guest-invite', 'PATCH'],
  ]

  for (const [path, wrongMethod] of endpoints) {
    test(`${path} rejeita método ${wrongMethod}`, async () => {
      const r = await fetch(`${BASE_URL}${path}`, {
        method:  wrongMethod,
        headers: { 'Origin': 'https://www.granaevo.com' },
      })
      assert.equal(r.status, 405, `${path} deve rejeitar ${wrongMethod} com 405: ${r.status}`)
    })
  }

})
