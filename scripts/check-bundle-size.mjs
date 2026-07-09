// scripts/check-bundle-size.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Guard de tamanho de bundle (BLINDAGEM de performance).
// Roda no `postbuild`: mede o gzip de cada asset crítico do dist/ e falha
// (exit 1) se algum estourar o orçamento. Impede que CSS/JS morto volte a
// crescer silenciosamente — análogo ao /god-eyes, mas para peso de página.
//
// Para ajustar um teto, edite BUDGETS_KB abaixo. Mantenha ~15% de folga.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist', 'assets');

// Orçamentos por PREFIXO de arquivo (sem hash), em KB de gzip.
const BUDGETS_KB = {
  'dashboard.css':       66,   // tela do pagante — alvo principal
  // 42 (2026-07-08): +9 conquistas no engine estatico (predicados) + sanitizadores
  // de config/desafios no load path. Recursos novos (radar/previsao/desafios/
  // horas-vida/simulador/recorrencias) sao TODOS chunks lazy — nao pesam aqui.
  'dashboard.js':        42,
  'vendor-supabase.js':  56,
  'db-relatorios.js':    40,
  'main.css':            14,
  'convidados.css':      20,
};

function gzipKB(file) {
  return gzipSync(readFileSync(file)).length / 1024;
}

// Casa cada arquivo do dist com seu prefixo de orçamento (ignora o -hash).
const files = readdirSync(DIST);
let failed = false;
const rows = [];

for (const [prefix, budget] of Object.entries(BUDGETS_KB)) {
  const dot = prefix.lastIndexOf('.');
  const base = prefix.slice(0, dot);          // ex.: "dashboard"
  const ext  = prefix.slice(dot);             // ex.: ".css"
  const match = files.find(f => f.startsWith(base + '-') && f.endsWith(ext));
  if (!match) { rows.push(`  ⚠️  ${prefix.padEnd(22)} não encontrado no dist`); continue; }
  const kb = gzipKB(join(DIST, match));
  const over = kb > budget;
  if (over) failed = true;
  const pct = Math.round((kb / budget) * 100);
  rows.push(`  ${over ? '❌' : '✅'} ${prefix.padEnd(22)} ${kb.toFixed(1).padStart(6)} KB / ${budget} KB  (${pct}%)`);
}

console.log('\n📦 Bundle budget (gzip):');
console.log(rows.join('\n'));

if (failed) {
  console.error('\n❌ Orçamento de bundle estourado. Reduza o asset ou ajuste BUDGETS_KB em scripts/check-bundle-size.mjs (com justificativa).');
  process.exit(1);
}
console.log('\n✅ Todos os assets dentro do orçamento.\n');
