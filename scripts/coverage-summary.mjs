// scripts/coverage-summary.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Condensa o export de Coverage do Chrome DevTools num relatório PEQUENO.
//
// O JSON exportado pela aba Coverage inclui o campo `text` (o código-fonte
// INTEIRO de cada arquivo). Isso infla o arquivo para ~1M tokens e estoura o
// limite do chat. Este script descarta o `text` e mantém só o que importa:
// bytes usados/não usados por arquivo. A saída cabe num colar simples.
//
// USO:
//   node scripts/coverage-summary.mjs caminho/para/Coverage-*.json
//   node scripts/coverage-summary.mjs coverage.json > coverage-resumo.txt
//
// Aí me mande apenas o coverage-resumo.txt (alguns KB), não o JSON cru.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/coverage-summary.mjs <coverage.json>');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`❌ Não consegui ler/parsear ${file}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(data)) {
  console.error('❌ Formato inesperado: esperava um array (export da aba Coverage do DevTools).');
  process.exit(1);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).replace(/^\//, '') || u.host;
  } catch {
    return url;
  }
}

const rows = [];
let totBytes = 0;
let totUsed = 0;

for (const entry of data) {
  // Suporta os dois formatos: ranges[{start,end}] OU functions[].ranges (CDP).
  const total = entry.text ? entry.text.length : (entry.total ?? 0);
  let used = 0;
  if (Array.isArray(entry.ranges)) {
    for (const r of entry.ranges) used += (r.end - r.start);
  }
  if (total === 0) continue;
  const unused = total - used;
  const pct = (used / total) * 100;
  rows.push({ url: shortUrl(entry.url || '(sem url)'), total, used, unused, pct });
  totBytes += total;
  totUsed += used;
}

// Maiores ofensores primeiro (mais bytes não usados = melhor alvo de corte).
rows.sort((a, b) => b.unused - a.unused);

const kb = (n) => (n / 1024).toFixed(1).padStart(8) + ' KB';

console.log('\n📊 Resumo de Coverage (ordenado por bytes NÃO usados)\n');
console.log('  uso%   |   não-usado |      total | arquivo');
console.log('  ' + '─'.repeat(70));
for (const r of rows) {
  console.log(
    `  ${r.pct.toFixed(1).padStart(5)}% | ${kb(r.unused)} | ${kb(r.total)} | ${r.url}`
  );
}

const totUnused = totBytes - totUsed;
const totPct = totBytes ? (totUsed / totBytes) * 100 : 0;
console.log('  ' + '─'.repeat(70));
console.log(
  `  TOTAL: ${totPct.toFixed(1)}% usado · ${(totUnused / 1024).toFixed(1)} KB não usados de ${(totBytes / 1024).toFixed(1)} KB · ${rows.length} arquivos\n`
);
