import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  publicDir: 'public',

  plugins: [
    // Gera dist/stats.html com mapa visual do bundle (tamanho gzip + brotli por módulo)
    visualizer({
      filename:   'dist/stats.html',
      gzipSize:   true,
      brotliSize: true,
      open:       false,
    }),

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
        globIgnores:  ['workbox-*.js', 'sw.js'],

        // Sem navigate fallback (não interceptar navegação HTML)
        navigateFallback: null,

        // Sem runtime caching de recursos externos.
        // Font Awesome (cdnjs): browser HTTP cache com Cache-Control do CDN ✓
        // Google Fonts: browser HTTP cache ✓
        // Supabase API: sempre rede para dados financeiros frescos ✓
        // Supabase Storage (avatares): browser HTTP cache ✓
        runtimeCaching: [],
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
        convidados:       'convidados.html',
        atualizarplano:   'atualizarplano.html',
        termos:           'termos.html',
        'aceitar-termos': 'aceitar-termos.html',
      },
      output: {
        manualChunks: (id) => {
          // Chart.js em chunk próprio — compartilhado entre dashboard, graficos, relatorios
          if (id.includes('node_modules/chart.js')) {
            return 'vendor-charts';
          }
          // Supabase SDK em chunk próprio — cacheado separado entre páginas.
          // supabase-client.js entra junto para evitar chunk de 0.6 kB que pode 404.
          if (
            id.includes('@supabase/supabase-js') ||
            id.includes('node_modules/@supabase') ||
            id.includes('supabase-client.js')
          ) {
            return 'vendor-supabase';
          }
        },
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
        // Remove chamadas de log residuais
        pure_funcs: ['console.log', 'console.info', 'console.debug'],
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