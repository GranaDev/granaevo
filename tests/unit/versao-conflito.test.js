/**
 * 37.3 — trava de versão: gravação baseada em leitura velha é recusada.
 *
 * DEFESA EM PROFUNDIDADE, não o conserto. O Lost Update já foi resolvido por
 * operações (37.0–37.2) e confirmado em produção. Isto fecha o que sobrou.
 *
 * O RACIOCÍNIO QUE DEFINE O DESENHO: o caminho por operações tem CINCO motivos
 * para cair no de estado inteiro (`sem_pedido`, `perfis_mudaram`, `invalidas:*`,
 * blob ilegível, `ops_completo:false`) — e o de estado inteiro sobrescreve.
 * Fechar cada porta uma a uma não termina nunca. A versão barra a gravação
 * velha venha ela por qual caminho for.
 *
 * ⚠️ E NÃO se aplica ao caminho por operações, de propósito. Operações são
 * aditivas e não dependem de versão: "adicionei a transação X" continua
 * verdadeiro mesmo que a linha tenha mudado. Travar ali geraria 409 em toda
 * gravação simultânea LEGÍTIMA — o oposto do que o passo existe para resolver.
 *
 * Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Asserção sobre comportamento olha só código: os comentários deste projeto
// citam o próprio código que explicam, e isso já produziu falsos positivos —
// inclusive numa verificação de segurança.
const soCodigo = (txt) => txt.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

const SAVE = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8'))
const GET  = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/get-user-data/index.ts'), 'utf8'))
const DM   = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
const DASH = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))

describe('⭐ a trava vale SÓ no estado inteiro', () => {
  test('a condição exige explicitamente NÃO ter usado operações', () => {
    // Sem o `!viaOperacoes`, duas pessoas lançando ao mesmo tempo — o caso que
    // este passo veio resolver — passariam a receber 409 uma da outra.
    assert.match(SAVE, /if \(!viaOperacoes && baseVersao && existing\?\.last_modified &&/)
  })

  test('e compara com o que está gravado AGORA', () => {
    assert.match(SAVE, /String\(existing\.last_modified\) !== baseVersao/)
    assert.match(SAVE, /\.select\('user_id, data_json, last_modified'\)/)
  })

  test('recusa com 409 e código legível, e devolve a versão boa', () => {
    const bloco = SAVE.match(/if \(!viaOperacoes && baseVersao[\s\S]*?\n {4}\}/)[0]
    assert.match(bloco, /code: 'VERSAO_DESATUALIZADA'/)
    assert.match(bloco, /\}, 409, corsHeaders\)/)
    assert.match(bloco, /versao: existing\.last_modified/)
  })

  test('a recusa acontece ANTES de gravar', () => {
    const i = SAVE.indexOf("code: 'VERSAO_DESATUALIZADA'")
    const j = SAVE.indexOf('.update({ email: effectiveUserEmail')
    assert.ok(i > 0 && j > i, 'recusar depois de gravar não recusa nada')
  })

  test('compatível para trás: sem `base_versao`, não há checagem', () => {
    // Cliente com bundle velho em cache de Service Worker continua salvando
    // exatamente como antes.
    assert.match(SAVE, /const baseVersao = typeof \(body as any\)\?\.base_versao === 'string' \? \(body as any\)\.base_versao : null/)
  })
})

describe('a versão circula pelas duas pontas', () => {
  test('o load devolve a versão lida', () => {
    assert.match(GET, /versao: \(data as any\)\?\.last_modified \?\? null/)
  })

  test('o cliente guarda o que leu e manda no save', () => {
    assert.match(DM, /this\.#versao = typeof result\.versao === 'string' \? result\.versao : null/)
    assert.match(DM, /base_versao: this\.#versao/)
  })

  test('o save devolve a versão NOVA, e o cliente a adota', () => {
    // Sem isto, o save seguinte nasceria velho e levaria 409 — um por save,
    // para sempre.
    assert.match(SAVE, /success: true, versao: now/)
    assert.match(DM, /if \(typeof eco\?\.versao === 'string'\) this\.#versao = eco\.versao/)
  })

  test('logout zera a versão junto com o resto', () => {
    assert.match(DM, /this\.#versao\s+= null;/)
  })
})

describe('o que o cliente faz com o 409', () => {
  test('reconhece o código e avisa a tela', () => {
    assert.match(DM, /corpo\?\.code === 'VERSAO_DESATUALIZADA'/)
    assert.match(DM, /new CustomEvent\('ge:versao-conflito'\)/)
  })

  test('adota a versão boa que veio na recusa', () => {
    // Sem isto o cliente insistiria com a versão velha e levaria 409 de novo.
    const bloco = DM.match(/if \(saveResp\.status === 409\) \{[\s\S]*?\n {12}\}/)[0]
    assert.match(bloco, /this\.#versao = corpo\.versao/)
  })

  test('a tela busca o estado bom, pelo MESMO caminho do tempo real', () => {
    // Dois gatilhos, um caminho: o aviso do canal e a recusa por versão fazem a
    // mesma coisa. Dois caminhos divergiriam com o tempo, e o que divergisse
    // viraria o bug.
    assert.match(DASH, /document\.addEventListener\('ge:versao-conflito'/)
    assert.match(DASH, /_recarregarDoServidor\(null\)/)
    assert.match(DASH, /recarregar:\s+_recarregarDoServidor/)
  })

  test('e o usuário fica sabendo — não é silencioso', () => {
    const bloco = DASH.match(/addEventListener\('ge:versao-conflito'[\s\S]*?\n\}\);/)[0]
    assert.match(bloco, /mostrarNotificacao\(/)
  })

  test('409 de conflito NÃO é tratado como erro genérico de rede', () => {
    // O bloco do 409 vem antes do `!saveResp.ok`, senão cairia no caminho de
    // erro comum e a tela nunca saberia que precisa recarregar.
    const i = DM.indexOf("saveResp.status === 409")
    const j = DM.indexOf('if (!saveResp.ok)')
    assert.ok(i > 0 && j > i)
  })
})
