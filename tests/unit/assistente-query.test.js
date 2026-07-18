/**
 * GranaEvo — Testes das consultas do assistente (query.js)
 *
 * Estes números o usuário LÊ e AGE em cima ("quanto posso gastar", "quanto gastei
 * semana passada"). Errar aqui é pior que não responder: é uma resposta errada com
 * cara de certa. Cada bloco trava um erro de conta que existiu de verdade.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { filterByPeriodo, mediaMensal, orcamentoRestante, ultimasTransacoes } from '../../src/scripts/modules/assistant/query.js'

// RELÓGIO FIXO. Antes o teste montava "N dias atrás" lendo o relógio e a função
// lia o relógio DE NOVO lá dentro: se a meia-noite (ou a virada de mês) caísse
// entre as duas leituras, a janela deslocava e o teste falhava sozinho —
// acontecia ~1 vez em 6 rodadas. Agora há uma leitura só, injetada.
// Escolhido meio-dia de propósito: longe das duas bordas do dia.
const HOJE = new Date(2026, 6, 18, 12, 0, 0)   // 18/07/2026, meio-dia local

// Data BR (DD/MM/AAAA) de N dias atrás, relativa a HOJE.
const diasAtras = (n) => {
  const d = new Date(HOJE)
  d.setDate(d.getDate() - n)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}
const S = (over) => ({ categoria: 'saida', tipo: 'Mercado', descricao: 'x', valor: 10, ...over })

describe('semana × semana passada são janelas distintas', () => {
  const txs = [
    S({ descricao: 'hoje', data: diasAtras(0) }),
    S({ descricao: 'ha 3 dias', data: diasAtras(3) }),
    S({ descricao: 'ha 6 dias', data: diasAtras(6) }),
    S({ descricao: 'ha 8 dias', data: diasAtras(8) }),
    S({ descricao: 'ha 12 dias', data: diasAtras(12) }),
    S({ descricao: 'ha 20 dias', data: diasAtras(20) }),
  ]
  const descs = (p) => filterByPeriodo(txs, p, HOJE).map((t) => t.descricao).sort()

  test('"semana" pega os últimos 7 dias, incluindo hoje', () => {
    assert.deepEqual(descs('semana'), ['ha 3 dias', 'ha 6 dias', 'hoje'].sort())
  })

  test('"semana_passada" pega os 7 dias ANTERIORES — e nada da semana atual', () => {
    assert.deepEqual(descs('semana_passada'), ['ha 12 dias', 'ha 8 dias'].sort())
  })

  test('as duas janelas não se sobrepõem', () => {
    const a = new Set(filterByPeriodo(txs, 'semana', HOJE).map((t) => t.descricao))
    const b = filterByPeriodo(txs, 'semana_passada', HOJE).map((t) => t.descricao)
    for (const d of b) assert.ok(!a.has(d), `"${d}" aparece nas duas janelas`)
  })

  test('o de 6 dias entra em "semana" mesmo consultando de noite', () => {
    // Regressão: a comparação usava `new Date()` com a hora corrente contra uma
    // data à meia-noite, descontando as horas de hoje e encolhendo a janela.
    assert.ok(descs('semana').includes('ha 6 dias'))
  })
})

describe('média mensal ignora o mês corrente (que é parcial)', () => {
  // 3 meses fechados de R$3.000 + o mês atual mal começado.
  // Ancorado em HOJE também. Lendo o relógio real aqui, o teste passaria hoje por
  // coincidência (HOJE == data real) e quebraria no mês que vem: as transações
  // seriam montadas em relação a agosto e a média julgada em relação a julho.
  const mesesAtras = (n) => {
    const d = new Date(HOJE)
    d.setDate(1)
    d.setMonth(d.getMonth() - n)
    return `10/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
  }
  const perfil = {
    transacoes: [
      S({ valor: 3000, data: mesesAtras(1) }),
      S({ valor: 3000, data: mesesAtras(2) }),
      S({ valor: 3000, data: mesesAtras(3) }),
      S({ valor: 100, data: diasAtras(0) }), // mês corrente, parcial
    ],
  }

  test('a média é dos meses FECHADOS', () => {
    const m = mediaMensal(perfil, { hoje: HOJE })
    assert.equal(m.media, 3000, 'o mês parcial estava puxando a média pra baixo')
    assert.equal(m.meses, 3)
  })

  test('"quanto posso gastar" usa a média correta', () => {
    const o = orcamentoRestante(perfil, HOJE)
    assert.equal(o.media, 3000)
    assert.equal(o.gastoMes, 100)
    assert.equal(o.restante, 2900, 'respondia R$2.175 com a média contaminada')
  })

  test('dá pra incluir o mês atual quando o chamador quiser', () => {
    assert.equal(mediaMensal(perfil, { incluirMesAtual: true, hoje: HOJE }).meses, 4)
  })

  test('quem só tem o mês atual não tem histórico (e não recebe palpite)', () => {
    const novato = { transacoes: [S({ valor: 100, data: diasAtras(0) })] }
    assert.equal(mediaMensal(novato, { hoje: HOJE }).meses, 0)
    assert.equal(orcamentoRestante(novato, HOJE).temHistorico, false)
  })
})

describe('"últimas transações" ordena por data, não por digitação', () => {
  test('um gasto antigo registrado agora NÃO aparece como o mais recente', () => {
    const perfil = {
      transacoes: [
        S({ descricao: 'Feira de hoje', data: diasAtras(0), hora: '09:00:00' }),
        S({ descricao: 'Lanche de 10 dias atras', data: diasAtras(10), hora: '12:00:00' }), // digitado depois
      ],
    }
    assert.equal(ultimasTransacoes(perfil)[0].descricao, 'Feira de hoje')
  })

  test('a hora desempata dentro do mesmo dia', () => {
    const perfil = {
      transacoes: [
        S({ descricao: 'manha', data: diasAtras(0), hora: '08:00:00' }),
        S({ descricao: 'noite', data: diasAtras(0), hora: '21:00:00' }),
      ],
    }
    assert.equal(ultimasTransacoes(perfil)[0].descricao, 'noite')
  })

  test('data ilegível vai pro fundo, nunca pro topo', () => {
    const perfil = {
      transacoes: [
        S({ descricao: 'quebrada', data: 'lixo' }),
        S({ descricao: 'boa', data: diasAtras(5) }),
      ],
    }
    assert.equal(ultimasTransacoes(perfil)[0].descricao, 'boa')
  })

  test('respeita o limite e não quebra com lista vazia', () => {
    const perfil = { transacoes: Array.from({ length: 20 }, (_, i) => S({ descricao: `t${i}`, data: diasAtras(i) })) }
    assert.equal(ultimasTransacoes(perfil, 8).length, 8)
    assert.deepEqual(ultimasTransacoes({ transacoes: [] }), [])
    assert.deepEqual(ultimasTransacoes(null), [])
  })
})
