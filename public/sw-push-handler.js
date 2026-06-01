/**
 * GranaEvo — Push Handler para Service Worker
 *
 * Este script é importado no SW principal via importScripts() ou
 * adicionado como customScript no VitePWA config.
 *
 * Anti-abuse:
 *   - Só exibe notificações com dados que vieram do servidor (não do cliente)
 *   - Tag única por tipo previne spam de notificações duplicadas
 *   - requireInteraction: false (não trava a tela)
 *   - Reuse de notificação existente se já há uma do mesmo tipo
 */

// Escutar evento push
self.addEventListener('push', (event) => {
  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch {
    return // payload inválido — ignora silenciosamente
  }

  // Validação mínima do payload
  const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'GranaEvo'
  const body  = typeof data.body  === 'string' ? data.body.slice(0, 200) : ''
  const tag   = typeof data.tag   === 'string' ? data.tag.slice(0, 50)   : 'granaevo-default'
  const url   = typeof data.url   === 'string' && data.url.startsWith('/')
    ? data.url.slice(0, 200)
    : '/dashboard'

  const options = {
    body,
    tag,                              // agrupa notificações do mesmo tipo
    icon:              '/assets/icons/pwa-192.png',
    badge:             '/assets/icons/pwa-192.png',
    renotify:          false,         // não renotifica se já há uma com a mesma tag
    requireInteraction:false,         // fecha sozinho
    silent:            false,
    data:              { url },
    actions: [
      { action: 'open',    title: 'Abrir' },
      { action: 'dismiss', title: 'Dispensar' },
    ],
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  )
})

// Clicar na notificação → abrir o app na URL correta
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'dismiss') return

  const url = event.notification.data?.url ?? '/dashboard'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Se o app já está aberto, focar nele
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.focus()
            client.navigate(url)
            return
          }
        }
        // Senão, abrir nova janela
        if (clients.openWindow) return clients.openWindow(url)
      })
  )
})
