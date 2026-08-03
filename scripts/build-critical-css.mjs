#!/usr/bin/env node
// scripts/build-critical-css.mjs — CSS crítico da landing, GERADO (O-2)
// ─────────────────────────────────────────────────────────────────────────────
// O PROBLEMA QUE ISTO RESOLVE
//   Na landing, o elemento que define o LCP é o logo dentro da tela de
//   carregamento. Ele só pode ser pintado depois que o CSS externo (12 KB gzip)
//   baixa e é processado — ou seja, o LCP fica preso atrás de uma folha de
//   estilo inteira, sendo que o loader precisa de ~40 linhas dela.
//
//   A técnica (a mesma já usada no dashboard, via public/css-boot.js): inline
//   só o crítico, e o resto vai com `media="print"` — que baixa SEM bloquear a
//   pintura — virando `media="all"` quando chega.
//
// POR QUE GERADO, E NÃO COPIADO À MÃO
//   O dashboard tem o crítico escrito à mão no HTML, com os valores das cores
//   resolvidos. Funciona, mas cria DUAS cópias da mesma regra: mude o loader no
//   CSS e o inline fica velho, em silêncio. Este projeto já foi mordido por
//   exatamente isso quando o tema claro foi extraído (regressão do toggle,
//   commit 4ac7c64).
//
//   Aqui o crítico é derivado do próprio `_loading.css` a cada build, com as
//   variáveis resolvidas. Uma fonte só: mudou o loader, o inline muda junto.
//
// AS VARIÁVEIS SÃO RESOLVIDAS EM CADEIA
//   `--primary: var(--color-primary)` → `--color-primary: #10b981`. Sem
//   resolver recursivamente, o inline sairia com `var(--primary)` apontando
//   para nada (os tokens ainda não carregaram) e o loader nasceria sem cor.
//
// USO:  node scripts/build-critical-css.mjs   (roda no prebuild)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');

const MARCA_INI = '<!-- CRITICAL-CSS:START (gerado por scripts/build-critical-css.mjs — não editar à mão) -->';
const MARCA_FIM = '<!-- CRITICAL-CSS:END -->';

// ── 1. Tabela de variáveis, de todos os arquivos que declaram tokens ────────
function tabelaDeVariaveis(arquivos) {
  const mapa = new Map();
  for (const arq of arquivos) {
    for (const m of ler(...arq).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
      // A PRIMEIRA definição vence: os overrides de tema claro vêm depois no
      // arquivo, e o loader é pintado antes de qualquer tema ser escolhido.
      if (!mapa.has(m[1])) mapa.set(m[1], m[2].trim());
    }
  }
  return mapa;
}

/** Resolve `var(--x)` em cadeia. Para em 10 níveis: ciclo em CSS existe. */
function resolver(valor, mapa, nivel = 0) {
  if (nivel > 10) return valor;
  return valor.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (todo, nome, fallback) => {
    const achado = mapa.get(nome);
    if (achado) return resolver(achado, mapa, nivel + 1);
    if (fallback) return resolver(fallback.trim(), mapa, nivel + 1);
    return todo;   // não achou: deixa como está, para o erro ser visível
  });
}

// ── 2. Monta o crítico ──────────────────────────────────────────────────────
const vars = tabelaDeVariaveis([
  ['src', 'styles', '_tokens.css'],
  ['src', 'styles', 'landing', '_variables.css'],
]);

let critico = ler('src', 'styles', 'landing', '_loading.css');
critico = resolver(critico, vars);

// Minificação conservadora: comentários e espaço em branco. Nada de reescrever
// seletor ou reordenar regra — CSS crítico quebrado é página sem estilo.
critico = critico
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s*([{}:;,])\s*/g, '$1')
  .replace(/;}/g, '}')
  .replace(/\s+/g, ' ')
  .trim();

const sobrou = critico.match(/var\(--[\w-]+\)/g);
if (sobrou) {
  console.error('\n❌ critical-css: variável não resolvida — o loader nasceria sem estilo:');
  console.error('   ' + [...new Set(sobrou)].join(', '));
  console.error('   Confira se o token existe em _tokens.css ou landing/_variables.css.\n');
  process.exit(1);
}

// ── 3. Hash para a CSP ──────────────────────────────────────────────────────
// A landing tem `style-src 'self'` — SEM `'unsafe-inline'`. Um <style> inline
// ali seria descartado pelo navegador e a página nasceria sem estilo.
//
// A saída NÃO é afrouxar a CSP da página mais exposta do site: é o hash, que o
// projeto já usa para script inline (o `sha256-JpSqkc4…` no script-src).
// Como o hash muda a cada alteração do CSS, ele é propagado AQUI — se ficasse
// para alguém colar à mão, o dia em que esquecesse a landing perderia o estilo.
const hash = 'sha256-' + createHash('sha256').update(critico, 'utf8').digest('base64');

// ── 4. Injeta no index.html (bloco + hash na CSP do <meta>) ────────────────
const ARQ = join(RAIZ, 'index.html');
let html = readFileSync(ARQ, 'utf8');
const antes = html;

const iIni = html.indexOf(MARCA_INI);
const iFim = html.indexOf(MARCA_FIM);
if (iIni < 0 || iFim < 0) {
  console.error('\n❌ critical-css: marcas não encontradas em index.html.');
  console.error('   Esperado:\n   ' + MARCA_INI + '\n   ' + MARCA_FIM + '\n');
  process.exit(1);
}

html = html.slice(0, iIni) + `${MARCA_INI}\n    <style>${critico}</style>\n    ` + html.slice(iFim);

// Troca o style-src do <meta> mantendo o resto da diretiva intacto.
html = html.replace(/style-src [^;]*;/, `style-src 'self' '${hash}';`);
if (!html.includes(hash)) {
  console.error('\n❌ critical-css: não consegui inserir o hash no style-src do index.html.\n');
  process.exit(1);
}
if (html !== antes) writeFileSync(ARQ, html);

// ── 5. vercel.json — o header HTTP é a CSP que vale de verdade ─────────────
// O <meta> é defesa em profundidade; o navegador aplica a política MAIS
// restritiva entre os dois. Sem atualizar aqui também, o header continuaria
// sem o hash e bloquearia o <style> mesmo com o meta liberando.
const VJ = join(RAIZ, 'vercel.json');
let vercel = readFileSync(VJ, 'utf8');
const vercelAntes = vercel;

// ⚠️ EDIÇÃO DE TEXTO, NÃO parse+stringify. A primeira versão fazia
// JSON.parse → JSON.stringify e REFORMATOU o arquivo inteiro: 263 linhas
// alteradas onde deviam ser 2, destruindo a formatação compacta e tornando o
// diff irrevisável. Config de infraestrutura se edita cirurgicamente.
// E SÓ NAS ROTAS DA LANDING. A primeira tentativa trocou em 8 rotas, porque
// o regex casava qualquer `style-src 'self';` do arquivo. Declarar um hash em
// páginas que não têm aquele <style> não abre brecha (hash libera só aquele
// conteúdo exato), mas polui a política e mente sobre o que a página faz.
const ROTAS = new Set(['/', '/landingpage']);
let tocou = 0;

// Fatia por bloco de rota: cada `"source":` inicia um. Assim a troca fica
// contida no bloco certo, sem precisar reserializar o JSON.
const partes = vercel.split(/(?="source":)/);
vercel = partes.map((parte) => {
  const src = parte.match(/^"source":\s*"([^"]+)"/);
  if (!src || !ROTAS.has(src[1])) return parte;
  return parte.replace(/style-src 'self'(?: 'sha256-[^']+')?;/, () => {
    tocou++;
    return `style-src 'self' '${hash}';`;
  });
}).join('');

if (vercel !== vercelAntes) writeFileSync(VJ, vercel);
console.log(`✓ critical-css: ${critico.length} bytes inline · hash ${hash.slice(0, 22)}…`);
console.log(`  index.html atualizado · vercel.json: ${tocou} rota(s)`);
