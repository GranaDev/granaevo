/**
 * GranaEvo — Testes do ritmo das metas (item 3)
 *
 * O prazo da meta já existia mas era uma tag decorativa. Este motor responde
 * "precisa de X/mês, você faz Y/mês". A regra que mais importa aqui: o ritmo
 * REAL vem das transações com metaId, NUNCA de meta.monthly — que soma o
 * rendimento diário e faria juros passarem por esforço do usuário.
 *
 * Puro, sem rede/DOM, `hoje` e `taxaMensal` injetáveis. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  analisarRitmo, ritmoReal, mesesAtePrazo, aporteNecessario, fvComposto, mesesParaMeta,
} from '../../src/scripts/modules/ritmo-metas.js'

const JULHO = new Date(2026, 6, 15) // 15/07/2026

const tx = (metaId, categoria, valor, data) => ({ metaId, categoria, valor, data })

describe('mesesAtePrazo', () => {
  test('prazo no mês corrente ainda conta como 1 mês (vale até o fim do mês)', () => {
    assert.equal(mesesAtePrazo('07/2026', JULHO), 1)
  })
  test('mês seguinte = 2 (este mês e o próximo)', () => {
    assert.equal(mesesAtePrazo('08/2026', JULHO), 2)
  })
  test('um ano à frente', () => {
    assert.equal(mesesAtePrazo('07/2027', JULHO), 13)
  })
  test('mês passado = 0 (vencido)', () => {
    assert.equal(mesesAtePrazo('06/2026', JULHO), 0)
  })
  test('formato inválido devolve null, não NaN', () => {
    assert.equal(mesesAtePrazo('julho de 2026', JULHO), null)
    assert.equal(mesesAtePrazo('13/2026', JULHO), null)
    assert.equal(mesesAtePrazo(null, JULHO), null)
    assert.equal(mesesAtePrazo('2026-07', JULHO), null)
  })
  test('aceita mês com 1 dígito', () => {
    assert.equal(mesesAtePrazo('7/2026', JULHO), 1)
  })
})

describe('matemática financeira', () => {
  test('fvComposto sem juros é soma simples', () => {
    assert.equal(fvComposto(1000, 100, 0, 10), 2000)
  })
  test('fvComposto com juros rende mais que a soma simples', () => {
    assert.ok(fvComposto(1000, 100, 0.01, 10) > 2000)
  })
  test('aporteNecessario sem juros divide o que falta', () => {
    assert.equal(aporteNecessario(0, 1200, 0, 12), 100)
  })
  test('aporteNecessario com juros exige menos que sem juros', () => {
    assert.ok(aporteNecessario(0, 1200, 0.01, 12) < 100)
  })
  test('mesesParaMeta: objetivo inalcançável devolve null', () => {
    assert.equal(mesesParaMeta(0, 1e9, 1, 0), null)
  })
})

describe('ritmoReal — a fonte honesta', () => {
  test('média dos aportes na janela', () => {
    const t = [
      tx('m1', 'reserva', 300, '10/07/2026'),
      tx('m1', 'reserva', 300, '10/06/2026'),
      tx('m1', 'reserva', 300, '10/05/2026'),
    ]
    const r = ritmoReal('m1', t, JULHO, 3)
    assert.equal(r.real, 300)
    assert.equal(r.aportes, 3)
    assert.equal(r.temHistorico, true)
  })

  test('retirada DESCONTA: guardar 500 e tirar 500 todo mês = ritmo zero', () => {
    const t = [
      tx('m1', 'reserva', 500, '05/07/2026'),
      tx('m1', 'retirada_reserva', 500, '20/07/2026'),
      tx('m1', 'reserva', 500, '05/06/2026'),
      tx('m1', 'retirada_reserva', 500, '20/06/2026'),
    ]
    const r = ritmoReal('m1', t, new Date(2026, 6, 25), 3)
    assert.equal(r.real, 0, 'saldo não anda — o ritmo tem que refletir isso')
  })

  test('meta nova: aporte único de 1000 há 10 dias NÃO vira 1000/mês inflado', () => {
    const t = [tx('m1', 'reserva', 1000, '05/07/2026')]
    const r = ritmoReal('m1', t, JULHO, 3)
    assert.equal(r.real, 1000, 'divisor é 1 mês decorrido, não a janela de 3')
  })

  test('divisor usa meses decorridos desde o 1º aporte (teto = janela)', () => {
    // 2 aportes de 300 em jun e jul → 2 meses decorridos → 300/mês
    const t = [
      tx('m1', 'reserva', 300, '10/06/2026'),
      tx('m1', 'reserva', 300, '10/07/2026'),
    ]
    assert.equal(ritmoReal('m1', t, JULHO, 3).real, 300)
  })

  test('ignora transações de OUTRA meta', () => {
    const t = [
      tx('m1', 'reserva', 300, '10/07/2026'),
      tx('m2', 'reserva', 9000, '10/07/2026'),
    ]
    assert.equal(ritmoReal('m1', t, JULHO, 3).real, 300)
  })

  test('ignora transação fora da janela', () => {
    const t = [tx('m1', 'reserva', 5000, '10/01/2026')]
    const r = ritmoReal('m1', t, JULHO, 3)
    assert.equal(r.real, 0)
    assert.equal(r.temHistorico, false)
  })

  test('ignora categoria que não é reserva/retirada (marcador de origem, não rótulo)', () => {
    const t = [{ metaId: 'm1', categoria: 'saida', tipo: 'Reserva', valor: 999, data: '10/07/2026' }]
    assert.equal(ritmoReal('m1', t, JULHO, 3).temHistorico, false)
  })

  test('entrada inválida não quebra', () => {
    assert.equal(ritmoReal('m1', null, JULHO).real, 0)
    assert.equal(ritmoReal(null, [], JULHO).real, 0)
    assert.equal(ritmoReal('m1', [tx('m1', 'reserva', NaN, '10/07/2026')], JULHO).temHistorico, false)
    assert.equal(ritmoReal('m1', [tx('m1', 'reserva', 100, 'ontem')], JULHO).temHistorico, false)
  })
})

describe('analisarRitmo — estados', () => {
  const meta = (extra = {}) => ({ id: 'm1', objetivo: 12000, saved: 0, prazo: '07/2027', ...extra })

  test('sem prazo → sem_prazo (não inventa cobrança)', () => {
    const r = analisarRitmo(meta({ prazo: null }), [], 0, JULHO)
    assert.equal(r.status, 'sem_prazo')
  })

  test('objetivo atingido → concluida', () => {
    const r = analisarRitmo(meta({ saved: 12000 }), [], 0, JULHO)
    assert.equal(r.status, 'concluida')
  })

  test('prazo passado e incompleta → vencida', () => {
    const r = analisarRitmo(meta({ prazo: '01/2026' }), [], 0, JULHO)
    assert.equal(r.status, 'vencida')
  })

  test('sem nenhum aporte → sem_historico com o valor necessário (orienta, não acusa)', () => {
    const r = analisarRitmo(meta(), [], 0, JULHO)
    assert.equal(r.status, 'sem_historico')
    assert.equal(Math.round(r.necessario), 923) // 12000 / 13 meses
    assert.equal(r.real, 0)
  })

  test('aportando o necessário → no_ritmo', () => {
    const t = [
      tx('m1', 'reserva', 950, '10/07/2026'),
      tx('m1', 'reserva', 950, '10/06/2026'),
      tx('m1', 'reserva', 950, '10/05/2026'),
    ]
    const r = analisarRitmo(meta({ saved: 2850 }), t, 0, JULHO)
    assert.equal(r.status, 'no_ritmo')
  })

  test('aportando pouco → atrasada, com o gap exato', () => {
    const t = [
      tx('m1', 'reserva', 100, '10/07/2026'),
      tx('m1', 'reserva', 100, '10/06/2026'),
      tx('m1', 'reserva', 100, '10/05/2026'),
    ]
    const r = analisarRitmo(meta({ saved: 300 }), t, 0, JULHO)
    assert.equal(r.status, 'atrasada')
    assert.equal(r.real, 100)
    assert.equal(Math.round(r.gap), Math.round(r.necessario - 100))
    assert.ok(r.gap > 0)
  })

  // O aporte necessário é função do que JÁ está guardado — guardar reduz o que
  // falta por mês. Por isso a fração é medida contra o necessário DAQUELE estado
  // (via `sem_historico`, que reporta o necessário sem aporte nenhum), e não
  // contra uma conta feita à mão com saved=0.
  const cenario = (saved, fracao) => {
    const m = meta({ saved })
    const { necessario } = analisarRitmo(m, [], 0, JULHO)
    const v = Math.round(necessario * fracao)
    const t = [
      tx('m1', 'reserva', v, '10/07/2026'),
      tx('m1', 'reserva', v, '10/06/2026'),
      tx('m1', 'reserva', v, '10/05/2026'),
    ]
    return analisarRitmo(m, t, 0, JULHO)
  }

  test('tolerância de 5%: 96% do necessário ainda é "no ritmo" (sem piscar por centavos)', () => {
    assert.equal(cenario(3000, 0.96).status, 'no_ritmo')
  })

  test('90% do necessário já é atrasada', () => {
    assert.equal(cenario(3000, 0.90).status, 'atrasada')
  })

  test('rendimento sozinho já alcança o objetivo → no_ritmo e necessário zero', () => {
    // saved alto + juros altos: não precisa aportar nada
    const r = analisarRitmo(meta({ saved: 11900, objetivo: 12000 }), [], 0.02, JULHO)
    assert.equal(r.status, 'no_ritmo')
    assert.equal(r.necessario, 0)
  })

  test('com rendimento, o aporte necessário é MENOR que sem', () => {
    const sem  = analisarRitmo(meta(), [], 0,    JULHO).necessario
    const com  = analisarRitmo(meta(), [], 0.01, JULHO).necessario
    assert.ok(com < sem)
  })

  test('entrada inválida não quebra', () => {
    assert.equal(analisarRitmo(null, [], 0, JULHO).status, 'sem_prazo')
    assert.equal(analisarRitmo({}, [], 0, JULHO).status, 'sem_prazo')
    assert.equal(analisarRitmo(meta({ objetivo: 0 }), [], 0, JULHO).status, 'sem_prazo')
    assert.equal(analisarRitmo(meta({ prazo: 'xx' }), [], 0, JULHO).status, 'sem_prazo')
  })
})

describe('REGRESSÃO: rendimento não pode se disfarçar de esforço', () => {
  test('meta que só rende juros e não recebe aporte é ATRASADA, não "no ritmo"', () => {
    // Cenário real: R$50k no CDI creditam ~R$400/mês em meta.monthly. Se o ritmo
    // saísse de monthly, esta meta pareceria saudável — mas o usuário parou de
    // guardar e NÃO vai chegar aos R$100k. É exatamente quando o alerta importa.
    const m = {
      id: 'm1', objetivo: 100000, saved: 50000, prazo: '07/2027',
      monthly: { '2026-07': 400, '2026-06': 400, '2026-05': 400 }, // só juros
    }
    const r = analisarRitmo(m, [/* nenhuma transação: nada foi aportado */], 0.008, JULHO)
    assert.equal(r.status, 'sem_historico', 'monthly não pode virar ritmo')
    assert.ok(r.necessario > 0, 'ainda falta muito — tem que cobrar aporte')
  })

  test('mesma meta COM aportes reais é avaliada pelos aportes, não por monthly', () => {
    const m = {
      id: 'm1', objetivo: 100000, saved: 50000, prazo: '07/2027',
      monthly: { '2026-07': 9999, '2026-06': 9999 }, // inflado por juros
    }
    const t = [
      tx('m1', 'reserva', 200, '10/07/2026'),
      tx('m1', 'reserva', 200, '10/06/2026'),
    ]
    const r = analisarRitmo(m, t, 0, JULHO)
    assert.equal(r.real, 200, 'ignora monthly por completo')
    assert.equal(r.status, 'atrasada')
  })
})
