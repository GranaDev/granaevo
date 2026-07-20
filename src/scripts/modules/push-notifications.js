/**
 * GranaEvo — Web Push Notifications (cliente)
 *
 * Fluxo:
 *   1. Verificar suporte do browser (ServiceWorker + PushManager)
 *   2. Solicitar permissão ao usuário (só após interação)
 *   3. Criar subscription via PushManager.subscribe() com VAPID public key
 *   4. Enviar subscription para /api/push-subscribe
 *   5. Salvar estado em sessionStorage (não pedir novamente na sessão)
 *
 * Segurança:
 *   - VAPID public key é pública por design (não é segredo)
 *   - Subscription object não contém dados financeiros
 *   - Rate limit no servidor (10 req/min)
 *   - Máximo 10 dispositivos por usuário (servidor impõe)
 */

// VAPID Public Key — gerada em setup e armazenada como env var pública
// Instrução: gerar com `npx web-push generate-vapid-keys` e colocar
// VITE_VAPID_PUBLIC_KEY no .env como variável pública (não é segredo)
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

// Consolidado em /api/user-data para respeitar o limite de 12 funções Vercel Hobby
const PUSH_SUBSCRIBE_URL = '/api/user-data'
const SESSION_KEY        = 'ge:push_subscribed'

// Último motivo real de falha ao ativar o push. Existe porque a ativação falhava
// em SILÊNCIO: a UI dizia só "não foi possível" e não havia como saber se o furo
// era permissão, Service Worker, VAPID ou a gravação no servidor — e sem isso não
// dá para consertar o que não se enxerga (2026-07-20).
let _ultimoErro = '';

/** Motivo da última falha de ativação (string curta, para exibir/depurar). */
export function getUltimoErroPush() {
  return _ultimoErro;
}

/** true se o browser suporta Web Push */
export function isPushSupported() {
  return 'serviceWorker' in navigator &&
         'PushManager'   in window &&
         'Notification'  in window
}

/** Retorna o estado da PERMISSÃO do browser (não é o estado do push — ver getPushState) */
export function getPushPermission() {
  if (!('Notification' in window)) return 'not-supported'
  return Notification.permission // 'default' | 'granted' | 'denied'
}

/**
 * Estado REAL do push, baseado na SUBSCRIPTION ativa — não na permissão.
 *
 * POR QUE ISTO EXISTE (2026-07-20): o toggle antes lia `Notification.permission`.
 * Mas "permissão concedida" ≠ "inscrito para receber push": o usuário pode ter
 * dado permissão e a subscription nunca ter sido criada/salva (0 linhas no
 * servidor). Aí o toggle mostrava "Ativas" mentindo, e desativar não fazia nada
 * (revogar permissão é impossível via JS). A verdade é: existe PushSubscription?
 *
 * @returns {Promise<'on'|'off'|'denied'|'not-supported'>}
 *   'on'  = há subscription ativa (push chega com o app fechado)
 *   'off' = sem subscription (mesmo que a permissão esteja 'granted')
 */
export async function getPushState() {
  if (!isPushSupported() || !VAPID_PUBLIC_KEY) return 'not-supported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return sub ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

/**
 * Solicita permissão, cria a subscription e a PERSISTE no servidor.
 * Só chamar após interação do usuário (clique em botão).
 *
 * Sem o curto-circuito de sessão da versão antiga: ele devolvia 'granted' SEM
 * salvar quando o flag de sessão existia — então, se o primeiro save falhou, a
 * subscription nunca era persistida e o push nunca funcionava (0 linhas). Agora
 * SEMPRE garante subscription + save; se o save falhar, retorna 'error' (a UI
 * não mente "ativado").
 *
 * @param {string} authToken — JWT do usuário autenticado
 * @returns {Promise<'granted'|'denied'|'not-supported'|'error'>}
 */
export async function requestPushPermission(authToken) {
  _ultimoErro = ''
  if (!isPushSupported()) { _ultimoErro = 'navegador sem suporte a Web Push'; return 'not-supported' }
  if (!VAPID_PUBLIC_KEY)  { _ultimoErro = 'VAPID public key ausente no build';  return 'not-supported' }

  try {
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
    if (permission !== 'granted') { _ultimoErro = 'permissão negada'; return 'denied' }

    // Service Worker precisa estar ATIVO — sem ele não há pushManager. Trava
    // aqui se o SW não subir (foi o que aconteceu quando o SW quebrou).
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Service Worker não ficou pronto em 10s')), 10_000)),
    ])

    // Reaproveita a subscription existente ou cria uma nova.
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }

    // Persistência é OBRIGATÓRIA e sem atalho: sem linha no servidor, não há push.
    await _saveSubscription(subscription, authToken)
    sessionStorage.setItem(SESSION_KEY, 'true')
    return 'granted'

  } catch (err) {
    if (err.name === 'NotAllowedError') { _ultimoErro = 'permissão negada'; return 'denied' }
    _ultimoErro = String(err?.message || err || 'erro desconhecido').slice(0, 160)
    console.error('[PUSH] Erro ao ativar push:', _ultimoErro)
    return 'error'
  }
}

/**
 * Remove subscription do servidor e do browser.
 * @param {string} authToken
 */
export async function unsubscribePush(authToken) {
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return

    // Notificar servidor primeiro (POST com action — /api/user-data não aceita DELETE)
    await fetch(PUSH_SUBSCRIBE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ action: 'push-unsubscribe', endpoint: subscription.endpoint }),
    })

    // Depois cancelar no browser
    await subscription.unsubscribe()
    sessionStorage.removeItem(SESSION_KEY)
  } catch (err) {
    console.error('[PUSH] Erro ao cancelar subscription:', err?.message)
  }
}

// ── Internos ──────────────────────────────────────────────────────────────────

async function _saveSubscription(subscription, authToken) {
  const { endpoint, keys } = subscription.toJSON()
  if (!keys) throw new Error('Subscription sem chaves — browser não suporta VAPID')

  const res = await fetch(PUSH_SUBSCRIBE_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      action:    'push-subscribe',
      endpoint,
      p256dh:    keys.p256dh,
      auth:      keys.auth,
      userAgent: navigator.userAgent.slice(0, 256),
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
}

/** Converte VAPID public key de base64url para Uint8Array */
function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw     = atob(base64)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}
