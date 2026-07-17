/**
 * GranaEvo — Testes do modo viagem (item 11)
 *
 * Duas regras de produto travadas aqui:
 *  - o custo vem da JANELA DE DATAS, não de marcador na transação (funciona
 *    retroativamente e não depende de carimbar 5 pontos de criação);
 *  - `total` vs `adicional`: o aluguel que debitou durante a viagem não é custo
 *    de viagem — você pagaria de qualquer jeito. Somar isso infla a conta.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  analisarViagem, iniciarViagem, encerrarViagem, viagemAtiva, isoParaData, dataParaIso,
} from '../../src/scripts/modules/viagem.js'

const HOJE = new Date(2026, 6, 20) // 20/07/2026

const saida = (valor, data, extra = {}) => ({ categoria: 'saida', tipo: 'Lazer', valor, data, ...extra })
const viagem = (extra = {}) => ({ ativa: true, nome: 'Bahia', inicio: '2026-07-10', fim: '2026-07-15', ...extra })

describe('datas', () => {
  test('ISO → Date local', () => {
    const d = isoParaData('2026-07-10')
    assert.equal(d.getFullYear(), 2026)
    assert.equal(d.getMonth(), 6)
    assert.equal(d.getDate(), 10)
    assert.equal(d.getHours(), 0)
  })
  test('data impossível é rejeitada, não "consertada" pelo Date', () => {
    assert.equal(isoParaData('2026-02-31'), null, '31/02 viraria 03/03 silenciosamente')
    assert.equal(isoParaData('2026-13-01'), null)
  })
  test('formato inválido → null', () => {
    assert.equal(isoParaData('10/07/2026'), null)
    assert.equal(isoParaData(''), null)
    assert.equal(isoParaData(null), null)
  })
  test('dataParaIso usa o dia LOCAL (toISOString viraria o dia)', () => {
    // 23h de 10/07 local: toISOString() daria 2026-07-11 em fusos negativos
    assert.equal(dataParaIso(new Date(2026, 6, 10, 23, 0)), '2026-07-10')
  })
  test('ida e volta', () => {
    assert.equal(dataParaIso(isoParaData('2026-01-05')), '2026-01-05')
  })
})

describe('viagemAtiva', () => {
  test('devolve a viagem quando ativa e com início válido', () => {
    assert.ok(viagemAtiva({ viagem: viagem({ fim: null }) }))
  })
  test('ativa:false → null', () => {
    assert.equal(viagemAtiva({ viagem: viagem({ ativa: false }) }), null)
  })
  test('início corrompido → null (não conta viagem sem começo)', () => {
    assert.equal(viagemAtiva({ viagem: viagem({ inicio: 'ontem' }) }), null)
  })
  test('config vazia/ausente → null', () => {
    assert.equal(viagemAtiva({}), null)
    assert.equal(viagemAtiva(null), null)
    assert.equal(viagemAtiva({ viagem: 'sim' }), null)
  })
})

describe('REGRESSÃO — só conta o que foi lançado DEPOIS de ativar', () => {
  // Bug relatado em prod (2026-07-16): "lancei uma saída, aí ativei o modo
  // viagem e depois lancei outro item; era pra cair só o segundo, mas caíram os
  // dois". Causa: a 1ª versão comparava só DATAS, então tudo do dia da ativação
  // entrava. Agora a viagem carimba a hora e a transação tem `hora`.
  const comHora = (valor, data, hora) => ({ categoria: 'saida', tipo: 'Lazer', valor, data, hora })

  test('o cenário exato: gasto de manhã fica fora, gasto da tarde entra', () => {
    const v = iniciarViagem('Bahia', new Date(2026, 6, 16, 14, 0, 0)) // ativou 14h
    const t = [
      comHora(100, '16/07/2026', '09:30:00'), // ANTES de ativar
      comHora(250, '16/07/2026', '18:45:00'), // depois de ativar
    ]
    const r = analisarViagem(v, t, new Date(2026, 6, 16, 20, 0))
    assert.equal(r.total, 250, 'o gasto da manhã não é da viagem')
    assert.equal(r.transacoes, 1)
  })

  test('encerrar também carimba hora: o que vem depois não entra', () => {
    let v = iniciarViagem('Bahia', new Date(2026, 6, 16, 8, 0))
    v = encerrarViagem(v, new Date(2026, 6, 16, 18, 0))
    const t = [
      comHora(80, '16/07/2026', '12:00:00'),  // durante
      comHora(300, '16/07/2026', '21:00:00'), // depois de encerrar
    ]
    assert.equal(analisarViagem(v, t, new Date(2026, 6, 17)).total, 80)
  })

  test('transação SEM hora no dia do início fica fora (conservador)', () => {
    const v = iniciarViagem('Bahia', new Date(2026, 6, 16, 14, 0))
    const t = [{ categoria: 'saida', tipo: 'Lazer', valor: 90, data: '16/07/2026' }]
    assert.equal(analisarViagem(v, t, new Date(2026, 6, 16, 20, 0)).total, 0,
      'sem hora vira 00:00 → antes da ativação → fora')
  })

  test('dia seguinte entra inteiro, com ou sem hora', () => {
    const v = iniciarViagem('Bahia', new Date(2026, 6, 16, 14, 0))
    const t = [
      comHora(50, '17/07/2026', '08:00:00'),
      { categoria: 'saida', tipo: 'Lazer', valor: 70, data: '17/07/2026' },
    ]
    assert.equal(analisarViagem(v, t, new Date(2026, 6, 18)).total, 120)
  })

  test('viagem antiga SEM inicioHora segue contando o dia todo (compatibilidade)', () => {
    const antiga = { ativa: true, nome: 'Velha', inicio: '2026-07-16', fim: null }
    const t = [comHora(100, '16/07/2026', '09:30:00')]
    assert.equal(analisarViagem(antiga, t, new Date(2026, 6, 16, 20, 0)).total, 100,
      'sem inicioHora = 00:00 = comportamento anterior, não some')
  })

  test('sair 22h e voltar 9h do dia seguinte = 2 dias (calendário, não 24h)', () => {
    let v = iniciarViagem('Bahia', new Date(2026, 6, 16, 22, 0))
    v = encerrarViagem(v, new Date(2026, 6, 17, 9, 0))
    assert.equal(analisarViagem(v, [], new Date(2026, 6, 18)).dias, 2)
  })
})

describe('analisarViagem — a janela', () => {
  test('soma só o que caiu dentro', () => {
    const t = [
      saida(100, '09/07/2026'), // véspera — fora
      saida(200, '10/07/2026'), // 1º dia  — dentro
      saida(300, '15/07/2026'), // último  — dentro
      saida(400, '16/07/2026'), // depois  — fora
    ]
    const r = analisarViagem(viagem(), t, HOJE)
    assert.equal(r.total, 500)
    assert.equal(r.transacoes, 2)
  })

  test('o dia do RETORNO conta inteiro (fim inclusivo)', () => {
    const r = analisarViagem(viagem(), [saida(80, '15/07/2026')], HOJE)
    assert.equal(r.total, 80, 'comparar com meia-noite descartaria o dia todo')
  })

  test('viagem de 1 dia dura 1 dia, não 0', () => {
    const r = analisarViagem(viagem({ inicio: '2026-07-10', fim: '2026-07-10' }), [saida(50, '10/07/2026')], HOJE)
    assert.equal(r.dias, 1)
    assert.equal(r.total, 50)
  })

  test('dias é inclusivo nas duas pontas', () => {
    assert.equal(analisarViagem(viagem(), [], HOJE).dias, 6) // 10 a 15
  })

  test('viagem EM CURSO conta até hoje, não até o infinito', () => {
    const r = analisarViagem(viagem({ fim: null }), [saida(90, '18/07/2026')], HOJE)
    assert.equal(r.emCurso, true)
    assert.equal(r.fim, '2026-07-20')
    assert.equal(r.total, 90)
  })

  test('gasto FUTURO (lançamento agendado) não entra numa viagem em curso', () => {
    const r = analisarViagem(viagem({ fim: null }), [saida(500, '25/07/2026')], HOJE)
    assert.equal(r.total, 0)
  })
})

describe('analisarViagem — total vs adicional (a honestidade do número)', () => {
  test('conta fixa que debitou na viagem NÃO é custo de viagem', () => {
    const t = [
      saida(300, '12/07/2026'),                              // gasto da viagem
      saida(2000, '12/07/2026', { contaFixaId: 'aluguel' }), // aluguel: pagaria igual
    ]
    const r = analisarViagem(viagem(), t, HOJE)
    assert.equal(r.total, 2300, 'total = tudo que saiu no período')
    assert.equal(r.fixas, 2000)
    assert.equal(r.adicional, 300, 'a viagem custou 300, não 2300')
  })

  test('fatura e parcela também são excluídas do adicional', () => {
    const t = [
      saida(100, '12/07/2026'),
      saida(800, '12/07/2026', { faturaId: 'f1' }),
      saida(150, '13/07/2026', { compraId: 'c1' }),
    ]
    const r = analisarViagem(viagem(), t, HOJE)
    assert.equal(r.adicional, 100)
    assert.equal(r.fixas, 950)
  })

  test('porDia usa o adicional, não o total (senão o aluguel vira "gasto diário")', () => {
    const t = [
      saida(600, '10/07/2026'),
      saida(3000, '10/07/2026', { contaFixaId: 'aluguel' }),
    ]
    const r = analisarViagem(viagem(), t, HOJE) // 6 dias
    assert.equal(r.porDia, 100) // 600 / 6
  })

  test('sem gastos, tudo zero e nada quebra', () => {
    const r = analisarViagem(viagem(), [], HOJE)
    assert.equal(r.total, 0)
    assert.equal(r.adicional, 0)
    assert.equal(r.porDia, 0)
    assert.deepEqual(r.categorias, [])
  })
})

describe('analisarViagem — categorias', () => {
  test('agrupa por tipo, maior primeiro, e ignora as geradas', () => {
    const t = [
      saida(300, '11/07/2026', { tipo: 'Ifood' }),
      saida(500, '12/07/2026', { tipo: 'Lazer' }),
      saida(100, '13/07/2026', { tipo: 'Ifood' }),
      saida(9000, '13/07/2026', { tipo: 'Conta fixa', contaFixaId: 'x' }),
    ]
    const r = analisarViagem(viagem(), t, HOJE)
    assert.deepEqual(r.categorias, [
      { tipo: 'Lazer', valor: 500 },
      { tipo: 'Ifood', valor: 400 },
    ])
  })
  test('transação sem tipo cai em Outros', () => {
    const r = analisarViagem(viagem(), [saida(50, '11/07/2026', { tipo: '' })], HOJE)
    assert.equal(r.categorias[0].tipo, 'Outros')
  })
  test('teto de 6 categorias', () => {
    const t = ['a','b','c','d','e','f','g','h'].map((x, i) => saida(10 * (i + 1), '11/07/2026', { tipo: x }))
    assert.equal(analisarViagem(viagem(), t, HOJE).categorias.length, 6)
  })
})

describe('analisarViagem — entradas e reservas não são gasto', () => {
  test('entrada/reserva na janela são ignoradas', () => {
    const t = [
      { categoria: 'entrada', tipo: 'Salário', valor: 5000, data: '11/07/2026' },
      { categoria: 'reserva', tipo: 'Reserva', valor: 500, data: '11/07/2026' },
      saida(70, '11/07/2026'),
    ]
    assert.equal(analisarViagem(viagem(), t, HOJE).total, 70)
  })
  test('saida_credito CONTA (foi gasto de verdade, só que no crédito)', () => {
    const t = [{ categoria: 'saida_credito', tipo: 'Lazer', valor: 250, data: '11/07/2026' }]
    assert.equal(analisarViagem(viagem(), t, HOJE).total, 250)
  })
})

describe('robustez', () => {
  test('entrada inválida devolve null em vez de número errado', () => {
    assert.equal(analisarViagem(null, [], HOJE), null)
    assert.equal(analisarViagem({ inicio: 'xx' }, [], HOJE), null)
    assert.equal(analisarViagem(viagem({ inicio: null }), [], HOJE), null)
  })
  test('fim antes do início é incoerente → null', () => {
    assert.equal(analisarViagem(viagem({ inicio: '2026-07-15', fim: '2026-07-10' }), [], HOJE), null)
  })
  test('valor/data lixo são ignorados', () => {
    const t = [saida(NaN, '11/07/2026'), saida(-50, '11/07/2026'), saida(50, 'ontem')]
    assert.equal(analisarViagem(viagem(), t, HOJE).total, 0)
  })
  test('transacoes null não quebra', () => {
    assert.equal(analisarViagem(viagem(), null, HOJE).total, 0)
  })
})

describe('iniciar / encerrar', () => {
  test('iniciarViagem marca hoje e fica ativa e aberta', () => {
    const v = iniciarViagem('Chile', HOJE)
    assert.equal(v.ativa, true)
    assert.equal(v.nome, 'Chile')
    assert.equal(v.inicio, '2026-07-20')
    assert.equal(v.fim, null)
  })
  test('nome vazio ganha padrão e nome gigante é cortado', () => {
    assert.equal(iniciarViagem('', HOJE).nome, 'Viagem')
    assert.equal(iniciarViagem('   ', HOJE).nome, 'Viagem')
    assert.equal(iniciarViagem(null, HOJE).nome, 'Viagem')
    assert.equal(iniciarViagem('x'.repeat(200), HOJE).nome.length, 60)
  })
  test('encerrarViagem fecha em hoje e desativa', () => {
    const v = encerrarViagem(iniciarViagem('Chile', new Date(2026, 6, 10)), HOJE)
    assert.equal(v.ativa, false)
    assert.equal(v.fim, '2026-07-20')
    assert.equal(v.inicio, '2026-07-10', 'não pode mexer no início')
  })
  test('encerrar inválido → null', () => {
    assert.equal(encerrarViagem(null, HOJE), null)
  })
  test('ciclo completo: inicia, gasta, encerra e o número fecha', () => {
    let v = iniciarViagem('Bahia', new Date(2026, 6, 10))
    v = encerrarViagem(v, new Date(2026, 6, 15))
    const r = analisarViagem(v, [saida(200, '11/07/2026'), saida(300, '14/07/2026')], HOJE)
    assert.equal(r.adicional, 500)
    assert.equal(r.dias, 6)
    assert.equal(r.emCurso, false)
  })
})
