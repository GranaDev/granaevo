/**
 * 37.2 — o servidor aplicando O QUE MUDOU, em vez de substituir tudo.
 *
 * É aqui que o Lost Update morre. Hoje o cliente diz "estas são todas as minhas
 * transações" e o servidor grava por cima — apagando o que a outra aba lançou
 * nos últimos segundos. Com operações, o que o cliente não mencionou não é
 * tocado.
 *
 * Testa a função DE VERDADE (transpilando o .ts com esbuild), como
 * merge-profiles.test.js: é a lógica que decide o destino de todo o dado
 * financeiro do app, e teste que só lê strings não provaria nada.
 *
 * Roda no CI: node --test tests/unit/
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

import { diffColecao, diffCampos, comEndereco } from '../../src/scripts/modules/diff-registros.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let validarOperacoes, aplicarOperacoes, MAX_OPS
before(async () => {
  const ts = readFileSync(join(RAIZ, 'supabase/functions/_shared/aplicar-operacoes.ts'), 'utf8')
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
  const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  validarOperacoes = mod.validarOperacoes
  aplicarOperacoes = mod.aplicarOperacoes
  MAX_OPS = mod.MAX_OPS
})

const tx = (id, over = {}) => ({ id, categoria: 'saida', tipo: 'Mercado', descricao: 'Feira', valor: 50, ...over })
const perfil = (over = {}) => ({ id: 'p1', nome: 'Lucas', transacoes: [], ...over })
const ids = (lista) => lista.map((x) => x.id)
const txs = (r, i = 0) => r.valor.profiles[i].transacoes

const aplicar = (perfis, ops, agora) => {
  const v = validarOperacoes(ops)
  assert.equal(v.ok, true, `validação recusou: ${v.erro}`)
  return aplicarOperacoes(perfis, v.valor, agora)
}

describe('aplica o que mudou, e não toca no resto', () => {
  test('add entra sem mexer no que já estava', () => {
    const r = aplicar([perfil({ transacoes: [tx('a')] })],
      [{ p: 'p1', c: 'transacoes', op: 'add', apos: 'a', r: tx('b') }])
    assert.deepEqual(ids(txs(r)), ['a', 'b'])
  })

  test('edit troca só o registro apontado', () => {
    const r = aplicar([perfil({ transacoes: [tx('a'), tx('b')] })],
      [{ p: 'p1', c: 'transacoes', op: 'edit', id: 'a', r: tx('a', { valor: 999 }) }])
    assert.equal(txs(r)[0].valor, 999)
    assert.equal(txs(r)[1].valor, 50)
  })

  test('rm tira só o apontado', () => {
    const r = aplicar([perfil({ transacoes: [tx('a'), tx('b')] })],
      [{ p: 'p1', c: 'transacoes', op: 'rm', id: 'a' }])
    assert.deepEqual(ids(txs(r)), ['b'])
  })

  test('set e unset mexem no campo do perfil', () => {
    const r = aplicar([perfil({ nome: 'Lucas', viagem: { destino: 'Chile' } })], [
      { p: 'p1', op: 'set', k: 'nome', v: 'Lucas O.' },
      { p: 'p1', op: 'unset', k: 'viagem' },
    ])
    assert.equal(r.valor.profiles[0].nome, 'Lucas O.')
    assert.ok(!('viagem' in r.valor.profiles[0]))
  })

  test('⭐ o perfil do OUTRO membro fica intocado — é o passo inteiro', () => {
    // O cenário que o dono reproduziu: dois editando ao mesmo tempo. Com estado
    // inteiro, o save de um apaga o do outro. Com operações, nem encosta.
    const guardados = [
      perfil({ id: 'p1', transacoes: [tx('a')] }),
      perfil({ id: 'p2', nome: 'Ke', transacoes: [tx('z')] }),
    ]
    const r = aplicar(guardados, [{ p: 'p1', c: 'transacoes', op: 'add', apos: 'a', r: tx('b') }])
    assert.deepEqual(ids(txs(r, 0)), ['a', 'b'])
    assert.deepEqual(ids(txs(r, 1)), ['z'], 'o perfil do outro membro foi mexido')
  })

  test('⭐ e a transação que a OUTRA ABA lançou no mesmo perfil sobrevive', () => {
    // A aba A lançou 'nova' e salvou. A aba B, que não sabe disso, lança 'outra'.
    // Com estado inteiro, B apagaria 'nova'. Com operações, B só fala de 'outra'.
    const jaNoBanco = [perfil({ transacoes: [tx('a'), tx('nova')] })]
    const r = aplicar(jaNoBanco, [{ p: 'p1', c: 'transacoes', op: 'add', apos: 'a', r: tx('outra') }])
    assert.deepEqual(ids(txs(r)), ['a', 'outra', 'nova'])
  })

  test('não muta os perfis recebidos', () => {
    // Mutar a referência do chamador faria a guarda anti-wipe comparar o
    // resultado consigo mesma e nunca disparar.
    const guardados = [perfil({ transacoes: [tx('a')] })]
    const copia = JSON.parse(JSON.stringify(guardados))
    aplicar(guardados, [{ p: 'p1', c: 'transacoes', op: 'rm', id: 'a' }])
    assert.deepEqual(guardados, copia)
  })
})

describe('37.2b — idempotência por construção, sem livro-caixa', () => {
  // O plano era guardar os últimos N ids aplicados. Não precisa: toda operação
  // já é idempotente, e isso é mais forte — não expira, não ocupa espaço e não
  // dessincroniza.
  const repetir = (perfis, ops) => {
    const uma = aplicar(perfis, ops)
    const duas = aplicar(uma.valor.profiles, ops)
    return { uma, duas }
  }

  test('⭐ add repetido NÃO duplica a transação', () => {
    // O caso real: o save chega, é gravado, e a RESPOSTA se perde. O cliente não
    // atualiza o retrato, então o save seguinte deriva as MESMAS operações. Sem
    // isto, a transação apareceria duas vezes no extrato.
    const ops = [{ p: 'p1', c: 'transacoes', op: 'add', apos: 'a', r: tx('b') }]
    const { duas } = repetir([perfil({ transacoes: [tx('a')] })], ops)
    assert.deepEqual(ids(txs(duas)), ['a', 'b'])
    assert.equal(duas.valor.ignoradas, 1, 'a segunda vez tem de ser contada como ignorada')
  })

  test('add repetido não SOBRESCREVE o que está lá', () => {
    // Se alguém editou o registro nesse meio-tempo, quem manda é quem está lá.
    // Reaplicar o add com o conteúdo velho apagaria a edição.
    const guardados = [perfil({ transacoes: [tx('b', { valor: 777 })] })]
    const r = aplicar(guardados, [{ p: 'p1', c: 'transacoes', op: 'add', apos: null, r: tx('b') }])
    assert.equal(txs(r)[0].valor, 777)
  })

  test('rm repetido é inofensivo', () => {
    const ops = [{ p: 'p1', c: 'transacoes', op: 'rm', id: 'a' }]
    const { duas } = repetir([perfil({ transacoes: [tx('a'), tx('b')] })], ops)
    assert.deepEqual(ids(txs(duas)), ['b'])
  })

  test('edit repetido dá o mesmo resultado', () => {
    const ops = [{ p: 'p1', c: 'transacoes', op: 'edit', id: 'a', r: tx('a', { valor: 5 }) }]
    const { duas } = repetir([perfil({ transacoes: [tx('a')] })], ops)
    assert.equal(txs(duas)[0].valor, 5)
    assert.equal(txs(duas).length, 1)
  })

  test('edit de registro que sumiu é ignorado, não recriado', () => {
    // Outro cliente removeu. Recriar ressuscitaria o que o usuário apagou.
    const r = aplicar([perfil({ transacoes: [tx('b')] })],
      [{ p: 'p1', c: 'transacoes', op: 'edit', id: 'a', r: tx('a', { valor: 5 }) }])
    assert.deepEqual(ids(txs(r)), ['b'])
    assert.equal(r.valor.ignoradas, 1)
  })

  test('a remessa inteira repetida deixa tudo igual', () => {
    const ops = [
      { p: 'p1', c: 'transacoes', op: 'rm', id: 'a' },
      { p: 'p1', c: 'transacoes', op: 'edit', id: 'b', r: tx('b', { valor: 2 }) },
      { p: 'p1', c: 'transacoes', op: 'add', apos: 'b', r: tx('c') },
      { p: 'p1', op: 'set', k: 'nome', v: 'Novo' },
    ]
    const base = [perfil({ transacoes: [tx('a'), tx('b')] })]
    const uma = aplicar(base, ops)
    const duas = aplicar(uma.valor.profiles, ops)
    assert.deepEqual(uma.valor.profiles, duas.valor.profiles)
  })
})

describe('37.2c — remessa malformada é recusada INTEIRA', () => {
  const recusa = (ops, erro) => {
    const v = validarOperacoes(ops)
    assert.equal(v.ok, false, `devia recusar: ${JSON.stringify(ops)}`)
    if (erro) assert.equal(v.erro, erro)
  }

  test('operação desconhecida', () => recusa([{ p: 'p1', op: 'drop' }], 'op_desconhecida'))
  test('sem perfil', () => recusa([{ op: 'set', k: 'x', v: 1 }], 'op_sem_perfil'))
  test('coleção inventada', () => recusa([{ p: 'p1', c: 'segredos', op: 'rm', id: 'a' }], 'colecao_desconhecida'))
  test('não é lista', () => recusa({ p: 'p1' }, 'ops_nao_e_lista'))
  test('add sem id no registro', () => recusa([{ p: 'p1', c: 'transacoes', op: 'add', apos: null, r: { valor: 1 } }], 'add_registro_sem_id'))
  test('rm sem id', () => recusa([{ p: 'p1', c: 'transacoes', op: 'rm' }], 'rm_sem_id'))
  test('set sem valor', () => recusa([{ p: 'p1', op: 'set', k: 'nome' }], 'set_sem_valor'))

  test('edit com id divergente do registro', () => {
    // Não dá para saber qual registro o cliente quis editar — e escolher errado
    // sobrescreve um lançamento que ele não tocou.
    recusa([{ p: 'p1', c: 'transacoes', op: 'edit', id: 'a', r: tx('b') }], 'edit_id_divergente')
  })

  test('⭐ set em __proto__ é barrado — poluição de protótipo', () => {
    // `perfil[o.k] = o.v` com k='__proto__' escreveria no protótipo de Object e
    // mudaria o comportamento de TODO objeto do processo, inclusive o de outro
    // usuário atendido pela mesma instância da função.
    recusa([{ p: 'p1', op: 'set', k: '__proto__', v: { admin: true } }], 'campo_proibido')
    recusa([{ p: 'p1', op: 'set', k: 'constructor', v: 1 }], 'campo_proibido')
    recusa([{ p: 'p1', op: 'unset', k: 'prototype' }], 'campo_proibido')
  })

  test('⭐ set no id do perfil é barrado', () => {
    // Deixar passar permitiria um cliente renomear a chave de um perfil pelo
    // caminho de dados — e cair em cima do perfil de outro membro.
    recusa([{ p: 'p1', op: 'set', k: 'id', v: 'p2' }], 'campo_proibido')
  })

  test('⭐ set numa COLEÇÃO é barrado', () => {
    // Substituiria a coleção inteira: exatamente o "manda tudo" que este passo
    // veio eliminar, entrando pela porta dos fundos.
    recusa([{ p: 'p1', op: 'set', k: 'transacoes', v: [] }], 'campo_proibido')
    recusa([{ p: 'p1', op: 'set', k: 'metas', v: [] }], 'campo_proibido')
  })

  test('remessa gigante é recusada', () => {
    const muitas = Array.from({ length: MAX_OPS + 1 }, (_, i) => (
      { p: 'p1', c: 'transacoes', op: 'add', apos: null, r: tx(`t${i}`) }))
    recusa(muitas, 'ops_demais')
  })

  test('uma operação ruim no meio derruba a remessa inteira', () => {
    // Aplicar metade de um save deixa o dado num estado que nem o cliente nem o
    // servidor sabem descrever.
    recusa([
      { p: 'p1', c: 'transacoes', op: 'add', apos: null, r: tx('a') },
      { p: 'p1', op: 'set', k: '__proto__', v: 1 },
      { p: 'p1', c: 'transacoes', op: 'add', apos: null, r: tx('b') },
    ], 'campo_proibido')
  })

  test('operação para perfil que não existe recusa na aplicação', () => {
    // Cliente e servidor discordam sobre a realidade. Aplicar às cegas criaria
    // perfil fantasma; recusar manda o save pelo caminho de estado inteiro, que
    // sabe criar e apagar perfil.
    const v = validarOperacoes([{ p: 'p9', c: 'transacoes', op: 'rm', id: 'a' }])
    assert.equal(v.ok, true, 'a forma está certa; o problema é semântico')
    const r = aplicarOperacoes([perfil()], v.valor)
    assert.equal(r.ok, false)
    assert.equal(r.erro, 'perfil_desconhecido')
  })

  test('remessa vazia é válida e não faz nada', () => {
    const r = aplicar([perfil({ transacoes: [tx('a')] })], [])
    assert.deepEqual(ids(txs(r)), ['a'])
    assert.equal(r.valor.aplicadas, 0)
  })
})

describe('o carimbo do lastUpdate é do SERVIDOR agora', () => {
  test('perfil tocado recebe o carimbo', () => {
    // Contrato do 37.1: o cliente parou de mandar `lastUpdate` (mudava a cada
    // save e faria toda gravação simultânea colidir). Sem o servidor carimbar,
    // o campo congelaria.
    const r = aplicar([perfil({ transacoes: [] })],
      [{ p: 'p1', c: 'transacoes', op: 'add', apos: null, r: tx('a') }],
      '2026-08-07T12:00:00.000Z')
    assert.equal(r.valor.profiles[0].lastUpdate, '2026-08-07T12:00:00.000Z')
  })

  test('perfil NÃO tocado mantém o carimbo antigo', () => {
    const guardados = [
      perfil({ id: 'p1' }),
      perfil({ id: 'p2', lastUpdate: '2020-01-01T00:00:00.000Z' }),
    ]
    const r = aplicar(guardados, [{ p: 'p1', op: 'set', k: 'nome', v: 'X' }], '2026-08-07T12:00:00.000Z')
    assert.equal(r.valor.profiles[1].lastUpdate, '2020-01-01T00:00:00.000Z')
  })
})

describe('37.2a/37.2d — como a Edge liga isso, e o que ela NÃO deixa passar', () => {
  const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')

  test('o gate exige as TRÊS chaves', () => {
    // ops_aplicar  : o cliente pede. Permite deployar a Edge sozinha sem mudar
    //                nada, e desligar depois por um deploy do front.
    // ops_completo : o cliente PROVOU que as operações reconstroem o estado.
    // profile_ops  : é uma lista.
    assert.match(EDGE, /ops_aplicar\s*===\s*true/)
    assert.match(EDGE, /ops_completo\s*===\s*true/)
    assert.match(EDGE, /Array\.isArray\(\(body as any\)\?\.profile_ops\)/)
  })

  test('37.2d — sem as chaves, o caminho de sempre continua valendo', () => {
    // Um cliente com bundle velho em cache de Service Worker tem de continuar
    // salvando exatamente como antes. Sem isto, o dia do deploy perde dados.
    assert.match(EDGE, /if \(!viaOperacoes && touched && existing\?\.data_json\)/)
    const i = EDGE.indexOf('let profilesFinais = profiles')
    assert.ok(i > 0, 'o padrão continua sendo o payload cru')
  })

  test('as operações são tentadas ANTES do merge, e o merge cede a elas', () => {
    const i = EDGE.indexOf('const querOps =')
    const j = EDGE.indexOf('if (!viaOperacoes && touched')
    assert.ok(i > 0 && j > i)
  })

  test('⭐ conjunto de perfis diferente cancela as operações', () => {
    // Operações não sabem criar nem apagar perfil. Se o conjunto mudou, o
    // caminho de estado inteiro tem de assumir — senão um perfil recém-apagado
    // sobreviveria calado, porque nenhuma operação fala dele.
    assert.match(EDGE, /const mesmoConjunto =/)
    assert.match(EDGE, /if \(!mesmoConjunto\)/)
    assert.match(EDGE, /conjunto de perfis mudou/)
  })

  test('operação inválida NÃO rejeita o save — cai no caminho de sempre', () => {
    // Rejeitar o save inteiro por operação malformada perderia o trabalho do
    // usuário por um defeito que é nosso.
    const bloco = EDGE.match(/const v = validarOperacoes[\s\S]*?\n {10}\} else \{/)[0]
    assert.ok(!/return json/.test(bloco), 'ops inválidas não podem devolver erro ao usuário')
    assert.match(bloco, /console\.warn/)
  })

  test('a guarda anti-wipe continua valendo sobre o resultado das operações', () => {
    // `profilesFinais` agora pode vir das operações. A guarda tem de olhar o que
    // VAI PARA O DISCO, não o payload cru.
    assert.match(EDGE, /const incomingHasAnyData = \(profilesFinais as any\[\]\)\.some\(profileHasData\)/)
    const iOps = EDGE.indexOf('viaOperacoes = true')
    const iWipe = EDGE.indexOf('GUARDA ANTI-WIPE')
    assert.ok(iWipe > iOps, 'a guarda tem de rodar depois de as operações comporem o resultado')
  })

  test('as operações NUNCA são persistidas', () => {
    // O blob guardado é reconstruído a partir de um shape conhecido. Se
    // `profile_ops` vazasse para lá, cresceria a cada save.
    const salvo = EDGE.match(/const dataToSave = \{[\s\S]*?\n {4}\}/)[0]
    assert.ok(!/profile_ops|ops_completo|ops_aplicar/.test(salvo))
  })

  test('o log não vaza dado do usuário', () => {
    // user id truncado em 8, contagens, e o motivo da recusa. Nada de valor.
    for (const linha of EDGE.match(/console\.(log|warn)\([^)]*ops[^)]*\)/g) || []) {
      assert.ok(!/profile_ops|v\.valor\)|r\.valor\.profiles/.test(linha), linha)
      if (/user:/.test(linha)) assert.match(linha, /slice\(0, 8\)/)
    }
  })
})

describe('as duas pontas concordam — diff do cliente × aplicação do servidor', () => {
  // Qualquer divergência entre diff-registros.js e aplicar-operacoes.ts vira
  // dado errado gravado. Estes testes fecham o ciclo completo: o cliente deriva,
  // o servidor aplica, e o resultado tem de ser o estado do cliente.
  const COLS = ['transacoes', 'metas', 'cartoesCredito', 'contasFixas', 'assinaturas']

  const cicloCompleto = (antes, depois) => {
    const ops = []
    for (const col of COLS) {
      const d = diffColecao(antes[col], depois[col])
      assert.equal(d.ok, true, col)
      ops.push(...comEndereco(d.ops, antes.id, col))
    }
    const dc = diffCampos(antes, depois, [...COLS, 'lastUpdate'])
    ops.push(...comEndereco(dc.ops, antes.id, null))

    const r = aplicar([antes], ops, '2026-08-07T12:00:00.000Z')
    const obtido = { ...r.valor.profiles[0] }
    delete obtido.lastUpdate
    const esperado = { ...depois }
    delete esperado.lastUpdate
    return { obtido, esperado }
  }

  const base = {
    id: 'p1', nome: 'Lucas', config: { tema: 'escuro' },
    orcamentos: { Mercado: { limite: 600 } },
    transacoes: [tx('t1'), tx('t2')],
    metas: [{ id: 'm1', descricao: 'Viagem', saved: 100 }],
    cartoesCredito: [], contasFixas: [], assinaturas: [],
  }

  const casos = {
    'lançou uma transação':   { ...base, transacoes: [...base.transacoes, tx('t3')] },
    'excluiu do meio':        { ...base, transacoes: [tx('t1')] },
    'desfez exclusão (meio)': { ...base, transacoes: [tx('t1'), tx('novo'), tx('t2')] },
    'editou o valor':         { ...base, transacoes: [tx('t1', { valor: 999 }), tx('t2')] },
    'guardou na reserva':     { ...base, metas: [{ id: 'm1', descricao: 'Viagem', saved: 150 }] },
    'renomeou o perfil':      { ...base, nome: 'Lucas O.' },
    'mudou o orçamento':      { ...base, orcamentos: { Mercado: { limite: 800 } } },
    'apagou o orçamento':     (() => { const c = { ...base }; delete c.orcamentos; return c })(),
    'importou extrato':       { ...base, transacoes: [...base.transacoes, tx('i1'), tx('i2'), tx('i3')] },
    'não mexeu em nada':      base,
  }

  for (const [nome, depois] of Object.entries(casos)) {
    test(nome, () => {
      const { obtido, esperado } = cicloCompleto(base, depois)
      assert.deepEqual(obtido, esperado)
    })
  }
})
