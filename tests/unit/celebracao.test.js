/**
 * GranaEvo — Testes da celebração de meta concluída (confetti)
 *
 * A regra é o que importa: `saved` muda em 5 pontos diferentes, então detectamos
 * a TRAVESSIA dos 100% num ponto único. Precisa disparar UMA vez (não a cada
 * render), não festejar metas antigas em aparelho novo, e voltar a festejar se a
 * meta sair e reentrar nos 100% (retirada → novo aporte).
 *
 * `dispararConfetti` precisa de canvas/DOM → não testado aqui (é enfeite).
 * Puro. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { metasParaCelebrar, metasCompletas } from '../../src/scripts/modules/celebracao.js'

describe('metasParaCelebrar — quem acabou de bater a meta', () => {
  test('meta em 100% ainda não celebrada → celebra', () => {
    const metas = [{ id: 'm1', objetivo: 1000, saved: 1000 }]
    assert.deepEqual(metasParaCelebrar(metas, []), ['m1'])
  })

  test('meta acima de 100% também conta', () => {
    const metas = [{ id: 'm1', objetivo: 1000, saved: 1500 }]
    assert.deepEqual(metasParaCelebrar(metas, []), ['m1'])
  })

  test('meta já celebrada → não repete (senão festeja a cada render)', () => {
    const metas = [{ id: 'm1', objetivo: 1000, saved: 1000 }]
    assert.deepEqual(metasParaCelebrar(metas, ['m1']), [])
  })

  test('meta incompleta → não celebra', () => {
    const metas = [{ id: 'm1', objetivo: 1000, saved: 999.99 }]
    assert.deepEqual(metasParaCelebrar(metas, []), [])
  })

  test('objetivo zero/inválido não celebra (evita festa sem sentido)', () => {
    assert.deepEqual(metasParaCelebrar([{ id: 'm1', objetivo: 0, saved: 0 }], []), [])
    assert.deepEqual(metasParaCelebrar([{ id: 'm2', saved: 100 }], []), [])
  })

  test('id numérico e string são a mesma meta', () => {
    const metas = [{ id: 7, objetivo: 100, saved: 100 }]
    assert.deepEqual(metasParaCelebrar(metas, ['7']), [], 'já celebrada, mesmo com id numérico')
  })

  test('várias metas: só as novas entram', () => {
    const metas = [
      { id: 'a', objetivo: 100, saved: 100 },  // já celebrada
      { id: 'b', objetivo: 100, saved: 100 },  // nova
      { id: 'c', objetivo: 100, saved: 50 },   // incompleta
    ]
    assert.deepEqual(metasParaCelebrar(metas, ['a']), ['b'])
  })

  test('entrada inválida não quebra', () => {
    assert.deepEqual(metasParaCelebrar(null, null), [])
    assert.deepEqual(metasParaCelebrar([], undefined), [])
  })
})

describe('metasCompletas — usado para podar a lista (retirada)', () => {
  test('lista só os completos', () => {
    const metas = [
      { id: 'a', objetivo: 100, saved: 100 },
      { id: 'b', objetivo: 100, saved: 99 },
      { id: 'c', objetivo: 0,   saved: 50 },
    ]
    assert.deepEqual(metasCompletas(metas), ['a'])
  })

  test('meta que saiu dos 100% some da lista → poder recelebrar depois', () => {
    // Antes: 'a' estava completa e celebrada. Agora houve retirada.
    const depoisDaRetirada = [{ id: 'a', objetivo: 100, saved: 40 }]
    assert.deepEqual(metasCompletas(depoisDaRetirada), [], 'sai da lista de celebradas')
    // Ao recompletar, volta a celebrar (a lista podada não contém 'a').
    const recompletou = [{ id: 'a', objetivo: 100, saved: 100 }]
    assert.deepEqual(metasParaCelebrar(recompletou, []), ['a'])
  })
})
