/**
 * GUARDA DE MONTAGEM INCOMPLETA — o save que apagava dado no boot.
 *
 * MEDIDO em produção (2026-08-15): o blob encolhia e voltava ao tamanho exato em
 * menos de 3 minutos — 245 vezes numa conta real, swing de até 53 KB, desde
 * fevereiro/2026. `salvarDados()` monta o perfil a partir das variáveis de módulo
 * vivas; um save disparado antes de elas serem populadas grava coleção vazia.
 *
 * A guarda NÃO é uma flag de "pronto" — flag fail-closed que alguém esqueça de
 * soltar faz o usuário parar de salvar para sempre. Ela compara duas fontes que
 * têm de concordar: `_allProfilesData` (do servidor) e a memória viva.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const semComentarios = (t) => t.split('\n')
  .filter((l) => { const s = l.trim(); return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) })
  .join('\n')

const DASH = semComentarios(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))

const bloco = (src, ini, fim) => {
  const i = src.indexOf(ini); assert.ok(i !== -1, `não achei o início: ${ini}`)
  const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
  return src.slice(i, j)
}

describe('guarda de montagem incompleta', () => {
  test('roda DENTRO de salvarDados, antes de montar dadosPerfil', () => {
    const fn = bloco(DASH, 'async function salvarDados()', 'const dadosPerfil = {')
    assert.match(fn, /SAVE_MOUNT_001/,
      'a guarda saiu do caminho do save — o boot volta a poder gravar coleção vazia')
  })

  test('compara a memória viva contra _allProfilesData (não é flag de pronto)', () => {
    const g = bloco(DASH, 'const _noCache = _allProfilesData.find', 'const dadosPerfil = {')
    assert.match(g, /_allProfilesData\.find/, 'parou de consultar o cache do servidor')
    // A condição é: cheio no cache E vazio na memória. As duas metades importam —
    // só a primeira bloquearia todo save; só a segunda não bloquearia nenhum.
    assert.match(g, /_cheio\(_noCache\[_campo\]\)\s*&&\s*!_cheio\(_memoria\)/,
      'a condição da guarda mudou de forma: ela precisa exigir cache COM conteúdo ' +
      'E memória SEM conteúdo, nessa conjunção')
    assert.doesNotMatch(g, /_perfilPronto|_montagemConcluida/,
      'virou flag de "pronto": fail-closed, e um caminho que esqueça de soltá-la ' +
      'para o save do usuário para sempre')
  })

  test('cobre TODO campo que vem de variável de módulo, não só as coleções', () => {
    // A 1ª versão desta guarda cobria só as 5 coleções financeiras e NÃO resolveu:
    // o reteste em produção manteve a oscilação de ±500 B. `dadosPerfil` grava dez
    // campos, e os cinco que faltavam (`orcamentos`, `tiposPersonalizados`,
    // `conquistas`, `config`, `desafios`) nascem vazios do mesmo jeito. Um campo
    // esquecido aqui é uma porta silenciosa: o dado some sem erro.
    const g = bloco(DASH, 'const _vivas = {', 'const _cheio =')
    for (const campo of [
      'transacoes', 'metas', 'contasFixas', 'cartoesCredito', 'assinaturas',
      'orcamentos', 'tiposPersonalizados', 'conquistas', 'config', 'desafios',
    ]) assert.ok(g.includes(campo), `"${campo}" ficou de fora da guarda`)
  })

  test('sabe medir "vazio" em objeto, não só em array', () => {
    // `orcamentos`, `conquistas` e `config` são objetos; `desafios` é objeto de
    // arrays. Checar só `.length` os trataria como sempre-vazios e a guarda
    // bloquearia todo save — ou como sempre-cheios e não bloquearia nenhum.
    const f = bloco(DASH, 'const _cheio = (v) =>', 'for (const [_campo')
    assert.match(f, /Array\.isArray\(v\)/, 'perdeu o caso do array')
    assert.match(f, /Object\.(values|keys)\(v\)/, 'perdeu o caso do objeto')
  })

  test('recusa o save (return false), não apenas loga', () => {
    // ⚠️ Recorte APERTADO de propósito. A primeira versão deste teste ia de
    // SAVE_MOUNT_001 até `const dadosPerfil = {` — e capturava os `return false`
    // das validações de limite que vêm depois. Passava com a guarda mutilada.
    // Provado por mutação: agora reprova quando o `return false` sai.
    const i = DASH.indexOf('gravar apagaria o dado')
    assert.ok(i > 0, 'a mensagem da guarda mudou — reveja este teste junto')
    const logo_apos = DASH.slice(i, i + 120)
    assert.match(logo_apos, /return false/,
      'só logar deixa o save seguir e apagar o dado — o log não é a guarda')
  })
})
