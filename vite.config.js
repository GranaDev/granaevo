import { defineConfig } from 'vite';

export default defineConfig({
  // Arquivos de public/ são copiados para dist/ na raiz.
  // Referências em HTML/CSS usam /assets/... (sem o prefixo /public/).
  publicDir: 'public',

  build: {
    // [CSP-FIX] Desabilita polyfill de modulepreload que injeta scripts data:URI
    // bloqueados pela CSP (script-src 'self' não permite data:).
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main:           'index.html',
        planos:         'planos.html',
        login:          'login.html',
        privacidade:    'privacidade.html',
        dashboard:      'dashboard.html',
        convidados:     'convidados.html',
        atualizarplano: 'atualizarplano.html',
        termos:         'termos.html',
      },
      output: {
        // Supabase JS em chunk próprio — cacheado separado entre páginas.
        // Vite 8 (Rolldown) exige função em vez de objeto para manualChunks.
        manualChunks: (id) => {
          // supabase-client.js (wrapper de configuração) entra no mesmo chunk
          // do vendor para evitar chunk separado de 0.6 kB que pode 404 em CDN.
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
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: {
        // Remove todos os console.* em produção — evita vazamento de logs
        drop_console: true,
        drop_debugger: true,
        passes: 2,
      },
      format: {
        comments: false,
      },
    },
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    cssCodeSplit: true,
    // Vite 8 usa LightningCSS por padrão — mais estrito que esbuild com !important
    // em múltiplos valores de transition. Mantém esbuild para compatibilidade.
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
});