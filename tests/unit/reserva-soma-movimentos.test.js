/**
 * RESERVA COMPARTILHADA: O SALDO É A SOMA DA TRILHA, NÃO UM NÚMERO DISPUTADO.
 *
 * ACHADO medido em produção (2026-08-16), com o dono reproduzindo passo a passo:
 *
 *   perfil 64 (B): saved=500  · lastUpdate=2026-08-16T18:06:06.332Z · movimentos=0
 *   perfil 65 (A): saved=1000 · lastUpdate=2026-08-16T18:06:06.332Z · movimentos=0
 *
 * Dois problemas, um dentro do outro:
 *
 *   1. Os `lastUpdate` empatavam AO MILISSEGUNDO, porque o carimbo era posto na
 *      PROPAGAÇÃO (uma vez, e o clone levava a mesma hora para todas as cópias).
 *      O desempate por hora virava sorteio pela ordem do array: `copiaMaisRecente`
 *      usa `>` estrito e ficava com a primeira — a de 500.
 *
 *   2. `movimentos` estava em CAMPOS_SINC, então a reconciliação SOBRESCREVIA a
 *      trilha com a da "cópia vencedora". Por isso "Quem colocou" aparecia vazio
 *      até para quem tinha acabado de aportar.
 *
 * A raiz é o modelo: comparar saldos pressupõe que uma cópia está certa. Numa
 * reserva compartilhada nenhuma está — cada uma viu uma parte. Agora a trilha se
 * UNE (dedupe por `mid`) e o saldo é DERIVADO dela.
 *
 * ⚠️ O QUE ESTE ARQUIVO MAIS PROTEGE É A MIGRAÇÃO. Reserva criada antes disto
 * tem saldo e nenhum movimento; derivar o saldo de uma trilha vazia ZERARIA o
 * dinheiro de quem já usa a feature.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let R
before(async () => { R = await import('../../src/scripts/modules/reserva-familia.js') })

const T = '2026-08-16T18:06:06.332Z'
const reserva = (saved, movimentos = []) => ({
  id: 'r1', compartilhada: true, membros: ['64', '65'],
  saved, lastUpdate: T, movimentos,
})
const conta = (saldoB, saldoA) => {
  const B = { id: '64', metas: [reserva(saldoB)] }
  const A = { id: '65', metas: [reserva(saldoA)] }
  return { B, A, mb: B.metas[0], ma: A.metas[0], profiles: [B, A] }
}

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ o caso reproduzido em produção', () => {
  test('⭐ as duas cópias convergem para o acumulado REAL', () => {
    const { mb, ma, profiles } = conta(500, 1000)
    R.reconciliarCopiaAtiva(mb, profiles)
    R.reconciliarCopiaAtiva(ma, profiles)

    // 1000, e não 500 (o que o sorteio dava) nem 1500 (o que somar às cegas
    // daria): os 500 de B já estavam DENTRO dos 1000 de A, porque A viu o
    // depósito de B antes de aportar.
    assert.equal(mb.saved, 1000, 'perfil B continuou com o saldo parcial')
    assert.equal(ma.saved, 1000, 'as cópias não convergiram')
  })

  test('carimbo empatado não decide mais nada', () => {
    // Antes, `lastUpdate` idêntico fazia a reconciliação desistir (`<=`) e a
    // escolha cair na ordem do array. Agora a trilha decide, e ela não empata.
    const { mb, profiles } = conta(500, 1000)
    assert.equal(mb.lastUpdate, profiles[1].metas[0].lastUpdate, 'o teste perdeu a condição')
    R.reconciliarCopiaAtiva(mb, profiles)
    assert.equal(mb.saved, 1000)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ dois aportes simultâneos SOMAM', () => {
  test('cada cópia registra o seu, e a união junta os dois', () => {
    const { mb, ma, profiles } = conta(0, 0)
    R.registrarMovimento(mb, { id: '64', nome: 'Giusepp', tipo: 'aporte', valor: 500 })
    R.registrarMovimento(ma, { id: '65', nome: 'Meow',    tipo: 'aporte', valor: 500 })

    R.reconciliarCopiaAtiva(mb, profiles)
    assert.equal(mb.saved, 1000, 'um aporte apagou o outro — é o defeito original')
  })

  test('⭐ "Quem colocou" mostra os dois', () => {
    const { mb, ma, profiles } = conta(0, 0)
    R.registrarMovimento(mb, { id: '64', nome: 'Giusepp', tipo: 'aporte', valor: 500 })
    R.registrarMovimento(ma, { id: '65', nome: 'Meow',    tipo: 'aporte', valor: 300 })
    R.reconciliarCopiaAtiva(mb, profiles)

    const quem = R.porMembro(mb.movimentos)
    assert.equal(quem.length, 2, 'a trilha perdeu um dos participantes')
    assert.equal(quem.find(q => q.id === '64').liquido, 500)
    assert.equal(quem.find(q => q.id === '65').liquido, 300)
  })

  test('retirada abate no total', () => {
    const { mb, ma, profiles } = conta(0, 0)
    R.registrarMovimento(mb, { id: '64', nome: 'B', tipo: 'aporte',   valor: 1000 })
    R.registrarMovimento(ma, { id: '65', nome: 'A', tipo: 'retirada', valor: 250 })
    R.reconciliarCopiaAtiva(mb, profiles)
    assert.equal(mb.saved, 750)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a migração não pode perder nem inventar dinheiro', () => {
  test('⭐ reserva antiga (saldo, zero movimentos) NÃO zera', () => {
    // O risco maior desta mudança: derivar de trilha vazia daria 0 e apagaria o
    // dinheiro de toda reserva existente.
    const { mb, profiles } = conta(1500, 1500)
    R.reconciliarCopiaAtiva(mb, profiles)
    assert.equal(mb.saved, 1500, 'a migração ZEROU uma reserva existente')
    assert.equal(mb.movimentos.length, 1)
    assert.equal(mb.movimentos[0].memberNome, 'Saldo anterior')
  })

  test('⭐ migrar duas vezes não dobra o saldo', () => {
    // O `mid` do legado é determinístico por reserva: duas cópias migrando ao
    // mesmo tempo geram a MESMA chave, e a união reconhece como uma só.
    const { mb, profiles } = conta(800, 800)
    R.reconciliarCopiaAtiva(mb, profiles)
    R.reconciliarCopiaAtiva(mb, profiles)
    R.reconciliarCopiaAtiva(mb, profiles)
    assert.equal(mb.saved, 800, 'a migração duplicou dinheiro ao repetir')
    assert.equal(mb.movimentos.filter(m => String(m.mid).startsWith('legado:')).length, 1)
  })

  test('saldo legado adota o valor MAIS COMPLETO entre as cópias', () => {
    assert.equal(R.saldoLegadoMaisCompleto([{ saved: 500 }, { saved: 1000 }]), 1000)
    // Cópia que já tem trilha não entra na conta do legado.
    assert.equal(
      R.saldoLegadoMaisCompleto([{ saved: 9999, movimentos: [{ valor: 1 }] }, { saved: 300 }]),
      300)
  })

  test('reserva zerada não ganha movimento fantasma', () => {
    const meta = reserva(0)
    assert.equal(R.migrarSaldoLegado(meta), false)
    assert.deepEqual(meta.movimentos, [])
  })

  test('depois de migrada, um aporte novo SOMA ao legado', () => {
    const { mb, ma, profiles } = conta(1000, 1000)
    R.reconciliarCopiaAtiva(mb, profiles)
    R.registrarMovimento(mb, { id: '64', nome: 'B', tipo: 'aporte', valor: 250 })
    R.reconciliarCopiaAtiva(ma, profiles)
    assert.equal(ma.saved, 1250)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('a união da trilha', () => {
  test('dedupe por `mid` — o mesmo movimento vindo de duas cópias conta uma vez', () => {
    const a = { mid: 'x1', tipo: 'aporte', valor: 100, em: 1 }
    const b = { mid: 'x2', tipo: 'aporte', valor: 200, em: 2 }
    assert.equal(R.unirMovimentos([a, b], [a], [b, a]).length, 2)
  })

  test('movimento legado (sem mid) também não duplica', () => {
    const velho = { memberId: '64', tipo: 'aporte', valor: 100, data: '2026-08-01', hora: '10:00' }
    assert.equal(R.unirMovimentos([velho], [{ ...velho }]).length, 1)
  })

  test('ordem estável entre perfis — mesma lista em qualquer aparelho', () => {
    const m1 = { mid: 'a', tipo: 'aporte', valor: 1, em: 200 }
    const m2 = { mid: 'b', tipo: 'aporte', valor: 2, em: 100 }
    assert.deepEqual(R.unirMovimentos([m1, m2]).map(x => x.mid), ['b', 'a'])
    assert.deepEqual(R.unirMovimentos([m2, m1]).map(x => x.mid), ['b', 'a'])
  })

  test('entrada inválida não derruba nem entra', () => {
    assert.deepEqual(R.unirMovimentos(null, undefined, [null, 0, 'x']), [])
  })

  test('saldo de trilha vazia é null, não 0', () => {
    // A diferença que impede o zeramento: `null` significa "não sei", e o
    // chamador preserva o saldo. `0` significaria "não há dinheiro".
    assert.equal(R.saldoDeMovimentos([]), null)
    assert.equal(R.saldoDeMovimentos(null), null)
    assert.equal(R.saldoDeMovimentos([{ tipo: 'aporte', valor: 10 }]), 10)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('estabilidade e convergência', () => {
  test('⭐ reconciliar N vezes não muda mais nada', () => {
    const { mb, ma, profiles } = conta(0, 0)
    R.registrarMovimento(mb, { id: '64', nome: 'B', tipo: 'aporte', valor: 500 })
    R.registrarMovimento(ma, { id: '65', nome: 'A', tipo: 'aporte', valor: 500 })
    for (let i = 0; i < 6; i++) {
      R.reconciliarCopiaAtiva(mb, profiles)
      R.reconciliarCopiaAtiva(ma, profiles)
    }
    assert.equal(mb.saved, 1000)
    assert.equal(ma.saved, 1000)
    assert.equal(mb.movimentos.length, 2, 'a trilha inflou ao reconciliar em laço')
  })

  test('a segunda reconciliação seguida devolve false — sem save inútil', () => {
    // `renderMetasList` persiste quando isto devolve true. Se nunca estabilizasse,
    // cada render dispararia um save.
    const { mb, profiles } = conta(0, 0)
    R.registrarMovimento(mb, { id: '64', nome: 'B', tipo: 'aporte', valor: 100 })
    R.reconciliarCopiaAtiva(mb, profiles)
    assert.equal(R.reconciliarCopiaAtiva(mb, profiles), false,
      'a reconciliação nunca estabiliza e salva a cada render')
  })

  test('`saved` e `movimentos` saíram dos campos copiados por hora', () => {
    // São acumuladores: copiar da "cópia vencedora" é o que apagava aportes.
    const src = readFileSync(
      new URL('../../src/scripts/modules/reserva-familia.js', import.meta.url), 'utf8')
    assert.match(src, /CAMPOS_DECLARATIVOS = CAMPOS_SINC\.filter\(k => k !== 'saved' && k !== 'movimentos'\)/)
    assert.match(src, /for \(const k of CAMPOS_DECLARATIVOS\)/,
      'a reconciliação voltou a copiar todos os campos, inclusive os acumuladores')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a cópia ativa sozinha também precisa migrar', () => {
  // Sem este caso, tirar `migrarSaldoLegado(metaAtiva, …)` passava despercebido:
  // as OUTRAS cópias migravam e a união trazia o valor de volta. A redundância
  // escondia a falta. Aqui não há outra cópia para socorrer.
  test('⭐ reserva antiga sem nenhuma outra cópia NÃO zera', () => {
    const so = { id: 'r9', compartilhada: true, membros: ['64', '65'],
                 saved: 1200, lastUpdate: T, movimentos: [] }
    const profiles = [{ id: '64', metas: [so] }]   // o outro perfil ainda não tem cópia
    R.reconciliarCopiaAtiva(so, profiles)
    assert.equal(so.saved, 1200, 'a reserva zerou por falta de migração da própria cópia')
    assert.equal(so.movimentos.length, 1, 'a trilha de abertura não foi criada')
  })

  test('e o saldo segue derivável dali em diante', () => {
    const so = { id: 'r9', compartilhada: true, membros: ['64', '65'],
                 saved: 1200, lastUpdate: T, movimentos: [] }
    const profiles = [{ id: '64', metas: [so] }]
    R.reconciliarCopiaAtiva(so, profiles)
    R.registrarMovimento(so, { id: '64', nome: 'B', tipo: 'aporte', valor: 300 })
    R.reconciliarCopiaAtiva(so, profiles)
    assert.equal(so.saved, 1500)
  })
})
