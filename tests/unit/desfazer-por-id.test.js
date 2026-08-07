/**
 * 37.0c — desfazer casa por `id`, e o casamento por campos vira reserva.
 *
 * O desfazer sempre procurou a transação por CAMPOS, porque não existia
 * identificador. Funcionava, e funcionava por sorte num caso: dois lançamentos
 * idênticos em tudo — "café de R$ 5" duas vezes no mesmo minuto — são
 * indistinguíveis por campo, e a busca removia "o último que casa". Acertava
 * quando o desfeito era o último; errava calado quando não era.
 *
 * Agora que todo registro tem `id` (37.0a/b), o desfazer pergunta pelo nome.
 * O caminho por campos continua vivo para registro legado: quem não recarregou
 * a página ainda tem, em memória, transações gravadas antes do Passo 37.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyLancamento, undoLancamento, applyPagamentoConta, undoPagamentoConta,
} from '../../src/scripts/modules/assistant/tx-builder.js'

const perfil = () => ({ transacoes: [], metas: [], contasFixas: [] })
const cafe = { categoria: 'saida', tipo: 'Lazer', descricao: 'Café', valor: 5 }
const descricoes = (p) => p.transacoes.map((t) => t.descricao)

describe('dois lançamentos idênticos — o desfazer tem de saber qual é qual', () => {
  test('desfaz o PRIMEIRO e o segundo continua lá', () => {
    // Sem id, este é o teste que falha: a busca por campos removeria o último.
    const p = perfil()
    const a = applyLancamento(p, cafe)
    const b = applyLancamento(p, cafe)
    assert.notEqual(a.transaction.id, b.transaction.id, 'ids têm de ser distintos')

    assert.equal(undoLancamento(p, a.transaction), true)
    assert.equal(p.transacoes.length, 1)
    assert.equal(p.transacoes[0].id, b.transaction.id, 'sobrou o errado')
  })

  test('desfazer duas vezes o mesmo lançamento não come o irmão', () => {
    // O segundo desfazer não acha mais nada e devolve false — antes, ele casaria
    // por campos com o gêmeo e apagaria um lançamento que o usuário não desfez.
    const p = perfil()
    const a = applyLancamento(p, cafe)
    applyLancamento(p, cafe)
    assert.equal(undoLancamento(p, a.transaction), true)
    assert.equal(undoLancamento(p, a.transaction), false)
    assert.equal(p.transacoes.length, 1)
  })

  test('sobrevive ao reload: o objeto some, o id fica', () => {
    // Depois de um reload os dados vêm do JSON — as referências são outras.
    // É por isso que o desfazer nunca pôde comparar por identidade de objeto.
    const p = perfil()
    const a = applyLancamento(p, cafe)
    applyLancamento(p, { ...cafe, descricao: 'Pão' })
    const recarregado = JSON.parse(JSON.stringify(p))
    assert.equal(undoLancamento(recarregado, a.transaction), true)
    assert.deepEqual(descricoes(recarregado), ['Pão'])
  })
})

describe('registro legado, sem id, continua desfazendo por campos', () => {
  test('acha e remove pela combinação de campos', () => {
    const p = perfil()
    const antiga = {
      categoria: 'saida', tipo: 'Mercado', descricao: 'Feira',
      valor: 87.4, data: '01/07/2026', hora: '09:00:00', metaId: null,
    }
    p.transacoes.push({ ...antiga })
    assert.equal(undoLancamento(p, antiga), true)
    assert.equal(p.transacoes.length, 0)
  })

  test('um lado com id e o outro sem cai no caminho de campos', () => {
    // Acontece de verdade na transição: o `txSnap` guardado antes do deploy não
    // tem id, e a transação já recarregada do banco tem. Exigir id nos dois
    // lados deixaria esse desfazer sem efeito, em silêncio.
    const p = perfil()
    const semId = {
      categoria: 'entrada', tipo: 'Salário', descricao: 'Pagamento',
      valor: 3000, data: '05/08/2026', hora: '08:00:00', metaId: null,
    }
    p.transacoes.push({ ...semId, id: 'ganhou-id-no-load' })
    assert.equal(undoLancamento(p, semId), true)
    assert.equal(p.transacoes.length, 0)
  })

  test('campos diferentes continuam não casando', () => {
    const p = perfil()
    p.transacoes.push({
      categoria: 'saida', tipo: 'Mercado', descricao: 'Feira',
      valor: 87.4, data: '01/07/2026', hora: '09:00:00', metaId: null,
    })
    const outro = { categoria: 'saida', tipo: 'Mercado', descricao: 'Feira',
      valor: 87.5, data: '01/07/2026', hora: '09:00:00', metaId: null }
    assert.equal(undoLancamento(p, outro), false)
    assert.equal(p.transacoes.length, 1)
  })
})

describe('reserva desfeita pelo id devolve o saldo da meta certa', () => {
  test('o dinheiro volta uma vez só', () => {
    const p = perfil()
    p.metas.push({ id: 'm1', descricao: 'Viagem', saved: 0, monthly: {} })
    const a = applyLancamento(p, { categoria: 'reserva', valor: 100, descricao: 'Guardado' })
    applyLancamento(p, { categoria: 'reserva', valor: 100, descricao: 'Guardado' })
    assert.equal(p.metas[0].saved, 200)

    undoLancamento(p, a.transaction)
    assert.equal(p.metas[0].saved, 100)
    assert.equal(p.transacoes.length, 1)
  })
})

describe('pagar a mesma conta duas vezes, e desfazer só uma', () => {
  test('remove o pagamento certo', () => {
    const p = perfil()
    p.contasFixas.push({ id: 'c1', descricao: 'Luz', valor: 180, vencimento: '2026-08-10', pago: false })
    const um = applyPagamentoConta(p, p.contasFixas[0])
    p.contasFixas[0].pago = false
    const dois = applyPagamentoConta(p, p.contasFixas[0])
    assert.equal(p.transacoes.length, 2)
    assert.notEqual(um.transaction.id, dois.transaction.id)

    undoPagamentoConta(p, um.transaction, um.snapshot)
    assert.equal(p.transacoes.length, 1)
    assert.equal(p.transacoes[0].id, dois.transaction.id)
  })

  test('pagamento legado (snapshot sem id) ainda é desfeito por campos', () => {
    const p = perfil()
    p.contasFixas.push({ id: 'c1', descricao: 'Luz', valor: 180, vencimento: '2026-08-10', pago: false })
    const r = applyPagamentoConta(p, p.contasFixas[0])
    const semId = { ...r.transaction }
    delete semId.id
    assert.equal(undoPagamentoConta(p, semId, r.snapshot), true)
    assert.equal(p.transacoes.length, 0)
  })
})
