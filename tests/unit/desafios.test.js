/**
 * GranaEvo — Testes da personalização de desafios (2026-07-18)
 *
 * O pedido era "analisar automaticamente os gastos e gerar desafios
 * personalizados de acordo com os hábitos". O que estes testes protegem não é
 * só o cálculo: é a REGRA ANTI-RUÍDO — nada é recomendado sem evidência nos
 * números da pessoa. Sugerir "7 dias sem delivery" para quem nunca pediu
 * delivery ensina o usuário a ignorar a tela, e aí o recurso inteiro morre.
 *
 * Puro, sem DOM/rede, `agora` injetável.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { analisarHabitos, sugerirDesafios, DESAFIOS } from '../../src/scripts/modules/desafios.js'

const AGORA = new Date(2026, 6, 18, 12, 0, 0)   // 18/07/2026 meio-dia (local)

/** Transação `d` dias atrás. */
const tx = (diasAtras, categoria, tipo, valor) => {
  const dt = new Date(AGORA.getTime() - diasAtras * 86_400_000)
  const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  return { categoria, tipo, valor, data: iso }
}

describe('analisarHabitos — a radiografia que alimenta tudo', () => {
  test('agrupa por tipo com total e nº de vezes', () => {
    const h = analisarHabitos([
      tx(2, 'saida', 'Ifood', 50),
      tx(5, 'saida', 'Ifood', 30),
      tx(6, 'saida', 'Mercado', 200),
    ], 30, AGORA)
    assert.equal(h.porTipo.get('Ifood').total, 80)
    assert.equal(h.porTipo.get('Ifood').vezes, 2)
    assert.equal(h.porTipo.get('Mercado').total, 200)
  })

  test('ignora o que está fora da janela', () => {
    const h = analisarHabitos([tx(45, 'saida', 'Ifood', 500)], 30, AGORA)
    assert.equal(h.porTipo.has('Ifood'), false)
  })

  test('separa credito, reservas e entradas', () => {
    const h = analisarHabitos([
      tx(1, 'saida_credito', 'Roupas', 300),
      tx(2, 'reserva', null, 150),
      tx(3, 'entrada', null, 4000),
    ], 30, AGORA)
    assert.equal(h.credito, 300)
    assert.equal(h.reservas, 150)
    assert.equal(h.entradas, 4000)
  })

  test('conta dias distintos com registro (base do desafio de hábito)', () => {
    const h = analisarHabitos([
      tx(1, 'saida', 'Mercado', 10),
      tx(1, 'saida', 'Mercado', 20),   // mesmo dia
      tx(2, 'saida', 'Mercado', 30),
    ], 30, AGORA)
    assert.equal(h.diasComRegistro, 2)
  })

  test('entrada invalida nao quebra', () => {
    assert.equal(analisarHabitos(null, 30, AGORA).diasComRegistro, 0)
    assert.equal(analisarHabitos([null, {}], 30, AGORA).saidas, 0)
  })
})

describe('sugerirDesafios — REGRA ANTI-RUÍDO', () => {
  test('quem NÃO gasta em delivery não recebe desafio de delivery', () => {
    const s = sugerirDesafios([tx(1, 'saida', 'Mercado', 90)], { agora: AGORA })
    assert.equal(s.some(r => r.def.id === 'semana_sem_delivery'), false,
      'sugerir sem evidência é ruído — ensina o usuário a ignorar a tela')
  })

  test('histórico vazio → só o desafio de REGISTRO, nenhum de gasto', () => {
    // Quem não registrou nada não tem gasto a atacar — recomendar "sem delivery"
    // aqui seria inventar. Mas o desafio de registrar É o certo: sem registro não
    // existe análise, então ele é o que destrava todos os outros.
    const s = sugerirDesafios([], { agora: AGORA })
    assert.deepEqual(s.map(r => r.def.id), ['registro_em_dia'])
  })

  test('quem gasta muito em iFood RECEBE o desafio, com o motivo real', () => {
    const txs = [
      tx(1, 'saida', 'Ifood', 45), tx(4, 'saida', 'Ifood', 38),
      tx(8, 'saida', 'Ifood', 52), tx(12, 'saida', 'Ifood', 41),
    ]
    const s = sugerirDesafios(txs, { agora: AGORA })
    const rec = s.find(r => r.def.id === 'semana_sem_delivery')
    assert.ok(rec, 'com 4 pedidos e R$176 o desafio tem que aparecer')
    assert.match(rec.motivo, /176/, 'o motivo mostra o número real da pessoa')
    assert.match(rec.motivo, /4 pedidos/)
  })

  test('respeita o mínimo: 2 pedidos baratos não justificam', () => {
    const s = sugerirDesafios([tx(1, 'saida', 'Ifood', 20), tx(2, 'saida', 'Ifood', 25)], { agora: AGORA })
    assert.equal(s.some(r => r.def.id === 'semana_sem_delivery'), false)
  })

  test('não repete o que já está ativo', () => {
    const txs = [tx(1, 'saida', 'Ifood', 45), tx(4, 'saida', 'Ifood', 38),
                 tx(8, 'saida', 'Ifood', 52), tx(12, 'saida', 'Ifood', 41)]
    const s = sugerirDesafios(txs, { agora: AGORA, excluirIds: ['semana_sem_delivery'] })
    assert.equal(s.some(r => r.def.id === 'semana_sem_delivery'), false)
  })

  test('ranqueia: o gasto maior vem primeiro', () => {
    const txs = [
      // impulso alto
      tx(1, 'saida', 'Shopee', 400), tx(3, 'saida', 'Amazon', 350), tx(5, 'saida', 'Roupas', 300),
      // delivery baixo mas elegível
      tx(2, 'saida', 'Ifood', 20), tx(6, 'saida', 'Ifood', 20), tx(9, 'saida', 'Ifood', 25),
    ]
    const s = sugerirDesafios(txs, { agora: AGORA })
    assert.ok(s.length > 1)
    assert.ok(s[0].score >= s[1].score, 'ordenado por relevância decrescente')
  })

  test('respeita o max', () => {
    const txs = [
      tx(1, 'saida', 'Ifood', 45), tx(4, 'saida', 'Ifood', 38), tx(8, 'saida', 'Ifood', 52),
      tx(2, 'saida', 'Shopee', 400), tx(3, 'saida', 'Amazon', 350), tx(5, 'saida', 'Roupas', 300),
      tx(6, 'saida', 'Mercado', 500), tx(7, 'saida', 'Mercado', 300), tx(9, 'saida', 'Mercado', 200),
    ]
    assert.ok(sugerirDesafios(txs, { agora: AGORA, max: 2 }).length <= 2)
  })
})

describe('teto personalizado — o alvo sai do gasto da própria pessoa', () => {
  const txsMercado = [
    tx(2, 'saida', 'Mercado', 400), tx(9, 'saida', 'Mercado', 350), tx(16, 'saida', 'Mercado', 250),
  ]  // total 1000

  test('o alvo fica ABAIXO do que a pessoa gastou (senão não é desafio)', () => {
    const s = sugerirDesafios(txsMercado, { agora: AGORA })
    const rec = s.find(r => r.def.id === 'teto_mercado')
    assert.ok(rec, 'R$1000 em 3 compras justifica o teto')
    assert.equal(rec.alvo, 850, '85% de 1000')
    assert.ok(rec.alvo < 1000)
  })

  test('sem lastro na categoria, o teto NÃO é sugerido (nada de meta inventada)', () => {
    const s = sugerirDesafios([tx(1, 'saida', 'Mercado', 50)], { agora: AGORA })
    assert.equal(s.some(r => r.def.id === 'teto_mercado'), false)
  })

  test('checkFinal usa o alvo PERSISTIDO e aprova quem ficou abaixo', () => {
    const def = DESAFIOS.find(d => d.id === 'teto_mercado')
    const janela = [tx(1, 'saida', 'Mercado', 300), tx(2, 'saida', 'Mercado', 200)]  // 500
    assert.equal(def.checkFinal(janela, new Date(), 850), true)
    assert.equal(def.checkFinal(janela, new Date(), 400), false, 'estourou o teto')
  })

  test('sem alvo salvo, checkFinal REPROVA em vez de aprovar por engano', () => {
    const def = DESAFIOS.find(d => d.id === 'teto_delivery')
    assert.equal(def.checkFinal([], new Date(), undefined), false)
    assert.equal(def.checkFinal([], new Date(), 0), false)
  })

  test('só conta a categoria do desafio', () => {
    const def = DESAFIOS.find(d => d.id === 'teto_delivery')
    const janela = [tx(1, 'saida', 'Mercado', 900), tx(2, 'saida', 'Ifood', 30)]
    assert.equal(def.checkFinal(janela, new Date(), 100), true, 'Mercado não polui o teto de delivery')
  })
})

describe('integridade do catálogo', () => {
  test('todo desafio tem id slug, título e ícone válidos', () => {
    for (const d of DESAFIOS) {
      assert.match(d.id, /^[a-z0-9_]{3,40}$/, `id inválido: ${d.id}`)
      assert.ok(d.titulo && d.desc, `${d.id} sem texto`)
      assert.match(d.icon, /^fa-[a-z0-9-]+$/, `${d.id} com ícone fora do padrão`)
      assert.ok(d.dias > 0)
    }
  })
  test('ids são únicos', () => {
    const ids = DESAFIOS.map(d => d.id)
    assert.equal(new Set(ids).size, ids.length)
  })
  test('todo desafio dinâmico sabe calcular seu alvo', () => {
    for (const d of DESAFIOS.filter(x => x.dinamico)) {
      assert.equal(typeof d.calcAlvo, 'function', `${d.id} dinâmico sem calcAlvo`)
      assert.equal(typeof d.checkFinal, 'function')
    }
  })
})
