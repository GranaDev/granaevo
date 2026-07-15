/**
 * GranaEvo — Testes do score de saúde financeira
 *
 * Motor extraído de db-relatorios.js (2026-07-14) para ser testável e alimentar o
 * semáforo do dashboard sem carregar o chunk de relatórios. Inclui a REGRESSÃO do
 * histórico: antes o score de meses passados zerava (a função refiltrava pelo mês
 * atual), deixando o gráfico de 6 meses constante e sem sentido.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { calcScore, nivelDe } from '../../src/scripts/modules/score-financeiro.js'

const JULHO = new Date(2026, 6, 15)

describe('nivelDe — faixas', () => {
  test('limites de cada nível', () => {
    assert.equal(nivelDe(850).letra, 'A')
    assert.equal(nivelDe(700).letra, 'B')
    assert.equal(nivelDe(550).letra, 'C')
    assert.equal(nivelDe(400).letra, 'D')
    assert.equal(nivelDe(399).letra, 'E')
  })
  test('logo abaixo do corte cai um nível', () => {
    assert.equal(nivelDe(849).letra, 'B')
    assert.equal(nivelDe(699).letra, 'C')
  })
})

describe('calcScore — componentes', () => {
  test('C1 taxa de poupança: 30% poupado = nota cheia (200)', () => {
    const tx = [
      { categoria: 'entrada', valor: 1000, data: '05/07/2026' },
      { categoria: 'saida',   valor: 700,  data: '10/07/2026' },
    ]
    const r = calcScore(tx, [], [], {}, JULHO)
    assert.equal(r.taxaPoup, 30)
    assert.equal(r.componentes[0].pts, 200)
  })

  test('C5 equilíbrio: 70% da renda gasta → 75/250', () => {
    const tx = [
      { categoria: 'entrada', valor: 1000, data: '05/07/2026' },
      { categoria: 'saida',   valor: 700,  data: '10/07/2026' },
    ]
    const r = calcScore(tx, [], [], {}, JULHO)
    assert.equal(r.componentes[4].pts, 75) // (1 - 0.7) * 250
  })

  test('C2 orçamentos: dentro do limite pontua cheio; estourado zera', () => {
    const base = { categoria: 'saida', tipo: 'Mercado', data: '10/07/2026' }
    const dentro = calcScore([{ ...base, valor: 400 }], [], [], { Mercado: { limite: 500 } }, JULHO)
    assert.equal(dentro.componentes[1].pts, 200)
    const fora = calcScore([{ ...base, valor: 600 }], [], [], { Mercado: { limite: 500 } }, JULHO)
    assert.equal(fora.componentes[1].pts, 0)
  })

  test('C2 sem orçamento definido fica no meio (100), não zera', () => {
    const r = calcScore([], [], [], {}, JULHO)
    assert.equal(r.componentes[1].pts, 100)
  })

  test('C3 cartões: sem uso = 150; metade do limite penaliza', () => {
    const semUso = calcScore([], [], [{ limite: 1000, usado: 0 }], {}, JULHO)
    assert.equal(semUso.componentes[2].pts, 150)
    const metade = calcScore([], [], [{ limite: 1000, usado: 500 }], {}, JULHO)
    assert.equal(metade.componentes[2].pts, 38) // (1 - 0.5*1.5) * 150 = 37.5 → 38
    const estourado = calcScore([], [], [{ limite: 1000, usado: 900 }], {}, JULHO)
    assert.equal(estourado.componentes[2].pts, 0)
  })

  test('C4 reservas: streak de meses consecutivos vale 40 cada (teto 200)', () => {
    const metas = [{ monthly: { '2026-07': 100, '2026-06': 100, '2026-05': 100 } }]
    const r = calcScore([], metas, [], {}, JULHO)
    assert.equal(r.componentes[3].pts, 120) // 3 meses × 40
  })

  test('score total e nível batem com a soma dos componentes', () => {
    const tx = [
      { categoria: 'entrada', valor: 1000, data: '05/07/2026' },
      { categoria: 'saida',   valor: 700,  data: '10/07/2026' },
    ]
    const r = calcScore(tx, [], [], {}, JULHO)
    // 200 (C1) + 100 (C2) + 150 (C3) + 0 (C4) + 75 (C5) = 525
    assert.equal(r.score, 525)
    assert.equal(r.nivel.letra, 'D')
  })
})

describe('calcScore — regressão do histórico (hoje injetável)', () => {
  const tx = [
    { categoria: 'entrada', valor: 1000, data: '05/06/2026' },
    { categoria: 'saida',   valor: 700,  data: '10/06/2026' },
  ]

  test('pedindo JUNHO, enxerga as transações de junho', () => {
    const junho = calcScore(tx, [], [], {}, new Date(2026, 5, 15))
    assert.equal(junho.entradas, 1000, 'era isto que quebrava o gráfico de 6 meses')
    assert.equal(junho.saidas, 700)
    assert.equal(junho.taxaPoup, 30)
  })

  test('pedindo JULHO (sem dados), zera corretamente', () => {
    const julho = calcScore(tx, [], [], {}, new Date(2026, 6, 15))
    assert.equal(julho.entradas, 0)
    assert.equal(julho.saidas, 0)
  })

  test('meses diferentes dão scores diferentes (o gráfico deixa de ser constante)', () => {
    const junho = calcScore(tx, [], [], {}, new Date(2026, 5, 15))
    const julho = calcScore(tx, [], [], {}, new Date(2026, 6, 15))
    assert.notEqual(junho.score, julho.score)
  })

  test('entrada inválida não quebra', () => {
    const r = calcScore(null, null, null, null, JULHO)
    assert.equal(typeof r.score, 'number')
    assert.equal(r.entradas, 0)
  })
})
