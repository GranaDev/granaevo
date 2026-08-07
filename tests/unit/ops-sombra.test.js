/**
 * 37.1b — a fase de sombra: as operações viajam, o servidor ignora.
 *
 * O ganho não é funcional, é de confiança. O cliente aplica o próprio diff sobre
 * o retrato e confere que o resultado é idêntico ao estado atual. Se bater
 * sempre, em produção, com dados reais, então a derivação está certa — e só aí
 * o servidor passa a aplicar operações em vez de substituir tudo.
 *
 * Ligar o servidor direto seria apostar que o diff está certo num caminho que
 * grava todo o dinheiro do app.
 *
 * O data-manager depende de `window` e de rede, então aqui a verificação é sobre
 * o CÓDIGO (ordem e condições) mais uma simulação do autoteste com o mesmo par
 * de funções que ele usa. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { diffColecao, aplicarOperacoes, comEndereco } from '../../src/scripts/modules/diff-registros.js'
import { serializarEstavel, carimbarNovos } from '../../src/scripts/modules/registro-id.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DM = readFileSync(join(RAIZ, 'src/scripts/modules/data-manager.js'), 'utf8')

const tx = (id, over = {}) => ({
  id, categoria: 'saida', tipo: 'Mercado', descricao: 'Feira',
  valor: 50, data: '07/08/2026', hora: '10:00:00', metaId: null, ...over,
})

/** O autoteste, exatamente como o data-manager o faz. */
const bate = (antes, depois) => {
  const d = diffColecao(antes, depois)
  if (d.ok !== true) return { ok: false, motivo: d.motivo }
  const refeito = aplicarOperacoes(antes || [], d)
  return {
    ok: serializarEstavel(refeito) === serializarEstavel(depois || []),
    n: d.ops.length,
  }
}

describe('o autoteste bate nos caminhos reais do app', () => {
  const casos = {
    'lançar uma transação (push)':       [[tx('a')], [tx('a'), tx('b')]],
    'lançar duas seguidas':              [[tx('a')], [tx('a'), tx('b'), tx('c')]],
    'excluir uma do meio':               [[tx('a'), tx('b'), tx('c')], [tx('a'), tx('c')]],
    'editar valor':                      [[tx('a')], [tx('a', { valor: 999 })]],
    'desfazer exclusão (splice no meio)': [[tx('a'), tx('c')], [tx('a'), tx('b'), tx('c')]],
    'importar extrato (vários no fim)':  [[tx('a')], [tx('a'), tx('i1'), tx('i2'), tx('i3')]],
    'primeiro save da conta':            [[], [tx('a'), tx('b')]],
    'sessão sem mexer em nada':          [[tx('a')], [tx('a')]],
  }
  for (const [nome, [antes, depois]] of Object.entries(casos)) {
    test(nome, () => assert.equal(bate(antes, depois).ok, true, nome))
  }

  test('e o diff é MUITO menor que o estado — é o ponto do passo', () => {
    const antes = Array.from({ length: 800 }, (_, i) => tx(`t${i}`))
    const depois = [...antes, tx('novo')]
    const r = bate(antes, depois)
    assert.equal(r.ok, true)
    assert.equal(r.n, 1, '800 transações no estado, 1 operação no diff')
  })
})

describe('o autoteste RECLAMA quando não deveria confiar', () => {
  test('transação sem id derruba a derivação daquele perfil', () => {
    // Depois do 37.0 isso não deveria acontecer — se acontecer, é sinal de um
    // ponto de criação novo que escapou do carimbo, e a sombra vai contar.
    const r = bate([tx('a')], [tx('a'), { valor: 5, descricao: 'sem id' }])
    assert.equal(r.ok, false)
    assert.equal(r.motivo, 'sem_id')
  })

  test('reordenação é o caso conhecido em que a reconstrução diverge', () => {
    // Não é recusa do diff (ele diz "nada mudou"); é o autoteste percebendo que
    // aplicar esse "nada" não reproduz o estado. É exatamente o que a sombra
    // existe para medir em produção.
    const d = diffColecao([tx('a'), tx('b')], [tx('b'), tx('a')])
    assert.equal(d.ok, true)
    assert.equal(d.ops.length, 0)
    assert.equal(bate([tx('a'), tx('b')], [tx('b'), tx('a')]).ok, false)
  })

  test('a rede de ids do 37.0 é o que mantém a sombra confiável', () => {
    // Com o carimbo, o mesmo cenário que falhava passa a bater.
    const perfil = { id: 'p1', transacoes: [tx('a'), { valor: 5, descricao: 'nova' }] }
    carimbarNovos([perfil])
    assert.equal(bate([tx('a')], perfil.transacoes).ok, true)
  })
})

describe('como o data-manager liga isso — ordem e condições', () => {
  test('a sombra é derivada DEPOIS de saber quem foi tocado', () => {
    const i = DM.indexOf('this.#perfisTocados(safeProfiles)')
    const j = DM.indexOf('this.#derivarOperacoes(safeProfiles, tocados)')
    assert.ok(i > 0 && j > i, 'derivar precisa do conjunto de tocados')
  })

  test('as operações vão no payload, e o servidor ainda não as usa', () => {
    assert.match(DM, /profile_ops:\s*sombra\.ops/)
    assert.match(DM, /ops_completo:\s*sombra\.completo/)
    const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
    assert.ok(!/profile_ops/.test(EDGE),
      'a Edge passou a ler profile_ops — isto deixou de ser fase de sombra (é o 37.2a)')
  })

  test('a sombra NUNCA pode ser o motivo de um save falhar', () => {
    // Conta grande: o 1º save da sessão descreve todas as transações, e o
    // payload passa a carregar o estado E as operações. Se estourar o teto, a
    // sombra sai e o save segue como sempre foi.
    const i = DM.indexOf('serialized.length > MAX_PAYLOAD_BYTES && dataToSave.profile_ops.length > 0')
    const j = DM.indexOf('delete dataToSave.profile_ops')
    assert.ok(i > 0 && j > i, 'falta a válvula de escape do payload')
  })

  test('divergência é relatada UMA vez por sessão, sem id de perfil', () => {
    // Um defeito sistemático relataria a cada save e viraria enxurrada no
    // Sentry. E o que sobe é motivo + contagem: nada do dinheiro do usuário.
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /#opsAvisado = true/)
    assert.match(fn, /captureError\(/)
    const ctx = fn.match(/captureError\([\s\S]*?\}\);/)[0]
    assert.ok(!/perfil_id|profileId|\bid\b\s*:/.test(ctx), 'contexto não pode levar id de perfil')
    assert.ok(!/valor|descricao|transacoes\[/.test(ctx), 'contexto não pode levar dado financeiro')
  })

  test('telemetria quebrada não derruba o save', () => {
    const fn = DM.match(/#derivarOperacoes\([\s\S]*?\n {4}\}/)[0]
    assert.match(fn, /captureError[\s\S]*?\} catch \{/)
  })
})

describe('o save do unload também declara o que tocou', () => {
  // Só o corpo de saveImmediate — asserção sobre o arquivo inteiro passaria por
  // causa do saveUserData, que é outro caminho.
  const IMEDIATO = DM.slice(DM.indexOf('async saveImmediate('), DM.indexOf('async saveImmediate(') + 2500)

  test('manda touched_profile_ids — sem ele a Edge substitui TUDO', () => {
    // Para a Edge, corpo sem `touched_profile_ids` significa "substitua tudo"
    // (compatibilidade com clientes antigos). Este caminho mandava só
    // `{profiles}`: fechar a aba desligava o merge por perfil e sobrescrevia o
    // trabalho dos outros membros da conta.
    assert.match(IMEDIATO, /touched_profile_ids:\s*this\.#perfisTocados\(profilesData\)/)
  })

  test('e carimba os ids ANTES de serializar', () => {
    const i = IMEDIATO.indexOf('carimbarNovos(profilesData)')
    const j = IMEDIATO.indexOf('JSON.stringify({')
    assert.ok(i > 0, 'o save do unload precisa carimbar ids como o save normal')
    assert.ok(j > i, 'carimbar depois de serializar não carimba nada')
  })

  test('a Edge realmente trata ausência como "substitua tudo"', () => {
    // A asserção acima só vale por causa desta. Se a Edge mudar de regra, o
    // teste de cima deixa de ser sobre o que importa.
    const EDGE = readFileSync(join(RAIZ, 'supabase/functions/save-user-data/index.ts'), 'utf8')
    assert.match(EDGE, /COMPAT[ÍI]VEL PARA TR[ÁA]S/)
    assert.match(EDGE, /let profilesFinais = profiles/)
  })
})
