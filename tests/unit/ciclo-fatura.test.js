/**
 * GranaEvo — Testes do ciclo da fatura (item 2)
 *
 * Estes testes existem por causa de dois bugs REAIS que estavam em produção no
 * painel "Resumo do cartão" (db-cartoes.js):
 *   1. No dia em que a fatura fechava, exibia "Fecha em 31 dias" — invertido no
 *      único dia em que a informação decide a compra. Causa: `new Date()` com
 *      hora comparado com `<=` contra a meia-noite do dia do fechamento.
 *   2. "Melhor dia de compra" = (dia % 28) + 1 → com fechamento no dia 28 dizia
 *      "melhor dia: 1", que é logo DEPOIS do fechamento seguinte: o pior dia.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  analisarCiclo, diasAteFechamento, melhorDiaCompra, proximaOcorrencia,
  diaFechamentoDe, meiaNoite,
} from '../../src/scripts/modules/ciclo-fatura.js'

const cartao = (extra = {}) => ({ id: 'c1', nomeBanco: 'Banco X', fechamentoDia: 10, ...extra })

describe('REGRESSÃO 1 — o dia do fechamento', () => {
  test('às 10h do dia 10, um cartão que fecha dia 10 fecha HOJE (não em 31 dias)', () => {
    const r = analisarCiclo(cartao(), new Date(2026, 6, 10, 10, 0))
    assert.equal(r.diasAteFechamento, 0, 'era o bug: dizia 31')
    assert.equal(r.fechaHoje, true)
    assert.equal(r.urgente, true)
  })

  test('às 23h59 do dia do fechamento ainda é hoje', () => {
    const r = analisarCiclo(cartao(), new Date(2026, 6, 10, 23, 59))
    assert.equal(r.diasAteFechamento, 0)
  })

  test('às 00h01 do dia do fechamento ainda é hoje', () => {
    const r = analisarCiclo(cartao(), new Date(2026, 6, 10, 0, 1))
    assert.equal(r.diasAteFechamento, 0)
  })

  test('véspera = 1 dia, independente da hora', () => {
    assert.equal(analisarCiclo(cartao(), new Date(2026, 6, 9, 1, 0)).diasAteFechamento, 1)
    assert.equal(analisarCiclo(cartao(), new Date(2026, 6, 9, 23, 0)).diasAteFechamento, 1)
  })

  test('dia seguinte ao fechamento → rola para o mês que vem', () => {
    const r = analisarCiclo(cartao(), new Date(2026, 6, 11, 10, 0))
    assert.equal(r.diasAteFechamento, 30) // 11/07 → 10/08
    assert.equal(r.fechaHoje, false)
    assert.equal(r.urgente, false)
  })
})

describe('REGRESSÃO 2 — melhor dia de compra', () => {
  test('fechamento dia 28 → melhor dia 29 (era 1: o PIOR dia possível)', () => {
    assert.equal(melhorDiaCompra(cartao({ fechamentoDia: 28 })), 29)
  })
  test('casos normais', () => {
    assert.equal(melhorDiaCompra(cartao({ fechamentoDia: 5 })), 6)
    assert.equal(melhorDiaCompra(cartao({ fechamentoDia: 10 })), 11)
    assert.equal(melhorDiaCompra(cartao({ fechamentoDia: 27 })), 28)
  })
  test('o dia seguinte sempre existe: o app limita o fechamento a 1–28', () => {
    for (let d = 1; d <= 28; d++) {
      const md = melhorDiaCompra(cartao({ fechamentoDia: d }))
      assert.ok(md >= 2 && md <= 29, `dia ${d} → ${md} fora de 2..29`)
    }
  })
})

describe('proximaOcorrencia', () => {
  test('hoje conta como próxima ocorrência (inclusive)', () => {
    const r = proximaOcorrencia(10, new Date(2026, 6, 10, 15, 0))
    assert.equal(r.getDate(), 10)
    assert.equal(r.getMonth(), 6)
  })
  test('dia já passado rola para o mês seguinte', () => {
    const r = proximaOcorrencia(5, new Date(2026, 6, 20))
    assert.equal(r.getDate(), 5)
    assert.equal(r.getMonth(), 7)
  })
  test('vira o ano corretamente', () => {
    const r = proximaOcorrencia(5, new Date(2026, 11, 20))
    assert.equal(r.getMonth(), 0)
    assert.equal(r.getFullYear(), 2027)
  })
  test('dia inválido devolve null, não uma data doida', () => {
    assert.equal(proximaOcorrencia(0, new Date()), null)
    assert.equal(proximaOcorrencia(32, new Date()), null)
    assert.equal(proximaOcorrencia(null, new Date()), null)
    assert.equal(proximaOcorrencia(10.5, new Date()), null)
    assert.equal(proximaOcorrencia('10', new Date()), null)
  })
  test('devolve sempre meia-noite', () => {
    const r = proximaOcorrencia(10, new Date(2026, 6, 9, 15, 30))
    assert.equal(r.getHours(), 0)
    assert.equal(r.getMinutes(), 0)
  })
})

describe('diaFechamentoDe — de onde sai o dia', () => {
  test('usa fechamentoDia quando existe', () => {
    assert.equal(diaFechamentoDe({ fechamentoDia: 12, vencimentoDia: 20 }), 12)
  })
  test('cai para vencimentoDia quando não há fechamento', () => {
    assert.equal(diaFechamentoDe({ vencimentoDia: 20 }), 20)
  })
  test('fora de 1–28 é dado legado: não afirma nada', () => {
    assert.equal(diaFechamentoDe({ fechamentoDia: 31 }), null)
    assert.equal(diaFechamentoDe({ fechamentoDia: 0 }), null)
    assert.equal(diaFechamentoDe({ fechamentoDia: -3 }), null)
  })
  test('entrada inválida não quebra', () => {
    assert.equal(diaFechamentoDe(null), null)
    assert.equal(diaFechamentoDe({}), null)
    assert.equal(diaFechamentoDe({ fechamentoDia: '10' }), null)
    assert.equal(diaFechamentoDe({ fechamentoDia: 10.5 }), null)
  })
})

describe('analisarCiclo — o retrato completo', () => {
  test('urgente é ≤3 dias — a janela em que ainda dá para adiar uma compra', () => {
    // cartão fecha dia 10
    assert.equal(analisarCiclo(cartao(), new Date(2026, 6, 7)).urgente, true)  // 3 dias
    assert.equal(analisarCiclo(cartao(), new Date(2026, 6, 6)).urgente, false) // 4 dias
  })

  test('proximaFatura começa no dia seguinte ao fechamento', () => {
    const r = analisarCiclo(cartao(), new Date(2026, 6, 5))
    assert.equal(r.fechamento.getDate(), 10)
    assert.equal(r.proximaFatura.getDate(), 11)
  })

  test('cartão sem dia utilizável devolve null (a UI não inventa)', () => {
    assert.equal(analisarCiclo({ id: 'x' }, new Date()), null)
    assert.equal(analisarCiclo(null, new Date()), null)
  })

  test('diasAteFechamento avulso bate com o do retrato', () => {
    const hoje = new Date(2026, 6, 3)
    assert.equal(diasAteFechamento(cartao(), hoje), analisarCiclo(cartao(), hoje).diasAteFechamento)
    assert.equal(diasAteFechamento({ id: 'x' }, hoje), null)
  })
})

describe('meiaNoite', () => {
  test('zera a hora sem mexer no dia', () => {
    const d = meiaNoite(new Date(2026, 6, 10, 23, 59, 59))
    assert.equal(d.getDate(), 10)
    assert.equal(d.getHours(), 0)
  })
  test('não muta a data original', () => {
    const orig = new Date(2026, 6, 10, 15, 0)
    meiaNoite(orig)
    assert.equal(orig.getHours(), 15)
  })
})
