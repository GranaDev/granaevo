/**
 * GranaEvo — Testes do normalize do assistente (a fronteira de sanitização)
 *
 * O normalize é o ponto ÚNICO onde os dois parsers (local e IA) convergem antes
 * de qualquer coisa tocar em dados. É a última linha: mesmo que a IA "invente" um
 * campo, é aqui que ele é domado.
 *
 * A trava de tokens de template nasceu de uma mudança real de superfície: quando
 * a descrição deixou de ser um rótulo de lista fechada ("Shopee") e passou a ser
 * TEXTO LIVRE do usuário (describe.js), ela virou entrada para o renderFormatted
 * do ui.js — que interpreta `*negrito*` e `{{fa-icone}}`. Não é XSS (o ui.js só
 * usa createTextNode/createElement e o faIcon tem whitelist), mas:
 *   • um "*" na descrição racha o pareamento do negrito e quebra a mensagem;
 *   • num perfil casal/família a descrição de um membro é renderizada na tela do
 *     outro — então não é só "o usuário se afetando".
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toCommand } from '../../src/scripts/modules/assistant/normalize.js'

const lancar = (over) => toCommand({
  intencao: 'lancar', categoria: 'saida', valor: 50, tipo: 'Mercado',
  descricao: 'Pão', confianca: 0.9, source: 'local', ...over,
})

describe('tokens de template não sobrevivem à fronteira', () => {
  test('asterisco é removido da descrição', () => {
    assert.equal(lancar({ descricao: 'pão * leite' }).descricao, 'pão  leite')
  })
  test('negrito injetado é neutralizado', () => {
    const d = lancar({ descricao: '*urgente* comprar' }).descricao
    assert.ok(!d.includes('*'), `sobrou asterisco: ${JSON.stringify(d)}`)
  })
  test('token de ícone injetado é neutralizado', () => {
    const d = lancar({ descricao: 'presente {{fa-skull}}' }).descricao
    assert.ok(!d.includes('{{'), `sobrou token de ícone: ${JSON.stringify(d)}`)
    assert.ok(!d.includes('}}'), `sobrou token de ícone: ${JSON.stringify(d)}`)
  })
  test('vale para todo campo de texto livre, não só a descrição', () => {
    const cmd = toCommand({
      intencao: 'lancar', categoria: 'reserva', valor: 10, confianca: 0.9,
      meta_hint: 'viagem *2026*', cartao_hint: '{{fa-bomb}}', conta_hint: 'luz *',
      lembrete_texto: 'pagar *tudo*',
    })
    for (const [campo, v] of Object.entries({
      metaHint: cmd.metaHint, cartaoHint: cmd.cartaoHint,
      contaHint: cmd.contaHint, lembreteTexto: cmd.lembreteTexto,
    })) {
      if (typeof v === 'string') {
        assert.ok(!v.includes('*') && !v.includes('{{'), `${campo} passou token: ${JSON.stringify(v)}`)
      }
    }
  })
  test('texto normal atravessa intacto — a trava não é agressiva', () => {
    assert.equal(lancar({ descricao: 'Fita de led e tinta branca' }).descricao, 'Fita de led e tinta branca')
    assert.equal(lancar({ descricao: 'Ração pro cachorro' }).descricao, 'Ração pro cachorro')
  })
})

describe('a descrição livre continua sendo validada como antes', () => {
  test('é aparada e limitada a 120 chars', () => {
    const d = lancar({ descricao: '  ' + 'a'.repeat(300) + '  ' }).descricao
    assert.equal(d.length, 120)
  })
  test('sem descrição cai no rótulo do tipo (comportamento correto p/ "gastei 50")', () => {
    assert.equal(lancar({ descricao: null }).descricao, 'Mercado')
  })
})

describe('defesa em profundidade: a IA não escapa das whitelists', () => {
  test('categoria inventada vira null', () => {
    assert.equal(lancar({ categoria: 'transferencia_pix' }).categoria, null)
  })
  test('valor negativo/absurdo/NaN é descartado', () => {
    for (const v of [-5, 0, 1e12, NaN, Infinity, 'muito']) {
      assert.equal(lancar({ valor: v }).valor, null, `valor ${v} passou`)
    }
  })
  test('consulta_alvo inventado cai no default', () => {
    const cmd = toCommand({ intencao: 'consultar', consulta_alvo: 'senha_do_banco', confianca: 0.9 })
    assert.equal(cmd.consultaAlvo, 'gasto')
  })
  test('periodo inventado vira null', () => {
    const cmd = toCommand({ intencao: 'consultar', periodo: 'desde_sempre_mesmo', confianca: 0.9 })
    assert.equal(cmd.periodo, null)
  })
  test('data_override fora do formato vira null', () => {
    assert.equal(lancar({ data_override: '2026-13-45' }).dataOverride, null)
    assert.equal(lancar({ data_override: '16/07/2026' }).dataOverride, '16/07/2026')
  })
  test('nunca lança, seja qual for o lixo', () => {
    for (const v of [null, undefined, 'texto', 42, [], { intencao: {} }]) {
      assert.doesNotThrow(() => toCommand(v))
    }
  })
})
