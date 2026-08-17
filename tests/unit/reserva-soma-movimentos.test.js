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

  test('⭐ acumulador NÃO é copiado da "cópia vencedora" — só o declarativo', () => {
    // São acumuladores: copiar `saved`/`movimentos`/`monthly` da cópia mais nova
    // é o que apagava aportes. Antes isto era uma expressão regular sobre o
    // fonte; agora é comportamento — a asserção de texto passava mesmo com a
    // regra desligada num ramo morto (ver assercoes_que_passam_com_codigo_removido).
    const minha = {
      id: 'r1', compartilhada: true, membros: ['64', '65'], objetivo: 1000,
      saved: 0, monthly: {}, movimentos: [], lastUpdate: '2026-08-17T09:00:00.000Z',
    }
    R.registrarMovimento(minha, { id: '64', nome: 'B', tipo: 'aporte', valor: 100, data: '17/08/2026' })

    // A outra cópia é MAIS NOVA e traz um objetivo novo + acumuladores próprios.
    const dela = {
      id: 'r1', compartilhada: true, membros: ['64', '65'], objetivo: 7000,
      saved: 999, monthly: { '2026-01': 999 }, movimentos: [],
      lastUpdate: '2026-08-17T23:00:00.000Z',
    }
    R.reconciliarCopiaAtiva(minha, [{ id: '64', metas: [minha] }, { id: '65', metas: [dela] }], '64')

    assert.equal(minha.objetivo, 7000, 'o campo DECLARATIVO não seguiu a cópia mais nova')
    assert.equal(minha.saved, 100,
      'o saldo veio copiado da outra cópia em vez de sair da trilha — é o bug que apagava aportes')
    assert.equal(minha.monthly['2026-01'], undefined,
      'o histórico mensal da outra cópia sobrescreveu o meu')
    assert.equal(minha.movimentos.length, 1, 'a trilha foi substituída em vez de unida')
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

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a derivação NUNCA apaga dinheiro que não sabe explicar', () => {
  // ACHADO em produção, e foi um defeito que EU introduzi ao derivar o saldo:
  //
  //   ANTES  saved=500 · movs=[Saldo anterior:500]
  //   aporte saved=600 · movs=[Saldo anterior:500]   ← a trilha não recebeu
  //   depois saved=500                                ← a derivação REVERTEU
  //
  // Existe caminho de aporte que mexe em `saved` sem registrar o movimento.
  // Derivar às cegas desfazia o aporte na cara do usuário.
  test('⭐ trilha incompleta NÃO reverte o saldo', () => {
    const m = { id: 'r1', compartilhada: true, membros: ['64', '65'], saved: 600, lastUpdate: T,
                movimentos: [{ mid: 'legado:r1', memberNome: 'Saldo anterior', tipo: 'aporte', valor: 500, em: 0 }] }
    R.reconciliarCopiaAtiva(m, [{ id: '64', metas: [m] }])
    assert.equal(m.saved, 600, 'a derivação reverteu um aporte — dinheiro sumindo da tela')
  })

  test('a diferença vira movimento de ajuste, e a trilha se completa', () => {
    const m = { id: 'r1', compartilhada: true, membros: ['64'], saved: 600, lastUpdate: T,
                movimentos: [{ mid: 'legado:r1', memberNome: 'Saldo anterior', tipo: 'aporte', valor: 500, em: 0 }] }
    R.reconciliarCopiaAtiva(m, [{ id: '64', metas: [m] }])
    assert.equal(m.movimentos.length, 2)
    assert.equal(R.saldoDeMovimentos(m.movimentos), 600, 'a trilha não passou a explicar o saldo')
  })

  test('⭐ o ajuste não se repete a cada render', () => {
    // `renderMetasList` persiste quando a reconciliação devolve true. Um ajuste
    // por render encheria a trilha e salvaria sem parar.
    const m = { id: 'r1', compartilhada: true, membros: ['64'], saved: 600, lastUpdate: T,
                movimentos: [{ mid: 'legado:r1', memberNome: 'Saldo anterior', tipo: 'aporte', valor: 500, em: 0 }] }
    const P = [{ id: '64', metas: [m] }]
    R.reconciliarCopiaAtiva(m, P); R.reconciliarCopiaAtiva(m, P); R.reconciliarCopiaAtiva(m, P)
    assert.equal(m.movimentos.length, 2, 'o ajuste se repetiu a cada reconciliação')
    assert.equal(m.saved, 600)
  })

  test('mas o saldo AINDA SOBE quando outro perfil aporta', () => {
    // A assimetria precisa valer nos dois sentidos: nunca reduzir sem explicar,
    // e sempre subir quando a trilha traz aporte de outra cópia.
    const a = { id: 'r1', compartilhada: true, membros: ['64','65'], saved: 0, lastUpdate: T, movimentos: [] }
    const b = { id: 'r1', compartilhada: true, membros: ['64','65'], saved: 0, lastUpdate: T, movimentos: [] }
    R.registrarMovimento(a, { id: '64', nome: 'Giusepp', tipo: 'aporte', valor: 500 })
    R.registrarMovimento(b, { id: '65', nome: 'Meow',    tipo: 'aporte', valor: 300 })
    R.reconciliarCopiaAtiva(a, [{ id: '64', metas: [a] }, { id: '65', metas: [b] }])
    assert.equal(a.saved, 800)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a migração das reservas que JÁ existem em produção', () => {
  // A propagação antiga deixou cópias divergentes, e a versão anterior da
  // reconciliação lançava um "Ajuste" em CADA uma para fechar a própria conta.
  // Ao unir as trilhas, dois reparos do mesmo buraco somariam — e a reserva da
  // família amanheceria com dinheiro que ninguém pôs.
  test('⭐ dois reparos concorrentes NÃO somam (não inventa dinheiro)', () => {
    const ajuste = (valor, n) => ({
      mid: `ajuste:r1:${valor}:${n}`, memberId: null, memberNome: 'Ajuste',
      tipo: 'aporte', valor, data: null, hora: null, em: 10,
    })
    const unida = R.unirMovimentos([ajuste(500, 1)], [ajuste(300, 1)])
    const reparos = unida.filter(m => String(m.mid).startsWith('ajuste:'))
    assert.equal(reparos.length, 1, 'os dois reparos entraram e o saldo inflou')
    assert.equal(reparos[0].valor, 500, 'ficou o reparo menor — apagaria dinheiro')
  })

  test('⭐ aberturas de legado divergentes colapsam na MAIOR', () => {
    const legado = (valor) => ({
      mid: 'legado:r1', memberId: null, memberNome: 'Saldo anterior',
      tipo: 'aporte', valor, data: null, hora: null, em: 0,
    })
    const unida = R.unirMovimentos([legado(500)], [legado(1000)])
    assert.equal(unida.length, 1)
    assert.equal(unida[0].valor, 1000)
  })

  test('rendimento de dias diferentes NÃO colapsa (cada dia é um crédito)', () => {
    const rend = (dia, valor) => ({
      mid: `rend:r1:${dia}`, memberId: null, memberNome: 'Rendimento',
      tipo: 'aporte', valor, data: dia, hora: null, em: 1,
    })
    const unida = R.unirMovimentos([rend('2026-08-16', 3)], [rend('2026-08-17', 4)])
    assert.equal(unida.length, 2, 'o rendimento de dois dias virou um só')
    assert.equal(R.saldoDeMovimentos(unida), 7)
  })

  test('⭐ o rendimento do MESMO dia, calculado pelos dois membros, conta uma vez', () => {
    const rend = (valor) => ({
      mid: 'rend:r1:2026-08-17', memberId: null, memberNome: 'Rendimento',
      tipo: 'aporte', valor, data: '2026-08-17', hora: null, em: 1,
    })
    assert.equal(R.saldoDeMovimentos(R.unirMovimentos([rend(5)], [rend(5)])), 5,
      'o casal creditou juros em dobro')
  })

  test('⭐ o reparo se refaz sozinho se o colapso tiver ficado curto', () => {
    // É o que torna o colapso seguro: perder um reparo é temporário.
    const m = { id: 'r1', compartilhada: true, membros: ['64'], saved: 900,
                movimentos: [{ mid: 'ajuste:r1:500:1', memberId: null, memberNome: 'Ajuste',
                               tipo: 'aporte', valor: 500, data: null, hora: null, em: 10 }] }
    assert.equal(R.repararSaldoLocal(m), true, 'a diferença de 400 não foi lançada')
    assert.equal(R.saldoDeMovimentos(m.movimentos), 900, 'a trilha não passou a explicar o saldo')
    assert.equal(R.repararSaldoLocal(m), false, 'o reparo se repete a cada reconciliação')
  })
})
