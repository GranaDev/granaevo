/**
 * Casos REAIS relatados pelo dono em 2026-08-04, mais o orçamento que inventava
 * dinheiro.
 *
 * Os três primeiros vieram do uso, não de varredura — e são melhores que
 * qualquer corpus que eu montasse, porque descrevem o que incomoda de verdade:
 *
 *   "gastei 50 reais num paflon"  → categoria Mercado, descrição "Num paflon"
 *   compra de jogo                → sem categoria própria, tinha que ir em Eletrônico
 *   "quero gastar no máximo 500"  → GRAVAVA UM GASTO DE R$500
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLocal, TIPOS_SAIDA, ORCAMENTO_TIPOS } from '../../src/scripts/modules/assistant/parser-local.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const p = (t) => parseLocal(t)

describe('o paflon — descrição não carrega mais a preposição', () => {
  test('"num/numa" saem da descrição', () => {
    // Ia pro extrato assim: "Num paflon". As contrações de em+um faltavam na
    // lista de bordas — "em uma tomada" já saía limpo porque ali são DUAS
    // palavras, e as duas estavam lá.
    assert.equal(p('gastei 50 reais num paflon').descricao, 'Paflon')
    assert.equal(p('comprei 50 numa panela').descricao, 'Panela')
    assert.equal(p('comprei 80 num chuveiro').descricao, 'Chuveiro')
  })

  test('não quebrou o que já funcionava', () => {
    assert.equal(p('gastei 30 em uma tomada').descricao, 'Tomada')
    assert.equal(p('gastei 75,69 na shopee com fita de led').descricao, 'Fita de led')
  })
})

describe('categoria CASA — item de casa tinha onde cair', () => {
  test('paflon, chuveiro e panela viram Casa', () => {
    for (const t of ['gastei 50 num paflon', 'comprei 80 num chuveiro', 'gastei 120 numa panela']) {
      assert.equal(p(t).tipo, 'Casa', t)
    }
  })

  test('e resolvem LOCAL — sem gastar IA nem perguntar', () => {
    // Antes: completude 0,4 → ia pra IA → o dono viu virar "Mercado".
    assert.equal(p('gastei 50 num paflon').completude, 1)
  })
})

describe('categoria JOGOS — o pedido do gamer', () => {
  test('lojas e consoles viram Jogos, não Eletrônico nem Lazer', () => {
    for (const t of ['comprei 200 na steam', 'gastei 60 num jogo', 'comprei 300 no xbox',
                     'gastei 90 na playstation', 'comprei 40 na epic games']) {
      assert.equal(p(t).tipo, 'Jogos', t)
    }
  })

  test('Jogos vem ANTES de Lazer — a ordem é que decide', () => {
    // steam/xbox moravam dentro da linha de Lazer. Sem a nova linha vir antes,
    // Lazer venceria e nada mudaria.
    assert.equal(p('netflix 30').tipo, 'Lazer', 'Lazer não pode ter sido engolido')
    assert.equal(p('fui no cinema 40').tipo, 'Lazer')
  })

  test('as duas categorias existem em TODAS as listas do app', () => {
    // A lista está duplicada em 7 lugares. Faltando numa, a categoria some da
    // tela de edição, ou o orçamento dela é descartado no próximo save.
    for (const cat of ['Casa', 'Jogos']) {
      assert.ok(TIPOS_SAIDA.includes(cat), `TIPOS_SAIDA sem ${cat}`)
      assert.ok(ORCAMENTO_TIPOS.includes(cat), `ORCAMENTO_TIPOS sem ${cat}`)
      for (const arq of ['src/scripts/pages/dashboard.js', 'src/scripts/pages/db-transacoes.js']) {
        assert.ok(readFileSync(join(RAIZ, arq), 'utf8').includes(`'${cat}'`), `${arq} sem ${cat}`)
      }
    }
  })

  test('os dois auto-categorizadores concordam', () => {
    // Divergirem faria a MESMA compra receber categorias diferentes conforme
    // fosse lançada pelo chat ou pelo dashboard.
    const DB = readFileSync(join(RAIZ, 'src/scripts/pages/db-transacoes.js'), 'utf8')
    assert.match(DB, /tipo: 'Jogos'/)
    assert.match(DB, /tipo: 'Casa'/)
  })
})

describe('orçamento — parou de gravar gasto que não existe', () => {
  test('as formas que criavam despesa falsa', () => {
    // "quero gastar no máximo 500 em mercado" GRAVAVA R$500 de gasto.
    for (const t of ['quero gastar no maximo 500 em mercado', 'orcamento mercado 500',
                     'nao quero gastar mais de 400 em lazer', 'teto de 200 pra ifood']) {
      assert.equal(p(t).intencao, 'definir_orcamento', t)
    }
  })

  test('verbo no PASSADO continua sendo lançamento', () => {
    // Sem esta guarda, "gastei 500 do orçamento de mercado" viraria uma
    // DEFINIÇÃO e o gasto real nunca seria registrado — o espelho do bug.
    assert.equal(p('gastei 500 do orcamento de mercado').intencao, 'lancar')
  })

  test('a CONSULTA de orçamento não foi roubada', () => {
    // A separação não depende de regex: o bloco só dispara com VALOR, e
    // "quanto posso gastar?" não tem valor nenhum.
    for (const t of ['quanto posso gastar', 'meu orcamento', 'quanto sobra pra gastar']) {
      assert.equal(p(t).intencao, 'consultar', t)
    }
  })
})

describe('a fronteira de palavra — 4ª e 5ª ocorrências', () => {
  test('"parcelado" volta a ser crédito', () => {
    // `parcelad` com \b no fim não casa "parcelado". A compra parcelada virava
    // saída à vista e sumia da fatura do cartão.
    for (const t of ['comprei 300 parcelado', 'comprei 300 parcelada', 'comprei 300 parcelados']) {
      assert.equal(p(t).categoria, 'saida_credito', t)
    }
  })

  test('"atacado" volta a ser Mercado', () => {
    // Era `atacad|atacadao`: "atacado", a forma mais comum, não casava nenhum
    // dos dois — o primeiro pelo \b, o segundo por ser outra palavra.
    for (const t of ['gastei 200 no atacado', 'gastei 200 no atacadao', 'gastei 200 no atacadista']) {
      assert.equal(p(t).tipo, 'Mercado', t)
    }
  })

  test('flexões dos verbos de dinheiro — a classe inteira', () => {
    // Guarda contra a 6ª ocorrência: cada uma dessas flexões já foi (ou seria)
    // um radical truncado esperando para falhar.
    const casos = [
      ['gastei 50', 'saida'], ['gastos de 50', 'saida'], ['deposito de 50', 'entrada'],
      ['depositaram 50', 'entrada'], ['comprei 50 parcelado', 'saida_credito'],
    ]
    for (const [t, esp] of casos) assert.equal(p(t).categoria, esp, t)
  })
})
