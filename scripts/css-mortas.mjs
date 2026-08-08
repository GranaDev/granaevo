#!/usr/bin/env node
// scripts/css-mortas.mjs — separa CSS morto de CSS que só PARECE morto.
// ─────────────────────────────────────────────────────────────────────────────
// O PROBLEMA COM A LISTA ANTIGA (`css-unused-candidates.txt`)
//   Ela marcava uma classe como candidata quando o nome não aparecia
//   literalmente em nenhum arquivo. O próprio cabeçalho dela avisa: classes
//   montadas em pedaços (`'cat-' + tipo`, `` `alerta-${nivel}` ``) caem ali como
//   falso-positivo. Uma lista de 104 nomes sem distinguir os dois casos não é
//   acionável: apagar em cima dela quebra tela em silêncio, e é justamente o
//   tipo de bug que nenhum teste pega.
//
// O QUE ESTE SCRIPT ACRESCENTA
//   Além de procurar o nome inteiro, ele procura os PREFIXOS do nome como
//   string literal no código. Se `alerta-header` não aparece, mas `'alerta-'`
//   aparece, então alguém pode estar montando esse nome em tempo de execução —
//   e a classe vai para o balde DINÂMICA, não para o de morta.
//
//   Sobra um terceiro balde, MORTA: nome que não aparece inteiro E cujo nenhum
//   prefixo aparece. Essa não tem como ser produzida pelo nosso código.
//
// O QUE ELE NÃO RESOLVE
//   Não substitui o Coverage do DevTools (`css-coverage-report.mjs`), que é a
//   única prova de que a regra nunca casou com um elemento de verdade. Este
//   script diz "o código não consegue nomear esta classe"; o Coverage diz "o
//   navegador nunca a aplicou". Os dois juntos é que dão confiança para deletar.
//
// ⚠️ O DEFAULT ERA UM ARQUIVO SÓ, E ISSO ESCONDEU 34 CLASSES MORTAS POR UMA SEMANA
//   Até 2026-08-08 o alvo padrão era `_db-all.css` — 1 dos 7 CSS do dashboard.
//   Rodar o script dizia "Total morto: 0" com toda a confiança, enquanto os
//   componentes órfãos de duas features (`rf-*` da reserva de família,
//   `saude-*` do semáforo) estavam intactos em `_db-features.css`, que ele
//   nunca abria. O relatório não estava errado — estava respondendo outra
//   pergunta. Agora o default é TUDO; para olhar um arquivo só, passe o caminho.
//
// USO
//   node scripts/css-mortas.mjs                     (default: todos os CSS)
//   node scripts/css-mortas.mjs [arquivo.css]       (um arquivo só)
//   node scripts/css-mortas.mjs --strict            (sai 1 se houver morta)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Onde procurar por uso: tudo que pode nomear uma classe.
const FONTES = ['src/scripts', 'public/scripts', 'src/styles'];
const HTML_NA_RAIZ = readdirSync(RAIZ).filter((f) => f.endsWith('.html'));

function arquivosDe(dir, exts) {
  const abs = join(RAIZ, dir);
  try { statSync(abs); } catch { return []; }
  const anda = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? anda(join(d, e.name))
      : (exts.some((x) => e.name.endsWith(x)) ? [join(d, e.name)] : []));
  return anda(abs);
}

// ── 1. Todo o código que pode citar uma classe ───────────────────────────────
const fontes = [
  ...FONTES.flatMap((d) => arquivosDe(d, ['.js', '.mjs', '.ts'])),
  ...HTML_NA_RAIZ.map((f) => join(RAIZ, f)),
];
const CODIGO = fontes.map((f) => readFileSync(f, 'utf8')).join('\n');

// ── 2. Classes definidas no CSS alvo ─────────────────────────────────────────
// Um caminho explícito restringe; sem ele, varre tudo. `--todos` continua
// aceito para não quebrar quem já o tinha no dedo, mas virou o padrão.
// `resolve` e não `join`: com caminho ABSOLUTO, o join concatena e produz lixo
// ("C:\repo\C:\tmp\x.css"), o readFileSync estoura e o script sai 1 — que é o
// mesmo código de saída do `--strict`. Um crash disfarçado de reprovação passou
// por prova de que a trava funcionava.
const arquivoPedido = process.argv.slice(2).find((a) => !a.startsWith('--'));
const alvo = arquivoPedido
  ? [resolve(RAIZ, arquivoPedido)]
  : arquivosDe('src/styles', ['.css']);

const classes = new Map();   // nome → arquivos que a definem
for (const arq of alvo) {
  const css = readFileSync(arq, 'utf8');
  postcss.parse(css).walkRules((regra) => {
    for (const m of regra.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      const nome = m[1];
      if (!classes.has(nome)) classes.set(nome, new Set());
      classes.get(nome).add(relative(RAIZ, arq));
    }
  });
}

// ── 3. Classificação ─────────────────────────────────────────────────────────
// Prefixos: para `alerta-header`, testa 'alerta-'.
//
// ⚠️ O CORTE MÍNIMO É 2, E ISSO CUSTOU CARO. A primeira versão exigia 3+
// caracteres antes do hífen, com o argumento de que prefixo curto casaria com
// tudo. Consequência: `rf-card`, `rf-icon`, `rf-body` — um componente inteiro
// da reserva de família — apareceram como MORTOS, porque `rf-` (2 letras)
// nunca era testado. Apagar por aquela lista teria removido o CSS de uma
// feature viva.
//
// O medo era infundado: exigir a string literal `'rf-` no código já é
// específico o bastante. O custo de um falso "dinâmico" é revisar uma classe a
// mais; o custo de um falso "morto" é quebrar tela em produção.
function prefixosDe(nome) {
  const saida = [];
  for (let i = 0; i < nome.length; i++) {
    if (nome[i] === '-' && i >= 2) saida.push(nome.slice(0, i + 1));
  }
  return saida;
}

const usadas = [], dinamicas = [], mortas = [];

for (const [nome, arquivos] of classes) {
  // Uso literal: entre aspas, em atributo class, ou como palavra solta.
  const literal = new RegExp(`(^|[^\\w-])${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`);
  if (literal.test(CODIGO)) { usadas.push(nome); continue; }

  const pref = prefixosDe(nome).filter((p) => CODIGO.includes(`'${p}`) || CODIGO.includes(`"${p}`) || CODIGO.includes('`' + p));
  if (pref.length) { dinamicas.push({ nome, pref, arquivos: [...arquivos] }); continue; }

  mortas.push({ nome, arquivos: [...arquivos] });
}

// ── 4. Relatório ─────────────────────────────────────────────────────────────
const pct = (n) => ((n / classes.size) * 100).toFixed(1);
console.log(`CSS analisado: ${alvo.map((a) => relative(RAIZ, a)).join(', ')}`);
console.log(`Classes definidas: ${classes.size}\n`);
console.log(`  USADAS ....... ${String(usadas.length).padStart(4)}  (${pct(usadas.length)}%)  nome aparece no código`);
console.log(`  DINÂMICAS .... ${String(dinamicas.length).padStart(4)}  (${pct(dinamicas.length)}%)  ⚠️ podem ser montadas em runtime — NÃO apagar por esta lista`);
console.log(`  MORTAS ....... ${String(mortas.length).padStart(4)}  (${pct(mortas.length)}%)  nem o nome nem prefixo algum aparecem\n`);

if (dinamicas.length) {
  console.log('── DINÂMICAS (falso-positivo da varredura antiga) ──');
  for (const d of dinamicas.slice(0, 40)) console.log(`  ${d.nome.padEnd(34)} monta via ${d.pref.map((p) => `'${p}…'`).join(', ')}`);
  if (dinamicas.length > 40) console.log(`  … e mais ${dinamicas.length - 40}`);
  console.log('');
}

console.log('── MORTAS (o código não consegue nomear estas) ──');
for (const m of mortas) console.log(`  ${m.nome}`);
console.log(`\nTotal morto: ${mortas.length}`);
console.log('\n⚠️  Antes de deletar: confirme com o Coverage do DevTools');
console.log('   (scripts/css-coverage-report.mjs). Este script prova que o CÓDIGO não');
console.log('   nomeia a classe; o Coverage prova que o NAVEGADOR nunca a aplicou.');

// Mesma convenção do check-dead-code.mjs: relata e sai 0; só o --strict reprova.
// Fora do CI de propósito — escrever o CSS antes do JS que o usa é fluxo normal,
// e um portão que reprova isso ensina a ignorar o portão.
if (process.argv.includes('--strict') && mortas.length) process.exit(1);
