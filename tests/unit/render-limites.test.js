// render-limites.test.js — nenhuma lista pinta o caso extremo de uma vez (O-6).
//
// A regra: lista cujo tamanho o USUÁRIO controla não pode ser renderizada
// inteira. Quem usa o cartão para tudo tem fatura com centenas de compras; quem
// lança pouco tem cinco. Renderizar tudo cobra de todo mundo o custo do caso
// extremo, e o sintoma é o pior tipo — não quebra, só trava, e só para quem tem
// muito dado (justamente quem mais usa o produto).
//
// Estes testes olham o FONTE, não a tela: não existe teste automatizado que
// perceba "o modal demora 2 s para abrir com 400 compras".

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ler  = (...p) => readFileSync(join(RAIZ, ...p), 'utf8')

describe('O-6 — listas grandes têm teto e "ver mais"', () => {
  test('compras da fatura: renderiza um lote, não a fatura inteira', () => {
    const src = ler('src', 'scripts', 'pages', 'db-cartoes.js')

    assert.match(src, /const COMPRAS_VISIVEIS = \d+/,
      'Sumiu o teto de compras visíveis da fatura.')

    assert.match(src, /fatura\.compras\.slice\(0, COMPRAS_VISIVEIS\)/,
      'A fatura voltou a renderizar todas as compras de uma vez. Cada compra vira um '
      + 'card com três linhas e botões — numa fatura cheia isso trava a abertura do modal.')

    // O laço original (`fatura.compras.forEach(compra => {`) não pode voltar:
    // é exatamente ele que renderizava tudo.
    const codigo = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.ok(!/fatura\.compras\.forEach/.test(codigo),
      'Voltou o forEach direto sobre fatura.compras, sem teto.')

    assert.match(src, /Ver mais \$\{_restantes\.length\}/,
      'O botão que mostra o resto sumiu — com teto e sem botão, o dado fica INACESSÍVEL, '
      + 'que é muito pior que lento.')
  })

  test('transações do relatório: mesmo padrão, já existente', () => {
    const src = ler('src', 'scripts', 'pages', 'db-relatorios.js')
    assert.match(src, /const REL_TX_VISIVEIS = \d+/)
    assert.match(src, /slice\(0, REL_TX_VISIVEIS\)/,
      'O relatório voltou a renderizar todas as transações do período de uma vez.')
    assert.match(src, /relTxVerMais/,
      'Sem o botão de expandir, as transações além do teto somem do relatório.')
  })

  test('o teto da fatura é MENOR que o do relatório (mais DOM por item)', () => {
    const compras = Number(ler('src', 'scripts', 'pages', 'db-cartoes.js')
      .match(/const COMPRAS_VISIVEIS = (\d+)/)?.[1])
    const relTx = Number(ler('src', 'scripts', 'pages', 'db-relatorios.js')
      .match(/const REL_TX_VISIVEIS = (\d+)/)?.[1])

    assert.ok(compras > 0 && relTx > 0, 'Não consegui ler um dos tetos.')
    assert.ok(compras < relTx,
      `Teto da fatura (${compras}) deveria ser menor que o do relatório (${relTx}): uma `
      + 'compra vira um card com três linhas e botões, uma transação de relatório vira uma '
      + 'linha. Contar itens sem contar o DOM de cada um leva a teto errado.')
  })
})
