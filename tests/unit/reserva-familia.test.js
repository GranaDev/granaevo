/**
 * GranaEvo — Testes da reserva compartilhada (item 13, RECONSTRUÍDA 2026-07-18)
 *
 * O modelo mudou: a reserva compartilhada agora é uma CAIXINHA NORMAL no blob
 * (`meta` com compartilhada:true). Este módulo cobre só o que é próprio dela: a
 * ATRIBUIÇÃO (quem colocou/tirou, em meta.movimentos[]) e a DIVISÃO ao dissolver
 * (C4). Guardar/retirar/saldo são o fluxo normal de metas (testado em db-metas).
 *
 * Puro, sem rede/DOM. Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  porMembro, progressoDe, contaCompartilhada, membroAtual, ehCompartilhada,
  registrarMovimento, perfilParticipa,
  depositoLiquidoDe, ehUltimoMembro, sairDaReserva,
  convitesPendentes, temConvitePendente, contarConvitesPendentes,
  aceitarConvite, recusarConvite, montarRosterConvite,
  sincronizarReservaEmPerfis, removerReservaDePerfis,
  marcarReservaAtualizada, copiaMaisRecente, reconciliarCopiaAtiva,
} from '../../src/scripts/modules/reserva-familia.js'

const mov = (tipo, valor, id, nome) => ({ memberId: id, memberNome: nome, tipo, valor })

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

describe('membroAtual — identidade por PERFIL (não por login)', () => {
  test('usa o id e o nome do perfil ativo', () => {
    const m = membroAtual({ usuarioLogado: { userId: 'u1' }, perfilAtivo: { id: 'A', nome: 'Ana' } })
    assert.deepEqual(m, { id: 'A', nome: 'Ana' })
  })
  test('id de perfil numérico vira string (bate com membros/convites)', () => {
    assert.equal(membroAtual({ perfilAtivo: { id: 5, nome: 'X' } }).id, '5')
  })
  test('sem perfil ativo → id null e nome "Você"', () => {
    const m = membroAtual({ usuarioLogado: { userId: 'u1' } })
    assert.equal(m.id, null)
    assert.equal(m.nome, 'Você')
    assert.equal(membroAtual(null).nome, 'Você')
  })
})

describe('ehCompartilhada', () => {
  test('só true com a flag explícita', () => {
    assert.equal(ehCompartilhada({ compartilhada: true }), true)
    assert.equal(ehCompartilhada({ compartilhada: false }), false)
    assert.equal(ehCompartilhada({}), false)
    assert.equal(ehCompartilhada(null), false)
  })
})

describe('registrarMovimento — grava QUEM (sem mexer no dinheiro)', () => {
  test('acrescenta um aporte à trilha', () => {
    const meta = { movimentos: [] }
    registrarMovimento(meta, { id: 'u1', nome: 'Ana', tipo: 'aporte', valor: 100, data: '2026-07-18', hora: '10:00' })
    assert.equal(meta.movimentos.length, 1)
    // `mid` e `em` entraram em 2026-08-16: são o que torna a trilha UNÍVEL entre
    // as cópias dos perfis (dedupe por id, ordem estável por tempo). Por isso a
    // asserção passou a olhar os campos que descrevem o movimento, em vez de
    // exigir o objeto inteiro — um campo novo não deve reprovar um teste de
    // conteúdo.
    const mov = meta.movimentos[0]
    assert.deepEqual(
      { memberId: mov.memberId, memberNome: mov.memberNome, tipo: mov.tipo,
        valor: mov.valor, data: mov.data, hora: mov.hora },
      { memberId: 'u1', memberNome: 'Ana', tipo: 'aporte', valor: 100, data: '2026-07-18', hora: '10:00' })
    assert.ok(mov.mid, 'movimento sem `mid` não pode ser deduplicado na união')
    assert.equal(typeof mov.em, 'number', 'sem `em` a ordem da trilha varia entre perfis')
  })
  test('cria o array se faltar', () => {
    const meta = {}
    registrarMovimento(meta, { id: 'u1', nome: 'Ana', tipo: 'aporte', valor: 50 })
    assert.equal(meta.movimentos.length, 1)
  })
  test('ignora valor/tipo inválido (falha segura — é dinheiro)', () => {
    const meta = { movimentos: [] }
    registrarMovimento(meta, { tipo: 'aporte', valor: NaN })
    registrarMovimento(meta, { tipo: 'aporte', valor: -5 })
    registrarMovimento(meta, { tipo: 'sei_la', valor: 10 })
    assert.equal(meta.movimentos.length, 0)
  })
  test('nome vazio vira "Membro"', () => {
    const meta = { movimentos: [] }
    registrarMovimento(meta, { id: null, nome: '   ', tipo: 'retirada', valor: 10 })
    assert.equal(meta.movimentos[0].memberNome, 'Membro')
  })
  test('cap de 500 — a trilha não estoura o blob', () => {
    const meta = { movimentos: [] }
    for (let i = 0; i < 520; i++) registrarMovimento(meta, { id: 'u1', nome: 'Ana', tipo: 'aporte', valor: 1 })
    assert.equal(meta.movimentos.length, 500)
  })
})

describe('porMembro — quem colocou e quem tirou', () => {
  test('agrupa por pessoa com aportes, retiradas e líquido', () => {
    const ms = [mov('aporte', 500, 'u1', 'Ana'), mov('aporte', 300, 'u2', 'Bruno'), mov('retirada', 100, 'u1', 'Ana')]
    const r = porMembro(ms)
    assert.equal(r.length, 2)
    assert.deepEqual(r[0], { id: 'u1', nome: 'Ana', aportes: 500, retiradas: 100, liquido: 400 })
    assert.deepEqual(r[1], { id: 'u2', nome: 'Bruno', aportes: 300, retiradas: 0, liquido: 300 })
  })
  test('ordena pelo líquido — quem sustenta aparece primeiro', () => {
    const ms = [mov('aporte', 100, 'u1', 'Ana'), mov('aporte', 900, 'u2', 'Bruno')]
    assert.equal(porMembro(ms)[0].nome, 'Bruno')
  })
  test('o LÍQUIDO conta a história: põe 500, tira 400 → fica 100', () => {
    const r = porMembro([mov('aporte', 500, 'u1', 'Ana'), mov('retirada', 400, 'u1', 'Ana')])
    assert.equal(r[0].liquido, 100)
    assert.equal(r[0].aportes, 500)
    assert.equal(r[0].retiradas, 400)
  })
  test('quem trocou de nome não vira duas pessoas (agrupa por id)', () => {
    const r = porMembro([mov('aporte', 100, 'u1', 'Ana'), mov('aporte', 100, 'u1', 'Ana Maria')])
    assert.equal(r.length, 1)
    assert.equal(r[0].liquido, 200)
    assert.equal(r[0].nome, 'Ana Maria', 'usa o nome mais recente')
  })
  test('entrada inválida não quebra', () => {
    assert.deepEqual(porMembro(null), [])
    assert.deepEqual(porMembro([{ tipo: 'aporte', valor: 'abc' }]), [])
  })
})

describe('progressoDe', () => {
  test('metade do objetivo = 50%', () => assert.equal(progressoDe(500, 1000), 50))
  test('passou do objetivo trava em 100', () => assert.equal(progressoDe(1500, 1000), 100))
  test('sem objetivo → null', () => assert.equal(progressoDe(500, 0), null))
})

describe('perfilParticipa — visibilidade por perfil (A1)', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111'
  const UUID_B = '22222222-2222-4222-8222-222222222222'

  test('caixinha NÃO compartilhada aparece para todos', () => {
    assert.equal(perfilParticipa({ compartilhada: false, membros: [UUID_A] }, UUID_B), true)
    assert.equal(perfilParticipa({}, UUID_B), true)
  })

  test('perfil no roster participa; fora do roster, não', () => {
    const m = { compartilhada: true, membros: [UUID_A] }
    assert.equal(perfilParticipa(m, UUID_A), true)
    assert.equal(perfilParticipa(m, UUID_B), false)
  })

  test('roster vazio não esconde de ninguém (evita reserva órfã invisível)', () => {
    assert.equal(perfilParticipa({ compartilhada: true, membros: [] }, UUID_B), true)
    assert.equal(perfilParticipa({ compartilhada: true }, UUID_B), true)
  })

  test('COMPATIBILIDADE: roster ANTIGO (nomes) segue visível para todos', () => {
    // Reservas criadas antes de 2026-07-19 guardavam nomes digitados. Tratar
    // isso como regra de acesso faria a reserva SUMIR da tela de alguém sem
    // aviso — perder o próprio dinheiro de vista é pior que ver uma a mais.
    const antiga = { compartilhada: true, membros: ['João', 'Maria'] }
    assert.equal(perfilParticipa(antiga, UUID_A), true)
    assert.equal(perfilParticipa(antiga, UUID_B), true)
  })

  test('roster misto (migração parcial) ainda respeita os ids', () => {
    const m = { compartilhada: true, membros: [UUID_A, 'Maria'] }
    assert.equal(perfilParticipa(m, UUID_A), true)
    assert.equal(perfilParticipa(m, UUID_B), false)
  })

  test('id inteiro (perfis legados) é reconhecido como id, não como nome', () => {
    const m = { compartilhada: true, membros: ['7', '9'] }
    assert.equal(perfilParticipa(m, '7'), true)
    assert.equal(perfilParticipa(m, '8'), false)
  })

  test('sem perfil ativo não esconde nada (não deixa o usuário sem ver)', () => {
    const m = { compartilhada: true, membros: [UUID_A] }
    assert.equal(perfilParticipa(m, null), true)
    assert.equal(perfilParticipa(m, ''), true)
  })
})

// ── Convite → aceite (v2, intra-conta) ──────────────────────────────────────
const compart = (extra = {}) => ({ compartilhada: true, membros: ['A'], convites: [], ...extra })

describe('convitesPendentes / temConvitePendente', () => {
  test('lista os ids pendentes; vazio quando não há', () => {
    assert.deepEqual(convitesPendentes(compart({ convites: ['B', 'C'] })), ['B', 'C'])
    assert.deepEqual(convitesPendentes(compart()), [])
  })
  test('não-compartilhada → sem convites', () => {
    assert.deepEqual(convitesPendentes({ convites: ['B'] }), [])
  })
  test('temConvitePendente casa por string', () => {
    const m = compart({ convites: ['B', 5] })
    assert.equal(temConvitePendente(m, 'B'), true)
    assert.equal(temConvitePendente(m, 5), true)
    assert.equal(temConvitePendente(m, '5'), true)
    assert.equal(temConvitePendente(m, 'A'), false)   // A é membro, não convidado
    assert.equal(temConvitePendente(m, ''), false)
  })
  test('contarConvitesPendentes soma por perfil', () => {
    const metas = [compart({ convites: ['B'] }), compart({ convites: ['B', 'C'] }), { compartilhada: false }]
    assert.equal(contarConvitesPendentes(metas, 'B'), 2)
    assert.equal(contarConvitesPendentes(metas, 'C'), 1)
    assert.equal(contarConvitesPendentes(metas, 'Z'), 0)
  })
})

describe('aceitarConvite', () => {
  test('move de convites → membros; idempotente', () => {
    const m = compart({ convites: ['B'] })
    assert.equal(aceitarConvite(m, 'B'), true)
    assert.deepEqual(m.convites, [])
    assert.deepEqual(m.membros, ['A', 'B'])
    // aceitar de novo (não é mais convidado) → false, sem duplicar
    assert.equal(aceitarConvite(m, 'B'), false)
    assert.deepEqual(m.membros, ['A', 'B'])
  })
  test('perfil não convidado → false, nada muda', () => {
    const m = compart({ convites: ['B'] })
    assert.equal(aceitarConvite(m, 'Z'), false)
    assert.deepEqual(m.convites, ['B'])
    assert.deepEqual(m.membros, ['A'])
  })
})

describe('recusarConvite', () => {
  test('remove de convites, NÃO vira membro', () => {
    const m = compart({ convites: ['B', 'C'] })
    assert.equal(recusarConvite(m, 'B'), true)
    assert.deepEqual(m.convites, ['C'])
    assert.deepEqual(m.membros, ['A'])
  })
  test('id inexistente → false', () => {
    const m = compart({ convites: ['B'] })
    assert.equal(recusarConvite(m, 'Z'), false)
  })
})

describe('montarRosterConvite — criador aceito, demais pendentes', () => {
  test('criação: criador em membros, resto em convites', () => {
    const r = montarRosterConvite(['A', 'B', 'C'], 'A', {})
    assert.deepEqual(r.membros, ['A'])
    assert.deepEqual(r.convites, ['B', 'C'])
  })
  test('criador sempre entra mesmo se ausente do roster', () => {
    const r = montarRosterConvite(['B'], 'A', {})
    assert.deepEqual(r.membros, ['A'])
    assert.deepEqual(r.convites, ['B'])
  })
  test('edição: quem já era membro continua membro (não re-convida)', () => {
    const r = montarRosterConvite(['A', 'B', 'C'], 'A', { membros: ['A', 'B'] })
    assert.deepEqual(r.membros, ['A', 'B'])   // B já aceitou → segue membro
    assert.deepEqual(r.convites, ['C'])       // C é o novo → pendente
  })
  test('dedup e ignora vazios; string-normaliza', () => {
    const r = montarRosterConvite(['A', 'A', 5, '', null, 5], 'A', {})
    assert.deepEqual(r.membros, ['A'])
    assert.deepEqual(r.convites, ['5'])
  })
  test('edição preserva convites pendentes que o form não mostra (não zera em voo)', () => {
    // roster do form = só membros (A, B); C está pendente e não aparece no form.
    const r = montarRosterConvite(['A', 'B'], 'A', { membros: ['A', 'B'], convites: ['C'] })
    assert.deepEqual(r.membros, ['A', 'B'])
    assert.deepEqual(r.convites, ['C'])   // C continua pendente, não sumiu
  })
})

// ── Propagação entre perfis (o que faz a reserva aparecer em OUTRO perfil) ────
const perfil = (id, metas = []) => ({ id, nome: 'P' + id, metas })

describe('sincronizarReservaEmPerfis', () => {
  test('injeta cópia só nos MEMBROS; convidado pendente NÃO recebe (não polui total)', () => {
    const reserva = { id: 'r1', compartilhada: true, saved: 100, membros: ['A'], convites: ['B'] }
    const profiles = [perfil('A'), perfil('B'), perfil('C')]
    sincronizarReservaEmPerfis(profiles, reserva)
    assert.equal(profiles[0].metas.length, 1)          // A (membro) → cópia
    assert.equal(profiles[1].metas.length, 0)          // B (convidado pendente) → NADA
    assert.equal(profiles[2].metas.length, 0)          // C fora → nada
    assert.equal(profiles[0].metas[0].saved, 100)
  })
  test('cópias são independentes (deep clone, sem alias)', () => {
    const reserva = { id: 'r1', compartilhada: true, saved: 10, movimentos: [{ v: 1 }], membros: ['A', 'B'], convites: [] }
    const profiles = [perfil('A'), perfil('B')]
    sincronizarReservaEmPerfis(profiles, reserva)
    profiles[0].metas[0].saved = 999
    profiles[0].metas[0].movimentos[0].v = 999
    assert.equal(profiles[1].metas[0].saved, 10)       // B não mudou junto
    assert.equal(profiles[1].metas[0].movimentos[0].v, 1)
    assert.equal(reserva.saved, 10)                    // fonte intacta
  })
  test('atualiza cópia existente em vez de duplicar', () => {
    const profiles = [perfil('A', [{ id: 'r1', compartilhada: true, saved: 1 }])]
    sincronizarReservaEmPerfis(profiles, { id: 'r1', compartilhada: true, saved: 50, membros: ['A'], convites: [] })
    assert.equal(profiles[0].metas.length, 1)
    assert.equal(profiles[0].metas[0].saved, 50)
  })
  test('quem deixou de participar perde a cópia', () => {
    const profiles = [perfil('A', [{ id: 'r1', compartilhada: true }]), perfil('B', [{ id: 'r1', compartilhada: true }])]
    // Agora só A participa (B recusou/saiu)
    sincronizarReservaEmPerfis(profiles, { id: 'r1', compartilhada: true, membros: ['A'], convites: [] })
    assert.equal(profiles[0].metas.length, 1)
    assert.equal(profiles[1].metas.length, 0)          // B perdeu a cópia
  })
  test('não-compartilhada ou sem id → no-op', () => {
    const profiles = [perfil('A')]
    sincronizarReservaEmPerfis(profiles, { id: 'r1', compartilhada: false, membros: ['A'] })
    sincronizarReservaEmPerfis(profiles, { compartilhada: true, membros: ['A'] })
    assert.equal(profiles[0].metas.length, 0)
  })
})

describe('removerReservaDePerfis', () => {
  test('remove a reserva de TODOS os perfis', () => {
    const profiles = [
      perfil('A', [{ id: 'r1' }, { id: 'r2' }]),
      perfil('B', [{ id: 'r1' }]),
      perfil('C', []),
    ]
    removerReservaDePerfis(profiles, 'r1')
    assert.deepEqual(profiles[0].metas.map(m => m.id), ['r2'])
    assert.equal(profiles[1].metas.length, 0)
    assert.equal(profiles[2].metas.length, 0)
  })
})

// ── Reconciliação entre cópias (corrige "reserva zerada no perfil B") ─────────
describe('reconciliação de cópias por lastUpdate', () => {
  test('marcarReservaAtualizada carimba lastUpdate', () => {
    const m = { id: 'r1' }
    marcarReservaAtualizada(m)
    assert.equal(typeof m.lastUpdate, 'string')
    assert.ok(m.lastUpdate.length > 10)
  })
  test('copiaMaisRecente pega a de maior lastUpdate entre os perfis', () => {
    const profiles = [
      { id: 'A', metas: [{ id: 'r1', saved: 100, lastUpdate: '2026-07-24T10:00:00.000Z' }] },
      { id: 'B', metas: [{ id: 'r1', saved: 0,   lastUpdate: '2026-07-24T09:00:00.000Z' }] },
    ]
    assert.equal(copiaMaisRecente(profiles, 'r1').saved, 100)
  })
  test('reconciliarCopiaAtiva traz o saldo mais novo do outro perfil (o bug relatado)', () => {
    // Perfil B abriu com a cópia zerada; A depositou 100 (cópia mais nova no slot de A).
    const metaAtivaB = { id: 'r1', compartilhada: true, saved: 0, movimentos: [], membros: ['A', 'B'], lastUpdate: '2026-07-24T09:00:00.000Z' }
    const profiles = [
      { id: 'A', metas: [{ id: 'r1', compartilhada: true, saved: 100, movimentos: [{ tipo: 'aporte', valor: 100 }], membros: ['A', 'B'], lastUpdate: '2026-07-24T10:00:00.000Z' }] },
      { id: 'B', metas: [metaAtivaB] },
    ]
    const mudou = reconciliarCopiaAtiva(metaAtivaB, profiles)
    assert.equal(mudou, true)
    assert.equal(metaAtivaB.saved, 100)               // B agora vê os 100 de A
    assert.equal(metaAtivaB.movimentos.length, 1)
    assert.equal(metaAtivaB.lastUpdate, '2026-07-24T10:00:00.000Z')
  })
  test('cópia mais antiga não derruba o saldo da ativa', () => {
    // A intenção original — "não aceitar um saldo mais velho por cima" — segue
    // valendo, e é o que este teste protege.
    //
    // O que mudou em 2026-08-16: a PRIMEIRA reconciliação agora devolve `true`,
    // porque migra o saldo legado para a trilha (mudança real, e necessária).
    // O saldo não se mexe, e a segunda chamada estabiliza em `false`.
    const metaAtiva = { id: 'r1', compartilhada: true, saved: 200, lastUpdate: '2026-07-24T11:00:00.000Z' }
    const profiles = [
      { id: 'A', metas: [{ id: 'r1', compartilhada: true, saved: 100, lastUpdate: '2026-07-24T10:00:00.000Z' }] },
      { id: 'B', metas: [metaAtiva] },
    ]
    reconciliarCopiaAtiva(metaAtiva, profiles)
    assert.equal(metaAtiva.saved, 200, 'a cópia velha (100) derrubou o saldo da ativa')
    assert.equal(reconciliarCopiaAtiva(metaAtiva, profiles), false,
      'a reconciliação não estabiliza — salvaria a cada render')
    assert.equal(metaAtiva.saved, 200)
  })
  test('reserva não compartilhada não reconcilia', () => {
    const m = { id: 'r1', saved: 5 }
    assert.equal(reconciliarCopiaAtiva(m, [{ id: 'A', metas: [{ id: 'r1', saved: 999, lastUpdate: 'x' }] }]), false)
  })
})

// ── SAIR DA RESERVA (substituiu a dissolução em bloco, 2026-07-26) ───────────
// A regra de ouro dos testes daqui: sair NÃO pode criar nem sumir com dinheiro,
// e NÃO pode mexer na vida de quem ficou além de reduzir o saldo pelo que levei.
describe('depositoLiquidoDe — quanto ESTE perfil tem a receber', () => {
  test('líquido do próprio perfil (aportes − retiradas dele)', () => {
    const meta = { compartilhada: true, saved: 1000, movimentos: [
      mov('aporte', 600, 'A', 'Ana'), mov('aporte', 400, 'B', 'Bruno'), mov('retirada', 100, 'A', 'Ana'),
    ] }
    assert.equal(depositoLiquidoDe(meta, 'A'), 500)
    assert.equal(depositoLiquidoDe(meta, 'B'), 400)
  })
  test('nunca oferece mais do que a reserva tem hoje', () => {
    // Ana pôs 600, mas o outro já sacou quase tudo: só há 50 na reserva.
    const meta = { compartilhada: true, saved: 50, movimentos: [mov('aporte', 600, 'A', 'Ana')] }
    assert.equal(depositoLiquidoDe(meta, 'A'), 50)
  })
  test('quem nunca pôs nada (ou tirou mais do que pôs) recebe 0, nunca negativo', () => {
    const meta = { compartilhada: true, saved: 300, movimentos: [
      mov('aporte', 100, 'A', 'Ana'), mov('retirada', 200, 'A', 'Ana'),
    ] }
    assert.equal(depositoLiquidoDe(meta, 'A'), 0)
    assert.equal(depositoLiquidoDe(meta, 'Z'), 0)
  })
  test('reserva vazia → 0', () => {
    assert.equal(depositoLiquidoDe({ compartilhada: true, saved: 0, movimentos: [] }, 'A'), 0)
  })
})

describe('ehUltimoMembro', () => {
  test('sozinho no roster = último', () => {
    assert.equal(ehUltimoMembro({ compartilhada: true, membros: ['A'] }, 'A'), true)
  })
  test('com companhia = não é o último', () => {
    assert.equal(ehUltimoMembro({ compartilhada: true, membros: ['A', 'B'] }, 'A'), false)
  })
  test('roster vazio = último (não deixa reserva órfã)', () => {
    assert.equal(ehUltimoMembro({ compartilhada: true, membros: [] }, 'A'), true)
  })
})

describe('sairDaReserva', () => {
  const nova = () => ({
    id: 'r1', compartilhada: true, saved: 1000, membros: ['A', 'B'], convites: [],
    movimentos: [mov('aporte', 600, 'A', 'Ana'), mov('aporte', 400, 'B', 'Bruno')],
  })

  test('quem sai leva a sua parte; a reserva CONTINUA viva para quem ficou', () => {
    const meta = nova()
    const r = sairDaReserva(meta, 'A', 600, 'Ana')
    assert.equal(r.ok, true)
    assert.equal(r.valor, 600)
    assert.equal(r.ultimo, false)
    assert.equal(meta.saved, 400, 'sobra exatamente o que era do Bruno')
    assert.deepEqual(meta.membros, ['B'], 'Bruno segue na reserva')
  })

  test('a saída fica registrada na trilha (quem tirou, quanto)', () => {
    const meta = nova()
    sairDaReserva(meta, 'A', 600, 'Ana')
    const ultimo = meta.movimentos[meta.movimentos.length - 1]
    assert.equal(ultimo.tipo, 'retirada')
    assert.equal(ultimo.valor, 600)
    assert.equal(ultimo.memberId, 'A')
    assert.equal(porMembro(meta.movimentos).find(m => m.id === 'A').liquido, 0)
  })

  test('"Outro valor" (rendimento) é aceito até o limite do saldo', () => {
    const meta = nova()
    const r = sairDaReserva(meta, 'A', 650, 'Ana')   // rendeu 50
    assert.equal(r.ok, true)
    assert.equal(meta.saved, 350)
  })

  test('não deixa sacar mais do que a reserva tem', () => {
    const meta = nova()
    const r = sairDaReserva(meta, 'A', 1200, 'Ana')
    assert.equal(r.ok, false)
    assert.equal(meta.saved, 1000, 'nada mudou')
    assert.deepEqual(meta.membros, ['A', 'B'])
  })

  test('valor inválido não muta a reserva', () => {
    const meta = nova()
    assert.equal(sairDaReserva(meta, 'A', -1, 'Ana').ok, false)
    assert.equal(sairDaReserva(meta, 'A', NaN, 'Ana').ok, false)
    assert.equal(meta.saved, 1000)
  })

  test('sair com 0 é permitido (só quero fora dessa reserva)', () => {
    const meta = nova()
    const r = sairDaReserva(meta, 'A', 0, 'Ana')
    assert.equal(r.ok, true)
    assert.equal(meta.saved, 1000, 'o dinheiro fica com quem ficou')
    assert.deepEqual(meta.membros, ['B'])
  })

  test('último membro leva TUDO — nunca sobra dinheiro numa reserva sem dono', () => {
    const meta = { id: 'r1', compartilhada: true, saved: 400, membros: ['B'], movimentos: [] }
    const r = sairDaReserva(meta, 'B', 10, 'Bruno')   // pediu 10; leva os 400
    assert.equal(r.ok, true)
    assert.equal(r.ultimo, true)
    assert.equal(r.valor, 400)
    assert.equal(meta.saved, 0)
    assert.deepEqual(meta.membros, [])
  })

  test('sair também tira um convite pendente do meu id', () => {
    const meta = { id: 'r1', compartilhada: true, saved: 0, membros: ['A', 'B'], convites: ['A'], movimentos: [] }
    sairDaReserva(meta, 'A', 0, 'Ana')
    assert.deepEqual(meta.convites, [])
    assert.deepEqual(meta.membros, ['B'])
  })

  test('carimba lastUpdate — é o que leva a saída aos outros perfis', () => {
    const meta = nova()
    sairDaReserva(meta, 'A', 600, 'Ana')
    assert.ok(meta.lastUpdate, 'sem lastUpdate a cópia do outro perfil nunca reconcilia')
  })

  test('reserva que não é compartilhada não entra neste fluxo', () => {
    const meta = { id: 'r1', saved: 100, membros: ['A'] }
    assert.equal(sairDaReserva(meta, 'A', 100, 'Ana').ok, false)
    assert.equal(meta.saved, 100)
  })

  test('soma fecha: o que saiu do saldo da reserva é exatamente o que a pessoa levou', () => {
    const meta = nova()
    const antes = meta.saved
    const r = sairDaReserva(meta, 'B', 400, 'Bruno')
    assert.equal(antes - meta.saved, r.valor)
  })
})
