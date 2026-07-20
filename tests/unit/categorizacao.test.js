/**
 * GranaEvo — Testes da categorização automática aprendida
 *
 * O contrato deste módulo é ser CONSERVADOR: ele fala na cara do usuário no
 * formulário de lançamento, e uma sugestão errada que ele aceita no automático
 * grava dado errado — contaminando saldo, relatório e meta. "Não sei" (null) é
 * uma resposta CORRETA e a maioria destes testes existe para provar que ele
 * sabe calar a boca.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { construirModelo, sugerirCategoria } from '../../src/scripts/modules/categorizacao.js'

const HOJE = new Date(2026, 6, 15)

// "N dias atrás" no formato que o app grava (DD/MM/YYYY).
const diasAtras = (n) => {
  const d = new Date(HOJE.getTime() - n * 86_400_000)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

// Lançamento manual base; sobrescreva o que o teste precisa.
const T = (over) => ({
  categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado Extra',
  valor: 50, data: diasAtras(10), ...over,
})

// N cópias de um lançamento em dias distintos e recentes (evita virar duplicata).
const varias = (n, over, diaInicial = 5) =>
  Array.from({ length: n }, (_, i) => T({ ...over, data: diasAtras(diaInicial + i * 7) }))

const modeloDe = (txs) => construirModelo(txs, HOJE)
const sugerir = (txs, desc, opts) => sugerirCategoria(modeloDe(txs), desc, opts)

describe('aprende com o histórico do usuário', () => {
  test('3× "Mercado Extra" → Mercado: sugere Mercado', () => {
    const r = sugerir(varias(3, { tipo: 'Mercado' }), 'mercado extra')
    assert.ok(r, 'deveria sugerir')
    assert.equal(r.tipo, 'Mercado')
    assert.equal(r.categoria, 'saida')
    assert.equal(r.baseadoEm, 3, 'os 3 lançamentos que sustentam a sugestão')
  })

  test('aprende o tipo DELE, não o da lista fixa do app', () => {
    // A lista fixa de db-transacoes.js diria "Mercado". Este usuário chama de 'Feira'.
    const r = sugerir(varias(4, { tipo: 'Feira' }), 'mercado extra')
    assert.equal(r.tipo, 'Feira', 'o histórico do usuário manda, não o regex embutido')
  })

  test('casa por token parcial — "mercado extra sábado" acha o histórico de "Mercado Extra"', () => {
    const r = sugerir(varias(3, {}), 'mercado extra sabado')
    assert.equal(r.tipo, 'Mercado')
  })

  test('baseadoEm conta transações DISTINTAS, não tokens casados', () => {
    // 3 lançamentos × 2 tokens casados ("mercado" e "extra") não são "6 vezes".
    const r = sugerir(varias(3, {}), 'mercado extra')
    assert.equal(r.baseadoEm, 3)
  })

  test('aprende entrada também (Salário)', () => {
    const r = sugerir(varias(3, { categoria: 'entrada', tipo: 'Salário', descricao: 'Salario empresa' }), 'salario empresa')
    assert.equal(r.categoria, 'entrada')
    assert.equal(r.tipo, 'Salário')
  })

  test('devolve a grafia original do tipo, não a normalizada', () => {
    const r = sugerir(varias(3, { tipo: 'Farmácia', descricao: 'Droga Raia' }), 'droga raia')
    assert.equal(r.tipo, 'Farmácia', 'com acento e maiúscula, como ele escreveu')
  })

  test('mesmo tipo com caixa diferente é UM tipo só (Mercado/mercado/MERCADO)', () => {
    const txs = [
      ...varias(2, { tipo: 'Mercado' }, 5),
      ...varias(2, { tipo: 'mercado' }, 40),
      ...varias(2, { tipo: 'MERCADO' }, 80),
    ]
    const r = sugerir(txs, 'mercado extra')
    assert.ok(r, 'a caixa não pode rachar a evidência a ponto de matar a sugestão')
    assert.equal(r.baseadoEm, 6)
    assert.equal(r.tipo.toLowerCase(), 'mercado')
  })
})

describe('não chuta — o silêncio é resposta', () => {
  test('descrição desconhecida → null', () => {
    assert.equal(sugerir(varias(5, {}), 'consulta veterinario'), null)
  })

  test('histórico vazio, nulo ou lixo → null, sem quebrar', () => {
    assert.equal(sugerir([], 'mercado'), null)
    assert.equal(sugerir(null, 'mercado'), null)
    assert.equal(sugerir(undefined, 'mercado'), null)
    assert.equal(sugerirCategoria(null, 'mercado'), null)
    assert.equal(sugerirCategoria({}, 'mercado'), null)
    assert.equal(sugerirCategoria(construirModelo(null), 'mercado'), null)
  })

  test('uma vez só é evento, não padrão → null', () => {
    assert.equal(sugerir([T({})], 'mercado extra'), null)
  })

  test('token ambíguo (3× Farmácia vs 3× Saúde, mesma recência) → null', () => {
    const txs = [
      ...varias(3, { tipo: 'Farmácia', descricao: 'Drogaria' }, 5),
      ...varias(3, { tipo: 'Saúde', descricao: 'Drogaria' }, 5),
    ]
    assert.equal(sugerir(txs, 'drogaria'), null, 'empate real não vira sugestão')
  })

  test('maioria apertada (4×3) não passa no limiar padrão', () => {
    const txs = [
      ...varias(4, { tipo: 'Farmácia', descricao: 'Drogaria' }, 5),
      ...varias(3, { tipo: 'Saúde', descricao: 'Drogaria' }, 5),
    ]
    assert.equal(sugerir(txs, 'drogaria'), null, 'ganhar por pouco não é saber')
  })

  test('descrição vazia/nula/não-string → null', () => {
    const txs = varias(5, {})
    for (const d of ['', '   ', null, undefined, 42, {}, []]) {
      assert.equal(sugerir(txs, d), null, `descrição ${JSON.stringify(d)}`)
    }
  })

  test('só palavras curtas (<3 chars) → null', () => {
    assert.equal(sugerir(varias(5, {}), 'ab cd e'), null)
  })
})

describe('confiança', () => {
  test('cresce com mais evidência', () => {
    const c = (n) => sugerir(varias(n, {}), 'mercado extra').confianca
    const c2 = c(2), c3 = c(3), c8 = c(8)
    assert.ok(c2 < c3 && c3 < c8, `esperava crescer: ${c2} < ${c3} < ${c8}`)
    assert.ok(c8 < 1, 'nunca é certeza absoluta')
  })

  test('evidência dividida derruba a confiança', () => {
    const puro = sugerir(varias(6, { tipo: 'Mercado', descricao: 'Drogaria' }, 5), 'drogaria').confianca
    const txs = [
      ...varias(6, { tipo: 'Farmácia', descricao: 'Drogaria' }, 5),
      ...varias(2, { tipo: 'Saúde', descricao: 'Drogaria' }, 5),
    ]
    const dividido = sugerirCategoria(modeloDe(txs), 'drogaria', { limiar: 0 })
    assert.ok(dividido.confianca < puro, `dividido (${dividido.confianca}) < puro (${puro})`)
  })

  test('limiar é respeitado — chamador pode ser mais ou menos exigente', () => {
    const txs = varias(3, {})
    assert.ok(sugerirCategoria(modeloDe(txs), 'mercado extra', { limiar: 0.5 }))
    assert.equal(sugerirCategoria(modeloDe(txs), 'mercado extra', { limiar: 0.99 }), null)
  })

  test('minEvidencia é respeitado', () => {
    const txs = varias(2, {})
    assert.ok(sugerirCategoria(modeloDe(txs), 'mercado extra', { minEvidencia: 2 }))
    assert.equal(sugerirCategoria(modeloDe(txs), 'mercado extra', { minEvidencia: 5 }), null)
  })

  test('confiancaCategoria cai quando o tipo é usado no débito e no crédito', () => {
    const txs = [
      ...varias(3, { categoria: 'saida', tipo: 'Mercado' }, 5),
      ...varias(3, { categoria: 'saida_credito', tipo: 'Mercado' }, 5),
    ]
    const r = sugerir(txs, 'mercado extra')
    assert.ok(r, 'o TIPO continua certo mesmo com a categoria rachada')
    assert.equal(r.tipo, 'Mercado')
    assert.ok(r.confianca >= 0.6, 'a confiança do tipo não pode ser punida pelo racha de categoria')
    assert.ok(r.confiancaCategoria <= 0.6, `categoria é o palpite fraco aqui: ${r.confiancaCategoria}`)
  })
})

describe('recência', () => {
  test('desempata: hábito atual vence hábito abandonado', () => {
    const txs = [
      ...varias(3, { tipo: 'Padaria', descricao: 'Pao Doce' }, 600), // ~2 anos atrás
      ...varias(3, { tipo: 'Mercado', descricao: 'Pao Doce' }, 5),   // agora
    ]
    const r = sugerir(txs, 'pao doce')
    assert.ok(r, 'com recência o empate deixa de ser empate')
    assert.equal(r.tipo, 'Mercado')
    assert.equal(r.baseadoEm, 3, 'só as recentes sustentam a sugestão')
  })

  test('o mesmo empate SEM diferença de idade continua null', () => {
    const txs = [
      ...varias(3, { tipo: 'Padaria', descricao: 'Pao Doce' }, 5),
      ...varias(3, { tipo: 'Mercado', descricao: 'Pao Doce' }, 5),
    ]
    assert.equal(sugerir(txs, 'pao doce'), null, 'prova que o desempate acima foi a recência')
  })

  test('histórico fora da janela (2+ anos) é esquecido', () => {
    assert.equal(sugerir(varias(5, {}, 900), 'mercado extra'), null)
  })

  test('lançamento futuro (agendado) não vale mais que hoje', () => {
    const futuro = varias(3, {}).map(t => ({ ...t, data: '30/12/2026' }))
    const r = sugerir(futuro, 'mercado extra')
    assert.ok(r && r.confianca <= 1, 'peso não pode estourar 1 e distorcer a pureza')
  })
})

describe('normalização de texto', () => {
  test('acento e maiúscula casam nos dois sentidos', () => {
    const comAcento = varias(3, { tipo: 'Farmácia', descricao: 'Farmácia São João' })
    assert.equal(sugerir(comAcento, 'FARMACIA SAO JOAO').tipo, 'Farmácia', 'busca sem acento acha histórico com acento')
    assert.equal(sugerir(comAcento, 'farmácia são joão').tipo, 'Farmácia')

    const semAcento = varias(3, { tipo: 'Farmácia', descricao: 'Farmacia Sao Joao' })
    assert.equal(sugerir(semAcento, 'Farmácia São João').tipo, 'Farmácia', 'e o contrário também')
  })

  test('pontuação e espaço extra não atrapalham', () => {
    const r = sugerir(varias(3, { descricao: 'Mercado Extra' }), '  ***MERCADO,,, EXTRA!!!  ')
    assert.equal(r.tipo, 'Mercado')
  })

  test('números não são aprendidos como palavra', () => {
    // "1234" é raro no histórico → se contasse, seria a "prova" mais forte da
    // sugestão. Comprar no Uber por R$25 e no mercado por R$25 não relaciona nada.
    const txs = varias(3, { tipo: 'Transporte', descricao: 'Uber 1234' })
    assert.equal(sugerir(txs, '1234'), null, 'número puro não casa com nada')
    assert.equal(sugerir(txs, 'uber 1234').tipo, 'Transporte', 'mas a palavra ainda casa')
  })

  test('descrição só de lixo (números e símbolos) → null, sem quebrar', () => {
    const txs = varias(5, {})
    for (const d of ['123 456', '!!! @#$ %', '... --- ...', '0', '99,90']) {
      assert.equal(sugerir(txs, d), null, `lixo ${JSON.stringify(d)}`)
    }
  })
})

describe('construirModelo — entrada defensiva', () => {
  test('não quebra com transações nulas, vazias ou malformadas', () => {
    const lixo = [null, undefined, {}, 42, 'texto', [], { categoria: 'saida' },
      { categoria: 'saida', tipo: 'X' }, { tipo: 'X', descricao: 'y', data: 'nada' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado', data: '32/13/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: null, data: diasAtras(1) }]
    assert.doesNotThrow(() => construirModelo(lixo, HOJE))
    assert.equal(sugerirCategoria(construirModelo(lixo, HOJE), 'mercado'), null)
  })

  test('lixo misturado com histórico bom não contamina o aprendizado', () => {
    const r = sugerir([null, {}, 'x', ...varias(3, {}), undefined], 'mercado extra')
    assert.equal(r.tipo, 'Mercado')
    assert.equal(r.baseadoEm, 3)
  })

  test('categoria inválida/legada é descartada', () => {
    assert.equal(sugerir(varias(5, { categoria: 'investimento' }), 'mercado extra'), null)
    assert.equal(sugerir(varias(5, { categoria: null }), 'mercado extra'), null)
  })

  test('tipo vazio ou só espaço é descartado', () => {
    assert.equal(sugerir(varias(5, { tipo: '   ' }), 'mercado extra'), null)
    assert.equal(sugerir(varias(5, { tipo: null }), 'mercado extra'), null)
  })

  test('gerados pelo app são ignorados — são replay de UMA decisão, não 12', () => {
    // Uma conta fixa de aluguel injeta 12 cópias/ano; se contassem, qualquer
    // sugestão viria "baseada em 12 vezes" a partir de um único clique do usuário.
    assert.equal(sugerir(varias(6, { contaFixaId: 'c1' }), 'mercado extra'), null)
    assert.equal(sugerir(varias(6, { faturaId: 'f1' }), 'mercado extra'), null)
    assert.equal(sugerir(varias(6, { compraId: 'p1' }), 'mercado extra'), null)
  })

  test('aceita data em ISO também', () => {
    const txs = varias(3, {}).map((t, i) => ({ ...t, data: `2026-07-${String(5 + i).padStart(2, '0')}` }))
    assert.equal(sugerir(txs, 'mercado extra').tipo, 'Mercado')
  })

  test('hoje default não quebra (sem injeção)', () => {
    assert.doesNotThrow(() => construirModelo(varias(3, {})))
    assert.doesNotThrow(() => construirModelo(varias(3, {}), 'não é uma data'))
  })

  test('teto de transações mantém as mais recentes', () => {
    const txs = [
      ...varias(3, { tipo: 'Padaria', descricao: 'Pao Doce' }, 300),
      ...varias(3, { tipo: 'Mercado', descricao: 'Pao Doce' }, 5),
    ]
    const m = construirModelo(txs, HOJE, { maxTransacoes: 3 })
    assert.equal(m.n, 3)
    assert.equal(sugerirCategoria(m, 'pao doce').tipo, 'Mercado')
  })

  test('modelo grande não degrada nem estoura tempo', () => {
    const muitas = Array.from({ length: 3000 }, (_, i) =>
      T({ tipo: i % 2 ? 'Mercado' : 'Transporte', descricao: i % 2 ? 'Mercado Extra' : 'Uber viagem', data: diasAtras(1 + (i % 400)) }))
    const t0 = Date.now()
    const m = construirModelo(muitas, HOJE)
    const r = sugerirCategoria(m, 'mercado extra')
    assert.ok(Date.now() - t0 < 1000, 'precisa ser rápido: roda a cada tecla no formulário')
    assert.equal(r.tipo, 'Mercado')
  })
})

describe('o mundo real não é limpo', () => {
  test('token genérico ("pagamento") não decide sozinho', () => {
    // "pagamento" aparece em tudo → IDF baixo → não pode arrastar a sugestão.
    const txs = [
      ...varias(5, { tipo: 'Transporte', descricao: 'Pagamento Uber' }, 5),
      ...varias(5, { tipo: 'Mercado', descricao: 'Pagamento Mercado Extra' }, 5),
      ...varias(5, { tipo: 'Farmácia', descricao: 'Pagamento Drogaria' }, 5),
    ]
    assert.equal(sugerir(txs, 'pagamento'), null, 'palavra vazia sozinha → não sei')
    assert.equal(sugerir(txs, 'pagamento uber').tipo, 'Transporte', 'mas o token que discrimina decide')
  })

  test('histórico rico: cada descrição vai para o seu tipo', () => {
    const txs = [
      ...varias(4, { tipo: 'Mercado', descricao: 'Mercado Extra' }, 3),
      ...varias(4, { tipo: 'Transporte', descricao: 'Uber viagem' }, 4),
      ...varias(4, { categoria: 'entrada', tipo: 'Salário', descricao: 'Salario ACME' }, 5),
      ...varias(4, { categoria: 'reserva', tipo: 'Emergência', descricao: 'Reserva emergencia' }, 6),
    ]
    const m = modeloDe(txs)
    assert.equal(sugerirCategoria(m, 'mercado extra').tipo, 'Mercado')
    assert.equal(sugerirCategoria(m, 'uber viagem').tipo, 'Transporte')

    const sal = sugerirCategoria(m, 'salario acme')
    assert.equal(sal.tipo, 'Salário')
    assert.equal(sal.categoria, 'entrada')

    const res = sugerirCategoria(m, 'reserva emergencia')
    assert.equal(res.tipo, 'Emergência')
    assert.equal(res.categoria, 'reserva')
  })

  test('o modelo não é mutado ao sugerir (reutilizável entre teclas)', () => {
    const m = modeloDe(varias(3, {}))
    const a = sugerirCategoria(m, 'mercado extra')
    const n = m.n
    sugerirCategoria(m, 'uber')
    sugerirCategoria(m, 'qualquer coisa')
    const b = sugerirCategoria(m, 'mercado extra')
    assert.equal(m.n, n)
    assert.deepEqual(a, b, 'mesma pergunta, mesma resposta')
  })
})

// Bug 2026-07-20: "quase todas as contas fixas viraram Mercado". O usuário tem um
// cartão "Mercado Pago", e as contas fixas se chamam "... pagamento mensal" — o
// token "pago/pagamento" ligava as duas coisas e decidia a votação.
describe('stopwords — palavras genéricas não podem decidir a categoria', () => {
  test('"pagamento" não liga conta fixa a "Mercado Pago"', () => {
    const historico = [
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado Pago pagamento', valor: 50, data: '01/07/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado Pago pagamento', valor: 60, data: '02/07/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Mercado Pago pagamento', valor: 70, data: '03/07/2026' },
    ]
    const modelo = construirModelo(historico, new Date('2026-07-20'))
    // "Condomínio pagamento mensal" só compartilha palavras GENÉRICAS com o
    // histórico — não pode virar Mercado.
    const s = sugerirCategoria(modelo, 'Condominio pagamento mensal')
    assert.equal(s, null, 'não deve sugerir nada com base só em "pagamento/mensal"')
  })

  test('palavra REAL continua funcionando (não quebrei o aprendizado)', () => {
    const historico = [
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Carrefour compra', valor: 50, data: '01/07/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Carrefour compra', valor: 60, data: '02/07/2026' },
      { categoria: 'saida', tipo: 'Mercado', descricao: 'Carrefour compra', valor: 70, data: '03/07/2026' },
    ]
    const modelo = construirModelo(historico, new Date('2026-07-20'))
    const s = sugerirCategoria(modelo, 'Carrefour')
    assert.ok(s && s.tipo === 'Mercado', 'token distintivo deve continuar sugerindo')
  })
})
