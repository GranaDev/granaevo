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
import { diffColecao, diffVazio, contarOperacoes, aplicarOperacoes }
  from '../../src/scripts/modules/diff-registros.js'

const r = (id, over = {}) => ({ id, categoria: 'saida', valor: 10, descricao: 'x', ...over })
const ids = (lista) => lista.map((x) => x.id)
// `add` carrega posição — `{apos, registro}` —, então o id mora um nível abaixo.
const idsAdd = (lista) => lista.map((x) => x.registro.id)

describe('o que mudou, e só o que mudou', () => {
  test('registro novo sai como add', () => {
    const d = diffColecao([r('a')], [r('a'), r('b')])
    assert.equal(d.ok, true)
    assert.deepEqual(idsAdd(d.add), ['b'])
    assert.deepEqual(d.edit, [])
    assert.deepEqual(d.remove, [])
  })

  test('registro alterado sai como edit, com o conteúdo novo inteiro', () => {
    const d = diffColecao([r('a', { valor: 10 })], [r('a', { valor: 99 })])
    assert.deepEqual(ids(d.edit), ['a'])
    assert.equal(d.edit[0].valor, 99)
    assert.deepEqual(d.add, [])
  })

  test('registro que sumiu sai como remove — só o id', () => {
    const d = diffColecao([r('a'), r('b')], [r('a')])
    assert.deepEqual(d.remove, ['b'])
    assert.deepEqual(d.add, [])
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
    assert.deepEqual(idsAdd(d.add), ['d'])
    assert.deepEqual(ids(d.edit), ['c'])
    assert.deepEqual(d.remove, ['b'])
    assert.equal(contarOperacoes(d), 3)
  })

  test('coleção que nasceu do zero: tudo é add', () => {
    const d = diffColecao(undefined, [r('a')])
    assert.deepEqual(idsAdd(d.add), ['a'])
    assert.equal(d.add[0].apos, null, 'o primeiro de todos não tem âncora')
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
    assert.deepEqual(ids(d.edit), ['m'])
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
    assert.deepEqual(idsAdd(d.add), ['b'])
    assert.equal(d.add[0].apos, 'a')
  })

  test('inserido no começo tem âncora nula', () => {
    const d = diffColecao([r('b')], [r('a'), r('b')])
    assert.equal(d.add[0].apos, null)
  })

  test('vários novos seguidos se ancoram em cadeia', () => {
    // Cada um aponta para o anterior, inclusive quando o anterior também é
    // novo — funciona porque as operações são aplicadas na ordem em que vêm.
    const d = diffColecao([r('a')], [r('a'), r('b'), r('c')])
    assert.deepEqual(d.add.map((x) => [x.apos, x.registro.id]), [['a', 'b'], ['b', 'c']])
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

describe('volume real', () => {
  test('mil registros, uma edição — o diff carrega uma operação', () => {
    // É o ponto do passo inteiro: hoje esse save empurra as mil transações e
    // sobrescreve o que outra aba lançou. Depois dele, empurra uma.
    const antes = Array.from({ length: 1000 }, (_, i) => r(`t${i}`))
    const depois = antes.map((x) => (x.id === 't500' ? { ...x, valor: 77 } : x))
    const d = diffColecao(antes, depois)
    assert.equal(contarOperacoes(d), 1)
    assert.deepEqual(ids(d.edit), ['t500'])
  })
})
