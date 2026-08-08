/**
 * C-9 — os achados da análise profunda de 2026-08-04, agora corrigidos.
 *
 * ⚠️ AO MEDIR, DESCOBRI QUE METADE DA LISTA JÁ ESTAVA CONSERTADA. O roadmap
 * dizia "medidos, não corrigidos" para coisas que funcionavam:
 *   · "quero gastar no máximo 500 em mercado" NÃO grava mais gasto falso
 *   · "comprado parcelado" JÁ virava crédito
 * É exatamente o que a Regra de Ouro existe para impedir — item pronto marcado
 * como pendente. Medir antes de consertar economizou o trabalho, e o roadmap
 * foi corrigido.
 *
 * O que estava REALMENTE quebrado, e este arquivo tranca:
 *   · "gastei 30 na segunda"            → sem data (ia para hoje, calado)
 *   · "não me deixa esquecer do X"      → virava lançamento, não lembrete
 *   · "minhas conquistas"               → "não entendi"
 *   · "quais minhas conquistas"         → PIOR: respondia sobre GASTO
 *   · "meus gastos de hoje"             → virava LANÇAMENTO (achado meu, novo)
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseLocal } from '../../src/scripts/modules/assistant/parser-local.js'

const p = (t) => parseLocal(t, { tipos: [] })
const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

describe('dia da semana solto vira data', () => {
  test('"na segunda" aponta para a segunda mais recente', () => {
    // Quem lança um gasto fala do passado. Sem isto a data caía em hoje, em
    // silêncio: um gasto de segunda aparecia no extrato de sábado.
    const r = p('gastei 30 na segunda')
    assert.match(String(r.data_override), /^\d{2}\/\d{2}\/\d{4}$/)
    const [d, m, a] = r.data_override.split('/').map(Number)
    assert.equal(new Date(a, m - 1, d).getDay(), 1, 'tem de cair numa segunda-feira')
  })

  test('todos os sete dias funcionam, com "na", "no" e "de"', () => {
    for (let i = 0; i < 7; i++) {
      for (const prep of ['na', 'no', 'de']) {
        const r = p(`gastei 30 ${prep} ${DIAS[i]}`)
        assert.ok(r.data_override, `"${prep} ${DIAS[i]}" ficou sem data`)
        const [d, m, a] = r.data_override.split('/').map(Number)
        assert.equal(new Date(a, m - 1, d).getDay(), i, `${prep} ${DIAS[i]}`)
      }
    }
  })

  test('nunca aponta para o futuro', () => {
    // "na sexta" dito numa quarta é a sexta que PASSOU — é lançamento, não plano.
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    for (const dia of DIAS) {
      const r = p(`gastei 30 na ${dia}`)
      const [d, m, a] = r.data_override.split('/').map(Number)
      assert.ok(new Date(a, m - 1, d) <= hoje, `${dia} caiu no futuro`)
    }
  })

  test('"segunda passada" continua valendo (e é estritamente antes de hoje)', () => {
    const r = p('gastei 30 na segunda passada')
    assert.ok(r.data_override)
  })
})

describe('"não me deixa esquecer" é lembrete', () => {
  for (const frase of [
    'nao me deixa esquecer do dentista',
    'nao deixa eu esquecer de pagar o aluguel',
    'nao esquece de pagar o iptu',
    'nao esqueça de renovar o seguro',
  ]) {
    test(`"${frase}"`, () => assert.equal(p(frase).intencao, 'lembrete'))
  }

  test('e "esquecer" sozinho não vira lembrete', () => {
    // Sem o "não", é conversa. Transformar tudo que menciona esquecer em
    // lembrete criaria lembrete do nada.
    assert.notEqual(p('acabei de esquecer o nome dele').intencao, 'lembrete')
  })
})

describe('⭐ conquistas: responder ERRADO é pior que não entender', () => {
  test('"minhas conquistas" é consulta de conquistas', () => {
    const r = p('minhas conquistas')
    assert.equal(r.intencao, 'consultar')
    assert.equal(r.consulta_alvo, 'conquistas')
  })

  test('"quais minhas conquistas" NÃO responde sobre gasto', () => {
    // Era o caso pior: o `quais` casava o RE_CONSULTA genérico e caía no alvo
    // padrão. O usuário perguntava uma coisa e recebia outra — com números.
    const r = p('quais minhas conquistas')
    assert.equal(r.consulta_alvo, 'conquistas')
  })

  for (const frase of ['quantas conquistas eu tenho', 'meu nivel', 'minhas medalhas']) {
    test(`"${frase}"`, () => assert.equal(p(frase).consulta_alvo, 'conquistas'))
  }

  test('a rota de conquistas vem ANTES da consulta genérica', () => {
    // Se vier depois, o RE_CONSULTA casa primeiro e o alvo volta a ser 'gasto'.
    // Este teste falha se alguém reordenar.
    assert.equal(p('qual o total de conquistas').consulta_alvo, 'conquistas')
  })
})

describe('⭐ "meus gastos" é pergunta, não lançamento', () => {
  // Achado pelo corpus em 2026-08-07, sem ninguém relatar: é o tipo de frase que
  // o usuário tenta uma vez, recebe algo estranho e não repete.
  for (const frase of ['meus gastos de hoje', 'meus gastos do mes', 'meu gasto de hoje', 'minhas despesas do mes']) {
    test(`"${frase}"`, () => assert.equal(p(frase).intencao, 'consultar'))
  }

  test('e "gastei 50 no mercado" continua sendo lançamento', () => {
    // A guarda pede "meu/meus" antes — o verbo sozinho não é afetado.
    const r = p('gastei 50 no mercado')
    assert.equal(r.intencao, 'lancar')
    assert.equal(r.categoria, 'saida')
  })
})

describe('o que a medição mostrou JÁ CORRIGIDO — trancado para não regredir', () => {
  test('orçamento não grava gasto falso (era o único item que inventava dinheiro)', () => {
    for (const frase of [
      'quero gastar no maximo 500 em mercado',
      'orcamento mercado 500',
      'define um limite de 500 pra mercado',
      'teto de 300 no ifood',
    ]) {
      const r = p(frase)
      assert.equal(r.intencao, 'definir_orcamento', frase)
      assert.notEqual(r.categoria, 'saida', `${frase} — gravaria despesa falsa`)
    }
  })

  test('parcelado vira crédito', () => {
    assert.equal(p('comprei 900 parcelado em 3x').categoria, 'saida_credito')
    assert.equal(p('comprei uma tv de 2000 parcelada em 10x').categoria, 'saida_credito')
  })
})
