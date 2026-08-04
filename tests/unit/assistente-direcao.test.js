/**
 * A DIREÇÃO DO DINHEIRO — o defeito mais caro que este chat pode ter.
 *
 * BUG RELATADO EM PRODUÇÃO (2026-08-04): *"tirei 100 reais da reserva"* entrou
 * como **entrada**, não como retirada.
 *
 * A causa não foi o parser errar a direção — foi ele **não reconhecer a frase**.
 * Uma medição com 23 formas naturais de dizer "tirei da reserva" reprovou 12.
 * Todas caíam em `valor_ambiguo`, e aí o assistente perguntava *"foi gasto ou
 * entrada?"*.
 *
 * Essa pergunta é uma armadilha para retirada de reserva: tirar da reserva **é**
 * dinheiro entrando na conta, então "entrada" é a resposta honesta à pergunta
 * errada. O usuário não errou — a pergunta é que não devia existir.
 *
 * A mesma medição achou o espelho do bug: *"meti 100 na poupança"* virava SAÍDA,
 * e *"vendi meu celular por 500"* virava SAÍDA/Eletrônico (a palavra-chave do
 * objeto vencia o verbo de venda).
 *
 * Por que este arquivo é grande: cada frase aqui é uma que um humano escreveria
 * e o parser não entendia. Vocabulário não se deduz — se mede.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocal } from '../../src/scripts/modules/assistant/parser-local.js'

const cat = (t) => parseLocal(t).categoria

/** Falha dizendo a FRASE, não só "esperava X recebeu Y". */
function todas(frases, esperada) {
  const erradas = frases.filter((f) => cat(f) !== esperada)
    .map((f) => `${JSON.stringify(f)} → ${cat(f)}`)
  assert.deepEqual(erradas, [], `\n  ${erradas.join('\n  ')}\n`)
}

describe('o bug relatado, travado pelo nome', () => {
  test('"tirei 100 reais da reserva" é RETIRADA, nunca entrada', () => {
    assert.equal(cat('tirei 100 reais da reserva'), 'retirada_reserva')
  })

  test('e nunca chega a virar pergunta — a pergunta era a armadilha', () => {
    // Se voltar a cair em `valor_ambiguo`, o assistente pergunta "gasto ou
    // entrada?" e o usuário responde "entrada" com toda a razão do mundo.
    assert.equal(parseLocal('tirei 100 reais da reserva').intencao, 'lancar')
  })
})

describe('RETIRADA da reserva — 25 formas de dizer a mesma coisa', () => {
  test('verbo + nome da reserva, em qualquer ordem', () => {
    todas([
      'tirei 100 da reserva', 'tirei 100 reais da reserva', 'retirei 100 reais da reserva',
      'saquei 100 reais da reserva', 'resgatei 100 reais da reserva',
      'retirei da reserva 100', 'da reserva tirei 100', '100 de retirada da reserva',
    ], 'retirada_reserva')
  })

  test('verbos genéricos — seguros porque a reserva é a âncora', () => {
    // "peguei", "usei", "mexi" só viram retirada quando a frase NOMEIA uma
    // reserva. É o que permite aceitá-los sem transformar "usei 100 no mercado"
    // em saque.
    todas([
      'peguei 100 da reserva', 'peguei 100 reais da reserva', 'usei 100 da reserva',
      'mexi em 100 da reserva', 'usei 100 do dinheiro guardado',
      'peguei de volta 100 da reserva', 'tirei 100 emprestado da reserva',
    ], 'retirada_reserva')
  })

  test('infinitivo e imperativo — a lista antiga só tinha o passado', () => {
    todas([
      'sacar 100 da reserva', 'quero tirar 100 da reserva', 'preciso tirar 100 da reserva',
      'tira 100 da reserva', 'tirar 100 da caixinha', 'vou tirar 100 do cofrinho',
    ], 'retirada_reserva')
  })

  test('os outros nomes que o brasileiro usa', () => {
    // Nubank chama "Caixinhas", PicPay "Cofrinhos". Quase ninguém diz "reserva".
    todas([
      'tirei 100 da caixinha', 'tirei 100 do cofrinho', 'tirei 100 da poupanca',
      'tirei 100 do guardadinho',
    ], 'retirada_reserva')
  })

  test('"retirada"/"resgate" como substantivo dispensam a âncora', () => {
    // Neste app essas palavras só significam reserva — `motivoRetirada` existe
    // só lá. E "retirada de 100" é a forma que o PRÓPRIO app usa nos rótulos.
    todas(['retirada de 100', 'fiz uma retirada de 100', 'resgate de 100 da reserva'],
      'retirada_reserva')
  })
})

describe('DEPÓSITO na reserva — o espelho do mesmo defeito', () => {
  test('"meti 100 na poupança" é RESERVA, não saída', () => {
    // Estava classificado como SAÍDA: "meti" está na lista de gasto, e nada
    // olhava para a palavra "poupança" ao lado.
    assert.equal(cat('meti 100 na poupanca'), 'reserva')
  })

  test('verbos genéricos com a âncora', () => {
    todas([
      'coloquei 100 na reserva', 'botei 100 na caixinha', 'depositei 100 na reserva',
      'coloquei 100 no cofrinho', 'adicionei 100 na reserva', 'transferi 100 pra reserva',
      'guarda 100 na reserva',
    ], 'reserva')
  })

  test('o idioma "de lado" vale como âncora própria', () => {
    todas(['pus 100 de lado', 'botei 100 de lado', 'deixei 100 de lado'], 'reserva')
  })

  test('verbos que já significam poupar dispensam âncora', () => {
    todas(['guardei 100', 'poupei 100', 'juntei 100 pra viagem', 'separei 100',
           'aportei 100 na reserva', 'economizei 100'], 'reserva')
  })
})

describe('ENTRADA — vender é receita, mesmo falando do objeto', () => {
  test('"vendi meu celular por 500" é ENTRADA, não gasto com eletrônico', () => {
    // A palavra-chave do objeto ("celular" → Eletrônico/saída) vencia o verbo.
    // O objeto de uma venda é o que saiu de casa; o dinheiro entrou.
    assert.equal(cat('vendi meu celular por 500'), 'entrada')
    assert.equal(cat('vendi um movel por 100'), 'entrada')
  })

  test('"deposito" volta a casar — a fronteira de palavra de novo', () => {
    // A regex tinha `deposit` com \b no fim: "deposito" (o que as pessoas
    // escrevem) não casava. Mesma armadilha do `gasto`/`gastos`, 3ª ocorrência
    // neste arquivo.
    todas(['deposito de 100', 'depositaram 100'], 'entrada')
  })

  test('dinheiro que volta também é entrada', () => {
    todas(['me devolveram 100', 'estorno de 100', 'reembolso de 100',
           'cashback de 100', 'rendimento de 100'], 'entrada')
  })

  test('as formas já cobertas continuam', () => {
    todas(['recebi 100', 'ganhei 100', 'caiu 100 na conta', 'me pagaram 100',
           'pix de 100', 'recebi 100 de salario'], 'entrada')
  })
})

describe('SAÍDA — as formas que faltavam', () => {
  test('custo e compra sem verbo de gasto explícito', () => {
    todas(['custou 100', 'ficou em 100', 'fiz uma compra de 100', 'compra de 100',
           'debitei 100'], 'saida')
  })

  test('as formas já cobertas continuam', () => {
    todas(['gastei 100', 'paguei 100', 'comprei 100', 'torrei 100 no bar'], 'saida')
  })
})

describe('CONTROLE NEGATIVO — a direção nunca pode inverter', () => {
  test('gasto comum não vira reserva nem retirada', () => {
    for (const f of ['gastei 100 no mercado', 'meti 100 no bar', 'mandei 100 pro joao',
                     'comprei um celular 500', 'usei 100 no mercado', 'peguei o onibus']) {
      assert.notEqual(cat(f), 'reserva', f)
      assert.notEqual(cat(f), 'retirada_reserva', f)
    }
  })

  test('depósito e retirada não se confundem entre si', () => {
    assert.equal(cat('guardei 100 na reserva'), 'reserva')
    assert.equal(cat('tirei 100 da reserva'), 'retirada_reserva')
  })

  test('"peguei 100 emprestado do banco" não é saque de reserva', () => {
    // Tem o verbo genérico, não tem a âncora. É o caso que justifica exigir o
    // nome da reserva para aceitar verbos como "peguei".
    assert.notEqual(cat('peguei 100 emprestado do banco'), 'retirada_reserva')
  })

  test('conta fixa continua indo pro fluxo próprio, não virando saída solta', () => {
    // "paguei 100 de luz" é `pagar_conta` — intenção dedicada, com baixa da
    // conta fixa. Classificar como saída comum perderia esse efeito.
    assert.equal(parseLocal('paguei 100 de luz').intencao, 'pagar_conta')
    assert.equal(parseLocal('paguei 100 de aluguel').intencao, 'pagar_conta')
  })
})
