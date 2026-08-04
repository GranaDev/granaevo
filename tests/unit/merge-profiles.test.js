/**
 * MERGE POR PERFIL — casal e família parando de se sobrescrever.
 *
 * RELATADO PELO DONO (2026-08-04): "2 usuários não conseguem editar e salvar ao
 * mesmo tempo, um sempre sobrescreve o save do outro".
 *
 * Casal e família compartilham UMA linha em `user_data` (a do dono — o
 * convidado nunca cria registro próprio, e isso é intencional: é o que faz o
 * dado aparecer para os dois). Cada save reescrevia o ARRAY INTEIRO:
 *
 *   ela carrega [A,B] · ele carrega [A,B]
 *   ela edita B → grava [A(velho), B(novo)]
 *   ele edita A → grava [A(novo), B(VELHO)]   ← o trabalho dela morre
 *
 * Eles nem mexeram no mesmo perfil. O conflito era do FORMATO — e sumia sem
 * erro, sem aviso, sem log.
 *
 * Este arquivo testa a função DE VERDADE (transpilando o .ts com esbuild), e
 * não asserções sobre o texto-fonte: é a lógica que decide o destino de todo o
 * dado financeiro do app, e um teste que só lê strings não provaria nada.
 *
 * Roda no CI: node --test tests/unit/
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let mergeProfiles
before(async () => {
  const ts = readFileSync(join(RAIZ, 'supabase/functions/_shared/merge-profiles.ts'), 'utf8')
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
  const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  mergeProfiles = mod.mergeProfiles
})

// Perfis mínimos, com um marcador para saber QUAL versão sobreviveu.
const p = (id, marca) => ({ id, nome: `perfil ${id}`, transacoes: [{ v: marca }] })
const ids = (r) => r.profiles.map((x) => String(x.id))
const marca = (r, id) => r.profiles.find((x) => String(x.id) === id)?.transacoes[0].v

describe('o cenário relatado', () => {
  test('ele edita A, ela edita B — nada se perde', () => {
    // Disco tem a versão dela do B (ela salvou primeiro).
    const disco    = [p('A', 'velho'), p('B', 'DELA')]
    // Ele manda o array inteiro, com uma cópia VELHA do B (carregada antes).
    const dele     = [p('A', 'DELE'), p('B', 'velho')]
    // Mas ele só declara o que tocou.
    const r = mergeProfiles(disco, dele, ['A'])

    assert.equal(marca(r, 'A'), 'DELE', 'a edição dele tem que valer')
    assert.equal(marca(r, 'B'), 'DELA', 'a edição dela NÃO pode ser sobrescrita')
  })

  test('funciona igual com 4 perfis (plano família)', () => {
    const disco = [p('A', 'a1'), p('B', 'b1'), p('C', 'c1'), p('D', 'd1')]
    const vindo = [p('A', 'a1'), p('B', 'b1'), p('C', 'NOVO'), p('D', 'velho')]
    const r = mergeProfiles(disco, vindo, ['C'])
    assert.deepEqual(ids(r), ['A', 'B', 'C', 'D'])
    assert.equal(marca(r, 'C'), 'NOVO')
    for (const id of ['A', 'B', 'D']) {
      assert.equal(marca(r, id), disco.find((x) => x.id === id).transacoes[0].v, id)
    }
    assert.equal(r.preservados, 3)
  })
})

describe('exclusão precisa ser DECLARADA', () => {
  test('declarou e não mandou = apagar', () => {
    const r = mergeProfiles([p('A', 1), p('B', 2)], [p('A', 1)], ['A', 'B'])
    assert.deepEqual(ids(r), ['A'])
    assert.deepEqual(r.removidos, ['B'])
  })

  test('NÃO declarou e não mandou = preservar', () => {
    // A inversão de significado que torna esta mudança delicada: antes,
    // "perfil ausente do payload" queria dizer APAGADO. Agora quer dizer "não
    // mexi nele". Trocar uma pela outra sem cuidado apaga o perfil de alguém.
    const r = mergeProfiles([p('A', 1), p('B', 2)], [p('A', 1)], ['A'])
    assert.deepEqual(ids(r), ['A', 'B'])
    assert.deepEqual(r.removidos, [])
  })
})

describe('perfil novo', () => {
  test('entra quando declarado', () => {
    const r = mergeProfiles([p('A', 1)], [p('A', 1), p('C', 9)], ['C'])
    assert.deepEqual(ids(r), ['A', 'C'])
  })

  test('NÃO entra sem declaração — senão ressuscita o que outro apagou', () => {
    // Cliente com cópia velha ainda tem o perfil B, que outro membro apagou.
    // Ele não declara B; mandar B no array não pode trazê-lo de volta.
    const r = mergeProfiles([p('A', 1)], [p('A', 1), p('B', 2)], ['A'])
    assert.deepEqual(ids(r), ['A'])
  })
})

describe('a ordem do disco é preservada', () => {
  test('o array não é reordenado pelo save de outro membro', () => {
    // A lista de perfis é visível na UI. Reordenar a cada save alheio faria os
    // perfis dançarem na tela sem ninguém ter pedido.
    const disco = [p('A', 1), p('B', 2), p('C', 3)]
    const vindo = [p('C', 30), p('A', 10), p('B', 20)]
    const r = mergeProfiles(disco, vindo, ['B'])
    assert.deepEqual(ids(r), ['A', 'B', 'C'])
    assert.equal(marca(r, 'B'), 20)
  })
})

describe('bordas que não podem explodir', () => {
  test('nada declarado = nada muda (tudo preservado)', () => {
    const disco = [p('A', 1), p('B', 2)]
    const r = mergeProfiles(disco, [p('A', 99), p('B', 99)], [])
    assert.equal(marca(r, 'A'), 1)
    assert.equal(marca(r, 'B'), 2)
    assert.equal(r.preservados, 2)
  })

  test('disco vazio (primeiro save) só aceita o que foi declarado', () => {
    const r = mergeProfiles([], [p('A', 1), p('B', 2)], ['A', 'B'])
    assert.deepEqual(ids(r), ['A', 'B'])
  })

  test('ids numéricos e string são o mesmo perfil', () => {
    // O id vem de lugares diferentes no app; comparar tipos diferentes criaria
    // um perfil duplicado a cada save.
    const r = mergeProfiles([{ id: 1, transacoes: [{ v: 'disco' }] }],
                            [{ id: '1', transacoes: [{ v: 'novo' }] }], ['1'])
    assert.equal(r.profiles.length, 1)
    assert.equal(r.profiles[0].transacoes[0].v, 'novo')
  })

  test('declarar um id que não existe em lugar nenhum não cria nada', () => {
    const r = mergeProfiles([p('A', 1)], [p('A', 1)], ['Z'])
    assert.deepEqual(ids(r), ['A'])
  })
})

describe('o lado cliente — quem calcula o que foi tocado', () => {
  const DM = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')

  test('o cálculo mora no data-manager, não nas telas', () => {
    // Pedir a cada tela que declare o que tocou exigiria auditar dezenas de
    // pontos de mutação — e bastaria UM esquecido para o dado de outro membro
    // ser sobrescrito de novo, em silêncio. O data-manager é o ponto único por
    // onde todo save do app passa.
    assert.match(DM, /#perfisTocados\(profiles\)/)
    assert.match(DM, /touched_profile_ids: tocados/)
  })

  test('o retrato é tirado no load bem-sucedido', () => {
    assert.match(DM, /this\.#lastLoadOk = true;[\s\S]{0,200}this\.#tirarRetrato\(userData\.profiles\)/)
  })

  test('e ATUALIZADO após cada save bem-sucedido', () => {
    // Sem isto, o mesmo perfil seria declarado como tocado em todo save
    // seguinte — e declarar tudo é exatamente igual a substituir tudo, ou seja,
    // a proteção viraria enfeite.
    assert.match(DM, /this\.#lastSaveTime = new Date\(\);[\s\S]{0,300}this\.#tirarRetrato\(safeProfiles\)/)
  })

  test('perfil que sumiu do array é declarado (exclusão)', () => {
    // Para o servidor, ausência passou a significar "não mexi nele". Se o
    // cliente não declarar a exclusão, o perfil apagado voltaria.
    assert.match(DM, /for \(const id of this\.#retrato\.keys\(\)\) if \(!agora\.has\(id\)\) tocados\.add\(id\)/)
  })

  test('perfil que não serializa conta como tocado, nunca como intocado', () => {
    // Falhar para o lado de "mexi" só custa sobrescrever o próprio perfil.
    // Falhar para o lado de "não mexi" perderia a edição do usuário.
    assert.match(DM, /if \(json === null \|\| this\.#retrato\.get\(id\) !== json\) tocados\.add\(id\)/)
  })

  test('o retrato morre no reset (logout / troca de conta)', () => {
    assert.match(DM, /this\.#retrato\s+= new Map\(\);/)
  })

  test('o proxy repassa o corpo cru — o campo novo não se perde', () => {
    // api/user-data.js valida `profiles` e encaminha `raw`. Se um dia passar a
    // remontar o body campo a campo, o touched_profile_ids some no caminho e o
    // merge silenciosamente para de funcionar.
    const API = readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8')
    assert.match(API, /body:\s+raw,/)
  })
})

describe('a fiação no save-user-data', () => {
  const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')

  test('usa o módulo compartilhado, sem cópia local', () => {
    assert.match(EDGE, /import \{ mergeProfiles \} from '\.\.\/_shared\/merge-profiles\.ts'/)
  })

  test('SEM `touched_profile_ids` o comportamento é o de antes', () => {
    // É o que permite deployar o servidor sozinho sem mudar nada, e só depois
    // os clientes. Se isto cair, o deploy do servidor vira uma mudança de
    // comportamento silenciosa para todo mundo.
    assert.match(EDGE, /Array\.isArray\(\(body as any\)\?\.touched_profile_ids\)/)
    assert.match(EDGE, /let profilesFinais = profiles/)
  })

  test('a leitura do disco vem ANTES de cifrar', () => {
    // Ordem é o comportamento: cifrar antes de ler tornaria o merge impossível.
    const sel = EDGE.indexOf(".from('user_data')")
    const enc = EDGE.indexOf('await encryptData(')
    assert.ok(sel > 0 && enc > sel, 'o select precisa vir antes do encrypt')
  })

  test('o anti-wipe valida o resultado MESCLADO, não o payload cru', () => {
    // Com merge, um payload que traz um perfil só é normal. Conferir o payload
    // faria a guarda enxergar um falso wipe e recusar saves legítimos.
    assert.match(EDGE, /const incomingHasAnyData = \(profilesFinais as any\[\]\)\.some\(profileHasData\)/)
    assert.match(EDGE, /wouldWipe = profilesFinais\.length === 0/)
  })

  test('blob ilegível pula o merge em vez de mesclar às cegas', () => {
    assert.match(EDGE, /merge pulado: blob atual ilegível/)
  })

  test('o teto de perfis é reconferido no resultado', () => {
    const bloco = EDGE.slice(EDGE.indexOf('const r = mergeProfiles('))
    assert.match(bloco.slice(0, 400), /r\.profiles\.length > MAX_PROFILES/)
  })
})
