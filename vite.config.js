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
    }
  },
  server: {
    port: 3000,
    open: true
  }
});