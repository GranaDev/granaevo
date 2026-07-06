/* assistant-sw.js — Service Worker INDEPENDENTE do "Assistente GranaEvo".
 * ---------------------------------------------------------------------------
 * Escopo: /assistente (registrado com { scope: '/assistente' }). É totalmente
 * separado do sw.js do site principal (que tem escopo "/"). Quando os dois
 * coexistem no mesmo device, o navegador entrega o controle da página
 * /assistente a ESTE SW (o escopo mais específico vence). Assim o "app" do
 * assistente instala e funciona como um PWA próprio — identidade, cache e
 * offline independentes do resto do site.
 *
 * Objetivo duplo:
 *   1) Existir com um handler de `fetch` → satisfaz o critério de
 *      instalabilidade do Chrome/Edge → o botão "Baixar" recebe o prompt nativo.
 *   2) App-shell offline: abrir /assistente sem rede continua funcionando.
 *
 * REGRA DE OURO respeitada: nada de dado financeiro é cacheado. As chamadas ao
 * Supabase são cross-origin e passam DIRETO pela rede (nunca interceptadas).
 */

const CACHE = 'ge-assistant-v1';
const SHELL = '/assistente';

// Recursos estáveis (não-hasheados) do app-shell. Os bundles JS/CSS hasheados
// entram no cache sob demanda no fetch (são imutáveis por conteúdo).
const PRECACHE = [
  '/assistente',
  '/assistente.webmanifest',
  '/pwa-init.js',
  '/assets/icons/pwa-192.png',
  '/assets/icons/pwa-512.png',
  '/assets/icons/favicon.png',
];

// ── Install: pré-cacheia o shell (tolerante a 404 individual) ────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    )
  );
});

// ── Activate: remove caches antigos SÓ deste SW e assume o controle ──────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('ge-assistant-') && k !== CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Só mexe em same-origin. Supabase / APIs externas passam direto (dado sempre fresco).
  if (url.origin !== self.location.origin) return;

  // Navegação (abrir o app): network-first → cai pro shell em cache quando offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(SHELL, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(SHELL)) || Response.error();
      }
    })());
    return;
  }

  // Assets do build (imutáveis por hash), ícones, manifest e pwa-init:
  // cache-first com revalidação em background (stale-while-revalidate).
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/assistente.webmanifest' ||
    url.pathname === '/pwa-init.js'
  ) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })());
    return;
  }

  // Qualquer outra coisa: deixa a rede resolver (sem interceptar).
});

// Permite que a página peça ativação imediata de uma nova versão do SW.
self.addEventListener('message', (event) => {
  if (event.data === 'ge-skip-waiting') self.skipWaiting();
});
