/**
 * GranaEvo — Testes da reserva compartilhada da família (item 13)
 *
 * Cobre o motor puro. O que NÃO está aqui, de propósito: autorização. Quem
 * autoriza é o RLS (migration 20260716120000) — estas funções só evitam que a
 * tela ofereça um botão que o banco vai recusar. `podeDesfazer` é o espelho da
 * política `srm_delete_recente_proprio`; se divergirem, quem manda é o banco.
 *
 * Puro, sem rede/DOM, `agora` injetável. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  saldoDe, porMembro, podeDesfazer, progressoDe, contaCompartilhada, JANELA_DESFAZER_MS,
} from '../../src/scripts/modules/reserva-familia.js'

const AGORA = new Date('2026-07-16T12:00:00Z')
const mov = (tipo, valor, uid, nome, minAtras = 0) => ({
  id: `m${Math.random()}`,
  member_user_id: uid,
  member_name: nome,
  tipo,
  valor,
  created_at: new Date(AGORA.getTime() - minAtras * 60_000).toISOString(),
})

describe('saldoDe', () => {
  test('aporte soma, retirada subtrai', () => {
    assert.equal(saldoDe([mov('aporte', 500, 'u1', 'Ana'), mov('retirada', 200, 'u2', 'Bruno')]), 300)
  })
  test('sem movimentos = 0', () => {
    assert.equal(saldoDe([]), 0)
    assert.equal(saldoDe(null), 0)
  })
  test('centavos não acumulam erro de ponto flutuante', () => {
    const ms = [mov('aporte', 0.1, 'u1', 'Ana'), mov('aporte', 0.2, 'u1', 'Ana')]
    assert.equal(saldoDe(ms), 0.3, '0.1+0.2 = 0.30000000000000004 sem arredondar')
  })
  test('linha corrompida é ignorada, não vira NaN (é dinheiro de família)', () => {
    const ms = [
      mov('aporte', 100, 'u1', 'Ana'),
      { tipo: 'aporte', valor: NaN, member_user_id: 'u1', member_name: 'X' },
      { tipo: 'aporte', valor: -50, member_user_id: 'u1', member_name: 'X' },
      { tipo: 'sei_la', valor: 999, member_user_id: 'u1', member_name: 'X' },
      null,
    ]
    assert.equal(saldoDe(ms), 100)
  })
})

describe('porMembro — quem colocou e quem tirou', () => {
  test('agrupa por pessoa com aportes, retiradas e líquido', () => {
    const ms = [
      mov('aporte', 500, 'u1', 'Ana'),
      mov('aporte', 300, 'u2', 'Bruno'),
      mov('retirada', 100, 'u1', 'Ana'),
    ]
    const r = porMembro(ms)
    assert.equal(r.length, 2)
    assert.deepEqual(r[0], { id: 'u1', nome: 'Ana', aportes: 500, retiradas: 100, liquido: 400 })
    assert.deepEqual(r[1], { id: 'u2', nome: 'Bruno', aportes: 300, retiradas: 0, liquido: 300 })
  })

  test('ordena pelo líquido — quem sustenta a reserva aparece primeiro', () => {
    const ms = [
      mov('aporte', 100, 'u1', 'Ana'),
      mov('aporte', 900, 'u2', 'Bruno'),
    ]
    assert.equal(porMembro(ms)[0].nome, 'Bruno')
  })

  test('o LÍQUIDO conta a história real: quem põe 500 e tira 400 fica com 100', () => {
    const ms = [mov('aporte', 500, 'u1', 'Ana'), mov('retirada', 400, 'u1', 'Ana')]
    const r = porMembro(ms)
    assert.equal(r[0].liquido, 100, 'mostrar só aportes esconderia as retiradas')
    assert.equal(r[0].aportes, 500)
    assert.equal(r[0].retiradas, 400)
  })

  test('líquido negativo é exibido (não some, não é escondido)', () => {
    const ms = [
      mov('aporte', 1000, 'u1', 'Ana'),
      mov('retirada', 300, 'u2', 'Bruno'),
    ]
    const r = porMembro(ms)
    assert.equal(r[1].nome, 'Bruno')
    assert.equal(r[1].liquido, -300)
  })

  test('quem trocou de nome não vira duas pessoas (agrupa por id)', () => {
    const ms = [
      mov('aporte', 100, 'u1', 'Ana'),
      mov('aporte', 100, 'u1', 'Ana Maria'),
    ]
    const r = porMembro(ms)
    assert.equal(r.length, 1)
    assert.equal(r[0].liquido, 200)
  })

  test('membro excluído (member_user_id null) ainda aparece pelo snapshot do nome', () => {
    const ms = [{ member_user_id: null, member_name: 'Ex-membro', tipo: 'aporte', valor: 250, created_at: AGORA.toISOString() }]
    const r = porMembro(ms)
    assert.equal(r[0].nome, 'Ex-membro')
    assert.equal(r[0].id, null)
    assert.equal(r[0].liquido, 250, 'o saldo tem que continuar fechando')
  })

  test('entrada inválida não quebra', () => {
    assert.deepEqual(porMembro(null), [])
    assert.deepEqual(porMembro([]), [])
    assert.deepEqual(porMembro([{ tipo: 'aporte', valor: 'abc' }]), [])
  })

  test('a soma dos líquidos bate com o saldo', () => {
    const ms = [
      mov('aporte', 500, 'u1', 'Ana'),
      mov('aporte', 300, 'u2', 'Bruno'),
      mov('retirada', 120.5, 'u1', 'Ana'),
      mov('retirada', 80, 'u2', 'Bruno'),
    ]
    const soma = porMembro(ms).reduce((s, m) => s + m.liquido, 0)
    assert.equal(Math.round(soma * 100) / 100, saldoDe(ms))
  })
})

describe('podeDesfazer — espelho da política srm_delete_recente_proprio', () => {
  test('o próprio, recém-lançado → pode', () => {
    assert.equal(podeDesfazer(mov('aporte', 50, 'u1', 'Ana', 1), 'u1', AGORA), true)
  })
  test('o próprio, mas fora da janela de 10 min → não pode (a trilha é imutável)', () => {
    assert.equal(podeDesfazer(mov('aporte', 50, 'u1', 'Ana', 11), 'u1', AGORA), false)
  })
  test('movimento de OUTRA pessoa → nunca, nem recém-lançado', () => {
    assert.equal(podeDesfazer(mov('aporte', 50, 'u2', 'Bruno', 1), 'u1', AGORA), false)
  })
  test('a borda dos 10 minutos', () => {
    const m = mov('aporte', 50, 'u1', 'Ana')
    m.created_at = new Date(AGORA.getTime() - JANELA_DESFAZER_MS + 1000).toISOString()
    assert.equal(podeDesfazer(m, 'u1', AGORA), true)
    m.created_at = new Date(AGORA.getTime() - JANELA_DESFAZER_MS - 1000).toISOString()
    assert.equal(podeDesfazer(m, 'u1', AGORA), false)
  })
  test('data corrompida → não pode (nega em vez de liberar)', () => {
    const m = mov('aporte', 50, 'u1', 'Ana')
    m.created_at = 'ontem'
    assert.equal(podeDesfazer(m, 'u1', AGORA), false)
  })
  test('entrada inválida → false', () => {
    assert.equal(podeDesfazer(null, 'u1', AGORA), false)
    assert.equal(podeDesfazer(mov('aporte', 50, 'u1', 'Ana'), null, AGORA), false)
  })
})

describe('progressoDe', () => {
  test('metade do objetivo = 50%', () => assert.equal(progressoDe(500, 1000), 50))
  test('passou do objetivo trava em 100', () => assert.equal(progressoDe(1500, 1000), 100))
  test('saldo negativo trava em 0', () => assert.equal(progressoDe(-50, 1000), 0))
  test('sem objetivo → null (não inventa barra)', () => {
    assert.equal(progressoDe(500, null), null)
    assert.equal(progressoDe(500, 0), null)
    assert.equal(progressoDe(500, 'abc'), null)
  })
})

describe('contaCompartilhada — para quem a feature aparece', () => {
  test('convidado sempre vê', () => {
    assert.equal(contaCompartilhada({ isGuest: true, plano: 'Individual' }), true)
  })
  test('titular de Casal/Família vê', () => {
    assert.equal(contaCompartilhada({ plano: 'Casal' }), true)
    assert.equal(contaCompartilhada({ plano: 'Família' }), true)
    assert.equal(contaCompartilhada({ plano: 'familia' }), true)
  })
  test('conta individual NÃO vê — "reserva da família" sozinho é ruído', () => {
    assert.equal(contaCompartilhada({ plano: 'Individual' }), false)
    assert.equal(contaCompartilhada({ plano: 'Pro' }), false)
  })
  test('entrada inválida → false', () => {
    assert.equal(contaCompartilhada(null), false)
    assert.equal(contaCompartilhada({}), false)
  })
})
