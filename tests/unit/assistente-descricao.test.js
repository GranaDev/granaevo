/**
 * GranaEvo — Testes da extração de descrição do assistente
 *
 * Este módulo existe por causa de um bug REAL relatado em prod: "75,69 gastos na
 * shopee com fita de led e tinta branca" gravava uma transação escrita "Shopee".
 * A descrição — o único campo que responde "para onde foi meu dinheiro" — era
 * sobrescrita pelo rótulo da categoria em toda transação lançada pelo chat.
 *
 * O contrato é CONSERVADOR, igual ao do categorizacao.js: descrição errada é pior
 * que descrição ausente. `null` é resposta CORRETA quando a frase só tem valor e
 * verbo ("gastei 50") — o chamador cai no rótulo do tipo. Boa parte destes testes
 * existe para provar que ele não inventa texto.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractDescricao, contarPalavrasConteudo, textoParaModelo } from '../../src/scripts/modules/assistant/describe.js'
import { construirModelo, sugerirCategoria } from '../../src/scripts/modules/categorizacao.js'

const desc = (t) => extractDescricao(t).descricao

describe('o bug relatado em produção', () => {
  test('a frase exata do usuário devolve o item, não a loja', () => {
    assert.equal(desc('75,69 gastos na shopee com fita de led e tinta branca'), 'Fita de led e tinta branca')
  })

  test('a loja NÃO vaza para a descrição quando há cláusula "com"', () => {
    const d = desc('75,69 gastos na shopee com fita de led e tinta branca')
    assert.ok(!/shopee/i.test(d), `descrição não deve conter a loja: "${d}"`)
  })

  test('o " e " dentro do item não fragmenta a descrição', () => {
    assert.equal(desc('250 no mercado com carne e arroz'), 'Carne e arroz')
  })
})

describe('cláusula "com <item>" — o sinal mais forte', () => {
  test('item simples', () => {
    assert.equal(desc('gastei 60 na farmacia com dipirona'), 'Dipirona')
  })
  test('item composto', () => {
    assert.equal(desc('gastei 75,69 na shopee com fita de led'), 'Fita de led')
  })
})

describe('sem cláusula "com" — o resto limpo é a descrição', () => {
  test('mantém o comerciante quando ele qualifica o gasto', () => {
    assert.equal(desc('gastei 35 no uber pro aeroporto'), 'Uber pro aeroporto')
  })
  test('mantém o item e o local', () => {
    assert.equal(desc('120 de gasolina no posto'), 'Gasolina no posto')
  })
  test('objeto comprado', () => {
    assert.equal(desc('comprei racao pro cachorro 90'), 'Racao pro cachorro')
  })
  test('marca preservada com a grafia do usuário', () => {
    assert.equal(desc('comprei tenis nike 350 em 3x no cartao'), 'Tenis nike')
  })
  test('comerciante sozinho vira a descrição (melhor que o rótulo)', () => {
    assert.equal(desc('30 no uber'), 'Uber')
    assert.equal(desc('paguei 89,90 da netflix'), 'Netflix')
    assert.equal(desc('paguei 300 no dentista ontem'), 'Dentista')
  })
})

describe('ruído estrutural nunca vira descrição', () => {
  test('forma de pagamento não é descrição', () => {
    assert.equal(desc('paguei 30 com pix'), null)
    assert.equal(desc('gastei 50 no cartao'), null)
    assert.equal(desc('paguei 80 no debito'), null)
  })
  test('banco não é descrição', () => {
    assert.equal(desc('paguei 40 com nubank'), null)
  })
  test('parcelas não viram descrição', () => {
    assert.equal(desc('comprei 300 em 3x'), null)
  })
  test('data não vira descrição', () => {
    assert.equal(desc('gastei 50 ontem'), null)
    assert.equal(desc('gastei 50 hoje'), null)
  })
  test('valor com moeda coloquial não vira descrição', () => {
    assert.equal(desc('gastei 40 pila'), null)
    assert.equal(desc('gastei 1,5k'), null)
    assert.equal(desc('gastei 2 mil'), null)
  })
})

describe('conservador: null quando não há o que dizer', () => {
  test('só verbo e valor', () => {
    assert.equal(desc('gastei 50'), null)
    assert.equal(desc('recebi 3000'), null)
    assert.equal(desc('guardei 200'), null)
  })
  test('vazio e lixo', () => {
    assert.equal(desc(''), null)
    assert.equal(desc('   '), null)
    assert.equal(desc(null), null)
    assert.equal(desc(undefined), null)
  })
  test('nunca lança, seja qual for a entrada', () => {
    for (const v of [123, {}, [], true, NaN]) {
      assert.doesNotThrow(() => extractDescricao(v))
    }
  })
})

describe('a descrição nunca abre nem fecha com preposição', () => {
  const frases = [
    'comprei um fone de ouvido por 120 na amazon',
    'gastei 35 no uber pro aeroporto',
    '75,69 gastos na shopee com fita de led e tinta branca',
    '120 de gasolina no posto',
  ]
  for (const f of frases) {
    test(JSON.stringify(f), () => {
      const d = desc(f)
      assert.ok(d, 'deveria extrair algo')
      const toks = d.toLowerCase().split(/\s+/)
      const prep = ['de', 'do', 'da', 'na', 'no', 'em', 'pra', 'para', 'pro', 'com', 'por', 'e', 'o', 'a']
      assert.ok(!prep.includes(toks[0]), `abre com preposição: "${d}"`)
      assert.ok(!prep.includes(toks[toks.length - 1]), `fecha com preposição: "${d}"`)
    })
  }
})

describe('limites', () => {
  test('descrição é truncada em 80 chars', () => {
    const d = desc('gastei 50 no mercado com ' + 'pão '.repeat(60))
    assert.ok(d.length <= 80, `deveria truncar, veio ${d.length}`)
  })
  test('não devolve string vazia — null ou conteúdo', () => {
    for (const f of ['gastei 50', 'paguei 30 com pix', 'comprei 300 em 3x', 'gastei 50 ontem']) {
      const d = desc(f)
      assert.ok(d === null || d.length >= 2, `"${f}" devolveu ${JSON.stringify(d)}`)
    }
  })
})

describe('textoParaModelo — o classificador precisa da loja; o humano não', () => {
  test('a loja SOBREVIVE aqui, mesmo quando some da descrição', () => {
    const t = 'gastei 80 na kalunga com um caderno'
    assert.equal(desc(t), 'Caderno', 'a descrição é o que o humano lê')
    assert.match(textoParaModelo(t), /kalunga/i, 'o modelo precisa da loja')
  })

  test('regressão: sem a loja, o cérebro do app não atinge evidência mínima', () => {
    // Este teste trava um bug real: o engine consultava o modelo com a DESCRIÇÃO
    // ("Caderno"), que aparecia 1x no histórico — abaixo do minEvidencia=2 do
    // categorizacao.js. Resultado: null, e o chat gastava token com a IA pra
    // descobrir algo que o próprio histórico já sabia.
    const hist = [
      { categoria: 'saida', tipo: 'Educação', descricao: 'Caderno kalunga', valor: 30, data: '01/07/2026' },
      { categoria: 'saida', tipo: 'Educação', descricao: 'Caneta kalunga', valor: 12, data: '03/07/2026' },
      { categoria: 'saida', tipo: 'Educação', descricao: 'Kalunga material', valor: 45, data: '08/07/2026' },
    ]
    const modelo = construirModelo(hist, new Date(2026, 6, 16))
    const frase = 'gastei 80 na kalunga com um caderno'

    assert.equal(sugerirCategoria(modelo, desc(frase)), null,
      'a descrição sozinha não deveria bastar — é por isso que textoParaModelo existe')

    const s = sugerirCategoria(modelo, textoParaModelo(frase))
    assert.ok(s, 'com a loja, o histórico resolve sem IA')
    assert.equal(s.tipo, 'Educação')
  })

  test('nunca lança e devolve null quando não sobra nada', () => {
    assert.equal(textoParaModelo('gastei 50'), null)
    assert.doesNotThrow(() => textoParaModelo(null))
  })
})

describe('contarPalavrasConteudo — alimenta a decisão de chamar a IA', () => {
  test('frase rica tem conteúdo não lido', () => {
    assert.ok(contarPalavrasConteudo('75,69 gastos na shopee com fita de led e tinta branca') >= 2)
  })
  test('frase seca não tem conteúdo', () => {
    assert.equal(contarPalavrasConteudo('gastei 50'), 0)
    assert.equal(contarPalavrasConteudo('paguei 30 com pix'), 0)
  })
})
