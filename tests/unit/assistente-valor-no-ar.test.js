/**
 * T7 — O VALOR QUE FICAVA NO AR.
 *
 * A conversa real do dono (2026-08-08):
 *   ele  › "Gastei 900 no cartão em 3x e em seguida 300 reais"
 *   app  › [os 900 lançam certo: Nubank · 3x de R$ 300,00]
 *   app  › "Peguei R$ 300,00 — só me diz o que foi que eu lanço."
 *   ele  › "Os 300 foram num carrinho"
 *   app  › "Peguei R$ 300,00 — só me diz o que foi que eu lanço."   ← mesma pergunta
 *   → os 300 nunca foram lançados.
 *
 * DUAS CAUSAS, e as duas medidas:
 *
 * 1. O encaixe exigia `!(p.valor > 0)` — qualquer número na resposta cancelava.
 *    Mas repetir o valor ("os 300 foram...") é a forma mais natural de
 *    responder: a pessoa diz de qual valor está falando.
 *
 * 2. O encaixe exigia `p.categoria` — ou seja, uma DIREÇÃO. Só que a pergunta
 *    dizia "me diz o que foi", que pede o ITEM. Pergunta ambígua, resposta
 *    recusada. Medido: "num carrinho", "foi um carrinho" e "carrinho" davam
 *    todos em nada, embora o extractDescricao lesse "Carrinho" nos três.
 *
 * ⚠️ O engine não instancia fora do navegador (importa dataManager/supabase).
 * Aqui se testa a REGRA de encaixe com as mesmas funções puras que ele usa,
 * mais a fiação no fonte. Onde dá para executar, executa.
 *
 * node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseLocal } from '../../src/scripts/modules/assistant/parser-local.js'
import { extractDescricao } from '../../src/scripts/modules/assistant/describe.js'
import { perguntarGastoOuEntrada } from '../../src/scripts/modules/assistant/phrases.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8')
  .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

/** A regra de encaixe, com a mesma forma do engine. */
function encaixa(textoResposta, valorPendente) {
  const p = parseLocal(textoResposta)
  const valorNovo = p.valor > 0 && p.valor !== valorPendente
  if (!valorNovo && p.intencao === 'lancar' && p.categoria) return 'lanca'
  if (!valorNovo && extractDescricao(textoResposta).descricao) return 'pergunta-direcao'
  return 'assunto-novo'
}

describe('⭐ a resposta do dono, palavra por palavra', () => {
  test('"Os 300 foram num carrinho" não é mais descartada', () => {
    assert.notEqual(encaixa('Os 300 foram num carrinho', 300), 'assunto-novo')
  })

  test('e o item é entendido como "Carrinho"', () => {
    assert.equal(extractDescricao('Os 300 foram num carrinho').descricao, 'Carrinho')
  })

  test('depois de dizer o item, o chip de direção fecha o lançamento', () => {
    // O chip reenvia "gastei 300" — mesmo valor do pendente, com direção.
    assert.equal(encaixa('gastei 300', 300), 'lanca')
  })
})

describe('as respostas naturais ao "o que foi"', () => {
  for (const r of ['num carrinho', 'foi um carrinho', 'carrinho', 'um carrinho de bebe']) {
    test(`"${r}" pede a direção, em vez de sumir`, () =>
      assert.equal(encaixa(r, 300), 'pergunta-direcao'))
  }
})

describe('as respostas de direção seguem funcionando', () => {
  for (const r of ['foi um gasto', 'gastei no mercado', 'recebi', 'guardei na reserva']) {
    test(`"${r}" lança direto`, () => assert.equal(encaixa(r, 300), 'lanca'))
  }
})

describe('⭐ o que NÃO pode acontecer', () => {
  test('valor DIFERENTE larga o pendente e segue o fluxo normal', () => {
    // Se herdasse, "gastei 50 no mercado" logo após um 300 no ar lançaria 300.
    // `assunto-novo` aqui significa "sai deste bloco e é tratado como qualquer
    // outra mensagem" — que é justamente o certo: ele tem valor e direção
    // próprios e não precisa do pendente para nada.
    assert.equal(encaixa('gastei 50 no mercado', 300), 'assunto-novo')
    assert.equal(parseLocal('gastei 50 no mercado').valor, 50, 'e com o valor DELE, não o pendente')
    assert.equal(parseLocal('gastei 50 no mercado').categoria, 'saida')
  })

  test('a direção NUNCA é adivinhada a partir do item', () => {
    // "carrinho" tanto pode ter sido comprado quanto vendido. Chutar aqui grava
    // dinheiro no sentido errado — o erro mais caro que este app comete.
    assert.equal(encaixa('carrinho', 300), 'pergunta-direcao')
    assert.match(ENGINE, /#perguntarDirecao\(pend\.valor, doItem\)/)
  })

  test('a repergunta acontece UMA vez, não vira laço', () => {
    assert.match(ENGINE, /!this\.#itemJaPerguntado/)
    assert.match(ENGINE, /this\.#itemJaPerguntado = true;/)
  })

  test('a trava é zerada em CADA caminho de saída', () => {
    // Se ficasse presa em `true`, o PRÓXIMO valor solto perderia o direito à
    // repergunta — bug que só aparece na segunda vez e por isso custa caro.
    //
    // Contar ocorrências não servia: o `= false` da DECLARAÇÃO entrava na conta,
    // então remover um reset ainda passava do limiar. Mutação de 2026-08-09
    // provou isso. Agora cada saída é verificada no seu próprio bloco.
    const apos = (marca, janela = 400) => {
      const i = ENGINE.indexOf(marca)
      assert.ok(i > 0, `não achei: ${marca}`)
      return ENGINE.slice(i, i + janela)
    }
    assert.match(apos('#pendingConta = this.#pendingLembrete'), /#itemJaPerguntado = false/,
      'logout precisa zerar a trava')
    assert.match(apos("if (!valorNovo && p.intencao === 'lancar' && p.categoria) {"), /#itemJaPerguntado = false/,
      'o caminho de SUCESSO precisa zerar a trava')
    assert.match(apos('this.#pendingValorAmbiguo = null;\n            this.#itemJaPerguntado'), /#itemJaPerguntado = false/,
      'a desistência precisa zerar a trava')
  })

  test('a regra do teste é a regra do engine (não uma cópia que envelhece)', () => {
    // `encaixa()` acima espelha o engine — e cópia diverge. Mutação de
    // 2026-08-09: quebrando o engine, este arquivo seguia verde. Mesma armadilha
    // das duas listas de categoria. Estas asserções soldam os dois lados.
    assert.match(ENGINE, /const valorNovo = p\.valor > 0 && p\.valor !== pend\.valor;/)
    assert.match(ENGINE, /if \(!valorNovo && p\.intencao === 'lancar' && p\.categoria\) \{/)
    assert.match(ENGINE, /const doItem = extractDescricao\(text\)\.descricao;/)
    assert.match(ENGINE, /if \(!valorNovo && doItem && !this\.#itemJaPerguntado\) \{/)
  })
})

describe('a pergunta pede o que o código aceita', () => {
  test('não pergunta mais "o que foi" — pergunta a direção', () => {
    const f = perguntarGastoOuEntrada(300, null)
    assert.ok(!/o que foi/i.test(f), 'a frase antiga convidava o item e recusava a resposta')
    assert.match(f, /gasto, entrada ou reserva/i)
  })

  test('com o item já sabido, ele volta na frase', () => {
    // Mostra que foi ouvido; a pessoa não repete o que já disse.
    assert.match(perguntarGastoOuEntrada(300, 'Carrinho'), /Carrinho/)
  })

  test('sem item, a frase não inventa um', () => {
    assert.ok(!/undefined|null|\*\*/.test(perguntarGastoOuEntrada(300, null)))
  })

  test('os chips estão num lugar só', () => {
    // Eram construídos inline; agora a pergunta é feita de DOIS pontos (valor
    // solto e repergunta), e duas cópias divergiriam justo no chip — que é o
    // que reenvia o valor.
    assert.equal((ENGINE.match(/label: 'Foi um gasto'/g) || []).length, 1)
    assert.match(ENGINE, /#perguntarDirecao\(valor, descricao\)/)
  })
})
