/**
 * GranaEvo — Testes da previsão de patrimônio (projetarPatrimonio)
 *
 * Motor puro de projeção: patrimônio hoje + ritmo de poupança observado →
 * onde o usuário chega em 1/5/10 anos, com e sem rendimento.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  projetarPatrimonio,
  projetarValor,
  calcularPatrimonioHoje,
} from '../../src/scripts/modules/patrimonio.js'

// Data fixa p/ determinismo: 15/07/2026 → mês corrente (julho) é INCOMPLETO,
// último mês completo = junho/2026, janela padrão = jan..jun (6 meses).
const HOJE = new Date(2026, 6, 15)

// Factory de transação — só o que o motor lê.
const tx = (categoria, valor, data, extra = {}) => ({ categoria, valor, data, ...extra })

// Arredonda p/ comparar dinheiro sem ruído de float.
const c2 = n => Math.round(n * 100) / 100

describe('calcularPatrimonioHoje — saldo + reservas', () => {
  test('patrimônio = saldo em conta + total guardado em metas', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 5000, '05/06/2026'),
        tx('saida', 1200, '10/06/2026'),
        tx('reserva', 800, '20/06/2026'), // sai do saldo, vira `saved`
      ],
      metas: [{ saved: 800 }, { saved: 450 }],
    }
    const r = calcularPatrimonioHoje(ctx)
    assert.equal(r.saldo, 3000)          // 5000 − 1200 − 800
    assert.equal(r.reservado, 1250)      // 800 + 450
    assert.equal(r.patrimonioHoje, 4250)
  })

  test('aportar numa reserva NÃO muda o patrimônio (transferência interna)', () => {
    const antes = calcularPatrimonioHoje({
      transacoes: [tx('entrada', 1000, '05/06/2026')],
      metas: [],
    })
    const depois = calcularPatrimonioHoje({
      transacoes: [tx('entrada', 1000, '05/06/2026'), tx('reserva', 400, '06/06/2026')],
      metas: [{ saved: 400 }],
    })
    assert.equal(antes.patrimonioHoje, 1000)
    assert.equal(depois.patrimonioHoje, 1000, 'só mudou de bolso, não de dono')
  })

  test('retirada_reserva devolve ao saldo', () => {
    const r = calcularPatrimonioHoje({
      transacoes: [tx('entrada', 1000, '05/06/2026'), tx('retirada_reserva', 300, '07/06/2026')],
      metas: [{ saved: 0 }],
    })
    assert.equal(r.saldo, 1300)
    assert.equal(r.patrimonioHoje, 1300)
  })

  test('meta com saved negativo/lixo não subtrai patrimônio', () => {
    const r = calcularPatrimonioHoje({
      transacoes: [],
      metas: [{ saved: -500 }, { saved: 'abc' }, { saved: 200 }, {}],
    })
    assert.equal(r.reservado, 200)
  })
})

describe('projetarValor — juros compostos (a fórmula)', () => {
  test('taxa 1%/mês, 12 meses: bate com o valor calculado à mão', () => {
    // P=10000, PMT=1000, i=0.01, n=12
    // (1.01)^12                      = 1.1268250301319698
    // P·(1.01)^12                    = 11268.250301319698
    // PMT·(((1.01)^12 − 1)/0.01)     = 1000 · 12.68250301319698 = 12682.50301319698
    // total                          = 23950.753314516678
    assert.equal(c2(projetarValor(10000, 1000, 0.01, 12)), 23950.75)
  })

  test('só principal, sem aporte: P·(1+i)^n', () => {
    // 10000 · 1.1268250301319698
    assert.equal(c2(projetarValor(10000, 0, 0.01, 12)), 11268.25)
  })

  test('só aporte, sem principal: PMT·(((1+i)^n − 1)/i)', () => {
    assert.equal(c2(projetarValor(0, 1000, 0.01, 12)), 12682.5)
  })

  test('taxa 0 NÃO divide por zero → projeção linear P + PMT·n', () => {
    const v = projetarValor(10000, 1000, 0, 12)
    assert.ok(Number.isFinite(v), 'não pode ser NaN/Infinity (0/0)')
    assert.equal(v, 22000)
  })

  test('taxa minúscula não colapsa o termo da série para 0', () => {
    // Guarda de tolerância: (1+1e-15)^12 − 1 arredonda pra 0 em float64; sem a
    // guarda a série devolveria 0 e o aporte de 12 mil sumiria.
    const v = projetarValor(10000, 1000, 1e-15, 12)
    assert.ok(Math.abs(v - 22000) < 0.01, `esperava ~22000, veio ${v}`)
  })

  test('taxa inválida (NaN/lixo) cai no linear em vez de propagar NaN', () => {
    assert.equal(projetarValor(10000, 1000, NaN, 12), 22000)
    assert.equal(projetarValor(10000, 1000, 'abc', 12), 22000)
  })

  test('aporte negativo projeta QUEDA, inclusive abaixo de zero', () => {
    // Sem rendimento: 1000 − 200·12 = −1400. Nada de piso otimista em zero.
    assert.equal(projetarValor(1000, -200, 0, 12), -1400)
    assert.ok(projetarValor(1000, -200, 0.01, 12) < 1000)
  })
})

describe('projetarPatrimonio — poupança mensal observada', () => {
  test('IGNORA o mês corrente incompleto', () => {
    const ctx = {
      transacoes: [
        // junho (completo): +1000 líquido
        tx('entrada', 3000, '05/06/2026'),
        tx('saida', 2000, '20/06/2026'),
        // julho (corrente, incompleto): salário já caiu, contas ainda não venceram
        tx('entrada', 50000, '05/07/2026'),
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.mesesObservados, 1)
    assert.equal(r.poupancaMensal, 1000, 'julho distorceria o ritmo para +51k/mês')
  })

  test('média sobre vários meses completos', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 3000, '05/05/2026'), tx('saida', 2000, '20/05/2026'), // +1000
        tx('entrada', 3000, '05/06/2026'), tx('saida', 1000, '20/06/2026'), // +2000
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.mesesObservados, 2)
    assert.equal(r.poupancaMensal, 1500) // (1000 + 2000) / 2
  })

  test('mês parado dentro do histórico conta no denominador (não infla)', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 3000, '05/04/2026'), tx('saida', 2000, '20/04/2026'), // +1000
        // maio: nada aconteceu — mês de poupança zero, não um mês inexistente
        tx('entrada', 3000, '05/06/2026'), tx('saida', 2000, '20/06/2026'), // +1000
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.mesesObservados, 3, 'abr, mai e jun')
    assert.equal(c2(r.poupancaMensal), 666.67, 'não 1000 — maio não pode ser pulado')
  })

  test('reserva/retirada não entram na poupança (não mudam patrimônio)', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 3000, '05/06/2026'),
        tx('saida', 2000, '20/06/2026'),
        tx('reserva', 500, '21/06/2026'),
        tx('retirada_reserva', 500, '22/06/2026'),
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.poupancaMensal, 1000, 'transferência interna não é poupança')
  })

  test('poupança NEGATIVA projeta patrimônio caindo', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 2000, '05/06/2026'),
        tx('saida', 3000, '20/06/2026'), // −1000/mês
      ],
      metas: [{ saved: 20000 }],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.poupancaMensal, -1000)
    // patrimônio hoje = saldo(−1000) + reservado(20000) = 19000
    assert.equal(r.patrimonioHoje, 19000)
    const um = r.projecoes.find(p => p.anos === 1)
    assert.equal(um.semRendimento, 19000 - 12000, 'queda honesta: 7000')
    assert.ok(um.valor < r.patrimonioHoje, 'não pode forçar otimismo')
    // Em 5 anos o dinheiro acaba e vira dívida — o motor não esconde isso.
    assert.ok(r.projecoes.find(p => p.anos === 5).semRendimento < 0)
  })
})

describe('projetarPatrimonio — denominador adaptativo (histórico curto)', () => {
  test('usuário novo com 1 mês completo divide por 1, não pela janela de 6', () => {
    const ctx = {
      transacoes: [tx('entrada', 3000, '05/06/2026'), tx('saida', 1800, '20/06/2026')],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.mesesObservados, 1)
    assert.equal(r.poupancaMensal, 1200, '1200/1 (piso), não 1200/6 = 200')
  })

  test('histórico longo é limitado pelo teto da janela (6 meses)', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 900, '10/01/2025'), // muito antes da janela → ignorado
        tx('entrada', 600, '10/02/2026'), // fev/2026, dentro da janela
        tx('entrada', 600, '10/06/2026'),
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.mesesObservados, 5, 'fev..jun; jan/2025 fora da janela')
    assert.equal(c2(r.poupancaMensal), 240) // 1200 / 5
  })

  test('janela configurável via opts.mesesJanela', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 1000, '10/03/2026'),
        tx('entrada', 1000, '10/06/2026'),
      ],
      metas: [],
    }
    const janela12 = projetarPatrimonio(ctx, HOJE, { mesesJanela: 12 })
    assert.equal(janela12.mesesObservados, 4) // mar..jun
    const janela2 = projetarPatrimonio(ctx, HOJE, { mesesJanela: 2 })
    assert.equal(janela2.mesesObservados, 1) // só jun (mai..jun é a janela)
    assert.equal(janela2.poupancaMensal, 1000)
  })

  test('sem histórico completo → poupança 0, sem inventar ritmo', () => {
    const ctx = { transacoes: [tx('entrada', 5000, '05/07/2026')], metas: [] } // só mês corrente
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.mesesObservados, 0)
    assert.equal(r.poupancaMensal, 0)
    assert.equal(r.patrimonioHoje, 5000)
    assert.equal(r.projecoes.find(p => p.anos === 10).valor, 5000, 'patrimônio parado')
  })
})

describe('projetarPatrimonio — despesas geradas pelo app', () => {
  // DECISÃO (ver cabeçalho de patrimonio.js): ao contrário de previsao-mes.js, o
  // marcador de origem NÃO exclui nada aqui. Lá ele evita double-count contra o
  // `contasAPagar`; aqui não há contabilização paralela — pular aluguel/fatura
  // apagaria as maiores despesas reais e inflaria a poupança.
  test('conta fixa e fatura pagas SÃO despesa real e reduzem a poupança', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 5000, '05/06/2026'),
        tx('saida', 1500, '10/06/2026', { tipo: 'Conta Fixa', contaFixaId: 'c1' }),
        tx('saida', 1000, '15/06/2026', { tipo: 'Pagamento Cartão', faturaId: 'f1', compraId: 'p1' }),
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.poupancaMensal, 2500, 'ignorá-las daria 5000/mês — fantasia')
    assert.equal(r.patrimonioHoje, 2500, 'e o saldo já as debitou')
  })

  test("'saida_credito' NÃO entra — evita cobrar a compra duas vezes", () => {
    // Compra no cartão em junho (saida_credito) + pagamento da fatura em junho
    // (saida + faturaId). O dinheiro saiu UMA vez.
    const ctx = {
      transacoes: [
        tx('entrada', 5000, '05/06/2026'),
        tx('saida_credito', 800, '08/06/2026', { tipo: 'Mercado' }),
        tx('saida', 800, '15/06/2026', { tipo: 'Pagamento Cartão', faturaId: 'f1', compraId: 'p1' }),
      ],
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.poupancaMensal, 4200, 'contar as duas daria 3400 (800 a mais)')
    assert.equal(r.patrimonioHoje, 4200, 'coerente com o saldo, que ignora saida_credito')
  })

  test('COERÊNCIA fluxo×estoque: Σ(poupança) = variação do patrimônio', () => {
    // A identidade que justifica a decisão acima: partindo do zero, o ritmo
    // observado × meses observados tem que reproduzir o patrimônio atual.
    const ctx = {
      transacoes: [
        tx('entrada', 4000, '05/05/2026'),
        tx('saida', 1500, '10/05/2026', { tipo: 'Conta Fixa', contaFixaId: 'c1' }),
        tx('reserva', 500, '25/05/2026'),
        tx('entrada', 4000, '05/06/2026'),
        tx('saida', 1000, '15/06/2026', { tipo: 'Pagamento Cartão', faturaId: 'f1' }),
      ],
      metas: [{ saved: 500 }],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(
      c2(r.poupancaMensal * r.mesesObservados),
      c2(r.patrimonioHoje),
      'estoque e fluxo têm que concordar sobre o que é dinheiro'
    )
  })
})

describe('projetarPatrimonio — projeções 1/5/10 anos', () => {
  const ctx = {
    transacoes: [tx('entrada', 3000, '05/06/2026'), tx('saida', 2000, '20/06/2026')],
    metas: [{ saved: 9000 }],
  }
  // patrimônio hoje = saldo(1000) + reservado(9000) = 10000; poupança = 1000/mês

  test('sem rendimento (taxa padrão 0) → linear', () => {
    const r = projetarPatrimonio(ctx, HOJE)
    assert.equal(r.patrimonioHoje, 10000)
    assert.equal(r.poupancaMensal, 1000)
    assert.equal(r.taxaMensal, 0)
    assert.deepEqual(r.projecoes.map(p => p.anos), [1, 5, 10])
    assert.equal(r.projecoes[0].valor, 22000)  // 10000 + 1000·12
    assert.equal(r.projecoes[1].valor, 70000)  // 10000 + 1000·60
    assert.equal(r.projecoes[2].valor, 130000) // 10000 + 1000·120
    // Sem rendimento, valor e semRendimento coincidem.
    r.projecoes.forEach(p => assert.equal(p.valor, p.semRendimento))
  })

  test('com rendimento (1%/mês) bate com a fórmula e supera o linear', () => {
    const r = projetarPatrimonio(ctx, HOJE, { taxaMensal: 0.01 })
    assert.equal(r.taxaMensal, 0.01)
    const um = r.projecoes.find(p => p.anos === 1)
    assert.equal(c2(um.valor), 23950.75)      // mesmo valor à mão de projetarValor
    assert.equal(um.semRendimento, 22000)
    r.projecoes.forEach(p => assert.ok(p.valor > p.semRendimento, `${p.anos}a`))
  })

  test('anos configuráveis via opts.anos', () => {
    const r = projetarPatrimonio(ctx, HOJE, { anos: [2, 20] })
    assert.deepEqual(r.projecoes.map(p => p.anos), [2, 20])
    assert.equal(r.projecoes[0].meses, 24)
    assert.equal(r.projecoes[1].meses, 240)
  })
})

describe('projetarPatrimonio — entradas inválidas não quebram', () => {
  test('ctx vazio / sem campos', () => {
    for (const ctx of [{}, { transacoes: [], metas: [] }, { transacoes: [] }]) {
      const r = projetarPatrimonio(ctx, HOJE)
      assert.equal(r.patrimonioHoje, 0)
      assert.equal(r.poupancaMensal, 0)
      assert.equal(r.projecoes.length, 3)
      r.projecoes.forEach(p => assert.equal(p.valor, 0))
    }
  })

  test('ctx null/undefined', () => {
    assert.equal(projetarPatrimonio(null, HOJE).patrimonioHoje, 0)
    assert.equal(projetarPatrimonio(undefined, HOJE).poupancaMensal, 0)
  })

  test('transações com valor/data lixo são ignoradas sem NaN', () => {
    const ctx = {
      transacoes: [
        tx('entrada', 'abc', '05/06/2026'),
        tx('entrada', null, '05/06/2026'),
        tx('saida', 100, 'data-invalida'),
        tx('saida', 100, null),
        tx('entrada', 1000, '2026-06-05'), // formato legado YYYY-MM-DD
        tx('entrada', -50, '05/06/2026'),  // negativo → 0
        { categoria: 'entrada' },
        null,
        undefined,
      ].filter(Boolean),
      metas: [],
    }
    const r = projetarPatrimonio(ctx, HOJE)
    assert.ok(Number.isFinite(r.patrimonioHoje), 'patrimônio virou NaN')
    assert.ok(Number.isFinite(r.poupancaMensal), 'poupança virou NaN')
    assert.equal(r.poupancaMensal, 1000, 'só a legada válida conta')
    r.projecoes.forEach(p => assert.ok(Number.isFinite(p.valor)))
  })

  test('opts inválido/ausente cai nos defaults', () => {
    const ctx = { transacoes: [tx('entrada', 1000, '05/06/2026')], metas: [] }
    for (const opts of [undefined, null, {}, { taxaMensal: 'abc', anos: 'x', mesesJanela: -3 }]) {
      const r = projetarPatrimonio(ctx, HOJE, opts)
      assert.equal(r.taxaMensal, 0)
      assert.deepEqual(r.projecoes.map(p => p.anos), [1, 5, 10])
      assert.ok(Number.isFinite(r.poupancaMensal))
    }
  })

  test('taxa absurda (< −100%/mês) é rejeitada em vez de gerar valor imaginário', () => {
    const ctx = { transacoes: [tx('entrada', 1000, '05/06/2026')], metas: [] }
    const r = projetarPatrimonio(ctx, HOJE, { taxaMensal: -2 })
    assert.equal(r.taxaMensal, 0)
    r.projecoes.forEach(p => assert.ok(Number.isFinite(p.valor)))
  })
})
