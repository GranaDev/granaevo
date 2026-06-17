// scripts/build-light-theme.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Extrai o TEMA CLARO do caminho crítico do dashboard.
//
// Problema: _db-light-theme.css (~66 KB) era @import dentro de _db-all.css, ou
// seja, render-blocking para 100% dos usuários — inclusive a maioria que usa o
// tema ESCURO e nunca aplica nenhuma daquelas regras [data-theme="light"].
//
// Solução: minifica esse CSS para um asset estático com URL estável
// (public/assets/css/db-light-theme.css) que é carregado SOMENTE quando
// theme-init.js detecta data-theme="light" (ver public/theme-init.js).
// Resultado: −66 KB do paint inicial para quem usa tema escuro, sem FOUC para
// quem usa tema claro (link injetado síncrono no <head>).
//
// CSP-safe: nenhum <style>/<script> inline; apenas um <link> externo on-demand.
// Roda no `prebuild` junto dos subsets de fonte/FA — nunca fica desatualizado.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { transform } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const SRC  = join(ROOT, 'src', 'styles', 'dashboard', '_db-light-theme.css');
const OUT_DIR = join(ROOT, 'public', 'assets', 'css');
const OUT  = join(OUT_DIR, 'db-light-theme.css');

const raw = readFileSync(SRC, 'utf8');

const { code } = await transform(raw, {
  loader: 'css',
  minify: true,
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, code, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`[light-theme] ${kb(raw.length)} → ${kb(code.length)} minificado → ${OUT}`);
