// scripts/css-coverage-report.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Transforma um export de Coverage do Chrome DevTools numa lista PRECISA de
// regras CSS que o navegador NUNCA aplicou durante a sessão gravada.
//
// Diferente do coverage-summary.mjs (que dá só % por arquivo), este casa as
// faixas "usadas" do Coverage com o código-fonte (via postcss) e diz, regra a
// regra, quais seletores ficaram 100% fora de qualquer faixa usada → candidatos
// a poda. É o passo que torna o corte de CSS morto SEGURO (verificado, não
// adivinhado) — sem o risco de remover uma classe dinâmica.
//
// ⚠️ LEIA ANTES DE CONFIAR:
//   Uma regra só aparece como "não usada" se o seletor NÃO casou com nenhum
//   elemento DURANTE A SESSÃO GRAVADA. Então a captura precisa EXERCITAR TUDO:
//   todas as abas, modais, estados de erro/vazio/hover, tema claro, tutorial,
//   popups. O que você não abrir vai parecer "morto" mesmo estando vivo.
//   Por isso a saída é uma lista de CANDIDATOS — cruzar com css-unused-candidates.txt
//   e revisar antes de deletar.
//
// USO:
//   node scripts/css-coverage-report.mjs <coverage.json> [minRuleBytes=0]
//   node scripts/css-coverage-report.mjs Coverage-2026....json > css-mortos.txt
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/css-coverage-report.mjs <coverage.json>');
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
  console.error('❌ Esperava um array (export da aba Coverage do DevTools).');
  process.exit(1);
}

// Mapa de (linha,coluna) 1-based → offset em code units (mesmo eixo do Coverage).
function lineOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
const toOffset = (starts, pos) => starts[pos.line - 1] + (pos.column - 1);

// Uma regra está "usada" se QUALQUER byte dela cai numa faixa usada.
function rangeUsed(ranges, start, end) {
  for (const r of ranges) if (r.start < end && r.end > start) return true;
  return false;
}

const cssEntries = data.filter(e => (e.url || '').split('?')[0].endsWith('.css') && e.text);
if (cssEntries.length === 0) {
  console.error('❌ Nenhum arquivo .css com `text` no export. Marque "CSS" no filtro do Coverage e re-exporte.');
  process.exit(1);
}

console.log('\n🎯 CSS morto por regra (Coverage) — CANDIDATOS a poda\n');
console.log('   ⚠️  Só é confiável se a sessão exercitou TODAS as telas/estados.\n');

for (const e of cssEntries) {
  const url = (e.url || '').split('/').pop().split('?')[0];
  const text = e.text;
  const ranges = Array.isArray(e.ranges) ? e.ranges : [];
  const starts = lineOffsets(text);

  let root;
  try { root = postcss.parse(text); }
  catch (err) { console.log(`\n── ${url}: (não parseou: ${err.message})`); continue; }

  const unused = [];
  let totalRules = 0;
  root.walkRules(rule => {
    if (!rule.source?.start || !rule.source?.end) return;
    totalRules++;
    const s = toOffset(starts, rule.source.start);
    const en = toOffset(starts, rule.source.end) + 1;
    if (!rangeUsed(ranges, s, en)) {
      unused.push({ sel: rule.selector.replace(/\s+/g, ' ').slice(0, 120), bytes: en - s });
    }
  });

  unused.sort((a, b) => b.bytes - a.bytes);
  const deadBytes = unused.reduce((n, u) => n + u.bytes, 0);
  console.log(`\n── ${url} — ${unused.length}/${totalRules} regras sem uso · ~${(deadBytes / 1024).toFixed(1)} KB candidatos`);
  for (const u of unused) console.log(`   ✂️  ${u.sel}`);
}
console.log('\n(Cruze estes seletores com css-unused-candidates.txt; os que aparecem nos DOIS são alta confiança.)\n');
