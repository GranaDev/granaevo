import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'landingpage.html',
        planos: 'planos.html',
        login: 'login.html',
        primeiroacesso: 'primeiroacesso.html',
        dashboard: 'dashboard.html'
      }
    },
    target: 'es2015',
    minify: 'terser',
    sourcemap: false,
    chunkSizeWarningLimit: 1000
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