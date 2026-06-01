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

/** true se o browser suporta Web Push */
export function isPushSupported() {
  return 'serviceWorker' in navigator &&
         'PushManager'   in window &&
         'Notification'  in window
}

/** Retorna o estado atual da permissão */
export function getPushPermission() {
  if (!('Notification' in window)) return 'not-supported'
  return Notification.permission // 'default' | 'granted' | 'denied'
}

/**
 * Solicita permissão e cria subscription.
 * Só chamar após interação do usuário (clique em botão).
 *
 * @param {string} authToken — JWT do usuário autenticado
 * @returns {Promise<'granted'|'denied'|'not-supported'|'error'>}
 */
export async function requestPushPermission(authToken) {
  if (!isPushSupported() || !VAPID_PUBLIC_KEY) return 'not-supported'

  // Não pedir permissão novamente se já foi concedida nesta sessão
  if (sessionStorage.getItem(SESSION_KEY) === 'true' &&
      Notification.permission === 'granted') {
    return 'granted'
  }

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'

    const registration = await navigator.serviceWorker.ready

    // Verificar se já tem subscription ativa
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      await _saveSubscription(existing, authToken)
      sessionStorage.setItem(SESSION_KEY, 'true')
      return 'granted'
    }

    // Criar nova subscription
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })

    await _saveSubscription(subscription, authToken)
    sessionStorage.setItem(SESSION_KEY, 'true')
    return 'granted'

  } catch (err) {
    if (err.name === 'NotAllowedError') return 'denied'
    console.error('[PUSH] Erro ao criar subscription:', err?.message)
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
