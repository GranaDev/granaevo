/**
 * UM VALOR, DOIS EVENTOS — a classe que registrava metade do que a pessoa disse.
 *
 * PEDIDO DO DONO (2026-08-04): *"retirei 50 reais da reserva e usei pra pagar um
 * boleto"* deve perguntar de qual reserva, lançar a retirada, e **em seguida**
 * lançar uma saída de "Boleto".
 *
 * O `splitCompound` não cobria: ele exige que cada pedaço tenha o SEU valor
 * ("gastei 50 no mercado e 30 na farmácia"). Aqui o valor é um só e aparece uma
 * vez — o dinheiro sai de um lugar e vai para outro.
 *
 * A medição achou três irmãos, e um é pior que o caso relatado:
 *   "vendi o celular por 500 e guardei"   → gravava a RESERVA e não a venda:
 *                                           dinheiro aparecendo do nada
 *   "ganhei 200 e gastei tudo no mercado" → gravava só a entrada
 *   "recebi 100 e paguei a conta"         → não gravava NADA
 *
 * O RISCO desta feature é o oposto do bug: duplicar lançamento. Por isso os
 * controles negativos aqui pesam mais que os acertos.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRetiradaComUso } from '../../src/scripts/modules/assistant/parser-local.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8')

describe('o caso relatado', () => {
  const r = parseRetiradaComUso('retirei 50 reais da reserva e usei pra pagar um boleto')

  test('reconhece as duas pernas', () => {
    assert.ok(r, 'a frase inteira precisa ser entendida')
    assert.equal(r.origem, 'retirada_reserva')
    assert.equal(r.valor, 50)
    assert.equal(r.uso.categoria, 'saida')
  })

  test('a descrição do gasto é "Boleto", não a frase inteira', () => {
    // Sem limpar o conectivo, saía "Usei pra um boleto" no extrato.
    assert.equal(r.uso.descricao, 'Boleto')
  })

  test('e a categoria do boleto é lida pelas keywords normais', () => {
    assert.equal(r.uso.tipo, 'Conta fixa')
  })
})

describe('os irmãos que a medição achou', () => {
  test('"vendi o celular por 500 e guardei" — entrada + reserva', () => {
    // O pior dos três: gravava a reserva e NÃO a venda. O dinheiro aparecia
    // no cofrinho vindo do nada.
    const r = parseRetiradaComUso('vendi o celular por 500 e guardei')
    assert.equal(r?.origem, 'entrada')
    assert.equal(r?.uso.categoria, 'reserva')
    assert.equal(r?.valor, 500)
  })

  test('"ganhei 200 e gastei tudo no mercado" — entrada + saída', () => {
    const r = parseRetiradaComUso('ganhei 200 e gastei tudo no mercado')
    assert.equal(r?.origem, 'entrada')
    assert.equal(r?.uso.categoria, 'saida')
    assert.equal(r?.uso.tipo, 'Mercado')
  })

  test('"tirei 100 da reserva e paguei a luz" — nem categoria tinha', () => {
    const r = parseRetiradaComUso('tirei 100 da reserva e paguei a luz')
    assert.equal(r?.origem, 'retirada_reserva')
    assert.equal(r?.uso.tipo, 'Conta fixa')
  })

  test('"pra comprar" também é destino, não só "e usei"', () => {
    const r = parseRetiradaComUso('tirei 200 da caixinha pra comprar um presente')
    assert.equal(r?.uso.tipo, 'Presente')
  })
})

describe('CONTROLE NEGATIVO — duplicar é pior que não entender', () => {
  test('DOIS valores nunca entram aqui', () => {
    // "recebi 2000 de salário e guardei 500" são dois eventos com valores
    // próprios: é composta comum, e o splitCompound já trata. Interferir
    // duplicaria lançamento.
    for (const t of ['recebi 2000 de salario e guardei 500',
                     'gastei 50 no mercado e 30 na farmacia',
                     'gastei 10 na padaria, 10 no mercado e 10 na gasolina']) {
      assert.equal(parseRetiradaComUso(t), null, t)
    }
  })

  test('frase simples continua simples', () => {
    for (const t of ['tirei 100 da reserva', 'guardei 100 na reserva',
                     'gastei 50 no mercado', 'recebi 2000']) {
      assert.equal(parseRetiradaComUso(t), null, t)
    }
  })

  test('sem valor, nada acontece', () => {
    assert.equal(parseRetiradaComUso('tirei da reserva e paguei a luz'), null)
  })

  test('"guardei" no destino vira RESERVA, não despesa', () => {
    // Sem distinguir, o dinheiro poupado seria registrado como gasto e sumiria.
    const r = parseRetiradaComUso('recebi 300 e guardei')
    assert.equal(r?.uso.categoria, 'reserva')
    assert.equal(r?.uso.tipo, null, 'reserva não tem tipo de gasto')
  })
})

describe('a fiação no engine', () => {
  test('vem ANTES do parser normal', () => {
    // O parser normal enxerga só a primeira perna e descarta o resto da frase.
    const i = ENGINE.indexOf('parseRetiradaComUso(text)')
    const j = ENGINE.indexOf('const local = parseLocal(text)')
    assert.ok(i > 0 && j > i, 'a detecção precisa vir antes do parseLocal')
  })

  test('a retirada carrega o uso ATRAVÉS da pergunta "de qual reserva?"', () => {
    // Sem isso, a 2ª metade da frase morria no picker — que é justamente o
    // fluxo que o dono descreveu: perguntar a reserva e depois lançar o gasto.
    assert.match(ENGINE, /_aposUso: comUso\.uso/)
    assert.match(ENGINE, /aposUso: cmd\._aposUso \?\? null/)
    const UI = readFileSync(join(RAIZ, 'src/scripts/pages/assistente.js'), 'utf8')
    assert.match(UI, /aposUso: retirada\.aposUso/)
  })

  test('o gasto só entra DEPOIS de a retirada estar salva', () => {
    // Se o gasto falhar, a retirada continua correta e o usuário refaz só o
    // que faltou — melhor que desfazer as duas e não saber qual quebrou.
    const salvou = ENGINE.indexOf('const saved = await dataManager.saveUserData(this.#profiles);',
                                  ENGINE.indexOf('applyRetirada(profile, cmd)'))
    const gasto  = ENGINE.indexOf('if (cmd._aposUso) {')
    assert.ok(salvou > 0 && gasto > salvou, 'o uso precisa vir depois do save da retirada')
  })

  test('as duas pernas usam o MESMO valor', () => {
    assert.match(ENGINE, /valor: cmd\.valor,\s+\/\/ o MESMO dinheiro que saiu da reserva/)
    assert.match(ENGINE, /valor: comUso\.valor,\s+\/\/ o MESMO dinheiro que entrou/)
  })
})
