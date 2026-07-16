/**
 * GranaEvo — Testes do parser local do assistente
 *
 * Trava os DOIS bugs relatados em produção em 16/07/2026, mais as regressões
 * adjacentes que a investigação encontrou. Cada bloco aqui nasceu de uma falha
 * real vista pelo usuário, não de um cenário imaginado.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocal, splitCompound } from '../../src/scripts/modules/assistant/parser-local.js'

const CONF_LOCAL_OK = 0.7 // espelha engine.js

describe('BUG 1 — "75,69 gastos na shopee com fita de led e tinta branca"', () => {
  const r = parseLocal('75,69 gastos na shopee com fita de led e tinta branca')

  test('a descrição é o ITEM, não a loja', () => {
    assert.equal(r.descricao, 'Fita de led e tinta branca')
  })
  test('a loja vai para o tipo', () => {
    assert.equal(r.tipo, 'Shopee')
  })
  test('é uma saída de 75,69', () => {
    assert.equal(r.categoria, 'saida')
    assert.equal(r.valor, 75.69)
  })
  test('descrição e tipo nunca mais são a mesma coisa numa frase rica', () => {
    assert.notEqual(r.descricao, r.tipo)
  })
})

describe('BUG 2 — "Retirei 109,05 da caixinha"', () => {
  const r = parseLocal('Retirei 109,05 da caixinha')

  test('"caixinha" é reserva — não é mais "gasto ou entrada?"', () => {
    assert.equal(r.intencao, 'lancar')
    assert.equal(r.categoria, 'retirada_reserva')
    assert.notEqual(r.intencao, 'valor_ambiguo')
  })
  test('o valor sobrevive', () => {
    assert.equal(r.valor, 109.05)
  })

  test('a resposta de follow-up "Retirada da caixinha" carrega a direção', () => {
    // Sem valor próprio: o engine casa com #pendingValorAmbiguo e herda os 109,05.
    const f = parseLocal('Retirada da caixinha')
    assert.equal(f.categoria, 'retirada_reserva')
    assert.equal(f.valor, null)
  })
})

describe('vocabulário real de reserva no Brasil', () => {
  const casos = [
    ['tirei 50 do cofrinho', 'cofrinho (PicPay)'],
    ['saquei 200 da poupanca', 'poupança'],
    ['retirei 80 do porquinho', 'porquinho'],
    ['resgatei 300 da minha reserva', 'reserva (o termo antigo, ainda funciona)'],
    ['tirei 100 da reserva de emergencia', 'reserva nomeada'],
  ]
  for (const [frase, apelido] of casos) {
    test(`${apelido}: ${JSON.stringify(frase)}`, () => {
      assert.equal(parseLocal(frase).categoria, 'retirada_reserva')
    })
  }

  test('CONTROLE NEGATIVO: "caixa eletrônico" NÃO é a caixinha', () => {
    const r = parseLocal('tirei 100 no caixa eletronico')
    assert.notEqual(r.categoria, 'retirada_reserva')
  })
  test('CONTROLE NEGATIVO: gasto comum segue sendo saída', () => {
    assert.equal(parseLocal('gastei 50 no mercado').categoria, 'saida')
  })
})

describe('meta_hint: nome real da reserva vs. palavra genérica', () => {
  test('nome real vira hint', () => {
    assert.equal(parseLocal('guardei 100 na caixinha de emergencia').meta_hint, 'emergencia')
  })
  test('a palavra genérica NÃO vira hint (senão o engine procura uma meta chamada "caixinha")', () => {
    assert.equal(parseLocal('guardei 100 na caixinha').meta_hint, null)
    assert.equal(parseLocal('guardei 100 na reserva').meta_hint, null)
  })
  test('retirada também extrai o nome — antes só reserva extraía', () => {
    assert.equal(parseLocal('retirei 50 da caixinha de emergencia').meta_hint, 'emergencia')
  })
})

describe('o verbo "gastos" (plural) é reconhecido', () => {
  test('sem depender de a loja ser conhecida', () => {
    // Antes: \bgasto\b não casa "gastos" → caía em valor_ambiguo e o assistente
    // perguntava "foi gasto ou entrada?" de uma frase que DIZ "gastos".
    const r = parseLocal('75,69 gastos com fita de led e tinta branca')
    assert.equal(r.categoria, 'saida')
    assert.notEqual(r.intencao, 'valor_ambiguo')
  })
  test('singular continua funcionando', () => {
    assert.equal(parseLocal('gasto de 30 no uber').categoria, 'saida')
  })
})

describe('completude — o que destrava a IA (R5)', () => {
  test('loja conhecida = completude cheia, IA não é chamada', () => {
    const r = parseLocal('gastei 200 no mercado')
    assert.equal(r.completude, 1)
    assert.ok(r.confianca >= CONF_LOCAL_OK)
  })
  test('loja DESCONHECIDA com descrição = completude baixa → vale perguntar', () => {
    // "kalunga" não está na lista fixa: sabemos que é saída e lemos o item,
    // mas não fazemos ideia da categoria. É exatamente aqui que a IA ajuda.
    const r = parseLocal('gastei 80 na kalunga com um caderno')
    assert.equal(r.categoria, 'saida')
    assert.ok(r.descricao, 'deveria ter extraído a descrição')
    assert.ok(r.completude < 1, `completude deveria ser baixa, veio ${r.completude}`)
  })
  test('frase seca não rebaixa completude (não há o que perder)', () => {
    assert.equal(parseLocal('gastei 50').completude, 1)
  })

  // Regressão: reserva/retirada têm tipo=null POR PROJETO (o tx-builder grava
  // 'Reserva'/'Retirada de Reserva'). Uma versão anterior desta regra tratava
  // isso como "sem categoria" e mandava TODO saque e TODO aporte pra IA —
  // rede + token à toa numa categoria que o parser já resolve sozinho.
  test('reserva e retirada NUNCA caem na IA por "falta de tipo"', () => {
    for (const f of ['Retirei 109,05 da caixinha', 'guardei 200 na viagem', 'tirei 50 do cofrinho', 'poupei 300']) {
      const r = parseLocal(f)
      assert.equal(r.completude, 1, `${JSON.stringify(f)} chamaria a IA sem necessidade`)
      assert.ok(r.confianca >= CONF_LOCAL_OK, `${JSON.stringify(f)} tem confiança baixa demais`)
    }
  })
})

describe('splitCompound não descarta pedaço em silêncio (R11)', () => {
  test('mensagem composta de verdade continua rachando', () => {
    const segs = splitCompound('gastei 10 no mercado e 20 no uber')
    assert.equal(segs.length, 2)
  })
  test('descrição com " e " NÃO racha — e nada é perdido', () => {
    // Antes: 2 valores no pedaço → rachava em todo " e " → "leite" (sem valor)
    // era filtrado fora sem aviso nenhum.
    const segs = splitCompound('gastei 20 no uber e 30 no mercado com pão e leite')
    for (const s of segs) {
      assert.ok(/\d/.test(s), `segmento sem valor sobreviveu ao split: ${JSON.stringify(s)}`)
    }
    const juntos = segs.join(' ')
    assert.ok(/leite/.test(juntos), 'o "leite" foi descartado silenciosamente')
  })
  test('frase simples não racha', () => {
    assert.deepEqual(splitCompound('250 no mercado com carne e arroz'), ['250 no mercado com carne e arroz'])
  })
})

describe('robustez: o parser nunca lança', () => {
  for (const v of ['', '   ', null, undefined, 123, {}, [], '💸', 'a'.repeat(5000)]) {
    test(`entrada ${JSON.stringify(String(v).slice(0, 20))}`, () => {
      assert.doesNotThrow(() => parseLocal(v))
    })
  }
})
