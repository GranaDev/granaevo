/**
 * 38.1 — a descrição tem de ser o que o USUÁRIO escreveu.
 *
 * MEDIDO PELO DONO EM PRODUÇÃO (2026-08-07), com estas frases:
 *   "Recebi um pix de 70 reais da Ke"  → descrição "Outros recebimentos"
 *   "e gastei ele no mercado"          → descrição "Ele no Mercado"
 *
 * A primeira é o rótulo da categoria no lugar do texto dele. A segunda é um
 * pronome solto virando descrição. No extrato do fim do mês, as duas são pior
 * que inúteis: a coluna que deveria dizer PARA ONDE FOI o dinheiro vira uma
 * fileira de rótulos repetidos e de "Ele".
 *
 * Este arquivo é o CORPUS (38.1a) — a régua. Sem ela, consertar descrição é
 * chute: cada ajuste conserta uma frase e quebra outra sem ninguém notar.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractDescricao } from '../../src/scripts/modules/assistant/describe.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const d = (t) => extractDescricao(t).descricao

describe('⭐ o corpus — a régua de 38.1', () => {
  // `null` = "não sobrou nada além de valor e verbo"; o chamador cai no rótulo
  // do tipo, que é o comportamento certo para "gastei 50".
  const CORPUS = {
    // ── Os dois casos relatados pelo dono ──────────────────────────────────
    'Recebi um pix de 70 reais da Ke':      'Pix da Ke',
    'e gastei ele no mercado':              'Mercado',

    // ── Pronomes soltos: ruído, nunca descrição ────────────────────────────
    'gastei ele no mercado':                'Mercado',
    'gastei 30 nisso':                      null,
    'paguei 80 nela':                       null,
    'usei isso pra pagar o boleto':         'Boleto',
    'gastei 25 naquilo':                    null,

    // ── O que o usuário escreveu, preservado ───────────────────────────────
    'comprei 120 de tenis nike':            'Tenis nike',
    'gastei 25 no ifood':                   'Ifood',
    'gastei 200 na farmacia':               'Farmacia',
    'recebi 200 do meu pai':                'Pai',
    'gastei 50 reais num paflon':           'Paflon',
    'gastei 40 no mercado com detergente':  'Detergente',
    'comprei um presente dela':             'Presente dela',
    // A loja fica DENTRO da descrição de propósito: "Fone de ouvido na amazon"
    // diz mais no extrato que "Fone de ouvido" sozinho.
    'fone de ouvido por 120 na amazon':     'Fone de ouvido na amazon',

    // ── Nada a dizer: o chamador usa o rótulo ──────────────────────────────
    'gastei 50':                            null,
    'recebi 3000':                          null,
    'guardei 200':                          null,
  }

  for (const [frase, esperado] of Object.entries(CORPUS)) {
    test(`"${frase}" → ${esperado === null ? '(rótulo)' : `"${esperado}"`}`, () => {
      assert.equal(d(frase), esperado)
    })
  }
})

describe('pronome é RUÍDO, não aparo de borda', () => {
  test('some também do MEIO da frase', () => {
    // "usei isso pra pagar o boleto" tem o pronome no meio; a limpeza de bordas
    // nunca o alcançaria, e o resultado era "Usei isso o boleto".
    assert.equal(d('usei isso pra pagar o boleto'), 'Boleto')
    assert.equal(d('paguei 40 nele no mercado'), 'Mercado')
  })

  test('mas "dele"/"dela" ficam — são descrição legítima', () => {
    // Conservador de propósito: "presente dela" diz algo; "nela" não.
    assert.equal(d('comprei um presente dela'), 'Presente dela')
    assert.equal(d('paguei a conta dele'), 'Conta dele')
  })

  test('não come palavra que só CONTÉM o pronome', () => {
    // A fronteira \b importa: sem ela, "elast" ou "isolamento" perderiam letras.
    assert.equal(d('comprei 30 de elastico'), 'Elastico')
    assert.equal(d('gastei 90 com isolamento'), 'Isolamento')
  })
})

describe('a IA não reescreve o que o usuário disse', () => {
  const ENGINE = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')

  test('⭐ a descrição das palavras do usuário vence a da IA', () => {
    // Mesma regra da direção do dinheiro, pelo mesmo motivo: a IA é palpite, e
    // aqui ela palpita PIOR que o texto original. Era ela que trocava
    // "Pix da Ke" por "Outros recebimentos".
    assert.match(ENGINE, /const doUsuario = extractDescricao\(text\)\.descricao/)
    assert.match(ENGINE, /descricao: doUsuario \|\| ai\.parse\?\.descricao \|\| local\.descricao/)
  })

  test('e quando não sobra nada do usuário, a IA segue decidindo', () => {
    // `extractDescricao` devolve null para "gastei 50" — aí o `||` passa a bola.
    assert.equal(d('gastei 50'), null)
  })

  test('a tentativa de reescrita é contada', () => {
    // Telemetria anônima: com que frequência a IA tentaria trocar o texto do
    // usuário. Se for alto, o prompt precisa mudar — não o código.
    assert.match(ENGINE, /bump\('ia_descricao_ignorada'\)/)
  })
})
