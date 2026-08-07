/**
 * GranaEvo — Testes da máscara monetária (modules/mascara-moeda.js)
 *
 * POR QUE ESTE ARQUIVO EXISTE:
 * A máscara faz o campo mostrar "1.234,56". Quem lê esse campo com parseFloat
 * recebe **1.234** — mil reais viram um e vinte e três, e o número errado vai
 * para o registro do usuário. `lerMoeda` é a defesa contra isso e precisa de
 * cobertura: é a função por onde passa TODO valor digitado no app.
 *
 * Puro, sem rede. A parte de DOM (`aplicarMascaraMoeda`) usa um fake mínimo de
 * input — só o que a máscara toca: value, dataset, selectionStart.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatarMoeda, valorDeMoeda, lerMoeda, definirMoeda, aplicarMascaraMoeda,
} from '../../src/scripts/modules/mascara-moeda.js'

describe('formatarMoeda — o que o usuário vê enquanto digita', () => {
  const casos = [
    ['', ''],
    ['1', '0,01'],
    ['10', '0,10'],
    ['100', '1,00'],          // o caso do pedido: digitou 100 → 1,00 e segue
    ['10000', '100,00'],
    ['123456', '1.234,56'],
    ['99999999999', '999.999.999,99'],
  ]
  for (const [entrada, esperado] of casos) {
    test(`"${entrada}" → "${esperado}"`, () => {
      assert.equal(formatarMoeda(entrada), esperado)
    })
  }

  test('ignora tudo que não é dígito (letra, R$, ponto, vírgula solta)', () => {
    assert.equal(formatarMoeda('R$ 1a2b3,4c5,6'), '1.234,56')
  })

  test('zeros à esquerda não consomem o teto de dígitos', () => {
    assert.equal(formatarMoeda('000000000000000123456'), '1.234,56')
  })

  test('passou do teto → o excesso simplesmente não entra (para de aceitar dígito)', () => {
    // 11 primeiros dígitos de "123456789012345" = "12345678901"
    assert.equal(formatarMoeda('123456789012345'), '123.456.789,01')
  })

  test('teto por campo (maxDigitos) é respeitado', () => {
    assert.equal(formatarMoeda('123456789', 5), '123,45')
  })
})

describe('valorDeMoeda — o número por trás do texto mascarado', () => {
  const casos = [
    ['1.234,56', 1234.56],
    ['0,01', 0.01],
    ['1,00', 1],
    ['999.999.999,99', 999999999.99],
  ]
  for (const [entrada, esperado] of casos) {
    test(`"${entrada}" → ${esperado}`, () => {
      assert.equal(valorDeMoeda(entrada), esperado)
    })
  }

  test('campo vazio → NaN (mesmo contrato do parseFloat("") de antes)', () => {
    assert.ok(Number.isNaN(valorDeMoeda('')))
  })

  test('REGRESSÃO: parseFloat leria "1.234,56" como 1.234 — valorDeMoeda não', () => {
    assert.equal(parseFloat('1.234,56'), 1.234)     // o bug que a função evita
    assert.equal(valorDeMoeda('1.234,56'), 1234.56)
  })
})

// ── Fake mínimo de <input> — só o que a máscara encosta ────────────────────
function inputFake(valor = '', comMascara = true) {
  return {
    value: valor,
    dataset: comMascara ? { moeda: '1', moedaMax: '11' } : {},
  }
}

describe('lerMoeda — leitura segura em campo com e sem máscara', () => {
  test('campo mascarado: decodifica a máscara', () => {
    assert.equal(lerMoeda(inputFake('1.234,56')), 1234.56)
  })

  test('campo AINDA sem máscara: cai no parseFloat de sempre', () => {
    assert.equal(lerMoeda(inputFake('1234.56', false)), 1234.56)
  })

  test('campo mascarado vazio → NaN (as validações existentes continuam pegando)', () => {
    assert.ok(Number.isNaN(lerMoeda(inputFake(''))))
  })

  test('elemento inexistente → NaN, sem lançar', () => {
    assert.ok(Number.isNaN(lerMoeda(null)))
  })
})

describe('definirMoeda — pré-preenchimento dos formulários de edição', () => {
  test('número vira texto mascarado', () => {
    const el = inputFake()
    definirMoeda(el, 1234.56)
    assert.equal(el.value, '1.234,56')
  })

  test('zero é valor legítimo (ajuste de reserva) → "0,00", não vazio', () => {
    const el = inputFake()
    definirMoeda(el, 0)
    assert.equal(el.value, '0,00')
  })

  test('vazio/null/NaN limpam o campo', () => {
    for (const v of ['', null, undefined, NaN]) {
      const el = inputFake('9,99')
      definirMoeda(el, v)
      assert.equal(el.value, '', `valor ${String(v)} deveria limpar`)
    }
  })

  test('sem erro de ponto flutuante no arredondamento dos centavos', () => {
    const el = inputFake()
    definirMoeda(el, 1919.19)      // 1919.19*100 = 191918.99999 em float
    assert.equal(el.value, '1.919,19')
  })

  test('ida e volta preserva o valor (definir → ler)', () => {
    for (const n of [0.01, 1, 99.9, 1234.56, 999999.99]) {
      const el = inputFake()
      definirMoeda(el, n)
      assert.equal(lerMoeda(el), n, `falhou em ${n}`)
    }
  })
})

// ── Digitação de verdade ───────────────────────────────────────────────────
// Fake de <input> completo o bastante para rodar os listeners REAIS da máscara.
// Um browser move o cursor para o fim ao atribuir .value; aqui o cursor é
// explícito, então este fake é MAIS severo que o navegador.
function inputVivo() {
  const ouvintes = {}
  const el = {
    value: '', type: 'number', inputMode: '', autocomplete: '',
    dataset: {}, selectionStart: 0, selectionEnd: 0,
    removeAttribute() {},
    addEventListener(ev, fn) { (ouvintes[ev] ||= []).push(fn) },
    setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b },
    select() { el.selectionStart = 0; el.selectionEnd = el.value.length },
  }
  el.digitar = (tecla) => {
    const p = el.selectionStart
    el.value = el.value.slice(0, p) + tecla + el.value.slice(el.selectionEnd)
    el.selectionStart = el.selectionEnd = p + tecla.length
    ;(ouvintes.input || []).forEach(fn => fn({ target: el }))
    return el
  }
  el.backspace = () => {
    const p = el.selectionStart
    if (p > 0) {
      el.value = el.value.slice(0, p - 1) + el.value.slice(el.selectionEnd)
      el.selectionStart = el.selectionEnd = p - 1
      ;(ouvintes.input || []).forEach(fn => fn({ target: el }))
    }
    return el
  }
  return el
}

function digitarTudo(teclas) {
  const el = inputVivo()
  aplicarMascaraMoeda(el)
  const passos = []
  for (const t of teclas) { el.digitar(t); passos.push(el.value) }
  return { el, passos }
}

describe('aplicarMascaraMoeda — o que acontece ao digitar', () => {
  test('REGRESSÃO: digitar 1,0,0 anda "0,01"→"0,10"→"1,00" (já travou em "0,01")', () => {
    // O bug: reposicionar o cursor contando dígitos da ESQUERDA o deixava no
    // meio (a máscara cria um "0" que ninguém digitou), e os dígitos seguintes
    // entravam no lugar errado — o campo congelava em "0,01".
    const { passos, el } = digitarTudo(['1', '0', '0'])
    assert.deepEqual(passos, ['0,01', '0,10', '1,00'])
    assert.equal(lerMoeda(el), 1)
  })

  test('o cursor termina no fim — senão o próximo dígito entra torto', () => {
    const { el } = digitarTudo(['1', '0', '0'])
    assert.equal(el.selectionStart, el.value.length)
  })

  test('digitação longa preenche da direita para a esquerda', () => {
    const { passos, el } = digitarTudo([...'1234567'])
    assert.deepEqual(passos, ['0,01', '0,12', '1,23', '12,34', '123,45', '1.234,56', '12.345,67'])
    assert.equal(lerMoeda(el), 12345.67)
  })

  test('backspace desfaz dígito a dígito, sem estado inválido', () => {
    const { el } = digitarTudo(['1', '0', '0'])          // "1,00"
    assert.equal(el.backspace().value, '0,10')
    assert.equal(el.backspace().value, '0,01')
    assert.equal(el.backspace().value, '0,00')
  })

  test('letra, ponto e vírgula digitados são ignorados', () => {
    const { passos } = digitarTudo(['5', 'a', ',', '.', '0'])
    assert.deepEqual(passos, ['0,05', '0,05', '0,05', '0,05', '0,50'])
  })

  test('colar "R$ 1.234,56" resolve numa tacada', () => {
    const { el } = digitarTudo(['R$ 1.234,56'])
    assert.equal(el.value, '1.234,56')
    assert.equal(lerMoeda(el), 1234.56)
  })

  test('converte type=number em text e marca o campo como mascarado', () => {
    const el = inputVivo()
    aplicarMascaraMoeda(el)
    assert.equal(el.type, 'text')
    assert.equal(el.inputMode, 'decimal')
    assert.equal(el.dataset.moeda, '1')
  })

  test('é idempotente — aplicar duas vezes não duplica a formatação', () => {
    const el = inputVivo()
    aplicarMascaraMoeda(el)
    aplicarMascaraMoeda(el)
    el.digitar('1'); el.digitar('0'); el.digitar('0')
    assert.equal(el.value, '1,00')
  })

  test('campo já preenchido ("1234.56") é mascarado ao ligar a máscara', () => {
    const el = inputVivo()
    el.value = '1234.56'
    aplicarMascaraMoeda(el)
    assert.equal(el.value, '1.234,56')
    assert.equal(lerMoeda(el), 1234.56)
  })
})
