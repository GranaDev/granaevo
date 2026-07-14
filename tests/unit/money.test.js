/**
 * GranaEvo — Testes de lógica financeira (parser de valores do assistente)
 *
 * money.js decide o VALOR de uma transação a partir de texto livre em PT-BR.
 * Um bug aqui grava dinheiro errado no registro do usuário → cobertura crítica.
 *
 * Puro, sem rede, sem DOM. Roda no CI (idempotente):
 *   node --test tests/unit/
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseValorBR, parseAritmetica, parseParcelas, parseExtenso,
  parseMesNomeado, mesLabel, parseDataRelativa, parseDataFutura,
  formatBRL, yearMonthKey, brDateToObj,
} from '../../src/scripts/modules/assistant/money.js'

describe('parseValorBR — valor monetário de texto livre', () => {
  const casos = [
    ['40', 40],
    ['gastei 40 pila no mercado', 40],
    ['recebi 40 reais', 40],
    ['R$ 1.234,56', 1234.56],
    ['1234,56', 1234.56],
    ['1,5k', 1500],
    ['2k', 2000],
    ['2 mil', 2000],
    ['1.500', 1500],          // ponto como milhar (3 casas)
    ['1,5', 1.5],             // vírgula decimal
    ['1.234.567,89', 1234567.89],
    ['paguei 40 em 3x', 40],  // ignora "3x" (parcelas), pega o 40
  ]
  for (const [entrada, esperado] of casos) {
    test(`"${entrada}" → ${esperado}`, () => {
      assert.equal(parseValorBR(entrada), esperado)
    })
  }

  test('"comprei em 3x" (só parcelas, sem valor) → null', () => {
    assert.equal(parseValorBR('comprei em 3x'), null)
  })
  test('texto sem número → null', () => {
    assert.equal(parseValorBR('sem valor aqui'), null)
  })
  test('zero não conta como valor → null', () => {
    assert.equal(parseValorBR('0'), null)
  })
  test('entrada não-string → null', () => {
    assert.equal(parseValorBR(null), null)
    assert.equal(parseValorBR(undefined), null)
    assert.equal(parseValorBR(42), null)
  })
})

describe('parseAritmetica — quantidade × preço unitário', () => {
  test('"2 cafés de 8" → 16', () => assert.equal(parseAritmetica('2 cafés de 8'), 16))
  test('"3 pães a 2,50" → 7,5', () => assert.equal(parseAritmetica('3 pães a 2,50'), 7.5))
  test('"4 cervejas por 6" → 24', () => assert.equal(parseAritmetica('4 cervejas por 6'), 24))
  test('substantivo de moeda é rejeitado ("2 reais de 8") → null', () =>
    assert.equal(parseAritmetica('2 reais de 8'), null))
  test('quantidade 1 não dispara (exige 2..99) → null', () =>
    assert.equal(parseAritmetica('1 café de 8'), null))
  test('sem padrão → null', () => assert.equal(parseAritmetica('mercado 50'), null))
})

describe('parseParcelas — nº de parcelas', () => {
  test('"em 3x" → 3', () => assert.equal(parseParcelas('em 3x'), 3))
  test('"1x" → 1', () => assert.equal(parseParcelas('à vista 1x'), 1))
  test('"parcelado em 12x" → 12', () => assert.equal(parseParcelas('parcelado em 12x'), 12))
  test('acima de 420 → null', () => assert.equal(parseParcelas('500x'), null))
  test('sem parcelas → null', () => assert.equal(parseParcelas('sem parcelas'), null))
})

describe('parseExtenso — números por extenso', () => {
  test('"cinquenta reais" → 50', () => assert.equal(parseExtenso('cinquenta reais'), 50))
  test('"mil e duzentos" → 1200', () => assert.equal(parseExtenso('mil e duzentos'), 1200))
  test('"dois mil" → 2000', () => assert.equal(parseExtenso('dois mil'), 2000))
  test('"cem reais" → 100', () => assert.equal(parseExtenso('cem reais'), 100))
  test('"vinte" (dezena forte, sem moeda) → 20', () => assert.equal(parseExtenso('vinte'), 20))
  test('"cinco" (fraco, sem moeda) → null', () => assert.equal(parseExtenso('cinco'), null))
  test('"um real" (fraco, mas com moeda) → 1', () => assert.equal(parseExtenso('um real'), 1))
})

describe('formatBRL — formatação de moeda', () => {
  test('1234.56 formata com milhar e centavos', () => {
    const s = formatBRL(1234.56)
    assert.match(s.replace(/\s/g, ' '), /R\$/)
    assert.ok(s.includes('1.234,56'), `esperava "1.234,56" em "${s}"`)
  })
  test('0 → contém "0,00"', () => assert.ok(formatBRL(0).includes('0,00')))
  test('não-número → R$ 0,00', () => {
    assert.ok(formatBRL('abc').includes('0,00'))
    assert.ok(formatBRL(NaN).includes('0,00'))
  })
})

describe('yearMonthKey — chave ano-mês', () => {
  test('julho/2026 → "2026-07"', () =>
    assert.equal(yearMonthKey(new Date(2026, 6, 14)), '2026-07'))
  test('janeiro/2025 → "2025-01"', () =>
    assert.equal(yearMonthKey(new Date(2025, 0, 1)), '2025-01'))
})

describe('brDateToObj — "dd/mm/aaaa" → Date', () => {
  test('data válida', () => {
    const d = brDateToObj('14/07/2026')
    assert.equal(d.getFullYear(), 2026)
    assert.equal(d.getMonth(), 6) // julho = índice 6
    assert.equal(d.getDate(), 14)
  })
  test('formato incompleto → null', () => assert.equal(brDateToObj('1/2'), null))
  test('não-string → null', () => assert.equal(brDateToObj(null), null))
})

describe('mesLabel — rótulo de "YYYY-MM"', () => {
  test('ano passado inclui o ano', () => assert.equal(mesLabel('2020-05'), 'maio de 2020'))
  test('formato inválido → ""', () => assert.equal(mesLabel('x+bad'), ''))
  test('mês inválido → ""', () => assert.equal(mesLabel('2020-13'), ''))
})

describe('parseMesNomeado — mês nomeado → "YYYY-MM"', () => {
  test('"relatório de maio" → mês 05 (ano varia)', () =>
    assert.match(parseMesNomeado('relatório de maio'), /^\d{4}-05$/))
  test('"gastos de dezembro" → mês 12', () =>
    assert.match(parseMesNomeado('gastos de dezembro'), /^\d{4}-12$/))
  test('palavra sem mês ("mercado") → null', () =>
    assert.equal(parseMesNomeado('mercado'), null))
})

// ── Datas relativas: expected computado a partir de hoje (robusto a data) ──────
describe('parseDataFutura — datas futuras (YYYY-MM-DD)', () => {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const hoje = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
  const maisDias = (n) => { const d = hoje(); d.setDate(d.getDate() + n); return iso(d) }

  test('"hoje" → hoje', () => assert.equal(parseDataFutura('hoje'), iso(hoje())))
  test('"amanhã" → hoje+1', () => assert.equal(parseDataFutura('me lembra amanhã'), maisDias(1)))
  test('"depois de amanhã" → hoje+2', () => assert.equal(parseDataFutura('depois de amanhã'), maisDias(2)))
  test('"em 5 dias" → hoje+5', () => assert.equal(parseDataFutura('em 5 dias'), maisDias(5)))
  test('sem data → null', () => assert.equal(parseDataFutura('qualquer coisa'), null))
})

describe('parseDataRelativa — datas no passado (dd/mm/aaaa)', () => {
  const fmt = (d) => d.toLocaleDateString('pt-BR')
  const menosDias = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d) }

  test('"ontem" → hoje-1', () => assert.equal(parseDataRelativa('gastei ontem'), menosDias(1)))
  test('"anteontem" → hoje-2', () => assert.equal(parseDataRelativa('anteontem'), menosDias(2)))
  test('"semana passada" → hoje-7', () => assert.equal(parseDataRelativa('semana passada'), menosDias(7)))
  test('sem data → null', () => assert.equal(parseDataRelativa('mercado'), null))
})
