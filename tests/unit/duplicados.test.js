/**
 * GranaEvo — Testes do detector de lançamento duplicado
 *
 * O app é 100% lançamento manual → duplicar é erro comum, e um duplicado
 * contamina saldo, previsão, relatórios e metas de uma vez. O detector precisa
 * ser CONSERVADOR: "2 cafés de R$8 no mesmo dia" é legítimo e não pode virar
 * acusação.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectarDuplicados, deveMostrarAvisoDup, assinaturaGrupo } from '../../src/scripts/modules/duplicados.js'

// Lançamento manual base; sobrescreva o que o teste precisa.
const T = (over) => ({
  categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado',
  valor: 50, data: '10/07/2026', hora: '14:30:00', ...over,
})

describe('detectarDuplicados — acusa o que é repetido', () => {
  test('dois lançamentos iguais no mesmo dia → detectado, impacto = 1× valor', () => {
    const r = detectarDuplicados([T({ id: 1 }), T({ id: 2, hora: '14:32:00' })])
    assert.equal(r.length, 1)
    assert.equal(r[0].itens.length, 2)
    assert.equal(r[0].impacto, 50, 'o dinheiro contado a mais')
  })

  test('três repetidos → impacto conta os 2 extras', () => {
    const r = detectarDuplicados([T({ id: 1 }), T({ id: 2 }), T({ id: 3 })])
    assert.equal(r.length, 1)
    assert.equal(r[0].itens.length, 3)
    assert.equal(r[0].impacto, 100)
  })

  test('aceita data em ISO também', () => {
    const r = detectarDuplicados([T({ id: 1, data: '2026-07-10' }), T({ id: 2, data: '2026-07-10' })])
    assert.equal(r.length, 1)
  })
})

describe('detectarDuplicados — NÃO acusa o que é legítimo', () => {
  test('mesmo valor e dia, descrições diferentes → não acusa (café vs Uber)', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1, descricao: 'Cafe' }), T({ id: 2, descricao: 'Uber' })]), [])
  })

  test('gerados pelo app (conta fixa) são ignorados — repetem de propósito', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1, contaFixaId: 'c1' }), T({ id: 2, contaFixaId: 'c1' })]), [])
  })

  test('gerados pelo app (fatura/compra) são ignorados', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1, faturaId: 'f1' }), T({ id: 2, faturaId: 'f1' })]), [])
    assert.deepEqual(detectarDuplicados([T({ id: 1, compraId: 'x' }), T({ id: 2, compraId: 'x' })]), [])
  })

  test('datas diferentes → não é duplicata', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1 }), T({ id: 2, data: '11/07/2026' })]), [])
  })

  test('valores diferentes → não é duplicata', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1 }), T({ id: 2, valor: 51 })]), [])
  })

  test('categorias diferentes → não é duplicata (saída vs entrada)', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1 }), T({ id: 2, categoria: 'entrada' })]), [])
  })

  test('lançamento único → nada', () => {
    assert.deepEqual(detectarDuplicados([T({ id: 1 })]), [])
  })

  test('lista vazia/inválida não quebra', () => {
    assert.deepEqual(detectarDuplicados([]), [])
    assert.deepEqual(detectarDuplicados(null), [])
  })
})

describe('deveMostrarAvisoDup + assinaturaGrupo', () => {
  const AGORA = new Date(2026, 6, 15).getTime()
  const DIA = 86_400_000
  const g = { dataISO: '2026-07-10', valor: 50, itens: [{ id: 1 }, { id: 2 }] }
  const sig = assinaturaGrupo(g)

  test('sem grupos → não mostra', () => {
    assert.equal(deveMostrarAvisoDup([], {}, AGORA), false)
    assert.equal(deveMostrarAvisoDup(null, {}, AGORA), false)
  })

  test('grupo novo → mostra', () => {
    assert.equal(deveMostrarAvisoDup([g], {}, AGORA), true)
  })

  test('grupo dispensado ("foi proposital") há 5 dias → fica quieto', () => {
    assert.equal(deveMostrarAvisoDup([g], { [sig]: AGORA - 5 * DIA }, AGORA), false)
  })

  test('dispensa vencida (70 dias > 60) → volta a perguntar', () => {
    assert.equal(deveMostrarAvisoDup([g], { [sig]: AGORA - 70 * DIA }, AGORA), true)
  })

  test('assinatura do grupo é estável (ordem dos itens não importa)', () => {
    const a = assinaturaGrupo({ dataISO: '2026-07-10', valor: 50, itens: [{ id: 2 }, { id: 1 }] })
    const b = assinaturaGrupo({ dataISO: '2026-07-10', valor: 50, itens: [{ id: 1 }, { id: 2 }] })
    assert.equal(a, b, 'senão a dispensa não gruda ao reordenar')
  })
})
