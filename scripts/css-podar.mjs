#!/usr/bin/env node
// scripts/css-podar.mjs — remove do CSS as classes provadas mortas (O-2).
// ─────────────────────────────────────────────────────────────────────────────
// Recebe a lista de classes e apaga o que se refere a elas. O cuidado que
// justifica um script em vez de um find/replace:
//
//   1. UM SELETOR MORTO NÃO SIGNIFICA REGRA MORTA. `.viva, .morta { … }` tem
//      duas metades: remover a regra inteira apagaria estilo em uso. Aqui cada
//      seletor da vírgula é avaliado sozinho, e a regra só cai quando TODOS
//      morrem.
//
//   2. SELETOR COMPOSTO MORRE INTEIRO. `#pagina .header .morta` nunca casa se
//      `.morta` nunca é aplicada — então o seletor todo vai embora, mesmo com
//      partes vivas dentro dele.
//
//   3. @media/@supports que ficam VAZIOS depois da poda também saem: bloco
//      vazio é lixo que sobrevive a todo minificador.
//
// USO
//   node scripts/css-podar.mjs <arquivo.css> <classe1,classe2,…> [--aplicar]
//   Sem --aplicar é simulação: mostra o que sairia e quantos bytes.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';

const [arquivo, listaRaw] = process.argv.slice(2);
const APLICAR = process.argv.includes('--aplicar');

if (!arquivo || !listaRaw) {
  console.error('Uso: node scripts/css-podar.mjs <arquivo.css> <classe1,classe2,…> [--aplicar]');
  process.exit(1);
}

const mortas = new Set(listaRaw.split(',').map((s) => s.trim()).filter(Boolean));
const original = readFileSync(arquivo, 'utf8');
const raiz = postcss.parse(original);

const seletorTemMorta = (sel) => {
  for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (mortas.has(m[1])) return true;
  }
  return false;
};

let regrasRemovidas = 0, seletoresRemovidos = 0, blocosVazios = 0;
const removidas = [];

raiz.walkRules((regra) => {
  // `selectors` já separa pela vírgula respeitando parênteses.
  const vivos = regra.selectors.filter((s) => !seletorTemMorta(s));
  if (vivos.length === regra.selectors.length) return;

  if (vivos.length === 0) {
    removidas.push(regra.selector.replace(/\s+/g, ' ').slice(0, 90));
    regrasRemovidas++;
    regra.remove();
  } else {
    seletoresRemovidos += regra.selectors.length - vivos.length;
    regra.selectors = vivos;   // sobrevive só a parte viva
  }
});

// Blocos que ficaram vazios (@media, @supports, @layer…)
let mudou = true;
while (mudou) {
  mudou = false;
  raiz.walkAtRules((at) => {
    if (at.nodes && at.nodes.length === 0) { at.remove(); blocosVazios++; mudou = true; }
  });
}

const novo = raiz.toString();
const economia = original.length - novo.length;

console.log(`arquivo ............... ${arquivo}`);
console.log(`classes alvo .......... ${mortas.size}`);
console.log(`regras removidas ...... ${regrasRemovidas}`);
console.log(`seletores podados ..... ${seletoresRemovidos}  (regra sobreviveu com o resto)`);
console.log(`blocos @ esvaziados ... ${blocosVazios}`);
console.log(`bytes ................. ${original.length} → ${novo.length}  (−${economia}, ${((economia / original.length) * 100).toFixed(1)}%)`);

if (removidas.length) {
  console.log('\n── regras removidas ──');
  for (const r of removidas.slice(0, 30)) console.log('  ' + r);
  if (removidas.length > 30) console.log(`  … e mais ${removidas.length - 30}`);
}

// Trava: se a poda comeu mais de 12% do arquivo, algo casou demais.
if (economia / original.length > 0.12) {
  console.error('\n❌ ABORTADO: a poda removeria mais de 12% do arquivo.');
  console.error('   Com 19 classes num CSS de ~9.800 linhas isso é impossível — ');
  console.error('   quase certo que um nome da lista casa mais do que deveria.');
  process.exit(1);
}

if (!APLICAR) { console.log('\n(simulação — rode com --aplicar para escrever)'); process.exit(0); }
writeFileSync(arquivo, novo);
console.log('\n✅ escrito.');
