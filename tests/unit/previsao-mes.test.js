/**
 * GranaEvo — Testes da previsão de fim de mês (calcularPrevisao)
 *
 * Regressão do bug "muito desproporcional" (2026-07-14): contas fixas/faturas
 * pagas vazavam pro gasto variável porque a exclusão usava tipos errados
 * ('Conta fixa'/'Cartão' vs os reais 'Conta Fixa'/'Pagamento Cartão').
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { calcularPrevisao } from '../../src/scripts/modules/previsao-mes.js'

// Data fixa p/ determinismo: 15/07/2026 → mês tem 31 dias, faltam 16.
const HOJE = new Date(2026, 6, 15)

describe('calcularPrevisao — exclusão de despesas fixas (o bug)', () => {
  test('Conta Fixa e Pagamento Cartão pagos NÃO entram no gasto variável', () => {
    const ctx = { transacoes: [
      { categoria: 'saida', tipo: 'Conta Fixa',      contaFixaId: 'c1', valor: 1500, data: '10/07/2026' },
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId:   'f1', valor: 2000, data: '05/07/2026' },
    ], contasFixas: [] }
    const r = calcularPrevisao(ctx, HOJE)
    assert.equal(r.mediaDiaria, 0, 'fixas/cartão não deveriam inflar a média diária')
    assert.equal(r.saldo, -3500, 'mas continuam reduzindo o saldo (são saídas reais)')
  })

  test('mesmo valor como gasto VARIÁVEL entra normalmente (prova o contraste)', () => {
    const ctx = { transacoes: [
      { categoria: 'saida', tipo: 'Mercado', valor: 1500, data: '18/06/2026' }, // ~28d atrás
      { categoria: 'saida', tipo: 'Lazer',   valor: 2000, data: '05/07/2026' },
    ], contasFixas: [] }
    const r = calcularPrevisao(ctx, HOJE)
    assert.equal(r.mediaDiaria, 3500 / 28, 'variável deve contar; denominador 28 (histórico ≥28d)')
  })

  test('exclusão robusta por marcador de origem mesmo com tipo inesperado', () => {
    const ctx = { transacoes: [
      { categoria: 'saida', tipo: 'Qualquer Rótulo Novo', contaFixaId: 'c9', valor: 999, data: '12/07/2026' },
    ], contasFixas: [] }
    const r = calcularPrevisao(ctx, HOJE)
    assert.equal(r.mediaDiaria, 0, 'o id de origem exclui independente do tipo')
  })
})

describe('calcularPrevisao — fórmula completa', () => {
  test('projeção = saldo + previstas − contasAPagar − mediaDiaria×diasRestantes', () => {
    const ctx = {
      transacoes: [
        { categoria: 'entrada', tipo: 'Salário', valor: 5000, data: '05/07/2026' },
        { categoria: 'saida',   tipo: 'Mercado', valor: 280,  data: '18/06/2026' }, // variável, ~28d
      ],
      contasFixas: [
        { pago: false, vencimento: '2026-07-20', valor: 800 }, // vence este mês
      ],
    }
    const r = calcularPrevisao(ctx, HOJE)
    assert.equal(r.saldo, 4720)          // 5000 − 280
    assert.equal(r.contasAPagar, 800)
    assert.equal(r.diasRestantes, 16)    // 31 − 15
    assert.equal(r.mediaDiaria, 10)      // 280 / 28
    assert.equal(r.entradasPrevistas, 0) // sem 2+ meses de histórico
    assert.equal(r.projecao, 4720 - 800 - 10 * 16) // = 3760
  })
})

describe('calcularPrevisao — denominador adaptativo e contas', () => {
  test('novo usuário (1 dia de histórico) usa piso de 7 dias, não estoura', () => {
    const ctx = { transacoes: [
      { categoria: 'saida', tipo: 'Mercado', valor: 70, data: '14/07/2026' }, // ontem
    ], contasFixas: [] }
    const r = calcularPrevisao(ctx, HOJE)
    assert.equal(r.mediaDiaria, 10, '70/7 (piso), não 70/1 nem 70/28')
  })

  test('contasAPagar: soma vencidas + do mês, ignora pagas e futuras', () => {
    const ctx = { transacoes: [], contasFixas: [
      { pago: false, vencimento: '2026-06-30', valor: 300 }, // vencida (mês anterior) → conta
      { pago: true,  vencimento: '2026-07-10', valor: 500 }, // paga → ignora
      { pago: false, vencimento: '2026-08-05', valor: 999 }, // mês que vem → ignora
    ] }
    const r = calcularPrevisao(ctx, HOJE)
    assert.equal(r.contasAPagar, 300)
    assert.equal(r.qtdContas, 1)
  })

  test('sem transações → tudo zero, projeção 0', () => {
    const r = calcularPrevisao({ transacoes: [], contasFixas: [] }, HOJE)
    assert.equal(r.saldo, 0)
    assert.equal(r.mediaDiaria, 0)
    assert.equal(r.projecao, 0)
  })
})
