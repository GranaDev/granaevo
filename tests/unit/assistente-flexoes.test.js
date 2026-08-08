/**
 * A armadilha do `\b` no fim de radical — a que já mordeu QUATRO vezes.
 *
 * O padrão é sempre o mesmo: alguém escreve `/\bgasto\b/` achando que cobre
 * "gasto", e o português flexiona. `\b` é fronteira entre caractere de palavra e
 * não-palavra — em "gastos", depois do `o` vem `s`, que é caractere de palavra.
 * Não há fronteira ali. A regex simplesmente não casa, e o app deixa de
 * reconhecer a frase SEM ERRO NENHUM.
 *
 * O histórico deste projeto, todos com o mesmo diagnóstico:
 *   · `gasto`     não casava "gastos"     → a saída não era reconhecida
 *   · `deposit`   não casava "depósito"   → a reserva não era reconhecida
 *   · `parcelad`  não casava "parcelado"  → a compra sumia da fatura do cartão
 *   · `esque[cç]a` não casava "esquece"   → o lembrete virava lançamento
 *
 * O roadmap (C-9) pediu, com estas palavras: *"o conserto certo é um teste de
 * flexões sobre cada radical — senão a 5ª vem"*. É este arquivo.
 *
 * Ele não testa a regex: testa a FRASE. Se um dia alguém reescrever o parser
 * inteiro, o teste continua valendo.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseLocal } from '../../src/scripts/modules/assistant/parser-local.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const p = (t) => parseLocal(t, { tipos: [] })

describe('⭐ as quatro flexões que já quebraram — e as vizinhas delas', () => {
  const CASOS = {
    // gasto / gastos — a 1ª
    'gastei 50 no mercado':            (r) => r.categoria === 'saida',
    '75,69 gastos na shopee':          (r) => r.categoria === 'saida',
    'meus gastos de hoje':             (r) => r.intencao === 'consultar',

    // deposit / depósito — a 2ª
    'depositei 200 na reserva':        (r) => r.categoria === 'reserva',
    'deposito de 200 na reserva':      (r) => r.categoria === 'reserva',

    // parcelad / parcelado — a 3ª
    'comprei 900 parcelado em 3x':     (r) => r.categoria === 'saida_credito',
    'comprei uma tv de 2000 parcelada em 10x': (r) => r.categoria === 'saida_credito',
    'geladeira 3000 parcelados em 12x': (r) => r.categoria === 'saida_credito',

    // esquec / esqueça / esquece — a 4ª
    'nao me deixa esquecer do dentista': (r) => r.intencao === 'lembrete',
    'nao esquece de pagar o iptu':       (r) => r.intencao === 'lembrete',
    'nao esqueça de pagar a luz':        (r) => r.intencao === 'lembrete',
  }

  for (const [frase, ok] of Object.entries(CASOS)) {
    test(`"${frase}"`, () => {
      const r = p(frase)
      assert.ok(ok(r), `caiu em intencao=${r.intencao} categoria=${r.categoria}`)
    })
  }
})

describe('a regra, escrita como teste sobre o FONTE', () => {
  const soCodigo = (t) => t.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
  const PARSER = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/assistant/parser-local.js'), 'utf8'))

  // Radicais que SEMPRE flexionam em português. Se um deles aparecer colado a
  // `\b` numa regex, a flexão não casa — e o app fica mudo, sem erro.
  const RADICAIS = ['gast', 'deposit', 'parcelad', 'esquec', 'comprad', 'pagament', 'lancament']

  test('⭐ nenhum radical que flexiona está colado a `\\b`', () => {
    const culpados = []
    for (const r of RADICAIS) {
      // `radical` seguido direto de `\b` dentro de uma regex.
      const re = new RegExp(`${r}\\\\b`, 'g')
      if (re.test(PARSER)) culpados.push(r)
    }
    assert.deepEqual(culpados, [],
      `radical(is) com \\b no fim: ${culpados.join(', ')} — a flexão não vai casar`)
  })

  test('e os comentários que explicam isso continuam lá', () => {
    // Não é enfeite: a explicação é o que impede a 5ª. Quem editar a regex
    // precisa esbarrar no motivo antes de "simplificar".
    const cru = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/parser-local.js'), 'utf8')
    assert.match(cru, /fronteira/i)
    assert.match(cru, /flexiona/i)
  })
})

describe('e o oposto: sem `\\b`, não pode comer palavra que só CONTÉM o radical', () => {
  test('"gasto" não transforma "gastronomia" em lançamento', () => {
    const r = p('anotei a aula de gastronomia')
    assert.notEqual(r.intencao, 'lancar')
  })

  test('"esquec" não pega "esquema"', () => {
    const r = p('qual o esquema do mes')
    assert.notEqual(r.intencao, 'lembrete')
  })
})
