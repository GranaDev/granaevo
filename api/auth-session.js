// /api/auth-session.js — BFF de sessão (modelo híbrido httpOnly)
//
// Objetivo de segurança:
//   O REFRESH TOKEN (credencial longeva e perigosa) nunca chega ao JavaScript.
//   Vive exclusivamente num cookie HttpOnly; Secure; SameSite=Strict, com Path
//   restrito a este endpoint — inalcançável por XSS. O ACCESS TOKEN (curto, ~1h)
//   é devolvido no corpo da resposta para o client guardar APENAS em memória e
//   usar via o callback `accessToken` do supabase-js (PostgREST/Realtime/Storage).
//
// Ações (POST, campo `action` no body):
//   login   { email, password, remember? } → password grant; seta cookie; retorna access
//   refresh {}                              → refresh grant via cookie; rotaciona cookie
//   logout  {}                              → revoga sessão; limpa cookie
//
// Substitui supabase.auth.signInWithPassword / autoRefreshToken / signOut no client.
//
// ─── MFA / TOTP (Passo 31 · B-1, 2026-07-27) ──────────────────────────────────
// Verificação em duas etapas OPCIONAL. Nasce DESLIGADA; o usuário liga em
// Configurações → Segurança da conta. Quem não ativa passa por um caminho de
// login byte-a-byte idêntico ao anterior — essa é a invariante desta feature.
//
//   mfa-status        {}                      → lista fatores do usuário logado
//   mfa-enroll        {}                      → cria fator TOTP pendente; devolve QR + segredo
//   mfa-activate      { factorId, code }      → confirma o fator; devolve códigos de recuperação
//   mfa-disable       { password }            → step-up por senha; remove fatores e códigos
//   mfa-login-verify  { code, remember? }     → 2º passo do login (usa o cookie ge_mfa)
//   mfa-login-recovery{ recoveryCode, ... }   → destrava com código de recuperação e DESLIGA o MFA
//
// POR QUE TUDO PASSA POR AQUI (e não pelo supabase.auth.mfa.* do cliente):
//   o `verify` do GoTrue devolve um par access+refresh NOVO (elevado a aal2). Se o
//   cliente chamasse direto, o REFRESH TOKEN cairia no JavaScript — exatamente o que
//   este arquivo inteiro existe para impedir. O BFF intercepta, guarda o refresh no
//   cookie HttpOnly e devolve ao cliente só o access token.
//
// POR QUE NÃO VIRA UMA ROTA NOVA EM api/:
//   o plano Hobby da Vercel aceita 12 Serverless Functions e o repo já usa as 12.
//   A 13ª quebra o build inteiro e congela a produção em silêncio (incidente de
//   2026-07-25). Recurso novo que precise de servidor entra como `action`.
//
// O COOKIE ge_mfa (sessão em trânsito):
//   entre "senha correta" e "código correto" existe uma sessão aal1 real e válida.
//   Ela NÃO pode ir para o cliente — senão bastaria a senha para ler os dados via
//   PostgREST, e o segundo fator viraria teatro. Fica num cookie HttpOnly de 5
//   minutos, com Path e SameSite iguais aos do ge_rt, e é destruída no primeiro
//   dos três eventos: sucesso, 5 erros, ou expiração.

import { checkRate, checkRateWindow, isIPBlocked,
         bumpCounter, readCounter, isKeyBlocked, blockKey, clearKeys,
         redisDegradado } from './_rate-limit.js'
import { logger } from './_logger.js'
import { turnstileOk } from './_turnstile.js'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const PATH         = '/api/auth-session'
const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const ANON_KEY     = process.env.SUPABASE_ANON_KEY ?? ''

const COOKIE_NAME      = 'ge_rt'
const COOKIE_PATH      = '/api/auth-session'
const REMEMBER_MAX_AGE = 60 * 60 * 24 * 30   // 30 dias quando "lembrar de mim"

// ── MFA: cookie da sessão em trânsito (entre a senha e o código) ──────────────
const MFA_COOKIE_NAME  = 'ge_mfa'
const MFA_TTL_SECS     = 300   // 5 min: tempo de pegar o celular, não mais que isso
const MFA_MAX_ATTEMPTS = 5     // erros de código antes de exigir login do zero

const ALLOWED_ORIGINS = new Set([
  'https://www.granaevo.com',
  'https://assistente.granaevo.com',
  'https://granaevo.com',
  'https://granaevo.vercel.app',
  ...(process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []),
])

// Rate limits por IP (por minuto), exceto login (janela maior anti brute-force)
const RL_LOGIN_MAX     = 8
const RL_LOGIN_WIN      = 600   // 8 logins / 10 min por IP
const RL_REFRESH_MAX   = 30     // refresh é frequente (a cada ~1h por aba, mais picos)
const RL_LOGOUT_MAX    = 15
const MAX_BODY_BYTES   = 4096
const EMAIL_RE         = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

// ── S-2: lockout de login POR CONTA ──────────────────────────────────────────
// O limite por IP (RL_LOGIN_MAX) não cobre força bruta distribuída: 100 IPs dão
// 4.800 tentativas/hora contra UMA conta. E o reCAPTCHA do login é acionado por
// contador em localStorage — quem chama este endpoint direto nunca o vê. Este é
// o único freio que acompanha a CONTA, não a origem.
//
// Escalonamento: quanto mais insiste, mais cara fica a próxima tentativa.
const LOCK_DEGRAUS = [
  { falhas: 20, ttl: 86_400 },   // 24 h
  { falhas: 10, ttl:  3_600 },   //  1 h
  { falhas:  5, ttl:    900 },   // 15 min
]
const LOCK_JANELA = 86_400       // o contador de falhas expira em 24 h
//
// COMPROMISSO ACEITO CONSCIENTEMENTE: qualquer lockout por conta permite que um
// terceiro trave o login de uma vítima errando a senha de propósito. Vale a pena
// porque (a) é progressivo e começa em 15 min, não é permanente; (b) a
// recuperação de senha continua funcionando, então há saída; e (c) a alternativa
// é deixar a força bruta distribuída livre, que é pior.
//
// A chave é o SHA-256 do e-mail, nunca o e-mail em claro: não há por que deixar
// PII espalhada nas chaves do Redis (e resolve encoding de acento e '+' de uma vez).
const chaveConta = (email) =>
  createHash('sha256').update(email).digest('hex').slice(0, 32)

// ── ACHADO-02: backstop durável do lockout, no banco ─────────────────────────
//
// O lockout acima é do Redis, e o Redis é volátil. Quando ele cai, `isKeyBlocked`
// e `readCounter` respondem a partir de um Map POR INSTÂNCIA serverless — o
// lockout por conta e o gate de captcha (que lê o MESMO contador) param de valer
// juntos, com uma única indisponibilidade.
//
// A tabela `login_lockouts` existia desde sempre, com índice, RLS e cron. O que
// faltava era um chamador: em produção ela tinha 0 linhas e
// `max(last_attempt_at) = NULL`. Um controle que nunca registrou nada.
//
// COMO AS DUAS CAMADAS CONVIVEM (e por que a ordem é esta):
//   • ESCRITA — sempre nas duas. Registrar a falha no banco só quando o Redis
//     já caiu seria tarde demais: o backstop precisa CHEGAR na queda com o
//     histórico pronto, não começar a contar do zero no pior momento.
//   • LEITURA — o Redis decide. O banco só é consultado quando `redisDegradado()`
//     diz que a resposta do Redis não vale como decisão de segurança. Assim o
//     caminho feliz não paga nenhum salto de rede extra.
//
// Nunca derruba o login: qualquer erro aqui é engolido e a decisão do Redis
// prevalece. O backstop é rede de segurança, não um novo ponto único de falha.
const PROXY_SECRET = process.env.PROXY_SECRET ?? ''

async function lockoutDuravel(acao, id, { esperar = true } = {}) {
  if (!SUPABASE_URL || !PROXY_SECRET || !ANON_KEY) return null
  const p = fetch(`${SUPABASE_URL}/functions/v1/login-lockout`, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'apikey':         ANON_KEY,
      'x-proxy-secret': PROXY_SECRET,
    },
    body:   JSON.stringify({ acao, id }),
    signal: AbortSignal.timeout(2_500),
  })
  if (!esperar) { p.catch(() => {}); return null }
  try {
    const r = await p
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

// ── B-2: captcha EXIGIDO PELO SERVIDOR ───────────────────────────────────────
// O captcha desta aplicação sempre existiu, mas quem decidia mostrá-lo era um
// contador em `localStorage`. Quem chama este endpoint direto — que é
// exatamente o atacante que importa — nunca tinha navegador, nunca tinha
// localStorage, e portanto nunca via desafio nenhum.
//
// Agora quem decide é o servidor, usando o MESMO contador de falhas por conta
// que o lockout (S-2) já mantém no Redis. Não há como um cliente pular esta
// checagem: ela roda antes do password grant e não depende de nada que venha
// do navegador além do próprio token.
//
// 3 e não 5: fica ABAIXO do primeiro degrau de lockout, então o usuário
// legítimo que errou a senha resolve um desafio (quase sempre invisível) antes
// de bater no bloqueio de 15 minutos. O captcha é a rampa; o lockout é a parede.
const CAPTCHA_APOS_FALHAS = 3


// MFA — o código TOTP tem 6 dígitos e vale ~60s (janela de 30s + 1 de tolerância).
// Sem teto por IP, uma botnet tenta ~1M de combinações dentro da validade. Os 5
// erros por cookie (MFA_MAX_ATTEMPTS) travam UMA sessão; este teto trava o IP.
const RL_MFA_VERIFY_MAX = 10
const RL_MFA_VERIFY_WIN = 600   // 10 tentativas / 10 min por IP
const RL_MFA_ADMIN_MAX  = 12    // enroll/activate/disable/status: uso humano normal
const RL_MFA_ADMIN_WIN  = 600
const TOTP_CODE_RE      = /^\d{6}$/
// Formato dos códigos de recuperação: 10 grupos de "XXXX-XXXX" em base32 sem
// caracteres ambíguos. Aceita com ou sem hífen, maiúscula ou minúscula.
const RECOVERY_CODE_RE  = /^[A-Z2-7]{4}-?[A-Z2-7]{4}$/

// ── Cookie helpers ────────────────────────────────────────────────────────────
function buildRefreshCookie(value, { maxAge, clear, domain } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Path=${COOKIE_PATH}`,
  ]
  // Domain=granaevo.com faz o cookie ser enviado a TODOS os subdomínios (www E
  // assistente) — sem isto ele fica host-only e o chat (assistente.granaevo.com)
  // não recebe a sessão, forçando um 2º login. Só em produção; em localhost/
  // preview o domain fica ausente (host-only, como antes).
  if (domain) parts.push(`Domain=${domain}`)
  if (clear)                         parts.push('Max-Age=0')
  else if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`)
  // sem Max-Age = cookie de sessão (some ao fechar o browser) — usado quando !remember
  return parts.join('; ')
}

// Domínio do cookie derivado do Host da requisição. Em *.granaevo.com devolve
// 'granaevo.com' (compartilha entre subdomínios); em localhost/*.vercel.app
// devolve undefined (host-only — Domain=granaevo.com seria rejeitado ali).
function cookieDomainDe(req) {
  const host = String(req.headers?.host ?? '').toLowerCase().split(':')[0]
  return (host === 'granaevo.com' || host.endsWith('.granaevo.com')) ? 'granaevo.com' : undefined
}

// Emite o(s) Set-Cookie de refresh. Quando estamos em produção (domain definido),
// também LIMPA o cookie host-only legado — senão o browser ficaria com dois
// `ge_rt` (o antigo host-only + o novo com Domain), e leria o antigo (já
// rotacionado/inválido) no próximo refresh, deslogando o usuário uma vez.
function setRefreshCookie(res, value, { maxAge, clear, domain } = {}) {
  const cookies = [buildRefreshCookie(value, { maxAge, clear, domain })]
  if (domain) cookies.push(buildRefreshCookie('', { clear: true })) // limpa o host-only legado
  res.setHeader('Set-Cookie', cookies)
}

function readRefreshCookie(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      const v = part.slice(idx + 1).trim()
      return v || null
    }
  }
  return null
}

// ── Cookie ge_mfa: sessão aal1 em trânsito, esperando o 2º fator ───────────────
//
// Guarda o par access+refresh da sessão aal1 que o GoTrue já emitiu (a senha
// estava certa) mas que o usuário ainda não completou. Fica HttpOnly com o mesmo
// Path/SameSite/Domain do ge_rt — quem não pode ler o refresh de 30 dias também
// não lê este, de 5 minutos.
//
// O refresh aal1 precisa estar aqui (e não só o access) por causa do caminho de
// recuperação: quando o usuário destrava com um código de recuperação, os fatores
// são removidos e a sessão aal1 passa a ser a sessão final — sem o refresh
// guardado, ele entraria e seria deslogado uma hora depois sem poder renovar.
//
// ── [SEC-002] POR QUE ESTE COOKIE É ASSINADO E O CONTADOR MORA FORA DELE ───────
// "HttpOnly" só impede o JAVASCRIPT da página de ler o cookie. Não impede nada
// de quem fala HTTP direto — e é exatamente esse o atacante aqui: alguém que já
// tem a SENHA da vítima e está preso no 2º fator. Ele vê o Set-Cookie na resposta
// do login, decodifica o base64url e reescreve o que quiser.
//
// Duas travas do MFA moravam DENTRO desse JSON e eram, portanto, dele:
//   `tries` — bastava reenviar o cookie original a cada palpite para o contador
//             de 5 tentativas nunca sair de zero.
//   `exp`   — bastava aumentar o número para a janela de 5 minutos virar eterna
//             (o Max-Age do browser não vincula quem monta o request na mão).
//
// A correção tem duas metades, e as duas são necessárias:
//   1. HMAC-SHA256 sobre o payload → `exp`, `fid` e `remember` viram imutáveis.
//      Sem a chave, forjar um payload novo é inviável.
//   2. `tries` SAI do cookie e vira contador de servidor, chaveado por um `sid`
//      aleatório que nasce dentro do payload assinado. Só o HMAC não bastaria:
//      um cookie legitimamente assinado com tries=0 pode ser REPETIDO à vontade.
//      Com o contador no servidor, repetir o mesmo cookie é repetir o mesmo sid
//      — e o contador continua de onde parou.
//
// A chave é derivada do PROXY_SECRET com um rótulo próprio, em vez de uma env
// var nova: separa o uso criptográfico (nada aqui vaza o PROXY_SECRET, que só
// entra num SHA-256) sem exigir configuração manual num deploy de segurança.
const MFA_COOKIE_KEY = createHash('sha256')
  .update('granaevo-ge-mfa-cookie-v1|' + (process.env.PROXY_SECRET ?? ''))
  .digest()

const mfaSign = (b64) =>
  createHmac('sha256', MFA_COOKIE_KEY).update(b64).digest('base64url')

function buildMfaCookie(payload, { clear, domain } = {}) {
  let value = ''
  if (!clear) {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    value = `${b64}.${mfaSign(b64)}`
  }
  const parts = [
    `${MFA_COOKIE_NAME}=${value}`,
    'HttpOnly', 'Secure', 'SameSite=Strict',
    `Path=${COOKIE_PATH}`,
    `Max-Age=${clear ? 0 : MFA_TTL_SECS}`,
  ]
  if (domain) parts.push(`Domain=${domain}`)
  return parts.join('; ')
}

function readMfaCookie(cookieHeader) {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() !== MFA_COOKIE_NAME) continue
    const raw = part.slice(idx + 1).trim()
    if (!raw) return null
    try {
      // Formato: <payload base64url>.<hmac base64url>. Sem assinatura válida o
      // cookie não existe — nem tenta parsear o JSON.
      const dot = raw.lastIndexOf('.')
      if (dot <= 0) return null
      const b64 = raw.slice(0, dot)
      const sig = Buffer.from(raw.slice(dot + 1), 'base64url')
      const esperada = Buffer.from(mfaSign(b64), 'base64url')
      if (sig.length !== esperada.length || !timingSafeEqual(sig, esperada)) return null

      const d = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
      // exp é a autoridade: o Max-Age do cookie é uma dica ao browser, não uma
      // garantia — um cliente que reenvie o cookie vencido não ganha nada.
      // Agora está coberto pelo HMAC, então também não dá para esticá-lo.
      if (!d?.at || !d?.rt || typeof d.exp !== 'number' || Date.now() > d.exp) return null
      // `sid` amarra o cookie ao contador de tentativas do servidor. Um payload
      // sem sid é de um deploy anterior a esta correção: recusar força um login
      // novo (custo: um formulário), em vez de cair no caminho sem contagem.
      if (typeof d.sid !== 'string' || d.sid.length < 16) return null
      return d
    } catch { return null }
  }
  return null
}

// Chave do contador de tentativas do 2º fator, no Redis (in-memory como
// fallback). TTL igual ao do cookie: a sessão em trânsito morre, o contador
// morre junto — ninguém carrega punição de uma tentativa de ontem.
const mfaTriesKey = (sid) => `mfatries:${sid}`

// Emite Set-Cookie para ge_rt e ge_mfa ao mesmo tempo, preservando a limpeza do
// cookie host-only legado que setRefreshCookie() já fazia.
function setCookies(res, list) {
  res.setHeader('Set-Cookie', list.filter(Boolean))
}

// ── Chamadas ao GoTrue (Supabase Auth REST) ────────────────────────────────────
async function gotrue(pathname, { token, body, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'apikey': ANON_KEY }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${SUPABASE_URL}/auth/v1/${pathname}`, {
    method,
    headers,
    body:    body ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(12_000),
  })
}

// Fatores TOTP já confirmados pelo usuário. Só `verified` conta: um fator
// `unverified` é lixo de um enroll abandonado e NUNCA pode barrar o login.
function verifiedTotp(user) {
  const factors = Array.isArray(user?.factors) ? user.factors : []
  return factors.filter(f => f?.status === 'verified' && f?.factor_type === 'totp')
}

// Descobre os fatores do usuário logo após o password grant.
//
// POR QUE ISTO CUSTA UM ROUND-TRIP EXTRA
//   O GoTrue serializa `factors` com `omitempty` e a consulta que atende o
//   /token não faz preload dos fatores — na prática a chave quase nunca vem na
//   resposta do login. `GET /auth/v1/user`, sim, carrega os fatores (é dali que
//   o próprio supabase-js lê em listFactors). Então: usa o que veio no grant se
//   veio, senão pergunta. São ~50ms no login, e só no login.
//
// POR QUE FALHA FECHADO
//   Se não dá para saber se a conta tem 2º fator, deixar passar seria abrir
//   exatamente o buraco que o 2º fator existe para tapar — e um atacante com a
//   senha na mão só precisaria provocar a falha. O preço é uma tela de "tente de
//   novo" num soluço de rede, o que é recuperável; o contrário não é.
//   A tentativa dupla existe para que esse soluço quase nunca chegue ao usuário.
async function fatoresDoGrant(grant) {
  if (Array.isArray(grant?.user?.factors)) return { ok: true, factors: verifiedTotp(grant.user) }

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await gotrue('user', { token: grant.access_token, method: 'GET' })
      if (!r.ok) {
        // 401/403 aqui significaria token recém-emitido e já inválido: não é
        // falha transitória, e repetir não muda nada.
        if (r.status === 401 || r.status === 403) return { ok: false, factors: [] }
        continue
      }
      const user = await r.json()
      return { ok: true, factors: verifiedTotp(user) }
    } catch { /* rede/timeout → tenta de novo */ }
  }
  return { ok: false, factors: [] }
}

// Resposta de sucesso: devolve só o que o client guarda em memória — nunca o refresh.
function sessionPayload(grant) {
  return {
    access_token: grant.access_token,
    expires_at:   grant.expires_at,   // epoch segundos
    expires_in:   grant.expires_in,
    token_type:   grant.token_type ?? 'bearer',
    user:         grant.user ?? null,
  }
}

export default async function handler(req, res) {
  const origin  = req.headers['origin'] ?? ''
  const allowed = ALLOWED_ORIGINS.has(origin)

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Vary', 'Origin')

  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end()
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Max-Age', '86400')
    return res.status(204).end()
  }

  if (!allowed)               return res.status(403).json({ error: 'Forbidden' })
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method !== 'POST')  return res.status(405).json({ error: 'Method Not Allowed' })
  if (!SUPABASE_URL || !ANON_KEY)
    return res.status(503).json({ error: 'Serviço indisponível' })

  // CSRF defesa-em-profundidade: Sec-Fetch + Origin já validado
  const fs = req.headers['sec-fetch-site'] ?? ''
  if (fs && fs !== 'same-origin' && fs !== 'none') return res.status(403).json({ error: 'Forbidden' })

  const ct = req.headers['content-type'] ?? ''
  if (!ct.includes('application/json'))
    return res.status(415).json({ error: 'Content-Type deve ser application/json' })

  const ip = (req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? 'unknown')
    .toString().split(',')[0].trim()

  if (await isIPBlocked(ip)) {
    logger.warn('ip_blocked', PATH, { ip })
    return res.status(403).json({ error: 'Forbidden' })
  }

  // ── Lê body (pequeno) ─────────────────────────────────────────
  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('TOO_LARGE')) } chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  } catch (e) {
    return res.status(e.message === 'TOO_LARGE' ? 413 : 400).json({ error: 'Body inválido' })
  }

  let body
  try { body = JSON.parse(raw || '{}') } catch { return res.status(400).json({ error: 'JSON inválido' }) }

  const action = typeof body?.action === 'string' ? body.action : ''

  // ── LOGIN ─────────────────────────────────────────────────────
  if (action === 'login') {
    if (!await checkRateWindow(`auth-login:${ip}`, RL_LOGIN_MAX, RL_LOGIN_WIN)) {
      logger.warn('rate_limit', PATH, { ip, action })
      res.setHeader('Retry-After', String(RL_LOGIN_WIN))
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' })
    }

    const email    = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const remember = body?.remember === true

    if (!EMAIL_RE.test(email) || !password || password.length > 128)
      return res.status(400).json({ error: 'invalid_credentials' })

    // ── S-2: a conta está travada? ────────────────────────────────────────
    // Antes do password grant: uma conta travada não deve nem chegar ao GoTrue.
    const kConta = chaveConta(email)
    const kLock  = `loginlock:${kConta}`
    const kFail  = `loginfail:${kConta}`

    if (await isKeyBlocked(kLock)) {
      logger.warn('login_locked', PATH, { ip })
      res.setHeader('Retry-After', '900')
      return res.status(429).json({ error: 'account_locked' })
    }

    // ACHADO-02: o "não bloqueado" acima só vale se veio do Redis de verdade.
    // Se ele está degradado, a resposta saiu de um Map local que um atacante
    // contorna trocando de instância — aí quem decide é o banco.
    //
    // TERCEIRO ESTADO, DECIDIDO EXPLICITAMENTE:
    //   Redis ok                    → proteção do Redis
    //   Redis fora, banco responde  → proteção do banco
    //   OS DOIS mudos               → NENHUMA camada de lockout de pé
    //
    // O terceiro caso não pode passar batido. Deixar o login seguir normalmente
    // ali seria uma camada mascarando silenciosamente a falha da outra — a
    // mesma classe de defeito que esta correção veio consertar.
    //
    // A resposta é degradar para uma defesa de PROVEDOR INDEPENDENTE, não
    // remover defesa: exige-se o captcha incondicionalmente. Cloudflare não
    // compartilha destino com Upstash nem com Supabase, então a chance de as
    // três estarem fora ao mesmo tempo é o resíduo declarado no baseline.
    //
    // POR QUE NÃO BLOQUEAR O LOGIN DE VEZ: uma indisponibilidade do Upstash
    // somada a uma da edge trancaria TODOS os clientes pagantes para fora da
    // própria conta. O custo de recusar todo mundo é maior que o de exigir um
    // desafio de bot durante a janela — o mesmo raciocínio já registrado em
    // api/_turnstile.js. Se um dia o captcha for a única camada restante, esta
    // decisão tem de ser revista junto.
    let semNenhumaCamada = false
    if (redisDegradado()) {
      const d = await lockoutDuravel('check', kConta)
      if (d?.is_locked) {
        logger.warn('login_locked_duravel', PATH, { ip })
        res.setHeader('Retry-After', '900')
        return res.status(429).json({ error: 'account_locked' })
      }
      // `null` = a edge não respondeu (ou falta config). Com o Redis já
      // degradado, isto significa que NINGUÉM está contando falhas.
      if (d === null) semNenhumaCamada = true
    }

    // ── B-2: o servidor exige o captcha, não o navegador ────────────────────
    // Lê o contador SEM incrementar (readCounter) — quem incrementa é só o
    // caminho de falha, mais abaixo. Incrementar aqui puniria quem acerta.
    let precisaCaptcha = false
    try {
      precisaCaptcha = (await readCounter(kFail)) >= CAPTCHA_APOS_FALHAS
    } catch { /* sem Redis: o degrau abaixo assume */ }

    if (semNenhumaCamada) {
      precisaCaptcha = true

      // ALARME OBRIGATÓRIO — e de propósito NÃO é `trackSecurityEvent`.
      //
      // Aquele caminho começa com `if (!REDIS_URL || !REDIS_TOKEN) return` e
      // conta as ocorrências no próprio Redis. Usá-lo para avisar que o Redis
      // caiu seria criar mais um controle incapaz de disparar exatamente no
      // momento em que ele importa — o defeito que esta auditoria encontrou
      // três vezes. `logger.error` vai para o stdout da função e chega ao
      // Vercel Logs sem depender de nada que possa estar fora do ar junto.
      logger.error('lockout_sem_camada', PATH, { ip })
    }

    if (precisaCaptcha) {
      const tok = typeof body?.captchaToken === 'string' ? body.captchaToken.trim() : ''
      if (!tok) {
        // 403 e não 401: o cliente precisa distinguir "senha errada" de
        // "resolva o desafio e tente de novo". Nada é revelado sobre a conta —
        // o contador sobe igual para e-mail que existe e para o que não existe.
        logger.warn('captcha_exigido', PATH, { ip })
        return res.status(403).json({ error: 'captcha_required', captcha_required: true })
      }
      if (!await turnstileOk(tok, ip, PATH)) {
        logger.warn('captcha_invalido', PATH, { ip })
        return res.status(403).json({ error: 'captcha_invalid', captcha_required: true })
      }
    }

    let grantRes
    try {
      grantRes = await gotrue('token?grant_type=password', { body: { email, password } })
    } catch (e) {
      const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
      return res.status(code).json({ error: 'Gateway indisponível' })
    }

    if (!grantRes.ok) {
      // ── S-2: contabiliza a falha e escalona ─────────────────────────────
      // Contamos MESMO se o e-mail não existir. Isso não é desperdício: se só
      // contássemos para contas reais, a diferença de comportamento viraria um
      // oráculo de enumeração — "travou, logo a conta existe". Contando sempre,
      // o 429 não diz nada sobre a existência da conta.
      try {
        const falhas = await bumpCounter(kFail, LOCK_JANELA)
        const degrau = LOCK_DEGRAUS.find(d => falhas >= d.falhas)
        if (degrau) {
          await blockKey(kLock, degrau.ttl)
          logger.warn('login_lockout_aplicado', PATH, { ip, falhas, ttl: degrau.ttl })
          // Um lockout isolado é ruído (alguém esqueceu a senha). VÁRIOS em
          // pouco tempo é credential stuffing — e é isso que o threshold de
          // `login_lockout` (5 em 10 min) existe para pegar. Sem esta linha o
          // sinal mais valioso do S-2 morria no log.
          // Fire-and-forget: monitoramento nunca atrasa nem derruba o login.
          import('./_alert.js')
            .then(({ trackSecurityEvent }) => trackSecurityEvent('login_lockout', { ip, falhas, ttl: degrau.ttl }))
            .catch(() => {})
        }
      } catch { /* o limite por IP segue valendo; nunca derruba o login por isto */ }

      // ACHADO-02: registra a MESMA falha na camada durável. Aguardado de
      // propósito — é o caminho de senha errada, onde alguns milissegundos a
      // mais não incomodam ninguém legítimo e atrapalham quem está martelando.
      // O `catch` interno de `lockoutDuravel` garante que um banco fora do ar
      // não transforme "senha errada" em erro 500.
      //
      // O resultado NÃO muda esta resposta: quem acabou de errar a senha recebe
      // 401 de qualquer forma, e o bloqueio entra na PRÓXIMA tentativa, pelo
      // check do topo. Menos um lugar onde as duas camadas podem discordar.
      await lockoutDuravel('record', kConta)

      // Não vaza se o email existe — sempre mensagem genérica
      logger.warn('login_failed', PATH, { ip })
      return res.status(401).json({ error: 'invalid_credentials' })
    }

    // Acertou a senha: zera o histórico. Sem isto, falhas legítimas espalhadas
    // ao longo de um dia se somariam até travar quem nunca foi atacado.
    clearKeys(kFail, kLock).catch(() => {})
    // Idem na camada durável. Aqui NÃO se espera: é o caminho feliz, e a janela
    // de 24 h de `record_failed_login` cura sozinha um clear perdido — o contador
    // do banco reinicia na primeira falha posterior à janela.
    lockoutDuravel('clear', kConta, { esperar: false })

    const grant = await grantRes.json()
    if (!grant?.access_token || !grant?.refresh_token)
      return res.status(502).json({ error: 'Resposta de autenticação inválida' })

    // ── Gate do 2º fator (B-1) ────────────────────────────────────────────────
    // Só entra aqui quem ATIVOU o MFA. Sem fator verificado, o fluxo abaixo é o
    // mesmo de sempre — nenhum request extra, nenhum cookie extra.
    const { ok: fatoresOk, factors } = await fatoresDoGrant(grant)
    if (!fatoresOk) {
      logger.error('mfa_factor_lookup_failed', PATH, { ip })
      return res.status(503).json({ error: 'Não foi possível concluir o login agora. Tente de novo.' })
    }

    if (factors.length > 0) {
      // Senha certa, mas a sessão ainda NÃO vale. Ela não vai para o cliente:
      // fica no ge_mfa (HttpOnly, 5 min) até o código confirmar.
      const domain = cookieDomainDe(req)
      setCookies(res, [
        buildMfaCookie({
          at:       grant.access_token,
          rt:       grant.refresh_token,
          fid:      factors[0].id,
          remember: remember === true,
          // [SEC-002] `tries` não mora mais aqui — ver o bloco do buildMfaCookie.
          // `sid` é o que amarra este desafio ao contador do servidor; sendo
          // aleatório e coberto pelo HMAC, não dá para trocar por um "sid limpo".
          sid:      randomBytes(16).toString('base64url'),
          exp:      Date.now() + MFA_TTL_SECS * 1000,
        }, { domain }),
        // Derruba qualquer ge_rt anterior: enquanto o 2º fator não vier, esta
        // requisição não pode deixar sessão utilizável para trás.
        buildRefreshCookie('', { clear: true, domain }),
        ...(domain ? [buildRefreshCookie('', { clear: true })] : []),
      ])
      logger.warn('mfa_challenge_issued', PATH, { ip })
      return res.status(200).json({
        mfa_required: true,
        factor_type:  'totp',
        expires_in:   MFA_TTL_SECS,
      })
    }

    setRefreshCookie(res, grant.refresh_token,
      { ...(remember ? { maxAge: REMEMBER_MAX_AGE } : {}), domain: cookieDomainDe(req) })
    return res.status(200).json(sessionPayload(grant))
  }

  // ── MFA: 2º passo do login ────────────────────────────────────────────────
  // Consome o ge_mfa, troca o código pelo par elevado (aal2) e só então emite o
  // ge_rt. Erro de código NÃO devolve sessão nenhuma e queima uma tentativa.
  if (action === 'mfa-login-verify' || action === 'mfa-login-recovery') {
    const domain = cookieDomainDe(req)
    const limparTudo = () => setCookies(res, [
      buildMfaCookie(null, { clear: true, domain }),
      ...(domain ? [buildMfaCookie(null, { clear: true })] : []),
    ])

    if (!await checkRateWindow(`mfa-verify:${ip}`, RL_MFA_VERIFY_MAX, RL_MFA_VERIFY_WIN)) {
      logger.warn('rate_limit', PATH, { ip, action })
      res.setHeader('Retry-After', String(RL_MFA_VERIFY_WIN))
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' })
    }

    const pend = readMfaCookie(req.headers['cookie'] ?? '')
    if (!pend) {
      limparTudo()
      return res.status(440).json({ error: 'mfa_expired' })
    }

    // ── Caminho A: código de recuperação (perdeu o celular) ──────────────────
    if (action === 'mfa-login-recovery') {
      const code = typeof body?.recoveryCode === 'string'
        ? body.recoveryCode.trim().toUpperCase().replace(/\s+/g, '') : ''
      if (!RECOVERY_CODE_RE.test(code)) return res.status(400).json({ error: 'codigo_invalido' })

      // A Edge Function é quem tem service_role: confere o hash, marca o código
      // como usado e REMOVE os fatores. Aqui não há chave privilegiada nenhuma.
      let rec
      try {
        rec = await fetch(`${SUPABASE_URL}/functions/v1/mfa-recovery`, {
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'Authorization':  `Bearer ${pend.at}`,
            'apikey':         ANON_KEY,
            'x-proxy-secret': process.env.PROXY_SECRET ?? '',
            'x-forwarded-for': ip,
          },
          body:   JSON.stringify({ action: 'consume', code }),
          signal: AbortSignal.timeout(12_000),
        })
      } catch {
        return res.status(502).json({ error: 'Gateway indisponível' })
      }
      if (!rec.ok) {
        // [SEC-002] contador no SERVIDOR (chave = sid do cookie assinado).
        // Reenviar o mesmo cookie reenvia o mesmo sid: a contagem não zera.
        const tries = await bumpCounter(mfaTriesKey(pend.sid), MFA_TTL_SECS)
        if (tries >= MFA_MAX_ATTEMPTS) {
          limparTudo()
          clearKeys(mfaTriesKey(pend.sid)).catch(() => {})
          return res.status(429).json({ error: 'mfa_locked' })
        }
        logger.warn('mfa_recovery_failed', PATH, { ip })
        return res.status(401).json({ error: 'codigo_invalido', attempts_left: MFA_MAX_ATTEMPTS - tries })
      }

      // Fatores removidos → a sessão aal1 guardada virou a sessão final.
      // Rotaciona o refresh antes de entregá-la (higiene: o par que fica com o
      // usuário nunca é o mesmo que passou pelo cookie intermediário).
      let novo
      try {
        const rr = await gotrue('token?grant_type=refresh_token', { body: { refresh_token: pend.rt } })
        novo = rr.ok ? await rr.json() : null
      } catch { novo = null }
      if (!novo?.access_token || !novo?.refresh_token) {
        limparTudo()
        return res.status(440).json({ error: 'mfa_expired' })
      }
      setCookies(res, [
        buildRefreshCookie(novo.refresh_token, { ...(pend.remember ? { maxAge: REMEMBER_MAX_AGE } : {}), domain }),
        buildMfaCookie(null, { clear: true, domain }),
        ...(domain ? [buildRefreshCookie('', { clear: true })] : []),
      ])
      clearKeys(mfaTriesKey(pend.sid)).catch(() => {})
      logger.warn('mfa_disabled_by_recovery', PATH, { ip })
      return res.status(200).json({ ...sessionPayload(novo), mfa_disabled: true })
    }

    // ── Caminho B: código do app autenticador ────────────────────────────────
    const code = typeof body?.code === 'string' ? body.code.trim().replace(/\s+/g, '') : ''
    if (!TOTP_CODE_RE.test(code)) return res.status(400).json({ error: 'codigo_invalido' })

    let chal
    try {
      const cr = await gotrue(`factors/${encodeURIComponent(pend.fid)}/challenge`, { token: pend.at })
      chal = cr.ok ? await cr.json() : null
    } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
    if (!chal?.id) { limparTudo(); return res.status(440).json({ error: 'mfa_expired' }) }

    let vr
    try {
      vr = await gotrue(`factors/${encodeURIComponent(pend.fid)}/verify`, {
        token: pend.at,
        body:  { challenge_id: chal.id, code },
      })
    } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }

    if (!vr.ok) {
      // [SEC-002] mesma troca do caminho de recuperação: a contagem é do
      // servidor, não do cookie que o cliente devolve.
      const tries = await bumpCounter(mfaTriesKey(pend.sid), MFA_TTL_SECS)
      if (tries >= MFA_MAX_ATTEMPTS) {
        limparTudo()
        clearKeys(mfaTriesKey(pend.sid)).catch(() => {})
        logger.warn('mfa_locked', PATH, { ip })
        return res.status(429).json({ error: 'mfa_locked' })
      }
      logger.warn('mfa_code_failed', PATH, { ip })
      return res.status(401).json({ error: 'codigo_invalido', attempts_left: MFA_MAX_ATTEMPTS - tries })
    }

    const elevado = await vr.json()
    if (!elevado?.access_token || !elevado?.refresh_token) {
      limparTudo()
      return res.status(502).json({ error: 'Resposta de autenticação inválida' })
    }

    setCookies(res, [
      buildRefreshCookie(elevado.refresh_token, { ...(pend.remember ? { maxAge: REMEMBER_MAX_AGE } : {}), domain }),
      buildMfaCookie(null, { clear: true, domain }),
      ...(domain ? [buildRefreshCookie('', { clear: true })] : []),
    ])
    clearKeys(mfaTriesKey(pend.sid)).catch(() => {})
    return res.status(200).json(sessionPayload(elevado))
  }

  // ── REFRESH ───────────────────────────────────────────────────
  if (action === 'refresh') {
    if (!await checkRate(`auth-refresh:${ip}`, RL_REFRESH_MAX)) {
      res.setHeader('Retry-After', '60')
      return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
    }

    // Sem cookie = simplesmente deslogado. Responde 200 com sessão vazia (não 401)
    // para não poluir o console com erro vermelho em toda página pública/deslogada.
    const refreshToken = readRefreshCookie(req.headers['cookie'] ?? '')
    if (!refreshToken) return res.status(200).json({ session: null })

    let grantRes
    try {
      grantRes = await gotrue('token?grant_type=refresh_token', { body: { refresh_token: refreshToken } })
    } catch (e) {
      // Erro real de gateway (rede/timeout/5xx) → transitório, NÃO desloga
      const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 504 : 502
      return res.status(code).json({ error: 'Gateway indisponível' })
    }

    if (!grantRes.ok) {
      // Refresh inválido/revogado → limpa o cookie e sinaliza "deslogado" (200, sem erro)
      setRefreshCookie(res, '', { clear: true, domain: cookieDomainDe(req) })
      return res.status(200).json({ session: null })
    }

    const grant = await grantRes.json()
    if (!grant?.access_token || !grant?.refresh_token) {
      setRefreshCookie(res, '', { clear: true, domain: cookieDomainDe(req) })
      return res.status(200).json({ session: null })
    }

    // Rotação: Supabase emite novo refresh a cada uso — re-grava o cookie.
    // Preserva a longevidade: se o cookie atual era persistente (remember), mantém.
    const wasPersistent = (req.headers['cookie'] ?? '').includes(`${COOKIE_NAME}=`) && body?.remember !== false
    setRefreshCookie(res, grant.refresh_token,
      { ...(body?.remember === true || wasPersistent ? { maxAge: REMEMBER_MAX_AGE } : {}), domain: cookieDomainDe(req) })
    return res.status(200).json(sessionPayload(grant))
  }

  // ── LOGOUT ────────────────────────────────────────────────────
  if (action === 'logout') {
    if (!await checkRate(`auth-logout:${ip}`, RL_LOGOUT_MAX)) {
      res.setHeader('Retry-After', '60')
      return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
    }

    const refreshToken = readRefreshCookie(req.headers['cookie'] ?? '')
    // Revoga server-side (best effort) — o access token é passado pelo client p/ autorizar o logout
    const authHdr = req.headers['authorization'] ?? ''
    const accessToken = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : null
    if (accessToken) {
      try { await gotrue('logout', { token: accessToken }) } catch { /* best effort */ }
    }
    // Limpa o cookie independentemente do resultado da revogação
    setRefreshCookie(res, '', { clear: true, domain: cookieDomainDe(req) })
    if (!refreshToken && !accessToken) return res.status(200).json({ ok: true })
    return res.status(200).json({ ok: true })
  }

  // ── Step-up: confirma a senha de quem já está logado (Passo 25) ──────────
  // Genérico de propósito: o `mfa-disable` faz a mesma checagem embutida, e a
  // exportação de dados (A-3) precisa dela. Não emite sessão nem altera nada —
  // só responde "essa senha é mesmo dessa conta agora".
  //
  // Por que a exportação exige isto: ela empacota TODA a vida financeira do
  // usuário num arquivo, num clique. Ver os dados na tela exige navegar; baixar
  // o arquivo não. Com uma sessão emprestada ou esquecida aberta, a diferença
  // entre as duas coisas é o que separa bisbilhotar de exfiltrar.
  if (action === 'verify-password') {
    if (!await checkRateWindow(`stepup:${ip}`, 8, 600)) {
      res.setHeader('Retry-After', '600')
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde.' })
    }

    const authHdr = req.headers['authorization'] ?? ''
    const at = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : ''
    if (!at) return res.status(401).json({ error: 'Não autenticado' })

    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password || password.length > 128)
      return res.status(400).json({ error: 'senha_obrigatoria' })

    let user
    try {
      const ur = await gotrue('user', { token: at, method: 'GET' })
      if (!ur.ok) return res.status(401).json({ error: 'Não autenticado' })
      user = await ur.json()
    } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
    if (!user?.email) return res.status(409).json({ error: 'conta_sem_email' })

    // [SEC-003] Este caminho também é um oráculo de senha, e precisa das MESMAS
    // travas do login. Ele faz um password grant de verdade contra o GoTrue:
    // quem tem um access token roubado (XSS, aparelho emprestado, sessão
    // esquecida) podia adivinhar a senha aqui à vontade, porque o teto era só
    // 8/10min POR IP — e o S-2 nasceu justamente porque limite por IP não
    // segura força bruta distribuída. Pior: acertar a senha aqui destrava
    // `mfa-disable` e a exclusão de conta, que é o fim da linha.
    //
    // Reusa `kFail`/`kLock` do login — mesma conta, mesmo contador. Um atacante
    // que alterne entre /login e este endpoint soma no mesmo balde.
    const kContaSU = chaveConta(String(user.email).toLowerCase())
    const kLockSU  = `loginlock:${kContaSU}`
    const kFailSU  = `loginfail:${kContaSU}`
    if (await isKeyBlocked(kLockSU)) {
      logger.warn('stepup_conta_travada', PATH, { ip })
      res.setHeader('Retry-After', '900')
      return res.status(429).json({ error: 'account_locked' })
    }

    let checa
    try {
      checa = await gotrue('token?grant_type=password', {
        body: { email: String(user.email).toLowerCase(), password },
      })
    } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }

    if (!checa.ok) {
      try {
        const falhas = await bumpCounter(kFailSU, LOCK_JANELA)
        const degrau = LOCK_DEGRAUS.find(d => falhas >= d.falhas)
        if (degrau) {
          await blockKey(kLockSU, degrau.ttl)
          logger.warn('login_lockout_aplicado', PATH, { ip, falhas, ttl: degrau.ttl, origem: 'stepup' })
          import('./_alert.js')
            .then(({ trackSecurityEvent }) => trackSecurityEvent('login_lockout', { ip, falhas, ttl: degrau.ttl }))
            .catch(() => {})
        }
      } catch { /* nunca derruba o step-up por falha do contador */ }
      logger.warn('stepup_senha_incorreta', PATH, { ip })
      return res.status(401).json({ error: 'senha_incorreta' })
    }
    // Senha certa: zera o histórico, igual ao login. Sem isto, confirmações
    // legítimas com um erro de digitação no meio somariam até travar a conta.
    clearKeys(kFailSU, kLockSU).catch(() => {})
    // O grant acima criou uma sessão paralela que ninguém vai usar. Não a
    // devolvemos (o cliente segue com a sessão dele) e revogamos na hora, para
    // não deixar refresh token órfão vivo no GoTrue a cada confirmação.
    //
    // ⚠️ `scope=local` NÃO É OPCIONAL AQUI. O `/logout` do GoTrue tem escopo
    // **global por padrão**: ele apaga TODAS as sessões do usuário, não só
    // aquela cujo token foi passado. Sem o parâmetro, esta "limpeza" derrubava
    // a sessão real de quem acabou de confirmar a senha — e a próxima chamada
    // do fluxo respondia 401.
    //
    // Foi exatamente isso em 2026-07-30: a exportação LGPD confirmava a senha,
    // recebia `{ok:true}`, e logo em seguida o `GET /api/user-data` devolvia
    // "Token inválido". Parecia bug da exportação; era o step-up deslogando o
    // usuário. Reproduzido em produção: 200 → step-up 200 → 401.
    try {
      const g = await checa.json()
      if (g?.access_token) await gotrue('logout?scope=local', { token: g.access_token })
    } catch { /* melhor esforço */ }

    return res.status(200).json({ ok: true })
  }

  // ── MFA: gerenciamento (usuário JÁ logado) ────────────────────────────────
  // status · enroll · activate · disable. Todas exigem o access token no header
  // Authorization; o GoTrue é quem valida a assinatura — aqui só repassamos.
  if (action === 'mfa-status' || action === 'mfa-enroll' ||
      action === 'mfa-activate' || action === 'mfa-disable') {

    if (!await checkRateWindow(`mfa-admin:${ip}`, RL_MFA_ADMIN_MAX, RL_MFA_ADMIN_WIN)) {
      res.setHeader('Retry-After', String(RL_MFA_ADMIN_WIN))
      return res.status(429).json({ error: 'Muitas requisições. Aguarde.' })
    }

    const authHdr = req.headers['authorization'] ?? ''
    const at = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : ''
    if (!at) return res.status(401).json({ error: 'Não autenticado' })

    // Uma única fonte de verdade sobre o usuário e seus fatores. Se o GoTrue
    // recusar o token aqui, nenhuma das ações abaixo chega a acontecer.
    let user
    try {
      const ur = await gotrue('user', { token: at, method: 'GET' })
      if (!ur.ok) return res.status(401).json({ error: 'Não autenticado' })
      user = await ur.json()
    } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
    if (!user?.id) return res.status(401).json({ error: 'Não autenticado' })

    const ativos = verifiedTotp(user)

    // ── status: alimenta o painel de Segurança ──────────────────────────────
    if (action === 'mfa-status') {
      return res.status(200).json({
        enabled: ativos.length > 0,
        factors: ativos.map(f => ({
          id:            f.id,
          friendly_name: f.friendly_name ?? 'App autenticador',
          created_at:    f.created_at ?? null,
        })),
      })
    }

    // ── enroll: cria o fator pendente e devolve o QR ────────────────────────
    if (action === 'mfa-enroll') {
      if (ativos.length > 0) return res.status(409).json({ error: 'mfa_ja_ativo' })

      // Limpa fatores `unverified` de tentativas abandonadas. Sem isto, o GoTrue
      // recusa o novo enroll por conflito de nome e o usuário fica travado num
      // erro que ele não tem como entender nem resolver sozinho.
      for (const f of (Array.isArray(user.factors) ? user.factors : [])) {
        if (f?.status === 'unverified') {
          try { await gotrue(`factors/${encodeURIComponent(f.id)}`, { token: at, method: 'DELETE' }) } catch { /* melhor esforço */ }
        }
      }

      let er
      try {
        er = await gotrue('factors', {
          token: at,
          body:  { factor_type: 'totp', friendly_name: 'GranaEvo', issuer: 'GranaEvo' },
        })
      } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
      if (!er.ok) {
        logger.warn('mfa_enroll_failed', PATH, { ip, status: er.status })
        return res.status(502).json({ error: 'Não foi possível iniciar a ativação.' })
      }
      const f = await er.json()
      if (!f?.id || !f?.totp) return res.status(502).json({ error: 'Resposta inválida do autenticador' })
      return res.status(200).json({
        factorId: f.id,
        qrCode:   f.totp.qr_code ?? null,   // SVG pronto para <img src>
        secret:   f.totp.secret  ?? null,   // digitação manual quando a câmera falha
        uri:      f.totp.uri     ?? null,
      })
    }

    // ── activate: confirma o fator e emite os códigos de recuperação ────────
    if (action === 'mfa-activate') {
      const factorId = typeof body?.factorId === 'string' ? body.factorId : ''
      const code     = typeof body?.code === 'string' ? body.code.trim().replace(/\s+/g, '') : ''
      if (!factorId || !TOTP_CODE_RE.test(code))
        return res.status(400).json({ error: 'codigo_invalido' })

      let chal
      try {
        const cr = await gotrue(`factors/${encodeURIComponent(factorId)}/challenge`, { token: at })
        chal = cr.ok ? await cr.json() : null
      } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
      if (!chal?.id) return res.status(400).json({ error: 'codigo_invalido' })

      let vr
      try {
        vr = await gotrue(`factors/${encodeURIComponent(factorId)}/verify`, {
          token: at, body: { challenge_id: chal.id, code },
        })
      } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
      if (!vr.ok) return res.status(401).json({ error: 'codigo_invalido' })

      // O verify eleva a sessão: chega par novo (aal2). O refresh vai pro cookie.
      const elevado = await vr.json()
      if (elevado?.access_token && elevado?.refresh_token) {
        const domain = cookieDomainDe(req)
        setRefreshCookie(res, elevado.refresh_token, { maxAge: REMEMBER_MAX_AGE, domain })
      }

      // Códigos de recuperação: sem eles, perder o celular = perder a conta.
      let recoveryCodes = []
      try {
        const gr = await fetch(`${SUPABASE_URL}/functions/v1/mfa-recovery`, {
          method:  'POST',
          headers: {
            'Content-Type':    'application/json',
            'Authorization':   `Bearer ${elevado?.access_token || at}`,
            'apikey':          ANON_KEY,
            'x-proxy-secret':  process.env.PROXY_SECRET ?? '',
            'x-forwarded-for': ip,
          },
          body:   JSON.stringify({ action: 'generate' }),
          signal: AbortSignal.timeout(12_000),
        })
        if (gr.ok) recoveryCodes = (await gr.json())?.codes ?? []
      } catch { /* o MFA já está ativo; a UI avisa que os códigos falharam */ }

      logger.warn('mfa_enabled', PATH, { ip })
      return res.status(200).json({
        ok: true,
        ...(elevado?.access_token ? sessionPayload(elevado) : {}),
        recoveryCodes,
      })
    }

    // ── disable: step-up por senha antes de baixar a guarda ─────────────────
    // Um access token roubado não pode desligar o 2º fator sozinho — se pudesse,
    // o MFA protegeria contra tudo menos contra o cenário que ele existe para
    // cobrir. Mesma regra do Passo 25 (excluir conta).
    if (action === 'mfa-disable') {
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!password || password.length > 128)
        return res.status(400).json({ error: 'Confirme sua senha para desativar.' })
      if (!user.email) return res.status(409).json({ error: 'conta_sem_email' })
      if (ativos.length === 0) return res.status(200).json({ ok: true, enabled: false })

      // [SEC-003] Mesma trava do login e do step-up, e aqui ela pesa mais que
      // nos outros dois: adivinhar a senha neste endpoint DESLIGA o 2º fator.
      // O teto de 12/10min por IP (bucket mfa-admin) não é freio contra botnet.
      const kContaMD = chaveConta(String(user.email).toLowerCase())
      const kLockMD  = `loginlock:${kContaMD}`
      const kFailMD  = `loginfail:${kContaMD}`
      if (await isKeyBlocked(kLockMD)) {
        logger.warn('mfa_disable_conta_travada', PATH, { ip })
        res.setHeader('Retry-After', '900')
        return res.status(429).json({ error: 'account_locked' })
      }

      let checa
      try {
        checa = await gotrue('token?grant_type=password', {
          body: { email: String(user.email).toLowerCase(), password },
        })
      } catch { return res.status(502).json({ error: 'Gateway indisponível' }) }
      if (!checa.ok) {
        try {
          const falhas = await bumpCounter(kFailMD, LOCK_JANELA)
          const degrau = LOCK_DEGRAUS.find(d => falhas >= d.falhas)
          if (degrau) {
            await blockKey(kLockMD, degrau.ttl)
            logger.warn('login_lockout_aplicado', PATH, { ip, falhas, ttl: degrau.ttl, origem: 'mfa-disable' })
            import('./_alert.js')
              .then(({ trackSecurityEvent }) => trackSecurityEvent('login_lockout', { ip, falhas, ttl: degrau.ttl }))
              .catch(() => {})
          }
        } catch { /* nunca derruba o fluxo por falha do contador */ }
        logger.warn('mfa_disable_bad_password', PATH, { ip })
        return res.status(401).json({ error: 'senha_incorreta' })
      }
      clearKeys(kFailMD, kLockMD).catch(() => {})

      // Mesma limpeza do step-up do Passo 25, pelo mesmo motivo: o grant acima
      // é só uma prova de senha, mas cria uma sessão de verdade. Sem revogar,
      // cada desativação de 2FA deixava um refresh token órfão vivo no GoTrue.
      // `scope=local` é obrigatório — sem ele o /logout apaga TODAS as sessões
      // do usuário e derruba quem está desativando (ver o aviso longo acima).
      try {
        const g = await checa.json()
        if (g?.access_token) await gotrue('logout?scope=local', { token: g.access_token })
      } catch { /* melhor esforço */ }

      let removidos = 0
      for (const f of ativos) {
        try {
          const dr = await gotrue(`factors/${encodeURIComponent(f.id)}`, { token: at, method: 'DELETE' })
          if (dr.ok) removidos++
        } catch { /* segue e reporta abaixo */ }
      }
      if (removidos !== ativos.length)
        return res.status(502).json({ error: 'Não foi possível desativar. Tente de novo.' })

      // Códigos de recuperação de um MFA desligado não podem sobreviver: eles
      // continuariam valendo como chave de destravamento de algo que não existe.
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/mfa-recovery`, {
          method:  'POST',
          headers: {
            'Content-Type':    'application/json',
            'Authorization':   `Bearer ${at}`,
            'apikey':          ANON_KEY,
            'x-proxy-secret':  process.env.PROXY_SECRET ?? '',
            'x-forwarded-for': ip,
          },
          body:   JSON.stringify({ action: 'purge' }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch { /* melhor esforço */ }

      logger.warn('mfa_disabled', PATH, { ip })
      return res.status(200).json({ ok: true, enabled: false })
    }
  }

  return res.status(400).json({ error: 'action inválida' })
}
