/**
 * GranaEvo — Contrato entre o schema da IA e o normalize do cliente
 *
 * POR QUE ESTE TESTE EXISTE: a Edge Function (chat-parse) declara o que a IA PODE
 * dizer; o normalize.js declara o que o cliente ACEITA ouvir. Quando as duas listas
 * divergem, nada quebra — nenhum erro, nenhum log. A IA simplesmente não consegue
 * emitir o valor certo, o normalize coage para o default ('gasto') e o usuário
 * recebe uma resposta correta para a pergunta errada.
 *
 * Isso já aconteceu de verdade duas vezes:
 *   1. `consulta_alvo` não existia no schema → TODA consulta corrigida por typo
 *      virava "quanto gastei".
 *   2. Os alvos novos (orcamento/assinaturas/narrativa/curiosidade/conquistas) e
 *      `trimestre` entraram no cliente e ninguém lembrou da Edge.
 *
 * Um remendo conserta a divergência de hoje. Este teste conserta a de amanhã:
 * ele lê os DOIS arquivos como texto e falha o build quando eles se separam.
 *
 * ATENÇÃO: mudar o schema da IA exige `supabase functions deploy chat-parse`.
 * Passar neste teste NÃO significa que a função em produção foi atualizada.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const edge = readFileSync(join(raiz, 'supabase/functions/chat-parse/index.ts'), 'utf8')
const norm = readFileSync(join(raiz, 'src/scripts/modules/assistant/normalize.js'), 'utf8')

// Lista literal ['a', 'b'] → ['a','b']
const parseLista = (s) => s.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)

// Primeiro `enum: [...]` depois de `<campo>: {` no schema da Edge.
function enumDaEdge(campo) {
  const i = edge.indexOf(`${campo}: {`)
  assert.ok(i >= 0, `campo "${campo}" não achado no schema da Edge`)
  const m = /enum:\s*\[([^\]]+)\]/.exec(edge.slice(i, i + 1200))
  assert.ok(m, `enum de "${campo}" não achado no schema da Edge`)
  return parseLista(m[1])
}

function listaDoCliente(re, nome) {
  const m = re.exec(norm)
  assert.ok(m, `${nome} não achado no normalize.js`)
  return parseLista(m[1])
}

describe('consulta_alvo: a IA consegue dizer tudo que o cliente entende', () => {
  test('as duas listas são idênticas', () => {
    const daIA = enumDaEdge('consulta_alvo')
    const doCliente = listaDoCliente(/consultaAlvo:\s*\[([^\]]+)\]\.includes/, 'whitelist de consultaAlvo')
    const faltaNaIA = doCliente.filter((x) => !daIA.includes(x))
    const sobraNaIA = daIA.filter((x) => !doCliente.includes(x))
    assert.deepEqual(faltaNaIA, [],
      `O cliente entende estes alvos mas a IA NÃO consegue emitir: ${faltaNaIA.join(', ')}. ` +
      `Adicione ao enum de consulta_alvo em chat-parse/index.ts e faça o deploy.`)
    assert.deepEqual(sobraNaIA, [],
      `A IA pode emitir estes alvos mas o cliente descarta (vira 'gasto' calado): ${sobraNaIA.join(', ')}.`)
  })
})

describe('periodo: a IA consegue dizer todas as janelas que o cliente aceita', () => {
  test('as duas listas são idênticas', () => {
    const daIA = enumDaEdge('periodo')
    const doCliente = listaDoCliente(/const PERIODOS_FIXOS = \[([^\]]+)\]/, 'PERIODOS_FIXOS')
    assert.deepEqual(daIA.slice().sort(), doCliente.slice().sort(),
      `Divergência de período entre a Edge e o normalize.js. ` +
      `Só na IA: [${daIA.filter((x) => !doCliente.includes(x))}] · ` +
      `Só no cliente: [${doCliente.filter((x) => !daIA.includes(x))}]`)
  })
})

describe('categoria: a IA só emite categorias que o cliente sabe gravar', () => {
  test('o enum da IA cabe dentro das categorias válidas do cliente', () => {
    const daIA = enumDaEdge('categoria')
    const doCliente = listaDoCliente(/const CATS_VALIDAS = \[([^\]]+)\]/, 'CATS_VALIDAS')
    const orfas = daIA.filter((x) => !doCliente.includes(x))
    assert.deepEqual(orfas, [], `A IA pode emitir categorias que o cliente joga fora: ${orfas.join(', ')}`)
  })
})

describe('strict tool use: required precisa listar TODA propriedade', () => {
  test('nenhuma propriedade fica de fora do required', () => {
    // A API da Anthropic exige, com strict:true + additionalProperties:false, que
    // `required` contenha todas as chaves de `properties`. Uma propriedade nova
    // esquecida no required faz a chamada inteira falhar em runtime (502 pro
    // usuário) — e isso só apareceria em produção, nunca aqui.
    const bloco = edge.slice(edge.indexOf('properties: {'), edge.indexOf('required: ['))
    const props = [...bloco.matchAll(/^      ([a-z_]+): \{$/gm)].map((m) => m[1])
    assert.ok(props.length >= 10, `esperava achar as propriedades do schema, achei ${props.length}`)

    const mReq = /required:\s*\[([\s\S]*?)\]/.exec(edge)
    const required = parseLista(mReq[1])
    const faltando = props.filter((p) => !required.includes(p))
    assert.deepEqual(faltando, [],
      `Propriedades fora do required (a chamada à IA falha com strict:true): ${faltando.join(', ')}`)
  })
})

describe('a regra de ouro continua no schema', () => {
  test('a saída da IA é forçada a virar tool_use — nunca texto livre', () => {
    assert.match(edge, /tool_choice:\s*\{\s*type:\s*'tool'/,
      'tool_choice forçado sumiu: a IA poderia responder com texto livre.')
    assert.match(edge, /strict:\s*true/, 'strict:true sumiu do tool.')
    assert.match(edge, /additionalProperties:\s*false/, 'additionalProperties:false sumiu do schema.')
  })

  test('a resposta devolve só o parse, nunca o texto do modelo', () => {
    assert.match(edge, /ok:\s*true,\s*parse:\s*toolUse\.input/,
      'a Edge deve devolver apenas toolUse.input — nenhum texto do modelo pode chegar ao cliente.')
  })
})
