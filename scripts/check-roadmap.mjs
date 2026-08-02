#!/usr/bin/env node
// scripts/check-roadmap.mjs — faz valer a REGRA DE OURO do roadmap.
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTE SCRIPT EXISTE
//   Em 2026-07-31 o roadmap tinha OITO itens marcados 🔴 que já estavam prontos
//   — inclusive o D-3, uma feature completa, ligada em três telas e com 13
//   testes, ainda descrita como "a fazer". Quase foi reconstruída.
//
//   A resposta foi a Regra de Ouro (topo do documento): quatro estados, e todo
//   🟡 obrigado a dizer o que falta. Mas regra que depende de alguém lembrar
//   volta a ser quebrada na terceira semana. Este script tira a lembrança da
//   equação.
//
// O QUE ELE VERIFICA
//   1. Todo 🟡 (PENDENTE) tem `Falta:` logo abaixo. É a regra central: um
//      "quase pronto" que não diz o que falta é exatamente a mentira que a
//      regra existe para matar.
//   2. A Regra de Ouro continua no documento (ninguém apagou sem querer).
//   3. Nenhum marcador fora dos quatro estados + ⛔ (ex.: 🟢, que já foi usado
//      como "quase" e não quer dizer nada).
//
// O QUE ELE NÃO VERIFICA (e é bom saber)
//   Se o status é VERDADE. Nenhum script sabe se um 🔴 já foi feito — isso é a
//   regra dos 2 minutos, humana. Aqui só se garante que a forma é seguível.
//
// USO:  node scripts/check-roadmap.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARQ  = join(RAIZ, 'docs', 'roadmap-melhorias-dev.md');

const linhas = readFileSync(ARQ, 'utf8').split('\n');
const erros  = [];

// ── O bloco da própria regra usa os emojis para explicá-los ─────────────────
const fimDaRegra = linhas.findIndex((l) => /^## Legenda de status/.test(l));
const INICIO = fimDaRegra > 0 ? fimDaRegra : 40;

// Numa linha de TABELA, 🟡/🟢 costumam ser a coluna de ESFORÇO/RISCO ("médio",
// "baixo"), não o status. Status em tabela é sempre a última coluna.
const ehLinhaDeTabela = (l) => /^\s*\|/.test(l);

const statusDeTabela = (l) => {
  const cols = l.split('|').map((c) => c.trim());
  return cols[cols.length - 2] ?? '';   // última célula real
};

// ── 1. Todo 🟡 diz o que falta ───────────────────────────────────────────────
linhas.forEach((linha, i) => {
  if (i < INICIO) return;

  const alvo = ehLinhaDeTabela(linha) ? statusDeTabela(linha) : linha;
  if (!alvo.includes('🟡')) return;

  // A pendência pode vir na mesma linha ou nas próximas — itens têm sub-bullets.
  const janela = linhas.slice(i, i + 10).join(' ');
  if (/Falta:/.test(janela)) return;

  erros.push({
    linha: i + 1,
    regra: '🟡 sem `Falta:`',
    texto: linha.trim().slice(0, 92),
  });
});

// ── 2. A Regra de Ouro continua lá ───────────────────────────────────────────
const texto = linhas.join('\n');
if (!/REGRA DE OURO/.test(texto)) {
  erros.push({ linha: 1, regra: 'Regra de Ouro sumiu do documento', texto: '' });
}
for (const estado of ['NÃO INICIADO', 'INICIADO', 'PENDENTE', 'FINALIZADO']) {
  if (!texto.includes(`**${estado}**`)) {
    erros.push({ linha: 1, regra: `estado "${estado}" não está definido`, texto: '' });
  }
}

// ── 3. Sem marcador fora da regra ────────────────────────────────────────────
// 🟢 já significou "quase pronto" — ambíguo por construção. Na coluna de
// esforço de tabela ele quer dizer "baixo", e ali é legítimo.
linhas.forEach((linha, i) => {
  if (i < INICIO) return;
  const alvo = ehLinhaDeTabela(linha) ? statusDeTabela(linha) : linha;
  if (alvo.includes('🟢')) {
    erros.push({
      linha: i + 1,
      regra: '🟢 não é um dos quatro estados (use 🟡 + Falta:, ou ✅)',
      texto: linha.trim().slice(0, 92),
    });
  }
});

// ── Relatório ────────────────────────────────────────────────────────────────
if (erros.length === 0) {
  console.log('✓ roadmap: Regra de Ouro respeitada (todo 🟡 diz o que falta)');
  process.exit(0);
}

console.error(`\n✗ roadmap: ${erros.length} violação(ões) da Regra de Ouro\n`);
for (const e of erros) {
  console.error(`  docs/roadmap-melhorias-dev.md:${e.linha}`);
  console.error(`    ${e.regra}`);
  if (e.texto) console.error(`    → ${e.texto}`);
}
console.error('\n  🟡 quer dizer "quase pronto". Sem dizer o que falta, é só');
console.error('  otimismo — e foi assim que oito itens prontos ficaram anos');
console.error('  marcados como "a fazer". Escreva `Falta:` ou marque 🔵.\n');
process.exit(1);
