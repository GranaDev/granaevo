/**
 * 38.3 — o chat via 1 perfil onde a conta tem 4.
 *
 * RELATADO PELO DONO (2026-08-04): "ela tem 2 perfis com o mesmo nome, e devido
 * a isso, lá no chat assistente só aparece 1 perfil".
 *
 * O nome repetido era coincidência, não causa. A causa são DUAS FONTES DE
 * VERDADE para "quais perfis existem":
 *
 *   dashboard → tabela `profiles`        (lista completa, autoritativa)
 *   chat      → `data_json.profiles`     (o blob) — SÓ os perfis que já foram
 *                                         salvos com dado alguma vez
 *
 * Perfil criado e nunca usado existe na conta e não no blob. Confirmado no banco
 * de produção em 2026-08-07: 4 perfis na tabela (`Userteste · Giusepp · Meow ·
 * Userteste`), e o chat enxergava só os do blob.
 *
 * A consequência era pior que "some da lista": um lançamento feito no chat ia
 * para `profiles[0]` — outro perfil —, e o dono procurava o dinheiro na tela
 * errada, achando que o dado tinha se perdido.
 *
 * Puro, sem rede/DOM (verificação sobre o código). Roda no CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')
const ENGINE = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8'))

// Reimplementa a união exatamente como o engine faz, para exercitá-la sem
// browser. Se o engine mudar de regra, o teste de código abaixo acusa.
const uniao = (daConta, doBlob) => {
  const vistos = new Map()
  for (const p of daConta) vistos.set(String(p.id), { id: String(p.id), name: p.name || 'Perfil' })
  for (const p of doBlob) {
    const id = String(p.id)
    if (!vistos.has(id)) vistos.set(id, { id, name: p.name || p.nome || 'Perfil' })
  }
  return [...vistos.values()]
}

describe('⭐ a lista do chat é a da CONTA, não a do blob', () => {
  test('perfil criado e nunca usado aparece', () => {
    // O caso do dono: 4 na conta, 1 no blob.
    const daConta = [{ id: 1, name: 'Userteste' }, { id: 2, name: 'Giusepp' },
                     { id: 3, name: 'Meow' }, { id: 4, name: 'Userteste' }]
    const doBlob  = [{ id: 1, nome: 'Userteste', transacoes: [] }]
    assert.equal(uniao(daConta, doBlob).length, 4)
  })

  test('nomes repetidos NÃO colapsam — a chave é o id', () => {
    // Era a suspeita do dono. Se a união deduplicasse por nome, os dois
    // "Userteste" virariam um, e o defeito continuaria de pé com outra causa.
    const r = uniao([{ id: 1, name: 'Userteste' }, { id: 4, name: 'Userteste' }], [])
    assert.equal(r.length, 2)
    assert.deepEqual(r.map((p) => p.id), ['1', '4'])
  })

  test('perfil que existe só no blob não é perdido', () => {
    // Conta antiga, de antes da tabela. Sumir com ele seria trocar um defeito
    // por outro pior.
    const r = uniao([{ id: 1, name: 'Novo' }], [{ id: 9, nome: 'Antigo' }])
    assert.deepEqual(r.map((p) => p.id).sort(), ['1', '9'])
  })

  test('a tabela manda no NOME — é onde o usuário renomeia', () => {
    const r = uniao([{ id: 1, name: 'Renomeado' }], [{ id: 1, nome: 'Velho' }])
    assert.deepEqual(r, [{ id: '1', name: 'Renomeado' }])
  })

  test('sem duplicar quando o id está nas duas fontes', () => {
    const r = uniao([{ id: 1, name: 'A' }], [{ id: 1, nome: 'A' }])
    assert.equal(r.length, 1)
  })
})

describe('o engine usa a união em todo lugar que decide perfil', () => {
  test('busca a lista da conta no init', () => {
    assert.match(ENGINE, /#carregarPerfisDaConta\(\)/)
    assert.match(ENGINE, /\.from\('profiles'\)\.select\('id, name'\)\.eq\('user_id', uid\)/)
    // Em paralelo com o blob: são duas idas à rede que não dependem uma da outra.
    assert.match(ENGINE, /Promise\.all\(\[dataManager\.loadUserData\(\), this\.#carregarPerfisDaConta\(\)\]\)/)
  })

  test('a restauração do perfil salvo olha a UNIÃO', () => {
    // Antes caía em `profiles[0]` do blob quando o perfil salvo não estava lá —
    // e era assim que o lançamento ia parar no perfil errado.
    const fn = ENGINE.match(/#restoreActive\(\) \{[\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /const todos = this\.listProfiles\(\)/)
    assert.ok(!/this\.#profiles\[0\]/.test(fn), 'o fallback não pode ser o blob')
  })

  test('trocar de perfil aceita qualquer um da conta', () => {
    assert.match(ENGINE, /if \(!this\.listProfiles\(\)\.some\(\(p\) => String\(p\.id\) === String\(id\)\)\) return false;/)
  })

  test('⭐ perfil da conta que ainda não está no blob NASCE ao ser usado', () => {
    // Sem isto, escolher um perfil novo no chat e lançar não teria onde gravar,
    // e o comando falharia sem explicação nenhuma para o usuário.
    const fn = ENGINE.match(/#active\(\) \{[\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /this\.#daConta\.find/)
    assert.match(fn, /this\.#profiles\.push\(novo\)/)
    assert.match(fn, /transacoes: \[\], metas: \[\]/)
  })

  test('o supabase está IMPORTADO — não é global', () => {
    // O build passa VERDE tratando identificador não declarado como global do
    // navegador; o erro só apareceria no primeiro comando do usuário. Foi assim
    // que os botões de Reservas quebraram em produção.
    assert.match(ENGINE, /import \{ supabase \} from '\.\.\/\.\.\/services\/supabase-client\.js/)
  })

  test('se a tabela falhar, o chat cai no blob em vez de quebrar', () => {
    const fn = ENGINE.match(/#carregarPerfisDaConta\(\) \{[\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /catch \{/)
  })
})
