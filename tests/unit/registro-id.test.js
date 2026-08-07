/**
 * registro-id — a identidade que faltava, e as duas regras opostas que ela junta.
 *
 * Fundação do Passo 37. Sem `id`, o cliente só sabe dizer "aqui está o estado
 * inteiro" — e é assim que duas abas no mesmo perfil se apagam. Com `id`, dá
 * para dizer "editei ESTE lançamento".
 *
 * O arquivo inteiro gira em torno de uma inversão que é fácil errar:
 *
 *   registro NOVO  → id ALEATÓRIO. Dois cafés de R$ 5 no mesmo minuto são dois
 *                    cafés. Id derivado dos campos fundiria os dois — o bug que
 *                    estamos consertando, de volta pela porta dos fundos.
 *   registro ANTIGO → id DERIVADO. Dois clientes que leem a MESMA linha do banco
 *                    têm de chegar ao mesmo id, senão cada um enxerga "sumiu um
 *                    e nasceu outro" e o histórico duplica.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { novoId, backfillIds, carimbarNovos, idDerivado, COLECOES }
  from '../../src/scripts/modules/registro-id.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const tx = (over = {}) => ({
  categoria: 'saida', tipo: 'Mercado', descricao: 'Feira',
  valor: 87.4, data: '07/08/2026', hora: '10:32:00', metaId: null, ...over,
})
const perfil = (over = {}) => ({ id: 'p1', name: 'Lucas', transacoes: [], metas: [], ...over })
const copia = (v) => JSON.parse(JSON.stringify(v))
const idsDe = (p, col = 'transacoes') => p[col].map((r) => r.id)

describe('registro que nasce agora: id sorteado', () => {
  test('duas chamadas nunca dão o mesmo id', () => {
    const vistos = new Set()
    for (let i = 0; i < 500; i++) vistos.add(novoId())
    assert.equal(vistos.size, 500)
  })

  test('dois lançamentos IDÊNTICOS recebem ids diferentes', () => {
    // O caso que quebraria tudo: comprar o mesmo café duas vezes no mesmo
    // minuto. São dois registros — se colidissem, um sumiria no primeiro save.
    const p = perfil({ transacoes: [tx(), tx()] })
    carimbarNovos([p])
    const [a, b] = idsDe(p)
    assert.ok(a && b)
    assert.notEqual(a, b)
  })

  test('não mexe em quem já tem id', () => {
    const p = perfil({ transacoes: [tx({ id: 'ja-tinha' }), tx()] })
    const n = carimbarNovos([p])
    assert.equal(n, 1)
    assert.equal(p.transacoes[0].id, 'ja-tinha')
    assert.ok(p.transacoes[1].id)
  })

  test('id vazio conta como ausente', () => {
    // `id: ''` vinha de código que preenchia o campo sem valor. Tratar isso como
    // "tem id" deixaria o registro invisível para o diff, para sempre.
    const p = perfil({ transacoes: [tx({ id: '' })] })
    assert.equal(carimbarNovos([p]), 1)
    assert.ok(p.transacoes[0].id.length > 0)
  })
})

describe('registro antigo: id derivado, igual em qualquer cliente', () => {
  test('dois clientes que leem a mesma linha chegam ao mesmo id', () => {
    // É a propriedade que sustenta tudo. Se falhar, o cliente A acha que o
    // cliente B apagou e recriou cada transação do histórico.
    const clienteA = [perfil({ transacoes: [tx(), tx({ valor: 12 })] })]
    const clienteB = copia(clienteA)
    backfillIds(clienteA)
    backfillIds(clienteB)
    assert.deepEqual(idsDe(clienteA[0]), idsDe(clienteB[0]))
  })

  test('recarregar a página não muda id nenhum', () => {
    // Verificação pedida no roadmap (37.0d): carregar duas vezes, nada muda.
    const p = [perfil({ transacoes: [tx(), tx({ tipo: 'Lazer' })] })]
    backfillIds(p)
    const antes = idsDe(p[0])
    const depoisDoReload = copia(p)      // sai e volta do banco, como JSON
    backfillIds(depoisDoReload)          // o load roda o backfill de novo
    assert.deepEqual(idsDe(depoisDoReload[0]), antes)
  })

  test('a ordem das chaves no JSON não afeta o id', () => {
    // Caminhos de código diferentes criam o mesmo registro com as chaves em
    // ordens diferentes. `JSON.stringify` preserva a ordem de inserção — usá-lo
    // cru faria o id depender de QUEM criou o objeto, não do que ele contém.
    assert.equal(
      idDerivado({ categoria: 'saida', valor: 10, descricao: 'x' }),
      idDerivado({ descricao: 'x', categoria: 'saida', valor: 10 }),
    )
  })

  test('conteúdo diferente, id diferente', () => {
    assert.notEqual(idDerivado(tx()), idDerivado(tx({ valor: 87.41 })))
    assert.notEqual(idDerivado(tx()), idDerivado(tx({ hora: '10:33:00' })))
  })

  test('registros antigos IDÊNTICOS são desempatados pela posição — e sempre igual', () => {
    // Dois cafés iguais no histórico derivam o mesmo hash. O segundo ganha
    // sufixo pela posição no array; como todo cliente lê o mesmo array na mesma
    // ordem, o desempate também é determinístico.
    const a = [perfil({ transacoes: [tx(), tx(), tx()] })]
    const b = copia(a)
    backfillIds(a)
    backfillIds(b)
    const ids = idsDe(a[0])
    assert.equal(new Set(ids).size, 3, 'os três precisam ficar distintos')
    assert.deepEqual(idsDe(b[0]), ids, 'e iguais no outro cliente')
  })

  test('id derivado nunca cai em cima de um id que já existe', () => {
    // Um registro sem id cujo hash bata com o id real de outro registro fundiria
    // os dois. Por isso os ids existentes entram no conjunto ANTES da derivação.
    const alvo = tx()
    const jaExiste = idDerivado(alvo)
    const p = [perfil({ transacoes: [tx({ id: jaExiste, valor: 999 }), alvo] })]
    backfillIds(p)
    const [a, b] = idsDe(p[0])
    assert.equal(a, jaExiste)
    assert.notEqual(b, jaExiste)
  })

  test('quem já tem id fica exatamente como estava', () => {
    const p = [perfil({ transacoes: [tx({ id: 'uuid-de-verdade' })] })]
    assert.equal(backfillIds(p), 0)
    assert.equal(p[0].transacoes[0].id, 'uuid-de-verdade')
  })
})

describe('todas as coleções, e nenhuma entrada estranha derruba', () => {
  test('cobre transações, metas, cartões, contas fixas e assinaturas', () => {
    assert.deepEqual(
      [...COLECOES].sort(),
      ['assinaturas', 'cartoesCredito', 'contasFixas', 'metas', 'transacoes'],
    )
    const p = perfil({
      transacoes: [tx()], metas: [{ descricao: 'Viagem' }],
      cartoesCredito: [{ nomeBanco: 'Nu' }], contasFixas: [{ descricao: 'Luz' }],
      assinaturas: [{ nome: 'Netflix' }],
    })
    backfillIds([p])
    for (const c of COLECOES) assert.ok(p[c][0].id, `${c} ficou sem id`)
  })

  test('perfil torto não derruba o load', () => {
    // O load roda isto antes de qualquer coisa. Uma exceção aqui deixaria o
    // usuário na tela de erro por causa de um registro velho malformado.
    assert.equal(backfillIds(null), 0)
    assert.equal(backfillIds(undefined), 0)
    assert.equal(carimbarNovos('nada disso'), 0)
    assert.doesNotThrow(() => backfillIds([null, 42, { transacoes: 'não é array' },
      { transacoes: [null, 'texto', tx()] }]))
  })
})

describe('onde as duas funções são chamadas — a ordem é o comportamento', () => {
  const DM = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')

  test('no load: backfill ANTES do retrato', () => {
    // Depois do retrato, o perfil inteiro apareceria como "tocado" no save
    // seguinte, e o merge por perfil viraria enfeite: declarar tudo é o mesmo
    // que substituir tudo, que é justamente o que ele existe para evitar.
    const i = DM.indexOf('backfillIds(userData.profiles)')
    const j = DM.indexOf('this.#tirarRetrato(userData.profiles)')
    assert.ok(i > 0 && j > i, 'backfill precisa vir antes de #tirarRetrato')
  })

  test('no save: carimba o ORIGINAL, antes do structuredClone', () => {
    // A armadilha mais fina do passo. O dashboard reconstrói cada objeto pelo
    // allowlist antes de salvar; se o carimbo caísse só na cópia, o array vivo
    // da tela continuaria sem id e sortearia OUTRO no save seguinte — o mesmo
    // registro pareceria apagado e recriado a cada gravação.
    const i = DM.indexOf('carimbarNovos(profilesData)')
    const j = DM.indexOf('structuredClone(profilesData)')
    assert.ok(i > 0 && j > i, 'carimbarNovos tem de vir antes do clone')
    assert.ok(!/carimbarNovos\(safeProfiles\)/.test(DM), 'carimbar o clone não vale')
  })

  test('e o carimbo acontece antes de calcular quem foi tocado', () => {
    const i = DM.indexOf('carimbarNovos(profilesData)')
    const j = DM.indexOf('this.#perfisTocados(safeProfiles)')
    assert.ok(i > 0 && j > i)
  })
})

describe('o id sobrevive ao save', () => {
  test('`id` está no allowlist de toda entidade — senão o save o descarta', () => {
    // O save reconstrói cada objeto a partir de `_ALLOWED_KEYS`. Campo fora da
    // lista some sem erro e sem aviso: funciona na tela, não existe no reload.
    // Já custou quatro bugs num único dia neste projeto.
    const DASH = readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8')
    const bloco = DASH.match(/_ALLOWED_KEYS = Object\.freeze\(\{[\s\S]*?\n\}\);/)[0]
    for (const ent of ['transacao', 'meta', 'contaFixa', 'cartao', 'assinatura']) {
      const lista = new RegExp(ent + String.raw`:\s*Object\.freeze\(\[([\s\S]*?)\]\)`).exec(bloco)
      assert.ok(lista, `allowlist de ${ent} não encontrada`)
      const campos = [...lista[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      assert.ok(campos.includes('id'), `'id' fora do allowlist de ${ent} — o save descartaria`)
    }
  })

  test('buildTransaction devolve transação COM id', () => {
    const TXB = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/tx-builder.js'), 'utf8')
    const fn = TXB.match(/export function buildTransaction[\s\S]*?\n\}/)[0]
    assert.match(fn, /id:\s*novoId\(\)/)
  })

  test('ninguém mais gera id de registro por conta própria', () => {
    // Havia seis cópias do mesmo `crypto.randomUUID() ?? fallback` espalhadas —
    // e uma delas era um `const novoId` local que SOMBREAVA o import. Uma fonte
    // só de identidade evita que as duas convivam sem ninguém notar.
    for (const arq of ['src/scripts/pages/dashboard.js', 'src/scripts/pages/db-metas.js',
      'src/scripts/pages/db-transacoes.js', 'src/scripts/pages/db-cartoes.js']) {
      const src = readFileSync(join(RAIZ, arq), 'utf8')
      assert.ok(!/id:\s*\(typeof crypto/.test(src), `${arq} ainda gera id inline`)
      assert.ok(!/(?:const|let|var)\s+novoId\s*=/.test(src), `${arq} tem novoId local sombreando o import`)
    }
  })
})
