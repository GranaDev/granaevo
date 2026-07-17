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
import { parseLocal, splitCompound, detectPeriodo } from '../../src/scripts/modules/assistant/parser-local.js'

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
    // "tabacaria" não está na lista fixa: sabemos que é saída e lemos o item, mas
    // não fazemos ideia da categoria. É exatamente aqui que a IA (ou o histórico)
    // ajuda. NB: escolher um termo que a lista fixa NÃO cobre é o ponto do teste —
    // se um dia ele virar keyword, troque o termo, não afrouxe a asserção.
    const r = parseLocal('gastei 30 na tabacaria')
    assert.equal(r.categoria, 'saida')
    assert.ok(r.descricao, 'deveria ter extraído a descrição')
    assert.ok(r.completude < 1, `completude deveria ser baixa, veio ${r.completude}`)
  })

  test('loja conhecida por keyword NOVA não gasta IA', () => {
    // Estes vinham caindo na IA por buraco na lista fixa (50% das frases comuns).
    for (const [f, tipo] of [['gastei 12 no café', 'Ifood'], ['paguei 30 no açougue', 'Mercado'],
      ['paguei 90 na oficina', 'Transporte'], ['paguei 18 na papelaria', 'Educação']]) {
      const r = parseLocal(f.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))
      assert.equal(r.tipo, tipo, `${f} → tipo`)
      assert.equal(r.completude, 1, `${f} ainda chamaria a IA`)
    }
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

describe('valor_ambiguo NÃO é catch-all — o lançamento fantasma', () => {
  // Bug real: qualquer frase não-entendida que tivesse um número virava "valor
  // solto" → o chat oferecia lançar → 1 toque gravava algo que ninguém pediu.
  // A régua é a INTENÇÃO (comando imperativo?), não a quantidade de conteúdo —
  // uma régua por conteúdo derrubava casos legítimos como "109,05 com fita de led"
  // na IA, que é lento, custa token e NÃO FUNCIONA OFFLINE.
  test('valor de verdade sozinho é ambíguo', () => {
    for (const f of ['109,05', '80', 'r$ 109,05', '50 reais', '1,5k', '80 no pix']) {
      assert.equal(parseLocal(f).intencao, 'valor_ambiguo', `${JSON.stringify(f)} deveria ser ambíguo`)
    }
  })

  test('valor COM item também é ambíguo — e a descrição vem junto', () => {
    // Sem isto, perguntar a direção custaria uma ida à IA e morreria offline.
    const r = parseLocal('109,05 com fita de led')
    assert.equal(r.intencao, 'valor_ambiguo')
    assert.equal(r.descricao, 'Fita de led', 'o item precisa sobreviver à pergunta')
  })

  test('verbo de transferência não vaza pra descrição', () => {
    const r = parseLocal('transferi 200 pro joao')
    assert.equal(r.intencao, 'valor_ambiguo')
    assert.ok(!/transferi/i.test(r.descricao || ''), `verbo vazou: ${r.descricao}`)
  })

  test('COMANDO imperativo nunca é valor solto', () => {
    for (const f of [
      'cria uma meta de 5000 pra viagem',
      'muda o valor pra 80',            // sem lançamento recente: não pode virar gasto de R$80
      'renomeia a reserva pra ferias 3000',
      'desativa o alerta de 500',
    ]) {
      assert.notEqual(parseLocal(f).intencao, 'valor_ambiguo', `${JSON.stringify(f)} ofereceria lançar`)
    }
  })

  test('pedido de EDITAR vira handoff, não lançamento', () => {
    const r = parseLocal('muda o valor daquela compra de terça pra 80')
    assert.equal(r.intencao, 'editar_antigo')
  })
})

describe('editar_antigo — honesto sobre o limite', () => {
  const casos = [
    'apaga o gasto de ontem no mercado',
    'muda aquela compra de terça pra 80',
    'deleta a transação de segunda',
    'corrige aquele lançamento',
    'altera o gasto do dia 5',
  ]
  for (const f of casos) {
    test(JSON.stringify(f), () => {
      assert.equal(parseLocal(f).intencao, 'editar_antigo')
    })
  }

  test('"apaga o último" continua sendo DESFAZER, não handoff', () => {
    for (const f of ['apaga o último', 'desfaz', 'errei', 'cancela isso']) {
      assert.equal(parseLocal(f.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')).intencao, 'desfazer', f)
    }
  })

  test('lançamento normal não é confundido com edição', () => {
    for (const f of ['gastei 50 no mercado', 'paguei 30 no uber ontem', 'recebi 3000 de salario']) {
      assert.equal(parseLocal(f).intencao, 'lancar', f)
    }
  })
})

describe('semana passada ≠ esta semana', () => {
  test('as duas expressões têm períodos DIFERENTES', () => {
    assert.equal(detectPeriodo('quanto gastei essa semana'), 'semana')
    assert.equal(detectPeriodo('quanto gastei semana passada'), 'semana_passada')
    assert.equal(detectPeriodo('quanto gastei na semana passada'), 'semana_passada')
    assert.equal(detectPeriodo('quanto gastei semana retrasada'), 'semana_passada')
  })
})

describe('robustez: o parser nunca lança', () => {
  for (const v of ['', '   ', null, undefined, 123, {}, [], '💸', 'a'.repeat(5000)]) {
    test(`entrada ${JSON.stringify(String(v).slice(0, 20))}`, () => {
      assert.doesNotThrow(() => parseLocal(v))
    })
  }
})
