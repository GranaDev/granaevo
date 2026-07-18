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
  registrarMovimento, divisaoSugerida,
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

describe('membroAtual — identidade de quem lança', () => {
  test('usa o nome do perfil ativo', () => {
    const m = membroAtual({ usuarioLogado: { userId: 'u1' }, perfilAtivo: { nome: 'Ana' } })
    assert.deepEqual(m, { id: 'u1', nome: 'Ana' })
  })
  test('sem perfil cai para "Você"', () => {
    assert.equal(membroAtual({ usuarioLogado: { userId: 'u1' } }).nome, 'Você')
    assert.equal(membroAtual(null).nome, 'Você')
  })
  test('convidado usa effectiveUserId quando não há userId', () => {
    const m = membroAtual({ usuarioLogado: { effectiveUserId: 'dono1' }, perfilAtivo: { nome: 'Bruno' } })
    assert.equal(m.id, 'dono1')
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
    assert.deepEqual(meta.movimentos[0], { memberId: 'u1', memberNome: 'Ana', tipo: 'aporte', valor: 100, data: '2026-07-18', hora: '10:00' })
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

describe('divisaoSugerida — C4, dividir ao dissolver', () => {
  test('proporcional ao líquido de cada um, somando o total exato', () => {
    const ms = [mov('aporte', 600, 'u1', 'Ana'), mov('aporte', 400, 'u2', 'Bruno')]
    const d = divisaoSugerida(ms, 1000, ['Ana', 'Bruno'])
    const soma = d.reduce((s, x) => s + x.valor, 0)
    assert.equal(soma, 1000, 'a divisão TEM que fechar com o saldo')
    assert.equal(d.find(x => x.nome === 'Ana').valor, 600)
    assert.equal(d.find(x => x.nome === 'Bruno').valor, 400)
  })
  test('centavos: 1000/3 fecha exatamente (resto vai no maior)', () => {
    const ms = [mov('aporte', 100, 'u1', 'A'), mov('aporte', 100, 'u2', 'B'), mov('aporte', 100, 'u3', 'C')]
    const d = divisaoSugerida(ms, 1000, [])
    assert.equal(d.reduce((s, x) => s + x.valor, 0), 1000)
  })
  test('sem líquido positivo → divide igual entre o roster', () => {
    const d = divisaoSugerida([], 300, ['Ana', 'Bruno'])
    assert.equal(d.length, 2)
    assert.equal(d.reduce((s, x) => s + x.valor, 0), 300)
    assert.equal(d[0].valor, 150)
  })
  test('roster vazio e sem trilha → tudo para "Você"', () => {
    const d = divisaoSugerida([], 250, [])
    assert.equal(d.length, 1)
    assert.equal(d[0].nome, 'Você')
    assert.equal(d[0].valor, 250)
  })
  test('saldo zero → nada a dividir', () => {
    assert.deepEqual(divisaoSugerida([mov('aporte', 100, 'u1', 'A')], 0, []), [])
  })
  test('quem retirou mais do que pôs não puxa o rateio para negativo', () => {
    // Ana +1000, Bruno -200 (retirou). Saldo 800. Só Ana tem líquido positivo.
    const ms = [mov('aporte', 1000, 'u1', 'Ana'), mov('retirada', 200, 'u2', 'Bruno')]
    const d = divisaoSugerida(ms, 800, ['Ana', 'Bruno'])
    assert.equal(d.reduce((s, x) => s + x.valor, 0), 800)
    assert.ok(d.every(x => x.valor >= 0))
  })
})
