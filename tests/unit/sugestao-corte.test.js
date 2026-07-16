/**
 * GranaEvo — Testes da sugestão de corte (item 17)
 *
 * As travas testadas aqui são de PRODUTO, não só de código: nunca sugerir corte
 * em essencial (remédio, mercado, transporte), nunca inventar hábito a partir de
 * 1 compra (o falso positivo do pedágio, em recorrencias.js, veio disso), e
 * nunca amolar por centavos.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  sugerirCortes, fracaoCorte, economiaTotalAnual, TIPOS_PROTEGIDOS, TIPOS_APARAVEIS,
} from '../../src/scripts/modules/sugestao-corte.js'

const JULHO = new Date(2026, 6, 31) // 31/07/2026

// Gera n saídas de `valor` espalhadas no mês/ano dados
const gastos = (tipo, valor, n, mes = 7, ano = 2026, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    categoria: 'saida',
    tipo,
    valor,
    data: `${String((i % 28) + 1).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`,
    ...extra,
  }))

describe('fracaoCorte — quanto dá para aparar sem doer', () => {
  test('hábito diário corta 1/3', () => assert.equal(fracaoCorte(20), 1 / 3))
  test('semanal corta 1/4', () => assert.equal(fracaoCorte(5), 1 / 4))
  test('quinzenal corta 1/5', () => assert.equal(fracaoCorte(2), 1 / 5))
  test('esporádico não gera sugestão (não se compra 4/5 de um tênis)', () => {
    assert.equal(fracaoCorte(1), 0)
    assert.equal(fracaoCorte(0.3), 0)
  })
})

describe('TRAVA 1 — essencial nunca é sugerido', () => {
  for (const tipo of ['Mercado', 'Farmácia', 'Saúde', 'Transporte', 'Educação', 'Pet', 'Academia']) {
    test(`${tipo}: 20 gastos altos e ainda assim nenhuma sugestão`, () => {
      const r = sugerirCortes(gastos(tipo, 200, 20), JULHO)
      assert.equal(r.length, 0, `${tipo} é essencial — cortar é conselho ruim`)
    })
  }
  test('Conta fixa e Cartão também ficam fora (compromisso / transferência)', () => {
    assert.equal(sugerirCortes(gastos('Conta fixa', 500, 10), JULHO).length, 0)
    assert.equal(sugerirCortes(gastos('Cartão', 500, 10), JULHO).length, 0)
  })
  test('"Outros" fica fora: não se aconselha sobre o que não se sabe o que é', () => {
    assert.equal(sugerirCortes(gastos('Outros', 300, 15), JULHO).length, 0)
  })
  test('as duas listas não se sobrepõem', () => {
    for (const t of TIPOS_APARAVEIS) assert.ok(!TIPOS_PROTEGIDOS.has(t), `${t} está nas duas`)
  })
})

describe('TRAVA 2 — evidência mínima (3 ocorrências)', () => {
  test('2 compras não viram hábito (lição do falso positivo do pedágio)', () => {
    const r = sugerirCortes(gastos('Eletrônico', 900, 2), JULHO)
    assert.equal(r.length, 0)
  })
  test('1 viagem cara não vira "corte 20% da sua viagem"', () => {
    const r = sugerirCortes(gastos('Viagem', 4000, 1), JULHO)
    assert.equal(r.length, 0)
  })
  test('3 já bastam quando há valor relevante', () => {
    const r = sugerirCortes(gastos('Lazer', 150, 3), JULHO)
    assert.equal(r.length, 1)
  })
})

describe('TRAVA 3 — piso de relevância', () => {
  test('R$5 de café 4× no mês não vira sugestão (R$20/mês é ruído)', () => {
    const r = sugerirCortes(gastos('Lazer', 5, 4), JULHO)
    assert.equal(r.length, 0)
  })
  test('o piso é configurável', () => {
    const r = sugerirCortes(gastos('Lazer', 5, 4), JULHO, { minMensal: 1 })
    assert.equal(r.length, 1)
  })
})

describe('sugerirCortes — o caso que motivou o módulo', () => {
  test('delivery repetido: 18× R$32 = R$576/mês → corta 1/3 → R$192/mês', () => {
    const r = sugerirCortes(gastos('Ifood', 32, 18), JULHO)
    assert.equal(r.length, 1)
    const s = r[0]
    assert.equal(s.tipo, 'Ifood')
    assert.equal(Math.round(s.gastoMensal), 576)
    assert.equal(s.ocorrencias, 18)
    assert.equal(s.ticketMedio, 32)
    assert.equal(Math.round(s.fracao * 100), 33)
    assert.equal(Math.round(s.economiaMensal), 192)
    assert.equal(Math.round(s.economiaAnual), 2304)
    assert.ok(s.cortesPorMes >= 1, 'precisa dizer quantos pedidos deixar de fazer')
  })

  test('ranqueado por economia, não por gasto bruto', () => {
    const r = sugerirCortes([
      ...gastos('Roupas', 400, 3),   // R$1200/mês, 3×/mês → 1/5 → R$240
      ...gastos('Ifood', 40, 15),    // R$600/mês, 15×/mês → 1/3 → R$200
    ], JULHO)
    assert.equal(r[0].tipo, 'Roupas', 'R$240 economizáveis > R$200')
    assert.equal(r.length, 2)
  })

  test('gasto MAIOR pode render MENOS corte que um menor e repetido', () => {
    const r = sugerirCortes([
      ...gastos('Eletrônico', 700, 3), // R$2100/mês mas só 3× → 1/5 → R$420
      ...gastos('Ifood', 50, 24),      // R$1200/mês, 24× → 1/3 → R$400
    ], JULHO)
    assert.equal(r[0].tipo, 'Eletrônico')
    assert.ok(r[0].economiaMensal > r[1].economiaMensal)
  })

  test('respeita o limite de sugestões', () => {
    const r = sugerirCortes([
      ...gastos('Ifood', 50, 10), ...gastos('Lazer', 60, 10),
      ...gastos('Roupas', 70, 10), ...gastos('Beleza', 80, 10),
    ], JULHO, { limite: 2 })
    assert.equal(r.length, 2)
  })
})

describe('exclusões estruturais', () => {
  test('lançamento GERADO pelo app não é escolha do mês (marcador de origem)', () => {
    assert.equal(sugerirCortes(gastos('Lazer', 100, 10, 7, 2026, { contaFixaId: 'cf1' }), JULHO).length, 0)
    assert.equal(sugerirCortes(gastos('Lazer', 100, 10, 7, 2026, { faturaId: 'f1' }), JULHO).length, 0)
    assert.equal(sugerirCortes(gastos('Lazer', 100, 10, 7, 2026, { compraId: 'c1' }), JULHO).length, 0)
  })
  test('entrada e reserva não são gasto', () => {
    const t = [
      ...gastos('Ifood', 50, 10).map(x => ({ ...x, categoria: 'entrada' })),
      ...gastos('Ifood', 50, 10).map(x => ({ ...x, categoria: 'reserva' })),
    ]
    assert.equal(sugerirCortes(t, JULHO).length, 0)
  })
  test('saida_credito CONTA como gasto (o relatório também soma)', () => {
    const t = gastos('Ifood', 40, 12).map(x => ({ ...x, categoria: 'saida_credito' }))
    assert.equal(sugerirCortes(t, JULHO).length, 1)
  })
  test('fora da janela não conta', () => {
    assert.equal(sugerirCortes(gastos('Ifood', 50, 15, 1, 2026), JULHO).length, 0)
  })
})

describe('denominador adaptativo', () => {
  test('usuário novo (1 mês de uso) não tem o gasto diluído por 3', () => {
    // 12 pedidos só em julho; hoje 31/07 → ~1 mês ativo, não 3
    const r = sugerirCortes(gastos('Ifood', 50, 12), JULHO)
    assert.equal(Math.round(r[0].gastoMensal), 600, 'R$600/mês, não R$200')
  })
  test('3 meses de histórico dividem por 3', () => {
    const t = [
      ...gastos('Ifood', 50, 4, 5, 2026),
      ...gastos('Ifood', 50, 4, 6, 2026),
      ...gastos('Ifood', 50, 4, 7, 2026),
    ]
    const r = sugerirCortes(t, JULHO)
    assert.equal(Math.round(r[0].gastoMensal), 200, 'R$600 em 3 meses = R$200/mês')
  })
})

describe('robustez', () => {
  test('entrada inválida não quebra', () => {
    assert.deepEqual(sugerirCortes(null, JULHO), [])
    assert.deepEqual(sugerirCortes(undefined, JULHO), [])
    assert.deepEqual(sugerirCortes([], JULHO), [])
    assert.deepEqual(sugerirCortes([{}, { categoria: 'saida' }], JULHO), [])
  })
  test('valor e data lixo são ignorados', () => {
    const t = [
      ...gastos('Ifood', NaN, 5),
      ...gastos('Ifood', -50, 5),
      { categoria: 'saida', tipo: 'Ifood', valor: 50, data: 'ontem' },
    ]
    assert.equal(sugerirCortes(t, JULHO).length, 0)
  })
  test('tipo sem trim/vazio não quebra', () => {
    const t = gastos('  Ifood  ', 50, 12)
    assert.equal(sugerirCortes(t, JULHO).length, 1, 'trim antes de classificar')
  })
  test('economiaTotalAnual soma tudo', () => {
    const r = sugerirCortes([...gastos('Ifood', 50, 12), ...gastos('Lazer', 80, 8)], JULHO)
    const esperado = r.reduce((s, x) => s + x.economiaAnual, 0)
    assert.equal(economiaTotalAnual(r), esperado)
    assert.equal(economiaTotalAnual(null), 0)
  })
})
