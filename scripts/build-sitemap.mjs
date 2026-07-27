#!/usr/bin/env node
/**
 * GranaEvo — gera public/sitemap.xml no prebuild  [M-1]
 * ---------------------------------------------------------------------------
 * O `robots.txt` declara `Sitemap: https://www.granaevo.com/sitemap.xml` desde
 * sempre — e o arquivo NUNCA existiu. O Google pedia, levava 404, e as páginas
 * públicas ficavam dependendo só de descoberta por link.
 *
 * POR QUE GERADO E NÃO ESTÁTICO
 *   Um sitemap estático nasce com `lastmod` errado no dia seguinte, e `lastmod`
 *   mentiroso é pior que ausente: o Google aprende a ignorar o arquivo inteiro.
 *   Aqui cada URL usa a data real da última alteração do HTML que a serve.
 *
 * A LISTA VEM DO robots.txt, NÃO DE UMA CONSTANTE AQUI
 *   Se as duas listas vivessem separadas, uma hora divergiriam — e o pior caso é
 *   um sitemap anunciando ao Google uma rota que o robots manda não indexar.
 *   Lendo o `Allow:` do robots, a contradição fica impossível por construção.
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ   = join(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGEM = 'https://www.granaevo.com'

// Rota pública → arquivo que a serve (o vercel.json faz o rewrite).
const ARQUIVO_DA_ROTA = {
  '/':            'index.html',
  '/planos':      'planos.html',
  '/termos':      'termos.html',
  '/privacidade': 'privacidade.html',
}

// Prioridade relativa. A landing é a porta de entrada; os documentos legais
// precisam ser indexáveis (é o que torna a política verificável por terceiros),
// mas não competem com as páginas de produto.
const PRIORIDADE = { '/': '1.0', '/planos': '0.9', '/termos': '0.3', '/privacidade': '0.3' }
const FREQUENCIA = { '/': 'weekly', '/planos': 'weekly', '/termos': 'yearly', '/privacidade': 'yearly' }

const robots = readFileSync(join(RAIZ, 'public', 'robots.txt'), 'utf8')
const permitidas = [...robots.matchAll(/^Allow:\s*(\S+)/gm)].map(m => m[1])

const urls = []
for (const rota of permitidas) {
  const arquivo = ARQUIVO_DA_ROTA[rota]
  if (!arquivo) {
    console.warn(`[sitemap] rota "${rota}" está no robots.txt mas não sei que arquivo a serve — pulando`)
    continue
  }
  let lastmod
  try {
    lastmod = statSync(join(RAIZ, arquivo)).mtime.toISOString().slice(0, 10)
  } catch {
    console.warn(`[sitemap] ${arquivo} não encontrado — pulando "${rota}"`)
    continue
  }
  urls.push(
    '  <url>\n' +
    `    <loc>${ORIGEM}${rota === '/' ? '/' : rota}</loc>\n` +
    `    <lastmod>${lastmod}</lastmod>\n` +
    `    <changefreq>${FREQUENCIA[rota] ?? 'monthly'}</changefreq>\n` +
    `    <priority>${PRIORIDADE[rota] ?? '0.5'}</priority>\n` +
    '  </url>',
  )
}

const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!-- Gerado por scripts/build-sitemap.mjs no prebuild. Não editar à mão. -->\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.join('\n') + '\n'
  + '</urlset>\n'

writeFileSync(join(RAIZ, 'public', 'sitemap.xml'), xml, 'utf8')
console.log(`✓ sitemap: ${urls.length} URLs → public/sitemap.xml`)
