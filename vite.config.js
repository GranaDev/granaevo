import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        planos: 'planos.html',
        login: 'login.html',
        primeiroacesso: 'primeiroacesso.html',
        dashboard: 'dashboard.html'
      },
      output: {
        // Extrai o Supabase JS num chunk próprio (cacheado separado entre páginas)
        manualChunks: {
          'vendor-supabase': ['./src/scripts/services/supabase-client.js'],
        },
      },
    },
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: {
        // Remove todos os console.* no build de produção — reduz bundle e evita
        // vazamento de logs com dados internos para usuários finais
        drop_console: true,
        drop_debugger: true,
        passes: 2,
      },
      format: {
        comments: false,
      },
    },
    sourcemap: false,
    chunkSizeWarningLimit: 500,
    cssCodeSplit: true,
  },
  server: {
    port: 3000,
    open: true,
    host: true
  },
  preview: {
    port: 4173,
    host: true
  }
});