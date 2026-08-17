/**
 * AS RESERVAS DA CONTA — a compartilhada conta UMA vez.
 *
 * A armadilha que este módulo existe para fechar: uma reserva compartilhada tem
 * uma cópia no slot de CADA membro (é o que faz a feature funcionar). Somar
 * `meta.saved` de todos os perfis conta o mesmo cofre duas, três, quatro vezes.
 *
 * Um cofre de R$ 200 dividido entre duas pessoas aparece como R$ 200 na tela de
 * cada uma — e isso é verdade, é o mesmo cofre. Mas "as reservas da família" não
 * são R$ 400.
 *
 * Roda no CI: node --test tests/unit/
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

let consolidarReservas, R
before(async () => {
  ;({ consolidarReservas } = await import('../../src/scripts/modules/relatorio-reservas.js'))
  R = await import('../../src/scripts/modules/reserva-familia.js')
})

const perfil = (id, nome, metas) => ({ id, nome, metas })

/** Duas cópias da MESMA reserva, como o blob guarda de verdade. */
function contaCompartilhada() {
  const base = {
    id: 'r1', descricao: 'Viagem', objetivo: 5000, saved: 0,
    compartilhada: true, membros: ['1', '2'], convites: [], movimentos: [],
    lastUpdate: '2026-08-17T10:00:00.000Z',
  }
  const a = JSON.parse(JSON.stringify(base))
  const b = JSON.parse(JSON.stringify(base))
  return { a, b, profiles: [perfil('1', 'Ana', [a]), perfil('2', 'Bruno', [b])] }
}

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a reserva compartilhada não conta duas vezes', () => {
  test('⭐ 100 de cada = 200 na conta, não 400', () => {
    const { a, b, profiles } = contaCompartilhada()
    R.registrarMovimento(a, { id: '1', nome: 'Ana',   tipo: 'aporte', valor: 100 })
    R.registrarMovimento(b, { id: '2', nome: 'Bruno', tipo: 'aporte', valor: 100 })
    // Cada cópia enxerga o total (é o mesmo cofre) — como na tela de cada um.
    a.saved = 200; b.saved = 200

    const r = consolidarReservas(profiles)
    assert.equal(r.total, 200, 'somou o mesmo cofre uma vez por perfil')
    assert.equal(r.reservas.length, 1, 'a mesma reserva apareceu mais de uma vez na lista')
  })

  test('⭐ o saldo sai da UNIÃO das trilhas, igual à tela da reserva', () => {
    // Cópias fora de sincronia (uma ainda não viu o aporte da outra) não podem
    // dar um número diferente do que a tela mostra.
    const { a, b, profiles } = contaCompartilhada()
    R.registrarMovimento(a, { id: '1', nome: 'Ana',   tipo: 'aporte', valor: 300 })
    R.registrarMovimento(b, { id: '2', nome: 'Bruno', tipo: 'aporte', valor: 200 })
    a.saved = 300     // Ana ainda não recarregou
    b.saved = 500

    assert.equal(consolidarReservas(profiles).total, 500)
  })

  test('a retirada de um membro abate no total da conta', () => {
    const { a, b, profiles } = contaCompartilhada()
    R.registrarMovimento(a, { id: '1', nome: 'Ana',   tipo: 'aporte',   valor: 1000 })
    R.registrarMovimento(b, { id: '2', nome: 'Bruno', tipo: 'retirada', valor: 250 })
    assert.equal(consolidarReservas(profiles).total, 750)
  })

  test('⭐ quem colocou quanto vem junto, sem as linhas de sistema viradas gente', () => {
    const { a, b, profiles } = contaCompartilhada()
    R.registrarMovimento(a, { id: '1', nome: 'Ana',   tipo: 'aporte', valor: 400 })
    R.registrarMovimento(b, { id: '2', nome: 'Bruno', tipo: 'aporte', valor: 100 })
    R.registrarMovimento(a, { id: null, nome: 'Rendimento', tipo: 'aporte', valor: 7,
                              mid: 'rend:r1:2026-08-17' })

    const [res] = consolidarReservas(profiles).reservas
    const pessoas = res.membros.filter(m => !m.sistema)
    assert.deepEqual(pessoas.map(m => [m.nome, m.liquido]).sort(),
      [['Ana', 400], ['Bruno', 100]])
    assert.ok(res.membros.some(m => m.sistema && m.nome === 'Rendimento'),
      'o rendimento sumiu do detalhamento')
    assert.equal(res.saved, 507)
  })

  test('os dois perfis aparecem como participantes', () => {
    const { profiles } = contaCompartilhada()
    assert.deepEqual(consolidarReservas(profiles).reservas[0].perfis.sort(), ['Ana', 'Bruno'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a migração não pode inventar dinheiro no consolidado', () => {
  test('⭐ reserva antiga (saldo, zero movimentos) NÃO soma as cópias', () => {
    // Antes da trilha existir, as duas cópias guardavam o mesmo saldo. Somar
    // daria o dobro; o certo é UMA vez.
    const { a, b, profiles } = contaCompartilhada()
    a.saved = 1500; b.saved = 1500
    assert.equal(consolidarReservas(profiles).total, 1500, 'a reserva legada dobrou no relatório')
  })

  test('cópias legadas divergentes adotam a MAIOR, nunca a soma', () => {
    const { a, b, profiles } = contaCompartilhada()
    a.saved = 500; b.saved = 1000
    assert.equal(consolidarReservas(profiles).total, 1000)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('reservas privadas e recibos', () => {
  test('reserva privada conta uma vez POR PERFIL (são cofres diferentes)', () => {
    const profiles = [
      perfil('1', 'Ana',   [{ id: 'p1', descricao: 'Carro', saved: 300, objetivo: 1000 }]),
      perfil('2', 'Bruno', [{ id: 'p2', descricao: 'Curso', saved: 200, objetivo: 800 }]),
    ]
    const r = consolidarReservas(profiles)
    assert.equal(r.total, 500)
    assert.equal(r.reservas.length, 2)
    assert.equal(r.totalCompartilhado, 0)
  })

  test('⭐ o RECIBO de quem saiu não entra no total da conta', () => {
    // O dinheiro já voltou para a pessoa por uma transação de retirada. Contar a
    // cópia-recibo somaria o mesmo valor de novo.
    const { a, b, profiles } = contaCompartilhada()
    R.registrarMovimento(a, { id: '1', nome: 'Ana', tipo: 'aporte', valor: 100 })
    a.saved = 100
    b.saved = 100
    b.saiu = true

    const r = consolidarReservas(profiles)
    assert.equal(r.total, 100)
    assert.deepEqual(r.reservas[0].perfis, ['Ana'], 'quem saiu ainda consta como participante')
  })

  test('entrada inválida não derruba', () => {
    assert.equal(consolidarReservas(null).total, 0)
    assert.equal(consolidarReservas([null, { metas: 'x' }, {}]).total, 0)
    assert.deepEqual(consolidarReservas(undefined).reservas, [])
  })

  test('ordena da maior para a menor', () => {
    const profiles = [perfil('1', 'Ana', [
      { id: 'p1', descricao: 'Pequena', saved: 10 },
      { id: 'p2', descricao: 'Grande',  saved: 900 },
    ])]
    assert.deepEqual(consolidarReservas(profiles).reservas.map(r => r.descricao),
      ['Grande', 'Pequena'])
  })
})
