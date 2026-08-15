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

const { enfileirar, pendentes, quantos, limpar, drenar, recuoMs, recuoBaseMs } =
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
    // Fala dos DEGRAUS, sem sortear: com jitter, comparar valores sorteados
    // daria um teste que reprova sozinho de vez em quando.
    assert.equal(recuoBaseMs(0), 2_000)
    assert.ok(recuoBaseMs(3) > recuoBaseMs(1))
    assert.equal(recuoBaseMs(99), recuoBaseMs(4), 'teto: não vira espera infinita')
  })

  // ── JITTER (2026-08-15) ───────────────────────────────────────────────────
  // Recuo determinístico faz N clientes que falharam juntos voltarem juntos, em
  // fase, para sempre. Ficou urgente quando o teto de escritas/hora entrou e o
  // 429 passou a enfileirar: sem dispersão, a proteção contra abuso vira o
  // metrônomo que sincroniza os clientes que ela mesma recusou.
  test('o recuo dispersa — dois clientes no mesmo instante não voltam juntos', () => {
    const amostras = new Set(Array.from({ length: 200 }, () => recuoMs(0)))
    // Determinístico daria 1 valor. Exigir >50 distintos em 200 sorteios de um
    // intervalo de 2001 inteiros: a chance de falso negativo é desprezível.
    assert.ok(
      amostras.size > 50,
      `o recuo voltou a ser determinístico (${amostras.size} valor(es) distinto(s) em 200)`,
    )
  })

  test('a dispersão respeita o degrau — nunca abaixo de 0,5× nem acima de 1,5×', () => {
    for (const n of [0, 1, 2, 3, 4, 99]) {
      const base = recuoBaseMs(n)
      for (let i = 0; i < 300; i++) {
        const v = recuoMs(n)
        assert.ok(
          v >= base * 0.5 && v <= base * 1.5,
          `recuoMs(${n}) devolveu ${v}, fora de [${base * 0.5}, ${base * 1.5}]`,
        )
      }
    }
  })

  test('nunca devolve zero nem negativo — reenvio imediato em rajada é o defeito', () => {
    for (let i = 0; i < 200; i++) assert.ok(recuoMs(0) >= 1_000)
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
    // A chave saiu do literal e foi para `#chaveFila()` em 2026-08-15, quando a
    // ESCRITA crua passou a existir e os dois lados precisaram casar exatamente.
    // O que este teste protege continua sendo o mesmo: leitura crua, sem módulo.
    assert.match(fn, /localStorage\.getItem\(this\.#chaveFila\(\)\)/,
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

// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 gravar mesmo quando o MÓDULO da fila não carrega', () => {
  // O paradoxo, medido em produção em 2026-08-15: `fila-save.js` é import() sob
  // demanda e o save só falha SEM REDE — o módulo é inalcançável exatamente
  // quando existe para servir. O Service Worker normalmente tem o chunk em
  // cache, mas depois de todo deploy há uma janela em que não tem: o HTML novo
  // entra em vigor na hora e passa a pedir o hash novo, enquanto o precache
  // leva ~1 min para alcançá-lo. Medido no navegador do dono: >54 s com o hash
  // novo ausente de TODOS os caches, SW ainda em `activating`.
  //
  // Cair nessa janela offline significava localStorage vazio e, no reload,
  // lançamento perdido sem aviso nenhum.
  const DM = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
  const bloco = (src, ini, fim) => {
    const i = src.indexOf(ini); assert.ok(i !== -1, `não achei o início: ${ini}`)
    const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
    return src.slice(i, j)
  }

  test('⭐ CONTRATO: o que a escrita crua grava, a drenagem lê', () => {
    // O risco desta correção é ter DUAS escritas que divergem em silêncio: o
    // lote iria para um formato que `_ler` descarta, e sumiria sem erro. Este
    // teste fixa o contrato entre as duas — é o que impede a divergência.
    _mem.clear()
    _mem.set('ge_fila_save_user-1', JSON.stringify([
      { em: Date.now(), ops: [{ p: 'p1', c: 'transacoes', op: 'add', r: { id: 't1' } }], tocados: ['p1'] },
    ]))
    const f = pendentes('user-1')
    assert.equal(f.length, 1, 'a drenagem não enxerga o que a escrita crua gravou')
    assert.equal(f[0].ops.length, 1)
    assert.deepEqual(f[0].tocados, ['p1'])
  })

  test('⭐ #enfileirar cai para a escrita crua quando o import falha', () => {
    const fn = bloco(DM, 'async #enfileirar(sombra, tocados) {', '#chaveFila() {')
    assert.match(fn, /await this\.#fila\(\)/, 'o caminho normal some')
    assert.match(
      fn,
      /\} catch \{[\s\S]*?this\.#gravarLoteCru\(sombra\.ops, tocados\)/,
      'o import voltou a ser o único caminho: offline na janela pós-deploy = dado perdido',
    )
  })

  test('a chave é a MESMA dos dois lados, `|| anon` incluído', () => {
    // Sem o `|| 'anon'`, um userId ausente vira a string "null" aqui e "anon"
    // no módulo: grava num lugar, procura em outro, e o lote fica invisível.
    const fn = bloco(DM, '#chaveFila() {', '#gravarLoteCru(')
    assert.match(fn, /ge_fila_save_\$\{this\.#userId \|\| 'anon'\}/)
    const modulo = readFileSync(join(RAIZ, 'src/scripts/modules/fila-save.js'), 'utf8')
    assert.match(modulo, /ge_fila_save_\$\{userId \|\| 'anon'\}/, 'o módulo mudou a chave sozinho')
  })

  test('a escrita crua respeita o teto de 10 lotes', () => {
    // Sem o corte, a fila crua cresceria até estourar a cota do localStorage —
    // e aí NADA mais é gravado, que é o oposto do que esta correção existe para
    // garantir.
    const fn = bloco(DM, '#gravarLoteCru(ops, tocados) {', '#retomarFilaPendente() {')
    assert.match(fn, /fila\.slice\(-10\)/)
    assert.match(fn, /em: Date\.now\(\)/, 'sem o carimbo, a validade de 24h descarta o lote na leitura')
  })

  test('o import da drenagem não vira unhandled rejection', () => {
    // `navigator.onLine` diz "há interface de rede", não "há internet". Quando
    // ele mente, este import falha DENTRO de um setTimeout — sem catch, a
    // rejeição não tem quem a pegue e a fila para de ser tentada na sessão.
    const fn = bloco(DM, 'const tentar = async () => {', 'setTimeout(tentar, 0)')
    // O `catch` continua obrigatório (rejeição em setTimeout não tem quem pegue),
    // mas desde 2026-08-15 ele não só engole: drena sem o módulo. Ver o describe
    // do module map, abaixo.
    assert.match(fn, /try \{\s*mod = await this\.#fila\(\);\s*\} catch \{/)
    assert.match(fn, /await this\.#drenarCru\(\);/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 drenar sem o módulo — o module map não devolve o que já falhou', () => {
  // MEDIDO em produção (2026-08-15), com a rede de volta e na MESMA página:
  //   ❌ Failed to fetch dynamically imported module: .../fila-save-DfS7l0RQ.js
  // Depois que um import() dinâmico falha, o navegador guarda a FALHA por URL
  // pelo tempo de vida do documento: import() rejeita na hora, sem tentar a
  // rede. Era por isso que a fila só drenava depois de um F5 — o reload zera o
  // module map. Esperar o módulo aqui é esperar por algo que não chega.
  const DM = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
  const bloco = (src, ini, fim) => {
    const i = src.indexOf(ini); assert.ok(i !== -1, `não achei o início: ${ini}`)
    const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
    return src.slice(i, j)
  }

  test('⭐ o import que falha cai na drenagem crua, não desiste', () => {
    const fn = bloco(DM, 'const tentar = async () => {', 'setTimeout(tentar, 0)')
    assert.match(
      fn,
      /\} catch \{[\s\S]*?await this\.#drenarCru\(\);\s*return;/,
      'voltou a desistir quando o módulo não carrega: a fila só drenaria após F5',
    )
  })

  test('a drenagem crua preserva a ORDEM e para no primeiro erro', () => {
    const fn = bloco(DM, 'async #drenarCru() {', '#gravarLoteCru(ops, tocados) {')
    assert.match(fn, /for \(const lote of fila\)/, 'perdeu a ordem: add+rm invertidos deixam o registro vivo')
    assert.match(fn, /if \(!ok\) break;/, 'passou a pular lotes que falharam — quebra a ordem')
    assert.match(fn, /fila\.slice\(enviados\)/, 'regrava a fila inteira em vez do que sobrou')
  })

  test('avisa a tela quando esvazia', () => {
    const fn = bloco(DM, 'async #drenarCru() {', '#gravarLoteCru(ops, tocados) {')
    assert.match(fn, /ge:fila-vazia/,
      'sem o aviso, a tela segue mostrando o estado de antes e o lançamento parece perdido')
  })

  test('usa a MESMA chave dos outros dois caminhos', () => {
    const fn = bloco(DM, 'async #drenarCru() {', '#gravarLoteCru(ops, tocados) {')
    assert.match(fn, /this\.#chaveFila\(\)/, 'chave própria = drena de um lugar e a escrita grava em outro')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('uma intenção, um lote', () => {
  // MEDIDO em 2026-08-15: UMA transação offline virou QUATRO lotes. O auto-save
  // de 30s continua rodando sem rede e cada ciclo reenfileira as MESMAS
  // operações. Não corrompe (idempotência do 37.2b — a drenagem devolveu 4×
  // HTTP 200 e zero duplicatas), mas são 4 requisições para uma intenção só —
  // e é a rajada que o thundering herd multiplica.
  const DM = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
  const bloco = (src, ini, fim) => {
    const i = src.indexOf(ini); assert.ok(i !== -1, `não achei: ${ini}`)
    const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
    return src.slice(i, j)
  }

  test('⭐ lote idêntico ao último não é enfileirado de novo', () => {
    const fn = bloco(DM, 'async #enfileirar(sombra, tocados) {', '#chaveFila() {')
    assert.match(fn, /if \(this\.#loteJaNaFila\(sombra\.ops\)\) \{/,
      'voltou a acumular um lote por ciclo de auto-save')
  })

  test('mas ainda agenda o reenvio — senão a fila fica parada', () => {
    const fn = bloco(DM, 'if (this.#loteJaNaFila(sombra.ops)) {', 'try {')
    assert.match(fn, /this\.#agendarReenvio\(\);/,
      'sem agendar, descartar o lote repetido deixaria a fila sem quem a drene')
  })

  test('compara só o ÚLTIMO lote, não a fila inteira', () => {
    // Varrer tudo poderia descartar uma intenção legítima que voltou depois de
    // outras — e a ordem dos lotes é o que impede `add`+`rm` de se inverterem.
    const fn = bloco(DM, '#loteJaNaFila(ops) {', 'async #drenarCru()')
    assert.match(fn, /fila\[fila\.length - 1\]\?\.ops/)
    assert.doesNotMatch(fn, /\.some\(|\.find\(|for \(/, 'passou a varrer a fila inteira')
  })

  test('na dúvida, enfileira', () => {
    const fn = bloco(DM, '#loteJaNaFila(ops) {', 'async #drenarCru()')
    assert.match(fn, /catch \{[\s\S]*?return false;/,
      'storage ilegível passou a descartar o lote — desperdício é melhor que perda')
  })
})
