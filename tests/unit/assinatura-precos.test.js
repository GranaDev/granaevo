/**
 * GranaEvo — Testes do detector de aumento de preço em cobrança recorrente
 *
 * O valor da feature é o número ANUAL: "a Netflix subiu R$ 5" dá de ombros,
 * "+R$ 60,00/ano" faz cancelar. Mas acusar aumento que não houve queima a
 * confiança no app inteiro — então o detector é conservador de propósito:
 * precisa de um DEGRAU limpo (patamar antigo estável → patamar novo estável e
 * maior) num padrão realmente mensal.
 *
 * Regressão herdada do recorrencias.js (2026-07-14): o que o app GERA (conta
 * fixa, fatura, compra) é excluído por MARCADOR DE ORIGEM, nunca por t.tipo —
 * os tipos reais são 'Conta Fixa'/'Pagamento Cartão' e comparar com
 * 'Conta fixa'/'Cartão' já causou 2 bugs graves. Conta fixa que reajusta
 * (aluguel +10%) é exatamente o padrão procurado aqui: sem o marcador, vira
 * falso-positivo na hora.
 *
 * Puro, sem rede/DOM, `hoje` injetável. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectarAumentosAssinatura } from '../../src/scripts/modules/assinatura-precos.js'

const HOJE = new Date(2026, 6, 15) // 15/07/2026

// Cobrança manual base; sobrescreva o que o teste precisa.
const T = (over) => ({
  categoria: 'saida', tipo: 'Lazer', descricao: 'Netflix',
  valor: 39.90, data: '12/07/2026', ...over,
})

// Netflix: R$ 39,90 em abr/mai → R$ 44,90 em jun/jul (o caso do backlog).
const NETFLIX_SUBIU = [
  T({ valor: 39.90, data: '12/04/2026' }),
  T({ valor: 39.90, data: '12/05/2026' }),
  T({ valor: 44.90, data: '12/06/2026' }),
  T({ valor: 44.90, data: '12/07/2026' }),
]

describe('detectarAumentosAssinatura — o aumento real', () => {
  test('Netflix 39,90 → 44,90 é detectada com o impacto ANUAL correto', () => {
    const r = detectarAumentosAssinatura(NETFLIX_SUBIU, HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].nome, 'Netflix')
    assert.equal(r[0].valorAntigo, 39.90)
    assert.equal(r[0].valorNovo, 44.90)
    assert.equal(r[0].aumento, 5)
    assert.equal(r[0].aumentoPct, 12.5)
    assert.equal(r[0].impactoAnual, 60, 'o número que faz o usuário decidir')
  })

  test('"desde" aponta a 1ª cobrança no preço novo', () => {
    const r = detectarAumentosAssinatura(NETFLIX_SUBIU, HOJE)
    assert.equal(r[0].desde.getTime(), new Date(2026, 5, 12).getTime(), 'junho, não julho')
  })

  test('3 ocorrências bastam: 2 no preço antigo + 1 no novo', () => {
    const txs = [
      T({ valor: 39.90, data: '12/05/2026' }),
      T({ valor: 39.90, data: '12/06/2026' }),
      T({ valor: 44.90, data: '12/07/2026' }),
    ]
    const r = detectarAumentosAssinatura(txs, HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].impactoAnual, 60)
  })

  test('assinatura no crédito (saida_credito) também conta', () => {
    const txs = NETFLIX_SUBIU.map(t => ({ ...t, categoria: 'saida_credito' }))
    assert.equal(detectarAumentosAssinatura(txs, HOJE).length, 1)
  })

  test('aceita data em ISO também', () => {
    const txs = [
      T({ valor: 39.90, data: '2026-05-12' }),
      T({ valor: 39.90, data: '2026-06-12' }),
      T({ valor: 44.90, data: '2026-07-12' }),
    ]
    assert.equal(detectarAumentosAssinatura(txs, HOJE).length, 1)
  })

  test('pega a mudança MAIS RECENTE quando há dois degraus', () => {
    const txs = [
      T({ valor: 30, data: '12/03/2026' }),
      T({ valor: 35, data: '12/04/2026' }),
      T({ valor: 35, data: '12/05/2026' }),
      T({ valor: 44, data: '12/06/2026' }),
      T({ valor: 44, data: '12/07/2026' }),
    ]
    const r = detectarAumentosAssinatura(txs, HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].valorAntigo, 35, 'o preço de ontem, não o de 4 meses atrás')
    assert.equal(r[0].valorNovo, 44)
    assert.equal(r[0].impactoAnual, 108)
  })

  test('degrau grande seguido de reajuste de centavos ainda reporta o degrau', () => {
    // O split mais recente (44 → 44,20) é ruído; a busca não pode parar nele e
    // engolir o 30 → 44 que veio antes.
    const txs = [
      T({ valor: 30, data: '12/02/2026' }),
      T({ valor: 30, data: '12/03/2026' }),
      T({ valor: 44, data: '12/04/2026' }),
      T({ valor: 44, data: '12/05/2026' }),
      T({ valor: 44.20, data: '12/06/2026' }),
      T({ valor: 44.20, data: '12/07/2026' }),
    ]
    const r = detectarAumentosAssinatura(txs, HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].valorAntigo, 30)
    assert.equal(r[0].valorNovo, 44.10, 'média do patamar novo (44 e 44,20 são o mesmo preço)')
  })

  test('ordena por impacto anual (o mais caro primeiro) — Spotify na frente', () => {
    const txs = [
      ...NETFLIX_SUBIU, // +R$ 60/ano
      T({ descricao: 'Spotify', valor: 21.90, data: '05/05/2026' }),
      T({ descricao: 'Spotify', valor: 21.90, data: '05/06/2026' }),
      T({ descricao: 'Spotify', valor: 34.90, data: '05/07/2026' }), // +R$ 156/ano
    ]
    const r = detectarAumentosAssinatura(txs, HOJE)
    assert.equal(r.length, 2)
    assert.equal(r[0].nome, 'Spotify')
    assert.equal(r[0].impactoAnual, 156)
    assert.equal(r[1].nome, 'Netflix')
  })
})

describe('detectarAumentosAssinatura — o que o app GERA nunca é aumento', () => {
  // Aluguel reajustado é degrau mensal perfeito: sem a exclusão por marcador,
  // é falso-positivo garantido.
  const ALUGUEL = [
    { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1500, data: '10/04/2026' },
    { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1500, data: '10/05/2026' },
    { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1650, data: '10/06/2026' },
    { categoria: 'saida', tipo: 'Conta Fixa', contaFixaId: 'c1', descricao: 'Aluguel', valor: 1650, data: '10/07/2026' },
  ]

  test('conta fixa reajustada (aluguel) NÃO vira "assinatura que subiu"', () => {
    assert.deepEqual(detectarAumentosAssinatura(ALUGUEL, HOJE), [])
  })

  test('a exclusão é pelo MARCADOR, não pelo rótulo do tipo', () => {
    // tipo inesperado/renomeado — o contaFixaId ainda segura
    const txs = ALUGUEL.map(t => ({ ...t, tipo: 'Rótulo Novo' }))
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('pagamento de fatura crescente NÃO vira aumento de assinatura', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f1', descricao: 'Nubank', valor: 800, data: '10/04/2026' },
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f2', descricao: 'Nubank', valor: 800, data: '10/05/2026' },
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f3', descricao: 'Nubank', valor: 950, data: '10/06/2026' },
      { categoria: 'saida', tipo: 'Pagamento Cartão', faturaId: 'f4', descricao: 'Nubank', valor: 950, data: '10/07/2026' },
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('parcelas de compra (compraId) são ignoradas', () => {
    const txs = NETFLIX_SUBIU.map(t => ({ ...t, compraId: 'x1' }))
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })
})

describe('detectarAumentosAssinatura — critérios conservadores', () => {
  test('preço estável NÃO é aumento', () => {
    const txs = [
      T({ data: '12/04/2026' }), T({ data: '12/05/2026' }),
      T({ data: '12/06/2026' }), T({ data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('QUEDA de preço não é reportada como aumento', () => {
    const txs = [
      T({ valor: 44.90, data: '12/04/2026' }),
      T({ valor: 44.90, data: '12/05/2026' }),
      T({ valor: 39.90, data: '12/06/2026' }),
      T({ valor: 39.90, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('valores oscilantes (mercado) não viram aumento', () => {
    const txs = [
      T({ tipo: 'Mercado', descricao: 'Mercado', valor: 100, data: '12/04/2026' }),
      T({ tipo: 'Mercado', descricao: 'Mercado', valor: 400, data: '12/05/2026' }),
      T({ tipo: 'Mercado', descricao: 'Mercado', valor: 250, data: '12/06/2026' }),
      T({ tipo: 'Mercado', descricao: 'Mercado', valor: 380, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('conta que OSCILA entre dois valores não vira aumento', () => {
    // Armadilha do "preço antigo = corrida estável antes do degrau": as duas últimas
    // cobranças são as caras, mas 44,90 já tinha aparecido lá atrás — não subiu, varia.
    const txs = [
      T({ valor: 39.90, data: '12/02/2026' }),
      T({ valor: 44.90, data: '12/03/2026' }),
      T({ valor: 39.90, data: '12/04/2026' }),
      T({ valor: 39.90, data: '12/05/2026' }),
      T({ valor: 44.90, data: '12/06/2026' }),
      T({ valor: 44.90, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('subida gradual e ruidosa (100→120→140→160) não é degrau', () => {
    const txs = [
      T({ descricao: 'Uber', valor: 100, data: '12/04/2026' }),
      T({ descricao: 'Uber', valor: 120, data: '12/05/2026' }),
      T({ descricao: 'Uber', valor: 140, data: '12/06/2026' }),
      T({ descricao: 'Uber', valor: 160, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('aumento de centavos (39,90 → 40,20) é ruído, não notícia', () => {
    const txs = [
      T({ valor: 39.90, data: '12/04/2026' }),
      T({ valor: 39.90, data: '12/05/2026' }),
      T({ valor: 40.20, data: '12/06/2026' }),
      T({ valor: 40.20, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('20% de aumento em cima de R$ 0,50 não merece um card (regra do E)', () => {
    const txs = [
      T({ descricao: 'Taxa', valor: 0.50, data: '12/05/2026' }),
      T({ descricao: 'Taxa', valor: 0.50, data: '12/06/2026' }),
      T({ descricao: 'Taxa', valor: 0.60, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('cobrança inativa (>45 dias sem cobrar) não conta — já cancelou', () => {
    const txs = [
      T({ valor: 39.90, data: '01/02/2026' }),
      T({ valor: 39.90, data: '01/03/2026' }),
      T({ valor: 44.90, data: '31/03/2026' }),
      T({ valor: 44.90, data: '30/04/2026' }), // 76 dias antes de HOJE
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('padrão semanal não é assinatura mensal', () => {
    const txs = [
      T({ descricao: 'Feira', valor: 50, data: '05/06/2026' }),
      T({ descricao: 'Feira', valor: 50, data: '12/06/2026' }),
      T({ descricao: 'Feira', valor: 80, data: '19/06/2026' }),
      T({ descricao: 'Feira', valor: 80, data: '26/06/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('só 2 ocorrências (um preço, um preço maior) não bastam', () => {
    const txs = [
      T({ valor: 39.90, data: '12/06/2026' }),
      T({ valor: 44.90, data: '12/07/2026' }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('aumento de salário (entrada) não é aumento de assinatura', () => {
    const txs = [
      { categoria: 'entrada', tipo: 'Salário', descricao: 'Salario', valor: 3000, data: '05/05/2026' },
      { categoria: 'entrada', tipo: 'Salário', descricao: 'Salario', valor: 3000, data: '05/06/2026' },
      { categoria: 'entrada', tipo: 'Salário', descricao: 'Salario', valor: 3500, data: '05/07/2026' },
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })
})

describe('detectarAumentosAssinatura — entrada inválida não quebra', () => {
  test('vazio / null / undefined', () => {
    assert.deepEqual(detectarAumentosAssinatura([], HOJE), [])
    assert.deepEqual(detectarAumentosAssinatura(null, HOJE), [])
    assert.deepEqual(detectarAumentosAssinatura(undefined, HOJE), [])
  })

  test('funciona sem passar `hoje` (default new Date())', () => {
    assert.deepEqual(detectarAumentosAssinatura([]), [])
  })

  test('transações lixo (null, sem campos, data/valor inválidos) são puladas', () => {
    const txs = [
      null, undefined, {},
      T({ data: 'ontem' }),
      T({ data: '32/13/2026' }),
      T({ valor: NaN }),
      T({ valor: 'abc' }),
      T({ valor: -50 }),
      T({ descricao: '' }),
      T({ descricao: null }),
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [])
  })

  test('lixo misturado não impede a detecção do aumento real', () => {
    const r = detectarAumentosAssinatura([null, {}, T({ data: 'ontem' }), ...NETFLIX_SUBIU], HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].impactoAnual, 60)
  })

  test('opts.max limita a lista', () => {
    assert.deepEqual(detectarAumentosAssinatura(NETFLIX_SUBIU, HOJE, { max: 0 }), [])
  })
})

describe('dia do mês consistente — o pedágio não é assinatura', () => {
  test('PEDÁGIO reajustado (dias aleatórios) NÃO é anunciado como aumento de assinatura', () => {
    // Caso real relatado pelo usuário no detector irmão: pedágio tem valor fixo e cai
    // ~1x/mês, então "degrau de preço" também casaria. O que o denuncia é o dia.
    const txs = [
      { categoria: 'saida_credito', tipo: 'Transporte', descricao: 'Pedagio', valor: 12.80, data: '03/04/2026' },
      { categoria: 'saida_credito', tipo: 'Transporte', descricao: 'Pedagio', valor: 12.80, data: '30/04/2026' },
      { categoria: 'saida_credito', tipo: 'Transporte', descricao: 'Pedagio', valor: 15.60, data: '28/05/2026' },
      { categoria: 'saida_credito', tipo: 'Transporte', descricao: 'Pedagio', valor: 15.60, data: '26/06/2026' },
    ]
    assert.deepEqual(detectarAumentosAssinatura(txs, HOJE), [],
      'dias 3, 30, 28 e 26 → espalhamento > 3, não é cobrança de assinatura')
  })

  test('assinatura com deslocamento normal (±3) ainda detecta o aumento', () => {
    const txs = [
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Disney', valor: 33.90, data: '11/04/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Disney', valor: 33.90, data: '13/05/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Disney', valor: 43.90, data: '12/06/2026' },
      { categoria: 'saida', tipo: 'Lazer', descricao: 'Disney', valor: 43.90, data: '11/07/2026' },
    ]
    const r = detectarAumentosAssinatura(txs, HOJE)
    assert.equal(r.length, 1)
    assert.equal(r[0].impactoAnual, 120)
  })
})
