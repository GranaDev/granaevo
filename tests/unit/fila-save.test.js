/**
 * 37.4 — o save que não conseguiu sair não morre com a aba.
 *
 * Última peça da concorrência, e a única que sobrou depois que o Lost Update
 * morreu. Esta não é integridade: é NÃO PERDER O QUE JÁ FOI FEITO. Antes, um
 * save que falhava ficava só na memória; fechar a aba levava o lançamento junto,
 * sem aviso nenhum.
 *
 * A fila só é possível por causa do 37.2b: toda operação é idempotente POR
 * CONSTRUÇÃO. Sem aquilo, reenviar seria uma máquina de duplicar transação.
 *
 * Puro, sem rede/DOM (localStorage é simulado). Roda no CI.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

// localStorage de mentira, antes de importar o módulo.
const _mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (_mem.has(k) ? _mem.get(k) : null),
  setItem: (k, v) => _mem.set(k, String(v)),
  removeItem: (k) => _mem.delete(k),
}

const { enfileirar, pendentes, quantos, limpar, drenar, recuoMs } =
  await import('../../src/scripts/modules/fila-save.js')

const U = 'user-1'
const ops = (n) => Array.from({ length: n }, (_, i) => ({ p: 'p1', c: 'transacoes', op: 'add', apos: null, r: { id: `t${i}` } }))

beforeEach(() => _mem.clear())

describe('guarda o que não conseguiu sair', () => {
  test('enfileira e devolve na ordem', () => {
    enfileirar(U, ops(1), ['p1'])
    enfileirar(U, ops(2), ['p1', 'p2'])
    const f = pendentes(U)
    assert.equal(f.length, 2)
    assert.equal(f[0].ops.length, 1)
    assert.equal(f[1].ops.length, 2)
    assert.deepEqual(f[1].tocados, ['p1', 'p2'])
  })

  test('lote sem operação não entra', () => {
    // Não há o que reenviar; guardar "nada" só criaria trabalho na drenagem.
    enfileirar(U, [], ['p1'])
    assert.equal(quantos(U), 0)
  })

  test('limpar esvazia de verdade', () => {
    enfileirar(U, ops(1), [])
    limpar(U)
    assert.equal(quantos(U), 0)
  })

  test('fila é por usuário', () => {
    enfileirar(U, ops(1), [])
    assert.equal(quantos('outro'), 0)
  })

  test('lote velho é descartado, não reaplicado', () => {
    // Operação parada há mais de um dia é lixo: o mundo mudou em volta dela, e a
    // pessoa provavelmente já refez à mão. Ressuscitar seria pior que perder.
    _mem.set(`ge_fila_save_${U}`, JSON.stringify([
      { em: Date.now() - 25 * 60 * 60 * 1000, ops: ops(1), tocados: [] },
      { em: Date.now(), ops: ops(1), tocados: [] },
    ]))
    assert.equal(quantos(U), 1)
  })

  test('storage corrompido vira fila vazia, não exceção', () => {
    _mem.set(`ge_fila_save_${U}`, 'isto não é json')
    assert.deepEqual(pendentes(U), [])
  })

  test('tem teto — a fila não cresce sem limite', () => {
    for (let i = 0; i < 30; i++) enfileirar(U, ops(1), [])
    assert.ok(quantos(U) <= 10)
  })
})

describe('⭐ a drenagem respeita a ORDEM, e para no primeiro erro', () => {
  test('envia do mais antigo para o mais novo', async () => {
    enfileirar(U, [{ marca: 'a' }], [])
    enfileirar(U, [{ marca: 'b' }], [])
    const vistos = []
    await drenar(U, (lote) => { vistos.push(lote.ops[0].marca); return true })
    assert.deepEqual(vistos, ['a', 'b'])
  })

  test('lote que falha PARA a fila e mantém os seguintes', async () => {
    // Pular para o próximo quebraria a ordem: um `add` seguido de um `rm` do
    // mesmo registro, aplicados ao contrário, deixariam o registro vivo.
    enfileirar(U, [{ marca: 'a' }], [])
    enfileirar(U, [{ marca: 'b' }], [])
    enfileirar(U, [{ marca: 'c' }], [])
    const r = await drenar(U, (lote) => lote.ops[0].marca !== 'b')
    assert.equal(r.enviados, 1)
    assert.equal(r.restantes, 2)
    assert.deepEqual(pendentes(U).map((l) => l.ops[0].marca), ['b', 'c'])
  })

  test('sucesso total esvazia', async () => {
    enfileirar(U, ops(1), [])
    enfileirar(U, ops(1), [])
    const r = await drenar(U, () => true)
    assert.equal(r.restantes, 0)
    assert.equal(quantos(U), 0)
  })

  test('enviador que estoura conta como falha, não derruba', async () => {
    enfileirar(U, ops(1), [])
    const r = await drenar(U, () => { throw new Error('rede') })
    assert.equal(r.enviados, 0)
    assert.equal(quantos(U), 1)
  })

  test('o recuo cresce e para de crescer', () => {
    assert.equal(recuoMs(0), 2_000)
    assert.ok(recuoMs(3) > recuoMs(1))
    assert.equal(recuoMs(99), recuoMs(4), 'teto: não vira espera infinita')
  })
})

describe('🔒 o reenvio não pode ser destrutivo', () => {
  const DM   = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
  const EDGE = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8'))

  test('⭐ o reenvio marca `ops_somente`', () => {
    // Ele manda `profiles: []`. Sem a marca, se as operações não aplicassem, o
    // servidor leria "os perfis declarados sumiram do payload" = EXCLUSÃO, e
    // apagaria a conta. A guarda anti-wipe pegaria, mas o reenvio nunca
    // funcionaria — e o desenho estaria contando com a rede de segurança.
    const fn = DM.match(/async #enviarLote\(lote\) \{[\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /ops_somente: true/)
    assert.match(fn, /profiles: \[\]/)
  })

  test('⭐ o servidor RECUSA em vez de cair no caminho de estado inteiro', () => {
    assert.match(EDGE, /const opsSomente = \(body as any\)\?\.ops_somente === true/)
    assert.match(EDGE, /if \(opsSomente && !viaOperacoes\) \{/)
    assert.match(EDGE, /code: 'OPS_NAO_APLICADAS'/)
    // E a recusa vem ANTES do merge, senão não recusaria nada.
    const i = EDGE.indexOf("code: 'OPS_NAO_APLICADAS'")
    const j = EDGE.indexOf('if (!viaOperacoes && touched && existing?.data_json)')
    assert.ok(i > 0 && j > i)
  })

  test('a checagem de conjunto de perfis é dispensada só no reenvio', () => {
    // Ele não traz `profiles` para comparar. Em qualquer outro payload a
    // checagem continua valendo — é ela que impede perfil apagado de voltar.
    assert.match(EDGE, /const mesmoConjunto = opsSomente \|\| \(/)
  })

  test('o reenvio fala SÓ por operações — nunca manda estado guardado', () => {
    // Estado salvo em disco é o mais velho que existe. Mandá-lo seria o Lost
    // Update de volta, com atraso de horas.
    const fn = DM.match(/async #enviarLote\(lote\) \{[\s\S]*?\n {4}\}/)[0]
    assert.ok(!/lote\.profiles|safeProfiles/.test(fn))
  })
})

describe('quando a fila entra em ação', () => {
  const DM = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))

  test('erro de rede enfileira', () => {
    assert.match(DM, /try \{ await this\.#enfileirar\(sombraDoLote, null\); \} catch/)
    // Declarado FORA do try — dentro, o catch não o enxergaria.
    const i = DM.indexOf('let sombraDoLote = null;')
    const j = DM.indexOf('try {', i)
    assert.ok(i > 0 && j > i)
  })

  test('5xx e 429 enfileiram; os demais 4xx não', () => {
    // 5xx é o servidor tropeçando: vale reenviar. 4xx é payload recusado —
    // insistir só repetiria a recusa, para sempre.
    //
    // 429 é a exceção, aberta em 2026-08-15 junto com o teto de escritas/hora, e
    // a razão é o que ele significa: "agora não, tente depois". O payload está
    // bom, só chegou cedo demais — é o único 4xx em que reenviar é a resposta
    // certa. Sem isto, o teto cobraria do usuário legítimo o preço da proteção
    // contra abuso. Ver tests/unit/teto-save.test.js.
    assert.match(
      DM,
      /if \(saveResp\.status >= 500 \|\| saveResp\.status === 429\) \{\s*await this\.#enfileirar\(sombra, tocados\);/,
    )
    // A porta continua estreita: nada de enfileirar 4xx em bloco.
    assert.doesNotMatch(DM, /saveResp\.status >= 400\) \{?\s*await this\.#enfileirar/)
  })

  test('só enfileira lote COMPLETO e com operações', () => {
    const fn = DM.match(/async #enfileirar\(sombra, tocados\) \{[\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /sombra\.completo !== true \|\| !sombra\.ops\?\.length/)
  })

  test('a rede voltando acorda a fila, e o listener é único', () => {
    assert.match(DM, /window\.addEventListener\('online'/)
    assert.match(DM, /if \(!this\.#filaOuvindoRede && typeof window !== 'undefined'\)/)
  })

  test('um agendamento por vez', () => {
    // Sem a trava, cada save que falha somaria um timer — e uma rede instável
    // viraria enxurrada de POSTs exatamente quando ela menos aguenta.
    assert.match(DM, /if \(this\.#reenvioAgendado\) return;/)
  })

  test('offline declarado não gasta tentativa', () => {
    assert.match(DM, /navigator\.onLine === false/)
  })

  test('a fila é carregada SOB DEMANDA', () => {
    // O caminho feliz nunca a importa. É o que permitiu fazer o 37.4 sem
    // esbarrar no teto do dashboard.js.
    assert.match(DM, /await import\('\.\/fila-save\.js\?v=1'\)/)
    assert.ok(!/^import .* from '\.\/fila-save\.js/m.test(DM))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACHADO 2026-08-15 — a fila sobrevivia à aba, mas ninguém a lia de volta.
//
// O Gate 6.1 do smoke test em produção pegou: lançar offline → recarregar →
// voltar online → `total: 22, esperado 23`. A alteração ficava no localStorage
// até a expiração de 24 h descartá-la, sem erro e sem aviso.
//
// Causa: `#agendarReenvio()` era a única porta de entrada da drenagem, e só
// abria por um save que falhava NA MESMA sessão de página; o listener de
// `online` era registrado dentro dela. Página nova = nada disso existe.
// ─────────────────────────────────────────────────────────────────────────────
describe('fila órfã — o que o Gate 6.1 pegou em produção', () => {
  const DM = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))

  const bloco = (src, ini, fim) => {
    const i = src.indexOf(ini); assert.ok(i !== -1, `não achei: ${ini}`)
    const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
    return src.slice(i, j)
  }

  test('o boot retoma a fila deixada por uma sessão anterior', () => {
    const init = bloco(DM, 'async initialize(', 'async loadUserData()')
    assert.match(init, /this\.#retomarFilaPendente\(\)/,
      'o boot voltou a ignorar a fila: recarregar a página perde a alteração pendente')
  })

  test('a retomada lê o localStorage CRU, sem carregar o módulo da fila', () => {
    const fn = bloco(DM, '#retomarFilaPendente() {', '#agendarReenvio() {')
    assert.match(fn, /localStorage\.getItem\(`ge_fila_save_/,
      'a checagem tem de ser leitura crua — importar fila-save.js aqui pesa em TODO boot')
    assert.doesNotMatch(fn, /await this\.#fila\(\)/,
      'importou o módulo da fila no caminho comum: o lazy do Passo 37.4 foi desfeito')
    assert.match(fn, /this\.#agendarReenvio\(\)/,
      'achou pendência e não agendou a drenagem')
  })

  test('offline NÃO reagenda em laço apertado', () => {
    const fn = bloco(DM, 'const tentar = async () => {', 'setTimeout(tentar, 0)')
    const i = fn.indexOf('navigator.onLine === false')
    assert.ok(i > 0, 'sumiu a checagem de offline')
    const ramo = fn.slice(i, fn.indexOf('}', i))
    assert.doesNotMatch(ramo, /#agendarReenvio\(\)/,
      'o ramo offline voltou a chamar #agendarReenvio — como `tentar` zera a trava na ' +
      'primeira linha, isso gira tentar→agendar→tentar a ~4 ms, queimando CPU sem rede')
  })
})
