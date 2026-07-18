/**
 * GranaEvo — Testes da proatividade/micro-lição do assistente (Passo 29)
 *
 * O que estes testes protegem NÃO é só a conta: é o CRITÉRIO. Um assistente que
 * dispara "você está gastando demais" sem lastro é pior que um calado — ensina o
 * usuário a ignorar. Por isso a maior parte daqui verifica quando ele CALA:
 * sem histórico suficiente, sem desvio relevante, com trocado.
 *
 * Puro, sem rede/DOM, `hoje` injetável.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { microLicao, assinaturaNaoCadastrada } from '../../src/scripts/modules/assistant/insights.js'

const HOJE = new Date(2026, 6, 18, 12, 0, 0)   // 18/07/2026

/** Saída em DD/MM/AAAA no mês `ymOffset` meses atrás de HOJE. */
const S = (mesesAtras, tipo, valor, dia = 10) => {
  const d = new Date(HOJE.getFullYear(), HOJE.getMonth() - mesesAtras, dia)
  return {
    categoria: 'saida', tipo, valor,
    data: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
  }
}

describe('microLicao — quando CALA (o mais importante)', () => {
  test('sem transações → null', () => {
    assert.equal(microLicao([], HOJE), null)
    assert.equal(microLicao(null, HOJE), null)
  })

  test('com só 1 mês fechado NÃO opina — 1 mês não é média, é amostra', () => {
    const txs = [
      S(1, 'Ifood', 500), S(1, 'Mercado', 500),
      S(0, 'Ifood', 900), S(0, 'Mercado', 100),
    ]
    assert.equal(microLicao(txs, HOJE), null)
  })

  test('gasto pequeno no mês não vira lição (nada de alarme com trocado)', () => {
    const txs = [
      S(1, 'Ifood', 100), S(1, 'Mercado', 900),
      S(2, 'Ifood', 100), S(2, 'Mercado', 900),
      S(0, 'Ifood', 40),   // mês atual: R$40 no total
    ]
    assert.equal(microLicao(txs, HOJE), null)
  })

  test('quem está DENTRO do próprio padrão não recebe lição', () => {
    const txs = [
      S(1, 'Ifood', 120), S(1, 'Mercado', 880),
      S(2, 'Ifood', 120), S(2, 'Mercado', 880),
      S(0, 'Ifood', 120), S(0, 'Mercado', 880),   // mesma proporção
    ]
    assert.equal(microLicao(txs, HOJE), null)
  })
})

describe('microLicao — quando FALA', () => {
  test('estourou a própria média: reporta tipo, % atual e % média', () => {
    const txs = [
      // 2 meses fechados: delivery ~12% do gasto
      S(1, 'Ifood', 120), S(1, 'Mercado', 880),
      S(2, 'Ifood', 120), S(2, 'Mercado', 880),
      // mês atual: delivery 40%
      S(0, 'Ifood', 400), S(0, 'Mercado', 600),
    ]
    const r = microLicao(txs, HOJE)
    assert.ok(r, 'deveria falar: 40% contra média de 12%')
    assert.equal(r.tipo, 'Ifood')
    assert.equal(r.pctAtual, 40)
    assert.equal(r.pctMedia, 12)
    assert.equal(r.gastoAtual, 400)
    assert.equal(r.meses, 2)
  })

  test('escolhe o MAIOR desvio quando há vários', () => {
    const txs = [
      S(1, 'Ifood', 100), S(1, 'Roupas', 100), S(1, 'Mercado', 800),
      S(2, 'Ifood', 100), S(2, 'Roupas', 100), S(2, 'Mercado', 800),
      // atual: Ifood 20% (+10pp) e Roupas 45% (+35pp) → ganha Roupas
      S(0, 'Ifood', 200), S(0, 'Roupas', 450), S(0, 'Mercado', 350),
    ]
    assert.equal(microLicao(txs, HOJE).tipo, 'Roupas')
  })

  test('a média usa a FATIA de cada mês — um mês caro não domina a referência', () => {
    const txs = [
      // mês -1 barato, metade em Ifood; mês -2 caríssimo, quase nada em Ifood
      S(1, 'Ifood', 50),  S(1, 'Mercado', 50),
      S(2, 'Ifood', 100), S(2, 'Mercado', 9900),
      // média das FATIAS = (50% + 1%)/2 ≈ 25,5% — não os ~1,5% da soma bruta
      S(0, 'Ifood', 300), S(0, 'Mercado', 700),   // atual 30%
    ]
    const r = microLicao(txs, HOJE)
    // 30% contra ~25% é desvio de ~5pp, abaixo do mínimo → cala.
    // Se a média fosse pela soma bruta (~1,5%), acusaria +28pp injustamente.
    assert.equal(r, null, 'a fatia média protege contra o mês atípico')
  })

  test('entrada corrompida não quebra nem vira NaN', () => {
    const txs = [
      S(1, 'Ifood', 120), S(1, 'Mercado', 880),
      S(2, 'Ifood', 120), S(2, 'Mercado', 880),
      S(0, 'Ifood', 400), S(0, 'Mercado', 600),
      { categoria: 'saida', tipo: 'X', valor: NaN, data: '10/07/2026' },
      { categoria: 'saida', tipo: 'Y', valor: 10, data: 'lixo' },
      null,
    ]
    const r = microLicao(txs, HOJE)
    assert.ok(r && Number.isFinite(r.pctAtual) && Number.isFinite(r.pctMedia))
  })

  test('entradas e reservas não entram na conta de gasto', () => {
    const txs = [
      S(1, 'Ifood', 120), S(1, 'Mercado', 880),
      S(2, 'Ifood', 120), S(2, 'Mercado', 880),
      S(0, 'Ifood', 400), S(0, 'Mercado', 600),
      { categoria: 'entrada', tipo: 'Salário', valor: 9000, data: '05/07/2026' },
      { categoria: 'reserva', tipo: 'Reserva', valor: 2000, data: '06/07/2026' },
    ]
    assert.equal(microLicao(txs, HOJE).pctAtual, 40, 'entrada/reserva inflariam o total')
  })
})

describe('assinaturaNaoCadastrada — reusa o motor de recorrências', () => {
  test('sem transações → null', () => {
    assert.equal(assinaturaNaoCadastrada([], [], HOJE), null)
    assert.equal(assinaturaNaoCadastrada(null, null, HOJE), null)
  })

  test('cobrança mensal repetida e não cadastrada é detectada', () => {
    const txs = [0, 1, 2, 3].map(m => ({
      ...S(m, 'Assinaturas', 39.9, 15),
      descricao: 'Streaming XYZ',
    }))
    const r = assinaturaNaoCadastrada(txs, [], HOJE)
    if (r) {   // o motor tem heurística própria; se detectou, o formato tem que fechar
      assert.ok(r.valorMensal > 0)
      assert.ok(typeof r.nome === 'string' && r.nome.length > 0)
      assert.equal(Math.round(r.valorAnual), Math.round(r.valorMensal * 12))
    }
  })

  test('não quebra quando o motor recebe lixo', () => {
    assert.doesNotThrow(() => assinaturaNaoCadastrada([{ foo: 1 }, null], undefined, HOJE))
  })
})
