// push-endpoint.ts — para onde o servidor aceita disparar um push
// ---------------------------------------------------------------------------
// Achado SEC-002 de 2026-08-17: `push_subscriptions.endpoint` era validado
// apenas como "string não-vazia". O `send-radar-push` então fazia POST para o
// que estivesse gravado — ou seja, o endpoint escolhido pelo usuário virava o
// destino de uma requisição de saída do backend (SSRF cego). E o cliente nem
// precisava da Edge Function: tinha INSERT/UPDATE direto na tabela via PostgREST.
//
// POR QUE A REGRA VIVE NUM ARQUIVO SÓ DELA: ela precisa valer em três lugares
// (ao gravar, ao disparar, e no CHECK do banco) e uma regra copiada três vezes
// diverge. Aqui ela é uma função pura — o teste exercita os desfechos em vez de
// procurar palavras no fonte, do mesmo jeito que `teto-blob.ts`.
//
// A LISTA É DE PERMISSÃO, NÃO DE BLOQUEIO. Bloquear "IP interno", "localhost" e
// "169.254.169.254" é jogo de gato e rato que se perde: sobra redirect, DNS
// rebinding, IPv6 mapeado, encurtador. Só existem quatro push services no mundo
// que um navegador pode devolver; qualquer outra coisa é, por definição, não é
// uma subscription de push.
// ---------------------------------------------------------------------------

/**
 * Hosts dos push services reais. Comparação por host EXATO ou por sufixo de
 * domínio (`.notify.windows.com`) — nunca por `includes`, senão
 * `fcm.googleapis.com.evil.test` passaria.
 */
const HOSTS_EXATOS = new Set([
  'fcm.googleapis.com',                    // Chrome / Edge / Android (FCM)
  'android.googleapis.com',                // FCM legado (gcm/send)
  'updates.push.services.mozilla.com',     // Firefox
  'web.push.apple.com',                    // Safari / iOS
])

const SUFIXOS = [
  '.notify.windows.com',          // WNS (Edge legado) — subdomínio por região
  '.push.services.mozilla.com',   // Mozilla — autopush por região
  '.push.apple.com',              // Apple — subdomínio por região
]

export type MotivoRecusa =
  | 'vazio'
  | 'nao_e_url'
  | 'nao_https'
  | 'host_nao_permitido'
  | 'tem_credenciais'
  | 'longo_demais'

// Endpoints reais de FCM ficam em ~200 chars. 2 kB é folgado e ainda impede que
// a coluna vire depósito de dado arbitrário.
export const MAX_ENDPOINT_CHARS = 2048

/**
 * `null` = aceito. Qualquer outra coisa é o motivo da recusa.
 *
 * Devolve o motivo (em vez de um booleano) para que o log do servidor saiba o
 * que aconteceu sem que a resposta ao cliente precise contar — recusa sempre
 * responde a mesma coisa lá fora.
 */
export function recusarEndpointPush(endpoint: unknown): MotivoRecusa | null {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return 'vazio'
  if (endpoint.length > MAX_ENDPOINT_CHARS) return 'longo_demais'

  let u: URL
  try { u = new URL(endpoint) } catch { return 'nao_e_url' }

  if (u.protocol !== 'https:') return 'nao_https'

  // `https://fcm.googleapis.com@evil.test/` tem hostname evil.test, mas um leitor
  // humano jura que é o FCM. A URL já resolve isso, e a recusa explícita evita
  // que alguém "simplifique" a checagem depois.
  if (u.username !== '' || u.password !== '') return 'tem_credenciais'

  const host = u.hostname.toLowerCase()
  if (HOSTS_EXATOS.has(host)) return null
  if (SUFIXOS.some((s) => host.endsWith(s))) return null

  return 'host_nao_permitido'
}

/** Açúcar para os call sites que só querem o sim/não. */
export function endpointPushValido(endpoint: unknown): boolean {
  return recusarEndpointPush(endpoint) === null
}
