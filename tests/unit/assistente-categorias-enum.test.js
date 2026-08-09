/**
 * A TRAVA DAS DUAS LISTAS DE CATEGORIA.
 *
 * O DEFEITO QUE ISTO IMPEDE (medido em 2026-08-09, e era a causa nº 1 de
 * categoria errada): existiam DUAS listas de categorias que divergiam.
 *
 *   parser-local.js (a real, do app) ..... 23 nomes, com `Jogos`
 *   chat-parse/index.ts (a que a IA vê) .. 19 nomes, SEM `Jogos`
 *
 * "gastei 40 num jogo" voltava como **Lazer**. Não era o modelo errando: era o
 * prompt não oferecendo `Jogos`. Faltavam também Assinaturas, Cartão e Casa.
 *
 * A edge roda em Deno e não importa de `src/scripts` — são deploys separados,
 * então o espelho é inevitável. O que NÃO é inevitável é ele envelhecer calado.
 * Este teste lê os dois arquivos como TEXTO e reprova na divergência de um nome.
 *
 * ⚠️ Lê o FONTE de propósito. Importar a edge exigiria um runtime Deno no CI, e
 * o que interessa aqui é justamente o texto que vai para o modelo.
 *
 * node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TIPOS_SAIDA, TIPOS_ENTRADA } from '../../src/scripts/modules/assistant/parser-local.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EDGE = readFileSync(join(RAIZ, 'supabase/functions/chat-parse/index.ts'), 'utf8')

/** Extrai um array literal de strings declarado como `const NOME = [...]`. */
function listaDoFonte(src, nome) {
  const i = src.indexOf(`const ${nome} = [`)
  assert.ok(i >= 0, `a edge precisa declarar ${nome}`)
  const abre = src.indexOf('[', i)
  const fecha = src.indexOf(']', abre)
  assert.ok(fecha > abre, `${nome} sem fechamento`)
  return src.slice(abre + 1, fecha)
    .split(',')
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean)
}

describe('⭐ as categorias da IA são as MESMAS do app', () => {
  test('TIPOS_SAIDA idêntico — mesma ordem, mesmos nomes, mesmo acento', () => {
    assert.deepEqual(listaDoFonte(EDGE, 'TIPOS_SAIDA'), [...TIPOS_SAIDA])
  })

  test('TIPOS_ENTRADA idêntico', () => {
    assert.deepEqual(listaDoFonte(EDGE, 'TIPOS_ENTRADA'), [...TIPOS_ENTRADA])
  })

  test('⭐ `Jogos` está na lista que a IA recebe', () => {
    // O caso concreto do dono. Explícito para que a falha diga o que quebrou,
    // em vez de sair um diff de 23 nomes.
    assert.ok(listaDoFonte(EDGE, 'TIPOS_SAIDA').includes('Jogos'))
  })

  test('as quatro que faltavam estão lá', () => {
    const daIA = listaDoFonte(EDGE, 'TIPOS_SAIDA')
    for (const c of ['Jogos', 'Assinaturas', 'Cartão', 'Casa']) {
      assert.ok(daIA.includes(c), `${c} sumiu da lista da IA outra vez`)
    }
  })
})

describe('o schema TRAVA a categoria — a IA não pode inventar', () => {
  test('o campo `tipo` é enum, não string livre', () => {
    // Com string livre o modelo devolvia "Lazer" para jogo e ninguém barrava.
    // Com enum + strict:true ele só consegue emitir um nome da lista.
    assert.match(EDGE, /tipo:\s*\{\s*\n\s*anyOf:\s*\[\{\s*type:\s*'string',\s*enum:\s*\[\.\.\.TIPOS_SAIDA,\s*\.\.\.TIPOS_ENTRADA\]\s*\}/)
  })

  test('o schema segue strict — enum sem strict não é garantia', () => {
    assert.match(EDGE, /strict:\s*true/)
    assert.match(EDGE, /tool_choice:\s*\{\s*type:\s*'tool'/)
  })

  test('a instrução manda preferir a específica à genérica', () => {
    // Sem isto, ter `Jogos` E `Lazer` no enum não resolve: o modelo escolheria
    // qualquer uma das duas. A CONDIÇÃO é a preferência, não a lista.
    const bloco = EDGE.slice(EDGE.indexOf('tipo: {'), EDGE.indexOf('descricao: {'))
    assert.match(bloco, /específica/i)
    assert.match(bloco, /Jogos/)
    assert.match(bloco, /Outros.*último recurso/is)
  })

  test('a lista antiga, solta na descrição, não voltou', () => {
    // A descrição citava 19 nomes à mão. Se alguém reescrever assim, a
    // divergência volta a ser possível sem o teste das listas notar.
    const bloco = EDGE.slice(EDGE.indexOf('tipo: {'), EDGE.indexOf('descricao: {'))
    const nomesSoltos = ['Mercado, Farmácia', 'Shopee, Amazon', 'Ifood, Shopee']
    for (const n of nomesSoltos) {
      assert.ok(!bloco.includes(n), `lista escrita à mão de volta na descrição: "${n}"`)
    }
  })
})
