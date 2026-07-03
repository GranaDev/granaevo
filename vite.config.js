import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  publicDir: 'public',

  plugins: [
    // ─── CSS STREAMING (lógica GTA) ─────────────────────────────────────────
    // Tira o CSS pesado do dashboard (~285 KB) do caminho crítico de render.
    // O Vite injeta o <link rel="stylesheet"> hasheado como render-blocking;
    // aqui reescrevemos para media="print" (baixa sem bloquear paint) + marca
    // data-async-style. O css-boot.js troca para media="all" assim que carrega.
    // O loader já é pintado pelo CSS crítico inline no <head> → zero tela branca.
    // Escopo: SOMENTE dashboard.html (demais páginas seguem padrão normal).
    {
      name: 'async-dashboard-css',
      enforce: 'post',
      transformIndexHtml(html, ctx) {
        const file = ctx?.filename || ctx?.path || '';
        if (!/dashboard\.html$/.test(file)) return html;
        let changed = false;
        const out = html.replace(
          /<link\s+rel="stylesheet"((?:(?!data-async-style)[^>])*?)href="([^"]+\.css(?:\?[^"]*)?)"((?:(?!data-async-style)[^>])*?)>/g,
          (m, pre, href, post) => {
            // não mexer em links já marcados ou já com media definido
            if (/\bmedia=/.test(pre + post)) return m;
            changed = true;
            return `<link rel="stylesheet"${pre}href="${href}"${post} media="print" data-async-style>` +
                   `<noscript><link rel="stylesheet" href="${href}"></noscript>`;
          }
        );
        return changed ? out : html;
      },
    },

    // Gera dist/stats.html com mapa visual do bundle (tamanho gzip + brotli por módulo).
    // GATEADO por env: SÓ roda quando você pede análise (ANALYZE=1 npm run build).
    // O build de produção na Vercel (npm run build) NUNCA emite stats.html — assim o
    // blueprint do bundle não fica público em /stats.html. Confiar em código, não no
    // .vercelignore (que filtra upload de source, não a saída do build rodado no servidor).
    ...(process.env.ANALYZE
      ? [visualizer({
          filename:   'dist/stats.html',
          gzipSize:   true,
          brotliSize: true,
          open:       false,
        })]
      : []),

    // PWA: Service Worker + Web App Manifest
    // Ativa instalação como app nativo em iOS/Android/Desktop
    VitePWA({
      registerType: 'autoUpdate',
      // Inclui o SW no build sem bloquear o carregamento inicial
      injectRegister: 'script-defer',
      // assets do SW ficam em /sw.js na raiz (mais fácil de referenciar)
      filename: 'sw.js',
      manifest: {
        name:             'GranaEvo — Controle Financeiro',
        short_name:       'GranaEvo',
        description:      'Domine suas finanças com inteligência. Controle gastos, metas e investimentos.',
        theme_color:      '#10b981',
        background_color: '#0a0b14',
        display:          'standalone',
        orientation:      'portrait-primary',
        lang:             'pt-BR',
        start_url:        '/dashboard',
        scope:            '/',
        id:               '/',
        icons: [
          {
            src:   '/assets/icons/pwa-192.png',
            sizes: '192x192',
            type:  'image/png',
            purpose: 'any',
          },
          {
            src:   '/assets/icons/pwa-512.png',
            sizes: '512x512',
            type:  'image/png',
            purpose: 'any maskable',
          },
        ],
        shortcuts: [
          {
            name:       'Dashboard',
            short_name: 'Home',
            url:        '/dashboard.html',
            icons:      [{ src: '/assets/icons/pwa-192.png', sizes: '192x192' }],
          },
        ],
        categories: ['finance', 'productivity'],
      },
      workbox: {
        // ─── ESTRATÉGIA CONSERVADORA ────────────────────────────────────────────
        // Problema anterior: cachear HTML, CDN e Supabase causou:
        //   1. Ícones Font Awesome sumindo (resposta opaca do CDN ficou em cache corrompido)
        //   2. Dados financeiros não atualizando (HTML/JS servido do cache, não do servidor)
        //
        // Regra: SOMENTE cachear assets do build com hash de conteúdo (JS/CSS).
        // Tudo mais — HTML, CDN externo, Supabase API — passa diretamente pela rede.
        // ────────────────────────────────────────────────────────────────────────

        // Força ativação imediata sem esperar o usuário fechar abas
        skipWaiting:          true,
        clientsClaim:         true,
        // Remove entradas de precache antigas automaticamente
        cleanupOutdatedCaches: true,

        // SOMENTE os assets do build (JS e CSS com hash de conteúdo).
        // HTML EXCLUÍDO intencionalmente: sempre buscar HTML fresco do servidor
        //   garante que o usuário sempre receba a versão mais nova do app.
        // Imagens, woff2, CDN EXCLUÍDOS: browser HTTP cache é suficiente e
        //   não tem risco de resposta opaca corrompida.
        globPatterns: ['assets/**/*.{js,css}'],
        globIgnores:  ['workbox-*.js', 'sw.js', 'stats.html'],

        // Sem navigate fallback (não interceptar navegação HTML)
        navigateFallback: null,

        // Runtime caching limitado a recursos estáticos que N��O carregam dados financeiros:
        //   - Google Fonts CSS: StaleWhileRevalidate (atualiza silenciosamente em background)
        //   - Google Fonts webfonts (.woff2): CacheFirst (imutáveis por design — URLs incluem hash)
        // NÃO cacheado: Supabase API, HTML, CDN de scripts — dados financeiros devem ser frescos.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'ge-fonts-css',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 }, // 30 dias
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ge-fonts-woff2',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }, // 1 ano
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // Injeta handler de push events no Service Worker
        importScripts: ['/sw-push-handler.js'],
      },
      // Dev mode: sem SW em desenvolvimento (evita conflito com HMR)
      devOptions: {
        enabled: false,
      },
    }),
  ],

  build: {
    // [CSP-FIX] Desabilita polyfill de modulepreload que injeta scripts data:URI
    // bloqueados pela CSP (script-src 'self' não permite data:).
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main:             'index.html',
        planos:           'planos.html',
        login:            'login.html',
        privacidade:      'privacidade.html',
        dashboard:        'dashboard.html',
        assistente:       'assistente.html',
        convidados:       'convidados.html',
        atualizarplano:   'atualizarplano.html',
        termos:           'termos.html',
        'aceitar-termos': 'aceitar-termos.html',
      },
      output: {
        manualChunks: (id) => {
          // Chart.js NÃO entra aqui: é servido como UMD self-hosted de
          // public/scripts/vendor/chart.umd.min.js (carregado sob demanda por
          // db-graficos.js). Nunca é importado como ESM — sem chunk vendor-charts.
          // Supabase SDK em chunk próprio — cacheado separado entre páginas.
          // supabase-client.js entra junto para evitar chunk de 0.6 kB que pode 404.
          if (
            id.includes('@supabase/supabase-js') ||
            id.includes('node_modules/@supabase') ||
            id.includes('supabase-client.js')
          ) {
            return 'vendor-supabase';
          }
          // Sentry em chunk separado — só carregado se houver erro, não bloqueia LCP
          if (id.includes('@sentry')) {
            return 'vendor-sentry';
          }
        },
        // Nomes legíveis em produção sem hash nos chunks vendor (cache-friendly)
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // esnext: tree shaking e output mais compacto que es2020
    target: 'esnext',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console:  true,
        drop_debugger: true,
        passes:        2,
        pure_getters:  true,
        unsafe_math:   false,
        // Remove chamadas de log residuais
        pure_funcs: ['console.log', 'console.info', 'console.debug', 'console.warn'],
      },
      mangle: {
        // Reduz nomes de variáveis internas para strings menores
        toplevel: false,
      },
      format: {
        comments: false,
      },
    },
    sourcemap: false,
    // Alerta quando qualquer chunk ultrapassa 200 KB comprimido — disciplina de bundle
    chunkSizeWarningLimit: 200,
    // Mostra tamanho gzip de cada chunk no output do build
    reportCompressedSize: true,
    cssCodeSplit: true,
    // Vite 8 usa LightningCSS por padrão — mantém esbuild para compatibilidade
    // com !important em múltiplos valores de transition.
    cssMinify: 'esbuild',
  },

  // Otimiza dependências internas do dev server (pre-bundling).
  // chart.js NÃO entra: é UMD self-hosted (public/), nunca importado como ESM.
  optimizeDeps: {
    include: ['@supabase/supabase-js'],
  },

  server: {
    port: 3000,
    open: true,
    host: true,
  },

  preview: {
    port: 4173,
    host: true,
  },
}));