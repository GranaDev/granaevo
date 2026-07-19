/**
 * GranaEvo — Testes do calendário financeiro (Passo 11)
 *
 * O calendário NÃO inventa dado: ele reorganiza o que o usuário já registrou.
 * Por isso a maior parte destes testes trava o oposto do de costume — que nada
 * apareça em dia errado, que nada seja contado duas vezes e que fuso horário não
 * mova evento de dia (a origem clássica de "a conta aparece um dia antes").
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  eventosDoMes, resumoDoDia, totaisDoMes, diasNoMes, primeiroDiaSemana, paraISO, PRIORIDADE,
} from '../../src/scripts/modules/calendario.js'

describe('helpers de data', () => {
  test('paraISO aceita os dois formatos do app', () => {
    assert.equal(paraISO('18/07/2026'), '2026-07-18')   // transações
    assert.equal(paraISO('2026-07-18'), '2026-07-18')   // contas fixas
    assert.equal(paraISO('lixo'), null)
    assert.equal(paraISO(null), null)
  })

  test('diasNoMes acerta fevereiro e bissexto', () => {
    assert.equal(diasNoMes(2026, 2), 28)
    assert.equal(diasNoMes(2024, 2), 29)
    assert.equal(diasNoMes(2026, 7), 31)
    assert.equal(diasNoMes(2026, 4), 30)
  })

  test('primeiroDiaSemana alinha a grade', () => {
    // 01/07/2026 é uma quarta-feira (3)
    assert.equal(primeiroDiaSemana(2026, 7), 3)
  })
})

describe('eventosDoMes — só o mês pedido', () => {
  const dados = {
    contasFixas: [
      { descricao: 'Aluguel',  valor: 1500, vencimento: '2026-07-10', pago: false },
      { descricao: 'Luz',      valor: 200,  vencimento: '2026-08-05', pago: false },  // outro mês
      { descricao: 'Fatura X', valor: 900,  vencimento: '2026-07-20', tipoContaFixa: 'fatura_cartao' },
    ],
    transacoes: [
      { categoria: 'entrada', descricao: 'Salário', valor: 5000, data: '05/07/2026' },
      { categoria: 'saida',   descricao: 'Mercado', valor: 300,  data: '05/07/2026' },
      { categoria: 'saida',   descricao: 'Antigo',  valor: 999,  data: '05/06/2026' },  // outro mês
    ],
    assinaturas: [
      { nome: 'Streaming', valor: 39.9, diaCobranca: 15, ativa: true },
      { nome: 'Cancelada', valor: 10,   diaCobranca: 15, ativa: false },
    ],
  }

  test('indexa por data e ignora outros meses', () => {
    const m = eventosDoMes(dados, 2026, 7)
    assert.ok(m.has('2026-07-10'), 'aluguel')
    assert.ok(m.has('2026-07-20'), 'fatura')
    assert.ok(m.has('2026-07-15'), 'assinatura')
    assert.ok(m.has('2026-07-05'), 'transações')
    assert.equal(m.has('2026-08-05'), false, 'conta de agosto não pode entrar em julho')
    assert.equal(m.has('2026-06-05'), false, 'transação de junho não pode entrar em julho')
  })

  test('fatura de cartão é distinguida de conta comum', () => {
    const m = eventosDoMes(dados, 2026, 7)
    assert.equal(m.get('2026-07-20')[0].tipo, 'fatura')
    assert.equal(m.get('2026-07-10')[0].tipo, 'conta')
  })

  test('assinatura CANCELADA não aparece', () => {
    const evs = eventosDoMes(dados, 2026, 7).get('2026-07-15')
    assert.equal(evs.length, 1)
    assert.equal(evs[0].titulo, 'Streaming')
  })

  test('dois eventos no mesmo dia convivem', () => {
    assert.equal(eventosDoMes(dados, 2026, 7).get('2026-07-05').length, 2)
  })

  test('reserva/retirada NÃO contam como gasto do dia', () => {
    const m = eventosDoMes({
      transacoes: [
        { categoria: 'reserva',          descricao: 'Guardei',  valor: 500, data: '07/07/2026' },
        { categoria: 'retirada_reserva', descricao: 'Retirei',  valor: 500, data: '07/07/2026' },
      ],
    }, 2026, 7)
    assert.equal(m.has('2026-07-07'), false, 'mover dinheiro entre bolsos não é entrada nem saída')
  })

  test('assinatura no dia 31 cai no último dia de fevereiro (não some)', () => {
    const m = eventosDoMes({ assinaturas: [{ nome: 'Dia 31', valor: 10, diaCobranca: 31 }] }, 2026, 2)
    assert.ok(m.has('2026-02-28'), 'a cobrança acontece — não pode sumir do calendário')
  })

  test('entrada inválida não quebra', () => {
    assert.equal(eventosDoMes({}, 2026, 7).size, 0)
    assert.equal(eventosDoMes(null, 2026, 7).size, 0)
    assert.equal(eventosDoMes({ contasFixas: [null, {}] }, 2026, 7).size, 0)
    assert.equal(eventosDoMes({}, 2026, 13).size, 0, 'mês inválido')
  })

  test('data em string não vira Date — fuso não move o evento de dia', () => {
    // Um gasto às 23h do dia 31 tem que ficar no 31, não pular para o 1º.
    const m = eventosDoMes({
      transacoes: [{ categoria: 'saida', descricao: 'Tarde da noite', valor: 50, data: '31/07/2026', hora: '23:59' }],
    }, 2026, 7)
    assert.ok(m.has('2026-07-31'))
  })
})

describe('resumoDoDia', () => {
  test('soma entradas e saídas separadamente', () => {
    const r = resumoDoDia([
      { tipo: 'entrada', valor: 1000 },
      { tipo: 'saida',   valor: 300 },
      { tipo: 'saida',   valor: 200 },
    ])
    assert.equal(r.entrou, 1000)
    assert.equal(r.saiu, 500)
    assert.equal(r.total, 3)
  })

  test('conta PAGA não entra em "a vencer"', () => {
    const r = resumoDoDia([
      { tipo: 'conta',  valor: 500, pago: true },
      { tipo: 'fatura', valor: 900, pago: false },
    ])
    assert.equal(r.aVencer, 900, 'só o que ainda não foi pago')
  })

  test('tipos vêm por prioridade — fatura nunca fica escondida', () => {
    const r = resumoDoDia([
      { tipo: 'saida', valor: 10 },
      { tipo: 'fatura', valor: 900 },
      { tipo: 'entrada', valor: 50 },
    ])
    assert.equal(r.tipos[0], 'fatura')
    assert.deepEqual(r.tipos, PRIORIDADE.filter(t => r.tipos.includes(t)))
  })

  test('dia vazio não quebra', () => {
    const r = resumoDoDia([])
    assert.equal(r.total, 0)
    assert.equal(r.entrou, 0)
    assert.deepEqual(r.tipos, [])
  })
})

describe('totaisDoMes', () => {
  test('agrega o mês inteiro e conta os dias com evento', () => {
    const m = eventosDoMes({
      contasFixas: [{ descricao: 'Aluguel', valor: 1500, vencimento: '2026-07-10', pago: false }],
      transacoes: [
        { categoria: 'entrada', descricao: 'Salário', valor: 5000, data: '05/07/2026' },
        { categoria: 'saida',   descricao: 'Mercado', valor: 300,  data: '06/07/2026' },
      ],
    }, 2026, 7)
    const t = totaisDoMes(m)
    assert.equal(t.entrou, 5000)
    assert.equal(t.saiu, 300)
    assert.equal(t.aVencer, 1500)
    assert.equal(t.diasComEvento, 3)
  })

  test('mês vazio zera tudo', () => {
    const t = totaisDoMes(new Map())
    assert.deepEqual(t, { entrou: 0, saiu: 0, aVencer: 0, diasComEvento: 0 })
  })
})
