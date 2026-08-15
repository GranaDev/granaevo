/**
 * GUARDA DO MONTE-QUE-NÃO-CARREGOU — o save que apagava dado no boot.
 *
 * MEDIDO em produção: o blob encolhia e voltava ao tamanho exato (A→B→A) em menos
 * de 3 minutos — 245 vezes numa conta real desde fevereiro/2026, swing até 53 KB.
 * `salvarDados()` monta o perfil a partir de variáveis de módulo que nascem
 * vazias; um save disparado antes de elas carregarem grava o perfil mutilado.
 *
 * ⚠️ DUAS TENTATIVAS ANTERIORES FALHARAM (bf20dd3, 4b052c0). As duas puseram a
 * guarda em `dashboard.js` comparando com `_allProfilesData` — e as duas foram
 * NO-OP, porque durante o boot esse cache também está vazio: a guarda comparava
 * duas fontes ambas vazias e se pulava sozinha. Estes testes existem para que a
 * terceira não repita o erro.
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

const DM   = semComentarios(readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8'))
const DASH = semComentarios(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))

const bloco = (src, ini, fim) => {
  const i = src.indexOf(ini); assert.ok(i !== -1, `não achei o início: ${ini}`)
  const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
  return src.slice(i, j)
}

describe('guarda do monte-que-não-carregou', () => {
  test('mede contra o #retrato, não contra _allProfilesData', () => {
    // O #retrato é tirado dentro do loadUserData(), então já está populado antes
    // de qualquer save poder disparar. Foi essa a diferença entre funcionar e ser
    // no-op nas duas tentativas anteriores.
    const g = bloco(DM, 'const CAMPOS_QUE_NAO_ESVAZIAM', 'const sombra = await this.#derivarOperacoes')
    assert.match(g, /this\.#retrato\.get\(/,
      'a guarda parou de medir contra o retrato — volta a ser no-op no boot')
    assert.doesNotMatch(g, /_allProfilesData/,
      'voltou a usar o cache do dashboard, que está VAZIO durante o boot')
  })

  test('a guarda NÃO mora mais no dashboard.js', () => {
    assert.ok(!DASH.includes('SAVE_MOUNT_001'),
      'a guarda no-op voltou para o dashboard: lá ela se pula sozinha no boot')
  })

  test('cobre os cinco campos que nunca esvaziam de verdade', () => {
    const g = bloco(DM, 'const CAMPOS_QUE_NAO_ESVAZIAM', 'const _temConteudo')
    for (const campo of ['orcamentos', 'tiposPersonalizados', 'conquistas', 'config', 'desafios'])
      assert.ok(g.includes(campo), `"${campo}" ficou de fora — foi um dos que oscilaram`)
  })

  test('NÃO guarda as coleções financeiras (elas podem esvaziar de verdade)', () => {
    // O usuário pode apagar a última transação. Guardar `transacoes` aqui
    // bloquearia exclusão legítima — trocaria perda por impossibilidade de apagar.
    const g = bloco(DM, 'const CAMPOS_QUE_NAO_ESVAZIAM', 'const _temConteudo')
    for (const col of ['transacoes', 'metas', 'contasFixas', 'cartoesCredito', 'assinaturas'])
      assert.ok(!g.includes(col),
        `"${col}" entrou na lista: o usuário não conseguiria mais apagar o último item`)
  })

  test('sabe medir vazio em objeto, não só em array', () => {
    const f = bloco(DM, 'const _temConteudo = (v) =>', 'for (const p of safeProfiles)')
    assert.match(f, /Array\.isArray\(v\)/, 'perdeu o caso do array')
    assert.match(f, /Object\.keys\(v\)/,   'perdeu o caso do objeto')
  })

  test('recusa o save de verdade, não apenas loga', () => {
    // Recorte apertado: a 1ª versão deste teste capturava `return false` de outras
    // validações e passava com a guarda mutilada.
    const i = DM.indexOf('Montagem incompleta')
    assert.ok(i > 0, 'a mensagem da guarda mudou — reveja este teste junto')
    assert.match(DM.slice(i, i + 220), /return false/,
      'só logar deixa o save seguir e apagar o dado')
  })

  test('perfil novo (sem retrato) não é bloqueado', () => {
    const g = bloco(DM, 'for (const p of safeProfiles)', 'const sombra = await')
    assert.match(g, /if \(bruto === undefined\) continue/,
      'sem esta linha, o primeiro save de um perfil novo seria recusado para sempre')
  })
})
