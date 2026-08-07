/**
 * diff-registros — 37.1a. O que separa "aqui está tudo" de "isto foi o que eu fiz".
 *
 * Um save que diz "adicionei a transação X" não fala nada sobre as outras, então
 * não pode apagá-las. É essa diferença que derruba o Lost Update.
 *
 * O teste mais importante deste arquivo não é nenhum dos casos felizes: é o
 * grupo "quando não dá para afirmar, RECUSA". Um diff que chuta apaga dinheiro
 * do usuário — recusar só custa cair no save de estado inteiro, que é o
 * comportamento de hoje.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { diffColecao, diffVazio, contarOperacoes, aplicarOperacoes, operacoesDe, comEndereco, diffCampos, aplicarCampos }
  from '../../src/scripts/modules/diff-registros.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const r = (id, over = {}) => ({ id, categoria: 'saida', valor: 10, descricao: 'x', ...over })
const ids = (lista) => lista.map((x) => x.id)
// O formato do fio é uma lista PLANA de operações — ver o cabeçalho do módulo
// (o teto de profundidade do proxy). Estes ajudantes leem uma fatia dela.
const add  = (d) => operacoesDe(d, 'add')
const edit = (d) => operacoesDe(d, 'edit')
const rm   = (d) => operacoesDe(d, 'rm').map((o) => o.id)
const idsAdd  = (d) => add(d).map((o) => o.r.id)
const idsEdit = (d) => edit(d).map((o) => o.r.id)

describe('o que mudou, e só o que mudou', () => {
  test('registro novo sai como add', () => {
    const d = diffColecao([r('a')], [r('a'), r('b')])
    assert.equal(d.ok, true)
    assert.deepEqual(idsAdd(d), ['b'])
    assert.deepEqual(edit(d), [])
    assert.deepEqual(rm(d), [])
  })

  test('registro alterado sai como edit, com o conteúdo novo inteiro', () => {
    const d = diffColecao([r('a', { valor: 10 })], [r('a', { valor: 99 })])
    assert.deepEqual(idsEdit(d), ['a'])
    assert.equal(edit(d)[0].r.valor, 99)
    assert.deepEqual(add(d), [])
  })

  test('registro que sumiu sai como remove — só o id', () => {
    const d = diffColecao([r('a'), r('b')], [r('a')])
    assert.deepEqual(rm(d), ['b'])
    assert.deepEqual(add(d), [])
  })

  test('nada mudou, nenhuma operação', () => {
    const d = diffColecao([r('a'), r('b')], [r('a'), r('b')])
    assert.ok(diffVazio(d))
    assert.equal(contarOperacoes(d), 0)
  })

  test('as três coisas ao mesmo tempo', () => {
    const d = diffColecao(
      [r('a'), r('b'), r('c')],
      [r('a'), r('c', { valor: 50 }), r('d')],
    )
    assert.deepEqual(idsAdd(d), ['d'])
    assert.deepEqual(idsEdit(d), ['c'])
    assert.deepEqual(rm(d), ['b'])
    assert.equal(contarOperacoes(d), 3)
  })

  test('coleção que nasceu do zero: tudo é add', () => {
    const d = diffColecao(undefined, [r('a')])
    assert.deepEqual(idsAdd(d), ['a'])
    assert.equal(add(d)[0].apos, null, 'o primeiro de todos não tem âncora')
  })

  test('coleção que não existe dos dois lados não gera nada', () => {
    assert.ok(diffVazio(diffColecao(undefined, undefined)))
    assert.ok(diffVazio(diffColecao(null, [])))
  })
})

describe('o que NÃO conta como mudança', () => {
  test('trocar a ordem das chaves não é edição', () => {
    // Caminhos de código diferentes criam o mesmo registro com as chaves em
    // ordens diferentes. Com `JSON.stringify` cru, todo save marcaria o registro
    // como editado — e um edit por save é um conflito por save quando o 37.3
    // chegar.
    const d = diffColecao(
      [{ id: 'a', valor: 10, descricao: 'x' }],
      [{ descricao: 'x', id: 'a', valor: 10 }],
    )
    assert.ok(diffVazio(d))
  })

  test('nem em objeto aninhado', () => {
    const d = diffColecao(
      [{ id: 'm', saved: 10, monthly: { '2026-07': 5, '2026-08': 3 } }],
      [{ id: 'm', monthly: { '2026-08': 3, '2026-07': 5 }, saved: 10 }],
    )
    assert.ok(diffVazio(d))
  })

  test('REORDENAR registros que já existiam não é mudança — limitação assumida', () => {
    // Diferente de inserir no meio (que o `apos` cobre): mover um registro que
    // já estava lá sai como "nada mudou". Nada no app reordena coleção hoje.
    const d = diffColecao([r('a'), r('b')], [r('b'), r('a')])
    assert.ok(diffVazio(d))
  })

  test('mas mudar o conteúdo de um aninhado É edição', () => {
    const d = diffColecao(
      [{ id: 'm', monthly: { '2026-08': 3 } }],
      [{ id: 'm', monthly: { '2026-08': 4 } }],
    )
    assert.deepEqual(idsEdit(d), ['m'])
  })

  test('id numérico e id string do mesmo valor são o mesmo registro', () => {
    // As metas antigas têm id inteiro; as novas, UUID. Tratar 1 e '1' como
    // registros diferentes geraria um remove + um add do mesmo dado.
    const d = diffColecao([{ id: 1, v: 'x' }], [{ id: '1', v: 'x' }])
    assert.ok(diffVazio(d), 'não pode virar remove+add')
  })
})

describe('quando não dá para afirmar, RECUSA', () => {
  test('registro sem id derruba o diff inteiro', () => {
    // Não é para "pular o registro sem id": pular significaria não mandar o
    // lançamento que o usuário acabou de fazer, e ele sumiria no reload.
    const d = diffColecao([r('a')], [r('a'), { valor: 5 }])
    assert.equal(d.ok, false)
    assert.equal(d.motivo, 'sem_id')
  })

  test('id vazio também', () => {
    assert.equal(diffColecao([], [{ id: '', v: 1 }]).motivo, 'sem_id')
  })

  test('dois registros com o mesmo id', () => {
    // Sem isto, o segundo sobrescreveria o primeiro no índice e o diff diria
    // "nada mudou" enquanto um registro inteiro desaparecia.
    const d = diffColecao([r('a')], [r('a'), r('a', { valor: 99 })])
    assert.equal(d.ok, false)
    assert.equal(d.motivo, 'id_duplicado')
  })

  test('duplicata no lado ANTIGO também recusa', () => {
    assert.equal(diffColecao([r('a'), r('a')], [r('a')]).motivo, 'id_duplicado')
  })

  test('o que não é lista recusa em vez de estourar', () => {
    assert.equal(diffColecao('x', []).motivo, 'nao_e_lista')
    assert.equal(diffColecao([], { a: 1 }).motivo, 'nao_e_lista')
  })

  test('entrada torta dentro da lista recusa', () => {
    assert.equal(diffColecao([], [null]).motivo, 'registro_invalido')
    assert.equal(diffColecao([], ['texto']).motivo, 'registro_invalido')
  })

  test('recusa não é diff vazio — o chamador precisa distinguir', () => {
    // Confundir os dois seria o pior desfecho possível: "não sei o que mudou"
    // tratado como "nada mudou" descartaria a edição do usuário em silêncio.
    const recusa = diffColecao([], [{ v: 1 }])
    assert.equal(diffVazio(recusa), false)
    assert.equal(contarOperacoes(recusa), 0)
  })
})

describe('posição: o add sabe onde entrar', () => {
  test('inserido no MEIO leva o vizinho de trás como âncora', () => {
    // O desfazer de uma exclusão reinsere no meio (`splice(pos, 0, t)`). Sem
    // âncora o servidor anexaria no fim e a transação apareceria no topo da
    // lista no próximo reload — a tela mostra o array ao contrário.
    const d = diffColecao([r('a'), r('c')], [r('a'), r('b'), r('c')])
    assert.deepEqual(idsAdd(d), ['b'])
    assert.equal(add(d)[0].apos, 'a')
  })

  test('inserido no começo tem âncora nula', () => {
    const d = diffColecao([r('b')], [r('a'), r('b')])
    assert.equal(add(d)[0].apos, null)
  })

  test('vários novos seguidos se ancoram em cadeia', () => {
    // Cada um aponta para o anterior, inclusive quando o anterior também é
    // novo — funciona porque as operações são aplicadas na ordem em que vêm.
    const d = diffColecao([r('a')], [r('a'), r('b'), r('c')])
    assert.deepEqual(add(d).map((o) => [o.apos, o.r.id]), [['a', 'b'], ['b', 'c']])
  })
})

describe('aplicar o diff reconstrói exatamente o estado — a prova da fase de sombra', () => {
  const casos = {
    'só adiciona':        [[r('a')], [r('a'), r('b')]],
    'adiciona no meio':   [[r('a'), r('c')], [r('a'), r('b'), r('c')]],
    'adiciona no começo': [[r('b')], [r('a'), r('b')]],
    'só edita':           [[r('a'), r('b')], [r('a', { valor: 1 }), r('b')]],
    'só remove':          [[r('a'), r('b'), r('c')], [r('a'), r('c')]],
    'remove o primeiro':  [[r('a'), r('b')], [r('b')]],
    'tudo junto':         [[r('a'), r('b'), r('c')], [r('a'), r('c', { valor: 9 }), r('d')]],
    'esvazia':            [[r('a'), r('b')], []],
    'nasce do zero':      [[], [r('a'), r('b')]],
    'nada muda':          [[r('a'), r('b')], [r('a'), r('b')]],
  }

  for (const [nome, [antes, depois]] of Object.entries(casos)) {
    test(nome, () => {
      const d = diffColecao(antes, depois)
      assert.equal(d.ok, true, nome)
      assert.deepEqual(aplicarOperacoes(antes, d), depois)
    })
  }

  test('aplicar não muta a lista original', () => {
    // O servidor vai aplicar sobre o blob decifrado; mutar a entrada faria a
    // guarda anti-wipe comparar o resultado consigo mesma e nunca disparar.
    const antes = [r('a'), r('b')]
    const copia = JSON.parse(JSON.stringify(antes))
    aplicarOperacoes(antes, diffColecao(antes, [r('a')]))
    assert.deepEqual(antes, copia)
  })

  test('âncora que sumiu no meio do caminho: anexa, nunca perde', () => {
    // Outro cliente removeu o vizinho entre o load e o save. Perder a posição
    // exata é aceitável; perder o registro não é.
    const d = diffColecao([r('a'), r('c')], [r('a'), r('b'), r('c')])
    const resultado = aplicarOperacoes([r('c')], d)   // 'a' não existe mais lá
    assert.deepEqual(ids(resultado), ['c', 'b'])
  })

  test('diff recusado não aplica nada — devolve a lista intacta', () => {
    const antes = [r('a')]
    assert.deepEqual(aplicarOperacoes(antes, diffColecao(antes, [{ v: 1 }])), antes)
  })

  test('reordenar registros existentes NÃO é reconstruído — e é para a sombra pegar', () => {
    // O único caso conhecido em que aplicar o diff não devolve o estado exato.
    // Está documentado no módulo, e é justamente o que a fase de sombra existe
    // para medir: se aparecer em produção, o `apos` precisa valer também para os
    // registros que já existiam, não só para os novos.
    const antes = [r('a'), r('b')]
    const depois = [r('b'), r('a')]
    const d = diffColecao(antes, depois)
    assert.ok(diffVazio(d))
    assert.notDeepEqual(aplicarOperacoes(antes, d), depois)
  })
})

describe('o formato cabe no que o proxy aceita — o motivo de a lista ser plana', () => {
  // Os tetos são lidos de api/user-data.js: se alguém apertá-los, este teste
  // aperta junto. Copiar os números aqui deixaria o teste passar enquanto a
  // produção rejeitava.
  const PROXY = readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8')
  const num = (nome) => Number(new RegExp(nome + String.raw`\s*=\s*([\d_]+)`).exec(PROXY)[1].replace(/_/g, ''))
  const MAX_DEPTH = num('MAX_JSON_DEPTH')
  const MAX_KEYS = num('MAX_KEYS_OBJ')

  // Mesmo algoritmo do proxy (`analyzeJson`): arrays não contam chaves.
  const medir = (root) => {
    if (root === null || typeof root !== 'object') return { depth: 0, keys: 0 }
    const pilha = [[root, 1]]
    let depth = 0, keys = 0
    while (pilha.length) {
      const [no, d] = pilha.pop()
      if (d > depth) depth = d
      if (!Array.isArray(no)) keys = Math.max(keys, Object.keys(no).length)
      for (const filho of (Array.isArray(no) ? no : Object.values(no))) {
        if (filho !== null && typeof filho === 'object') pilha.push([filho, d + 1])
      }
    }
    return { depth, keys }
  }

  // A coleção mais funda do app: contaFixa → compras → compra.
  const fatura = (id) => ({
    id, descricao: 'Fatura Nu', valor: 300, vencimento: '2026-09-10',
    pago: false, cartaoId: 'c1', tipoContaFixa: 'fatura_cartao',
    compras: [{ id: 'cp1', tipo: 'Mercado', descricao: 'x', valorParcela: 100, totalParcelas: 3 }],
  })

  test('save com fatura de cartão cabe no teto de profundidade', () => {
    // Este é o teste que justifica o formato. Agrupado por perfil e coleção
    // (`{p1: {contasFixas: {add: [{apos, registro}]}}}`) dava 9 níveis: TODO
    // save com fatura voltaria 400, em produção, para todos os usuários.
    const d = diffColecao([], [fatura('f1')])
    const payload = {
      version: '1.0',
      profiles: [{ id: 'p1', name: 'n', transacoes: [], contasFixas: [fatura('f1')] }],
      touched_profile_ids: ['p1'],
      profile_ops: comEndereco(d.ops, 'p1', 'contasFixas'),
      metadata: { lastSync: 'x', totalProfiles: 1 },
    }
    const { depth } = medir(payload)
    assert.ok(depth <= MAX_DEPTH, `profundidade ${depth} passa do teto ${MAX_DEPTH}`)
  })

  test('as operações não são mais fundas que o estado que elas descrevem', () => {
    // Enquanto valer, o `profile_ops` nunca é o motivo de um 400 — o próprio
    // `profiles`, que já viaja hoje, estoura antes.
    const d = diffColecao([], [fatura('f1')])
    const so_estado = medir({ profiles: [{ id: 'p1', contasFixas: [fatura('f1')] }] })
    const so_ops = medir({ profile_ops: comEndereco(d.ops, 'p1', 'contasFixas') })
    assert.ok(so_ops.depth <= so_estado.depth, `ops ${so_ops.depth} > estado ${so_estado.depth}`)
  })

  test('importar 100 transações de uma vez não estoura o teto de chaves', () => {
    // Um mapa de âncoras indexado por id teria 100 chaves e voltaria 400. Lista
    // não conta chaves — foi o segundo motivo de o formato ser plano.
    const cem = Array.from({ length: 100 }, (_, i) => r(`t${i}`))
    const d = diffColecao([], cem)
    assert.equal(contarOperacoes(d), 100)
    const { keys } = medir({ profile_ops: comEndereco(d.ops, 'p1', 'transacoes') })
    assert.ok(keys <= MAX_KEYS, `${keys} chaves passa do teto ${MAX_KEYS}`)
  })

  test('cada operação carrega o próprio endereço', () => {
    const d = diffColecao([r('a')], [r('a'), r('b')])
    const [op] = comEndereco(d.ops, 'p1', 'transacoes')
    assert.equal(op.p, 'p1')
    assert.equal(op.c, 'transacoes')
    assert.equal(op.op, 'add')
  })
})

describe('37.1d — campos do perfil, que não são lista nem têm id', () => {
  const perfil = (over = {}) => ({
    id: 'p1', name: 'Lucas', foto: null, balance: 0,
    config: { tema: 'escuro' }, orcamentos: { Mercado: { limite: 600 } },
    transacoes: [r('a')], ...over,
  })
  const COLS = ['transacoes', 'metas', 'cartoesCredito', 'contasFixas', 'assinaturas']
  const dcampos = (a, b) => diffCampos(a, b, COLS)

  test('renomear o perfil vira UM set — nada mais', () => {
    const d = dcampos(perfil(), perfil({ name: 'Lucas Oliveira' }))
    assert.deepEqual(d.ops, [{ op: 'set', k: 'name', v: 'Lucas Oliveira' }])
  })

  test('as coleções não entram (elas viajam por operação própria)', () => {
    const d = dcampos(perfil(), perfil({ transacoes: [r('a'), r('b')] }))
    assert.deepEqual(d.ops, [])
  })

  test('o `id` do perfil nunca vira set — ele é a chave', () => {
    const d = dcampos(perfil(), perfil({ id: 'outro' }))
    assert.deepEqual(d.ops, [])
  })

  test('campo APAGADO vira unset, não set com null', () => {
    // O app apaga campo de verdade: o allowlist do save descarta o que virou
    // `undefined`. Confundir "removido" com "vale null" gravaria null onde havia
    // ausência — e `'x' in obj` passaria a ser true onde era false.
    const antes = perfil({ viagem: { destino: 'Chile' } })
    const d = dcampos(antes, perfil())
    assert.deepEqual(d.ops, [{ op: 'unset', k: 'viagem' }])
  })

  test('campo NOVO vira set', () => {
    const d = dcampos(perfil(), perfil({ viagem: { destino: 'Chile' } }))
    assert.deepEqual(d.ops, [{ op: 'set', k: 'viagem', v: { destino: 'Chile' } }])
  })

  test('objeto aninhado vai inteiro no valor', () => {
    const d = dcampos(perfil(), perfil({ orcamentos: { Mercado: { limite: 800 } } }))
    assert.equal(d.ops.length, 1)
    assert.deepEqual(d.ops[0], { op: 'set', k: 'orcamentos', v: { Mercado: { limite: 800 } } })
  })

  test('reordenar chaves de um aninhado não é mudança', () => {
    const a = perfil({ orcamentos: { Mercado: { limite: 600 }, Lazer: { limite: 100 } } })
    const b = perfil({ orcamentos: { Lazer: { limite: 100 }, Mercado: { limite: 600 } } })
    assert.deepEqual(dcampos(a, b).ops, [])
  })

  test('dois campos diferentes = duas operações — é o ponto da granularidade', () => {
    // Mandar "o resto todo" num bloco só traria de volta o problema que este
    // passo existe para resolver: duas pessoas mexendo em campos DIFERENTES do
    // mesmo perfil voltariam a se atropelar.
    const d = dcampos(perfil(), perfil({ name: 'Novo', config: { tema: 'claro' } }))
    assert.deepEqual(d.ops.map((o) => o.k).sort(), ['config', 'name'])
  })

  test('aplicar reconstrói o perfil exatamente', () => {
    const casos = [
      [perfil(), perfil({ name: 'X' })],
      [perfil(), perfil({ viagem: { destino: 'Chile' } })],
      [perfil({ viagem: {} }), perfil()],
      [perfil(), perfil({ config: { tema: 'claro' }, balance: 10 })],
      [{ id: 'p1' }, perfil()],
      [perfil(), perfil()],
    ]
    for (const [antes, depois] of casos) {
      const semCols = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !COLS.includes(k)))
      const refeito = aplicarCampos(semCols(antes), dcampos(antes, depois))
      assert.deepEqual(refeito, semCols(depois))
    }
  })

  test('aplicar não muta o objeto original', () => {
    const antes = perfil()
    const copia = JSON.parse(JSON.stringify(antes))
    aplicarCampos(antes, dcampos(antes, perfil({ name: 'X' })))
    assert.deepEqual(antes, copia)
  })

  test('o que não é objeto recusa', () => {
    assert.equal(diffCampos(null, {}).motivo, 'nao_e_objeto')
    assert.equal(diffCampos({}, [1, 2]).motivo, 'nao_e_objeto')
  })

  test('operação de campo não leva `c` — ela é do perfil, não de coleção', () => {
    const d = dcampos(perfil(), perfil({ name: 'X' }))
    const [op] = comEndereco(d.ops, 'p1', null)
    assert.equal(op.p, 'p1')
    assert.ok(!('c' in op), 'mandar c:null convida quem aplica a tratar null como coleção')
  })

  test('os dois aplicadores não se atropelam na lista misturada', () => {
    // O fio carrega uma lista só, com operações de coleção E de campo. Cada
    // aplicador tem de ignorar o que não é dele.
    const mistura = [
      { p: 'p1', c: 'transacoes', op: 'add', apos: null, r: r('z') },
      { p: 'p1', op: 'set', k: 'name', v: 'Novo' },
    ]
    assert.deepEqual(ids(aplicarOperacoes([], mistura)), ['z'])
    assert.deepEqual(aplicarCampos({ name: 'Velho' }, mistura), { name: 'Novo' })
  })
})

describe('volume real', () => {
  test('mil registros, uma edição — o diff carrega uma operação', () => {
    // É o ponto do passo inteiro: hoje esse save empurra as mil transações e
    // sobrescreve o que outra aba lançou. Depois dele, empurra uma.
    const antes = Array.from({ length: 1000 }, (_, i) => r(`t${i}`))
    const depois = antes.map((x) => (x.id === 't500' ? { ...x, valor: 77 } : x))
    const d = diffColecao(antes, depois)
    assert.equal(contarOperacoes(d), 1)
    assert.deepEqual(idsEdit(d), ['t500'])
  })
})
