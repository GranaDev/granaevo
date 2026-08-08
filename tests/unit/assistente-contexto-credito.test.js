/**
 * C-1 (resto) — a continuação no CRÉDITO não herdava contexto.
 *
 * "comprei 900 parcelado em 3x" → "e mais 300" e o assistente reperguntava
 * tudo, porque `#lastLancamentoCmd` só era gravado por saída/entrada/reserva.
 *
 * A regra saiu do engine para `contexto-conversa.js` justamente para este
 * arquivo poder EXECUTÁ-LA. Testar o engine por leitura do fonte já passou
 * cinco vezes nesta base com o código quebrado.
 *
 * Puro, sem DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { guardarContexto, contextoValido, heranca, ehHandoff, CATS_HANDOFF,
         JANELA_CONTEXTO_MS } from '../../src/scripts/modules/assistant/contexto-conversa.js'
import { applyLancamento } from '../../src/scripts/modules/assistant/tx-builder.js'
import { toCommand } from '../../src/scripts/modules/assistant/normalize.js'
import { parseLocal, ehContinuacao } from '../../src/scripts/modules/assistant/parser-local.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')
const ENGINE = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8'))

describe('⭐ o crédito deixa contexto para a frase seguinte', () => {
  test('uma compra no cartão vira contexto de crédito', () => {
    const ctx = guardarContexto({ categoria: 'saida_credito', tipo: 'vestuario', descricao: 'Tênis', valor: 900 })
    assert.equal(ctx.categoria, 'saida_credito')
    assert.equal(heranca(ctx).categoria, 'saida_credito', 'a continuação tem de voltar pro crédito')
  })

  test('a continuação herda a categoria e o tipo', () => {
    const ctx = guardarContexto({ categoria: 'saida_credito', tipo: 'vestuario', valor: 900 })
    const h = heranca(ctx)
    assert.equal(h.categoria, 'saida_credito')
    assert.equal(h.tipo, 'vestuario')
  })

  test('⭐ NÃO herda parcelas — senão inventa um parcelamento que o usuário não pediu', () => {
    // "comprei 900 parcelado em 3x" → "e mais 300" viraria 3× de 100.
    const ctx = guardarContexto({ categoria: 'saida_credito', valor: 900, parcelas: 3 })
    assert.equal(ctx.parcelas, undefined, 'parcelas não podem sequer ser guardadas')
    assert.equal(heranca(ctx).parcelas, undefined)
    // E o comando montado a partir da herança sai à vista.
    assert.equal(toCommand({ ...heranca(ctx), intencao: 'lancar', valor: 300 }).parcelas, null)
  })

  test('⭐ NÃO herda o cartão — debitar o cartão errado calado é erro de dinheiro', () => {
    const ctx = guardarContexto({ categoria: 'saida_credito', valor: 900, cardId: 'c1' })
    assert.equal(ctx.cardId, undefined)
    assert.equal(heranca(ctx).cardId, undefined)
  })

  test('NÃO herda a descrição (regra que já valia, agora executada)', () => {
    const ctx = guardarContexto({ categoria: 'saida', descricao: 'pão', valor: 50 })
    assert.equal(heranca(ctx).descricao, undefined)
  })

  test('herda a meta em snake_case — é assim que o toCommand lê', () => {
    // `metaHint:` aqui compilaria e seria ignorado calado: a continuação de
    // reserva perderia a meta e viraria pergunta.
    const ctx = guardarContexto({ categoria: 'reserva', metaHint: 'Viagem', valor: 100 })
    assert.equal(heranca(ctx).meta_hint, 'Viagem')
    assert.equal(toCommand({ ...heranca(ctx), intencao: 'lancar', valor: 100 }).metaHint, 'Viagem')
  })
})

describe('a janela de contexto', () => {
  test('dentro da janela, o contexto vale', () => {
    const t0 = 1_000_000
    const ctx = guardarContexto({ categoria: 'saida_credito', valor: 900 }, t0)
    assert.ok(contextoValido(ctx, t0 + JANELA_CONTEXTO_MS - 1))
  })

  test('fora da janela, não vale — "e mais 30" não continua o mercado de ontem', () => {
    const t0 = 1_000_000
    const ctx = guardarContexto({ categoria: 'saida_credito', valor: 900 }, t0)
    assert.equal(contextoValido(ctx, t0 + JANELA_CONTEXTO_MS), null)
  })

  test('⭐ contexto sem `_em` REPROVA (NaN não pode virar "válido")', () => {
    // Aparelho que não recarregou, contexto gravado por versão antiga.
    assert.equal(contextoValido({ categoria: 'saida', _em: undefined }, Date.now()), null)
  })

  test('a janela é de 10 minutos', () => {
    assert.equal(JANELA_CONTEXTO_MS, 10 * 60 * 1000)
  })
})

describe('handoff: quem o applyLancamento se recusa a aplicar', () => {
  test('⭐ a lista bate com a realidade do tx-builder', () => {
    // Se alguém ensinar o applyLancamento a fazer crédito, este teste avisa
    // que CATS_HANDOFF ficou desatualizada — em vez de o desvio virar cruft.
    for (const cat of CATS_HANDOFF) {
      const p = { transacoes: [], metas: [], cartoesCredito: [{ id: 'c1', nomeBanco: 'Nu', faturas: {} }] }
      const r = applyLancamento(p, { categoria: cat, valor: 300, descricao: 'x', _confirmed: true })
      assert.equal(r.ok, false, `${cat} deveria ser handoff`)
      assert.equal(r.reason, 'handoff')
      assert.equal(p.transacoes.length, 0, 'e não pode gravar nada pelo caminho errado')
    }
  })

  test('crédito é handoff; saída e entrada não', () => {
    assert.equal(ehHandoff('saida_credito'), true)
    assert.equal(ehHandoff('saida'), false)
    assert.equal(ehHandoff('entrada'), false)
    assert.equal(ehHandoff(null), false)
  })
})

describe('as frases que abrem uma continuação', () => {
  // O portão real: só é continuação se o parser disser `valor_ambiguo` E o
  // texto tiver marcador. Testado com o parser de verdade.
  const continua = (t) => parseLocal(t).intencao === 'valor_ambiguo' && ehContinuacao(t)

  for (const f of ['e mais 300', 'e mais 300 reais', 'mais 300', 'e tambem 150',
                   'e outros 80', 'e outras 80', 'e outro 80', 'e 300']) {
    test(`"${f}" continua`, () => assert.equal(continua(f), true))
  }

  test('⭐ o plural "outros" não pode cair na armadilha do \\b', () => {
    // `outro\b` não casa "outros": o `s` fica dentro da palavra.
    assert.equal(continua('e outros 80'), true)
    assert.equal(continua('e outras 80'), true)
  })

  test('sem número não é continuação de lançamento', () => {
    assert.equal(ehContinuacao('mais alguma coisa'), false)
  })

  test('assunto novo não é continuação', () => {
    for (const f of ['gastei 50 no mercado', 'quanto gastei esse mes']) {
      assert.equal(continua(f), false, f)
    }
  })
})

describe('o engine liga as pontas', () => {
  test('⭐ o "de novo" desvia o crédito ANTES de chamar o applyLancamento', () => {
    // Sem o desvio, o usuário via "erro do sistema" numa operação que não
    // falhou. Ordem, não presença: asserta que o desvio vem antes.
    const bloco = ENGINE.slice(ENGINE.indexOf('async #repetirUltimo()'))
    const iDesvio = bloco.indexOf('if (ehHandoff(cmd.categoria)) return this.#doCredito(cmd);')
    const iApply  = bloco.indexOf('applyLancamento(profile,')
    assert.ok(iDesvio > 0, 'o desvio precisa existir')
    assert.ok(iApply > iDesvio, 'e vir antes do applyLancamento')
  })

  test('⭐ o contexto é gravado depois da compra existir, não no picker', () => {
    // No #doCredito a compra ainda não aconteceu (falta escolher o cartão).
    // Gravar lá deixaria contexto de uma compra que o usuário pode abandonar.
    const credito = ENGINE.slice(ENGINE.indexOf('async #doCredito(cmd)'), ENGINE.indexOf('async applyCredito('))
    assert.ok(!credito.includes('#lastLancamentoCmd'), 'o picker não grava contexto')
    const apply = ENGINE.slice(ENGINE.indexOf('async applyCredito('), ENGINE.indexOf('async #undoCredito('))
    assert.match(apply, /this\.#lastLancamentoCmd = guardarContexto\(\{ categoria: 'saida_credito'/)
    // E só depois do save ter dado certo.
    assert.ok(apply.indexOf('#lastLancamentoCmd') > apply.indexOf('const saved = await dataManager.saveUserData'))
  })

  test('não sobrou uma segunda cópia da regra no engine', () => {
    // A regra tinha três cópias; o crédito caiu fora das três.
    assert.ok(!/#lastLancamentoCmd = \{/.test(ENGINE), 'nenhuma gravação montada à mão')
    assert.match(ENGINE, /import \{ guardarContexto, contextoValido, heranca, ehHandoff, JANELA_CONTEXTO_MS \} from '\.\/contexto-conversa\.js'/)
  })
})
