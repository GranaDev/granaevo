// lcp-imagem.test.js — o logo do loader é o LCP das páginas públicas (O-7).
//
// POR QUE ESTE ARQUIVO EXISTE
// O gate do Lighthouse no CI reprova LCP > 2,5 s e CLS > 0,1 — e mede
// justamente as páginas públicas. O logo dentro da tela de carregamento é o
// primeiro elemento pintado delas, ou seja, é o candidato natural a LCP.
//
// Três atributos decidem se ele ajuda ou atrapalha, e nenhum deles é visível
// olhando a tela: o navegador não reclama quando faltam, só fica mais lento.
// Por isso teste, e não revisão.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// As três primeiras são as que o lighthouserc.cjs mede. As duas últimas usam o
// mesmo componente de loading — se divergirem, alguém copiou pela metade.
const PAGINAS = ['index.html', 'planos.html', 'login.html', 'privacidade.html', 'termos.html']

const ler = (f) => readFileSync(join(RAIZ, f), 'utf8')
const loaderDe = (html) => html.match(/<img[^>]*logo-img-loader[^>]*>/s)?.[0] ?? null
const preloadDe = (html) => html.match(/<link[^>]*rel="preload"[^>]*as="image"[^>]*>/)?.[0] ?? null

describe('O-7 — o logo do loader está preparado para ser o LCP', () => {
  for (const pag of PAGINAS) {
    test(`${pag}: width/height evitam CLS`, () => {
      const img = loaderDe(ler(pag))
      assert.ok(img, `${pag} perdeu o logo do loader.`)
      assert.match(img, /width="96"/,
        'Sem width/height o navegador não reserva espaço: o layout pula quando a imagem '
        + 'chega. Isso é CLS, e CLS é limiar `error` no gate do CI. A imagem é 300x300 '
        + '(quadrada) e o CSS a renderiza em 96px — os atributos existem para a proporção, '
        + 'não para o tamanho final.')
      assert.match(img, /height="96"/, 'height junto com width, senão não há proporção.')
    })

    test(`${pag}: fetchpriority avisa que este é o elemento importante`, () => {
      assert.match(loaderDe(ler(pag)), /fetchpriority="high"/,
        'Sem fetchpriority o navegador trata o logo como imagem qualquer e o enfileira '
        + 'atrás de CSS e scripts — justamente o elemento que define o LCP.')
    })

    test(`${pag}: o preload existe e CASA o crossorigin com a <img>`, () => {
      const html = ler(pag)
      const img  = loaderDe(html)
      const pre  = preloadDe(html)

      assert.ok(pre, `${pag} não tem <link rel="preload" as="image">. Sem ele o navegador `
        + 'só descobre a imagem ao processar o body.')

      // ⚠️ A armadilha. Preload e <img> com `crossorigin` diferente são, para o
      // navegador, DOIS recursos distintos: ele baixa a imagem DUAS vezes e o
      // preload vira custo puro — o oposto exato do objetivo. Não aparece na
      // tela, só no waterfall.
      const imgTemCors = /crossorigin/.test(img)
      const preTemCors = /crossorigin/.test(pre)
      assert.equal(preTemCors, imgTemCors,
        `${pag}: a <img> ${imgTemCors ? 'TEM' : 'não tem'} crossorigin e o preload `
        + `${preTemCors ? 'TEM' : 'não tem'}. Quando divergem, o navegador trata como dois `
        + 'recursos e baixa a imagem duas vezes.')
    })
  }
})
