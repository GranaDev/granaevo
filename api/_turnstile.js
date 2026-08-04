// api/_turnstile.js — validação do captcha da Cloudflare, server-side.
// ---------------------------------------------------------------------------
// Prefixo `_`: a Vercel NÃO conta este arquivo como Serverless Function. Isso
// importa aqui mais do que parece — o plano Hobby aceita 12, e a 13ª congela
// todo o deploy em silêncio (já custou um dia, em 2026-07-25).
//
// Nasceu dentro do `auth-session.js`, servindo só ao login. O cadastro virou o
// segundo chamador (Passo 26), e a política de falha abaixo é sutil demais para
// existir em duas cópias que podem divergir.
// ---------------------------------------------------------------------------

import { logger } from './_logger.js'

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Valida um token do Turnstile contra a Cloudflare.
 *
 * FALHA ABERTO de propósito, e a razão muda um pouco conforme o caminho:
 *
 *   • LOGIN — o lockout por conta continua valendo e barra a força bruta de
 *     qualquer jeito. Falhar fechado trancaria o usuário para fora da própria
 *     conta por uma indisponibilidade de terceiro.
 *   • CADASTRO — o rate limit por IP (3/hora) continua valendo. Falhar fechado
 *     durante uma queda da Cloudflare derrubaria a porta de entrada PAGA do
 *     produto; o custo de recusar um cliente real é maior que o de aceitar
 *     alguns bots durante a janela, já que a camada de baixo segue de pé.
 *
 * Em ambos, o captcha é a camada de CIMA, nunca a única. Se um dia for a única,
 * esta política tem de ser revista junto.
 *
 * @param {string}  token  Resposta do widget (`cf-turnstile-response`).
 * @param {string} [ip]    IP do cliente, para o `remoteip` da Cloudflare.
 * @param {string} [path]  Rota chamadora, só para o log.
 * @returns {Promise<boolean>}
 */
export async function turnstileOk(token, ip, path = 'turnstile') {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    // Sem chave configurada o gate inteiro é no-op — evita que um deploy sem a
    // env var derrube o login de quem errou a senha, ou o cadastro inteiro.
    logger.warn('turnstile_sem_secret', path, {})
    return true
  }
  // Token malformado é recusado SEM consultar a Cloudflare: falhar aberto é
  // para indisponibilidade de terceiro, não para lixo enviado pelo cliente.
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return false

  try {
    const form = new URLSearchParams({ secret, response: token })
    if (ip && ip !== 'unknown') form.set('remoteip', ip)
    const r = await fetch(TURNSTILE_VERIFY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    form,
      signal:  AbortSignal.timeout(8_000),
    })
    if (!r.ok) { logger.warn('turnstile_gateway', path, { status: r.status }); return true }
    const j = await r.json()
    return j?.success === true
  } catch {
    logger.warn('turnstile_timeout', path, {})
    return true          // ver o comentário acima: falha aberto
  }
}
