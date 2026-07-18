/**
 * GranaEvo — Testes do motor de parcelamento (reestruturação 2026-07-17)
 *
 * Cobre os cenários EXATOS relatados pelo usuário:
 *  - Xbox 5×150: cada parcela num mês diferente; pagar a de janeiro baixa só
 *    janeiro; fevereiro fica em fevereiro.
 *  - fatura.valor = Σ das NÃO pagas (pagar diminui de verdade).
 *  - migração do modelo antigo (parcelaAtual) sem recriar as já pagas.
 *
 * Puro, sem rede/DOM, `hoje`/datas injetáveis. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  paraISO, somaMesesISO, baseVencimentoISO, gerarParcelas,
  valorAbertoFatura, parcelasDaCompra, ehParcelaAntiga, migrarCompra, anexarParcelas,
} from '../../src/scripts/modules/fatura-parcelas.js'

// fecha dia 10, vence dia 20 (vence DEPOIS de fechar → mesmo mês)
const cartao = { id: 'c1', nomeBanco: 'Banco X', fechamentoDia: 10, vencimentoDia: 20 }
// fecha dia 28, vence dia 6 (vence ANTES de fechar → +1 mês)
const cartaoInvertido = { id: 'c2', fechamentoDia: 28, vencimentoDia: 6 }

describe('datas', () => {
  test('paraISO aceita BR e ISO', () => {
    assert.equal(paraISO('15/03/2026'), '2026-03-15')
    assert.equal(paraISO('2026-03-15'), '2026-03-15')
    assert.equal(paraISO('2026-03-15T10:00'), '2026-03-15')
    assert.equal(paraISO('xx'), null)
  })
  test('somaMesesISO vira o ano e faz clamp de dia', () => {
    assert.equal(somaMesesISO('2026-11-20', 2), '2027-01-20')
    assert.equal(somaMesesISO('2026-01-31', 1), '2026-02-28') // fev não tem 31
    assert.equal(somaMesesISO('2026-01-20', 0), '2026-01-20')
  })
})

describe('baseVencimentoISO — ciclo do cartão', () => {
  test('compra ANTES do fechamento → vence no mês corrente', () => {
    assert.equal(baseVencimentoISO(cartao, '2026-03-05'), '2026-03-20')
  })
  test('compra NO dia do fechamento → próximo ciclo', () => {
    assert.equal(baseVencimentoISO(cartao, '2026-03-10'), '2026-04-20')
  })
  test('compra depois do fechamento → próximo ciclo', () => {
    assert.equal(baseVencimentoISO(cartao, '2026-03-15'), '2026-04-20')
  })
  test('cartão que vence antes de fechar (28/6) → mês seguinte ao fechamento', () => {
    // compra 01/03: antes do fechamento (28) → ciclo fecha 28/03 → vence 06/04
    assert.equal(baseVencimentoISO(cartaoInvertido, '2026-03-01'), '2026-04-06')
  })
  test('cartão sem dados → null (não inventa)', () => {
    assert.equal(baseVencimentoISO({}, '2026-03-05'), null)
    assert.equal(baseVencimentoISO(cartao, 'xx'), null)
  })
})

describe('gerarParcelas — o Xbox 5×150', () => {
  const ger = gerarParcelas({
    cartao, tipo: 'Eletrônico', descricao: 'Xbox', valorTotal: 750,
    parcelas: 5, dataCompraISO: '2026-03-05', compraOrigemId: 'origem-xbox',
  })

  test('cria 5 parcelas, uma por mês', () => {
    assert.equal(ger.length, 5)
    assert.deepEqual(ger.map(g => g.vencimentoISO), [
      '2026-03-20', '2026-04-20', '2026-05-20', '2026-06-20', '2026-07-20',
    ])
  })
  test('cada parcela vale 150 e todas dividem o mesmo compraOrigemId', () => {
    for (const g of ger) {
      assert.equal(g.parcela.valorParcela, 150)
      assert.equal(g.parcela.compraOrigemId, 'origem-xbox')
      assert.equal(g.parcela.pago, false)
      assert.equal(g.parcela.totalParcelas, 5)
    }
    assert.deepEqual(ger.map(g => g.parcela.numeroParcela), [1, 2, 3, 4, 5])
  })
  test('Σ das parcelas = total exato, mesmo com centavos (a 1ª absorve o resto)', () => {
    const g = gerarParcelas({ cartao, tipo: 'x', descricao: 'y', valorTotal: 100, parcelas: 3, dataCompraISO: '2026-03-05' })
    const soma = g.reduce((s, x) => s + x.parcela.valorParcela, 0)
    assert.equal(Number(soma.toFixed(2)), 100)   // 33,34 + 33,33 + 33,33
    assert.equal(g[0].parcela.valorParcela, 33.34)
  })
  test('à vista (1×) gera 1 parcela', () => {
    const g = gerarParcelas({ cartao, tipo: 'x', descricao: 'y', valorTotal: 90, parcelas: 1, dataCompraISO: '2026-03-05' })
    assert.equal(g.length, 1)
    assert.equal(g[0].parcela.valorParcela, 90)
  })
  test('entrada inválida → [] (não cria dado quebrado)', () => {
    assert.deepEqual(gerarParcelas({ cartao, valorTotal: 0, parcelas: 5, dataCompraISO: '2026-03-05' }), [])
    assert.deepEqual(gerarParcelas({ cartao, valorTotal: 100, parcelas: 0, dataCompraISO: '2026-03-05' }), [])
    assert.deepEqual(gerarParcelas({ cartao: {}, valorTotal: 100, parcelas: 3, dataCompraISO: '2026-03-05' }), [])
  })
})

describe('valorAbertoFatura — pagar diminui de verdade', () => {
  test('soma só as NÃO pagas', () => {
    const fatura = { compras: [
      { valorParcela: 150, pago: false },
      { valorParcela: 200, pago: true },   // paga não conta
      { valorParcela: 50,  pago: false },
    ] }
    assert.equal(valorAbertoFatura(fatura), 200)
  })
  test('cenário do usuário: 1 compra na fatura, pagar → cai a zero', () => {
    const fatura = { compras: [{ valorParcela: 150, pago: false }] }
    assert.equal(valorAbertoFatura(fatura), 150)
    fatura.compras[0].pago = true          // pagou a parcela do mês
    assert.equal(valorAbertoFatura(fatura), 0, 'a fatura do mês zera — não puxa a próxima')
  })
  test('fatura vazia/inválida = 0', () => {
    assert.equal(valorAbertoFatura(null), 0)
    assert.equal(valorAbertoFatura({ compras: [] }), 0)
  })
})

describe('parcelasDaCompra — achar todas para excluir/reverter', () => {
  test('junta as parcelas espalhadas nas faturas, em ordem', () => {
    const contasFixas = [
      { tipoContaFixa: 'fatura_cartao', compras: [
        { compraOrigemId: 'A', numeroParcela: 2, valorParcela: 150 },
        { compraOrigemId: 'B', numeroParcela: 1, valorParcela: 99 },
      ] },
      { tipoContaFixa: 'fatura_cartao', compras: [
        { compraOrigemId: 'A', numeroParcela: 1, valorParcela: 150 },
        { compraOrigemId: 'A', numeroParcela: 3, valorParcela: 150 },
      ] },
      { tipoContaFixa: 'conta_normal', compras: [{ compraOrigemId: 'A' }] }, // ignora não-fatura
    ]
    const r = parcelasDaCompra(contasFixas, 'A')
    assert.equal(r.length, 3)
    assert.deepEqual(r.map(x => x.parcela.numeroParcela), [1, 2, 3]) // ordenado
  })
  test('compra inexistente → []', () => {
    assert.deepEqual(parcelasDaCompra([], 'A'), [])
  })
})

describe('anexarParcelas — distribui nas faturas mensais', () => {
  test('o Xbox: 5 parcelas criam/preenchem 5 faturas, uma por mês', () => {
    const contasFixas = []
    const ger = gerarParcelas({ cartao, tipo: 'Eletrônico', descricao: 'Xbox', valorTotal: 750, parcelas: 5, dataCompraISO: '2026-03-05' })
    anexarParcelas(contasFixas, cartao, ger)
    const faturas = contasFixas.filter(f => f.tipoContaFixa === 'fatura_cartao')
    assert.equal(faturas.length, 5)
    assert.deepEqual(faturas.map(f => f.vencimento).sort(), ['2026-03-20','2026-04-20','2026-05-20','2026-06-20','2026-07-20'])
    for (const f of faturas) assert.equal(f.valor, 150)
  })

  test('2ª compra no mesmo mês SOMA na fatura existente (não duplica fatura)', () => {
    const contasFixas = []
    anexarParcelas(contasFixas, cartao, gerarParcelas({ cartao, tipo: 'x', descricao: 'A', valorTotal: 300, parcelas: 1, dataCompraISO: '2026-03-05' }))
    anexarParcelas(contasFixas, cartao, gerarParcelas({ cartao, tipo: 'y', descricao: 'B', valorTotal: 200, parcelas: 1, dataCompraISO: '2026-03-06' }))
    const faturas = contasFixas.filter(f => f.tipoContaFixa === 'fatura_cartao')
    assert.equal(faturas.length, 1, 'mesma fatura de março')
    assert.equal(faturas[0].valor, 500)
    assert.equal(faturas[0].compras.length, 2)
  })

  test('idempotente: reanexar as MESMAS parcelas não duplica', () => {
    const contasFixas = []
    const ger = gerarParcelas({ cartao, tipo: 'x', descricao: 'A', valorTotal: 300, parcelas: 3, dataCompraISO: '2026-03-05' })
    anexarParcelas(contasFixas, cartao, ger)
    anexarParcelas(contasFixas, cartao, ger)  // de novo
    const totalCompras = contasFixas.reduce((s, f) => s + (f.compras?.length || 0), 0)
    assert.equal(totalCompras, 3)
  })
})

describe('migração do modelo antigo', () => {
  test('ehParcelaAntiga distingue os formatos', () => {
    assert.equal(ehParcelaAntiga({ parcelaAtual: 3, totalParcelas: 5 }), true)
    assert.equal(ehParcelaAntiga({ numeroParcela: 3, totalParcelas: 5, pago: false }), false)
    assert.equal(ehParcelaAntiga(null), false)
  })

  test('compra antiga 3/5 → gera as 3 RESTANTES, sem recriar as pagas', () => {
    const antiga = {
      tipo: 'Eletrônico', descricao: 'Xbox', valorTotal: 750, valorParcela: 150,
      totalParcelas: 5, parcelaAtual: 3, dataCompra: '05/03/2026',
    }
    const r = migrarCompra(antiga, cartao, '2026-05-20')  // fatura atual = maio
    assert.equal(r.length, 3, '3,4,5 restantes — 1 e 2 já foram pagas')
    assert.deepEqual(r.map(x => x.parcela.numeroParcela), [3, 4, 5])
    // a parcela atual (3) fica na fatura atual; 4 e 5 nos meses seguintes
    assert.deepEqual(r.map(x => x.vencimentoISO), ['2026-05-20', '2026-06-20', '2026-07-20'])
    for (const x of r) assert.equal(x.parcela.pago, false)
    // valor preservado: 3 restantes × 150 = 450 (o usado do cartão bate)
    assert.equal(r.reduce((s, x) => s + x.parcela.valorParcela, 0), 450)
  })

  test('todas compartilham 1 compraOrigemId (para exclusão futura)', () => {
    const antiga = { valorParcela: 100, totalParcelas: 3, parcelaAtual: 1, dataCompra: '05/03/2026' }
    const r = migrarCompra(antiga, cartao, '2026-03-20')
    const ids = new Set(r.map(x => x.parcela.compraOrigemId))
    assert.equal(ids.size, 1)
  })

  test('compra à vista antiga (1/1) → 1 parcela', () => {
    const r = migrarCompra({ valorParcela: 90, totalParcelas: 1, parcelaAtual: 1, dataCompra: '05/03/2026' }, cartao, '2026-03-20')
    assert.equal(r.length, 1)
    assert.equal(r[0].parcela.numeroParcela, 1)
  })

  test('compra já quitada (parcelaAtual > total) → [] (nada a migrar)', () => {
    assert.deepEqual(migrarCompra({ valorParcela: 150, totalParcelas: 5, parcelaAtual: 6, dataCompra: '05/03/2026' }, cartao, '2026-03-20'), [])
  })

  test('não mexe em compra já no formato novo (idempotência)', () => {
    assert.equal(migrarCompra({ numeroParcela: 2, totalParcelas: 5, pago: false }, cartao, '2026-03-20'), null)
  })
})
