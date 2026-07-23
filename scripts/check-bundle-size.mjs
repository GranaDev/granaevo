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
  // Passo 10 (2026-07-18): 41,1 → 39,0 KB extraindo o painel de alertas para um
  // chunk lazy. Orçamento baixado 42 → 40 DE PROPÓSITO: da última vez o ganho do
  // Passo 10 foi silenciosamente reocupado por features novas até voltar a 98%.
  // Com 40, quem estourar é obrigado a lazy-ar em vez de engordar o boot.
  'dashboard.js':        40,
  'vendor-supabase.js':  40,   // Passo 8: realtime-js stubado (34,3 KB). Teto baixo TRAVA o ganho — se o realtime real voltar (~48,6), o CI barra.
  // 40 → 43 (2026-07-22): reforma editorial das exportações (PDF/slides).
  // 43 → 41 (2026-07-23): gerarXlsx virou import() dinâmico (chunk xlsx-*.js).
  // 41 → 30 (2026-07-23): as 4 funções de export (PDF/CSV/Excel/slides) + helpers
  // só-de-export saíram para db-relatorios-export.js, carregado sob demanda no
  // clique. db-relatorios caiu 38,5 → 27,6 — MAIS LEVE que os 40 originais. Teto
  // agora bem abaixo do ponto de partida. Polimentos de export (ex.: CSV) caem no
  // chunk de export, não aqui.
  'db-relatorios.js':    30,
  // Sub-chunk lazy das exportações (só baixa no clique de exportar). Teto folgado
  // porque está fora do caminho crítico; ainda assim trava crescimento silencioso.
  'db-relatorios-export.js': 16,
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
