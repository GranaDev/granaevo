/**
 * C-1 — memória de conversa do assistente.
 *
 * O defeito: cada mensagem era um universo isolado. Depois de "gastei 50 no
 * mercado", um "e mais 30" chegava sem direção e o assistente perguntava
 * "foi gasto ou entrada?" — a pergunta cuja resposta ele acabara de ouvir.
 *
 * O risco de consertar isso é maior que o defeito: herdar a direção errada
 * grava dinheiro que não existe, e o usuário só descobre no fim do mês sem
 * pista de onde veio. Por isso a herança exige marcador EXPLÍCITO e uma janela
 * de tempo — e é isso que este arquivo tranca.
 *
 * Puro, sem rede/DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLocal, ehContinuacao, descricaoVazia } from '../../src/scripts/modules/assistant/parser-local.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8')

// Os comentários deste projeto citam o próprio código que explicam; casar a
// asserção com um comentário já deu falso "passou" antes. Só o código.
const CODIGO = ENGINE.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

describe('C-1 — o que conta como continuação', () => {
  test('marcador explícito + valor novo é continuação', () => {
    for (const t of ['e mais 30', 'mais 20', 'também 15', 'e 30', 'e outro de 40', 'e mais 30 ontem']) {
      assert.ok(ehContinuacao(t), `deveria ser continuação: ${t}`)
    }
  })

  test('frase que se explica sozinha NÃO é continuação', () => {
    // Tem verbo e direção própria — herdar aqui seria sobrepor o que o usuário disse.
    assert.ok(!ehContinuacao('gastei 50 no mercado'))
  })

  test('valor solto NÃO é continuação — continua virando pergunta', () => {
    // O "e" é o consentimento. Sem ele o assistente não adivinha a direção,
    // porque um palpite errado aqui vira transação errada gravada em silêncio.
    assert.ok(!ehContinuacao('30'))
    assert.ok(!ehContinuacao('30 na farmacia'))
  })

  test('sem número não é continuação de lançamento', () => {
    assert.ok(!ehContinuacao('mais alguma coisa'))
    assert.ok(!ehContinuacao('e no mes passado?'))
  })

  test('parcelamento fica de fora — tem mecânica própria', () => {
    // "e mais 3x de 40" já é resolvido como saida_credito pelo parser; deixar a
    // continuação capturá-lo transformaria uma compra parcelada em uma à vista.
    assert.ok(!ehContinuacao('e mais 3x de 40'))
    assert.equal(parseLocal('e mais 3x de 40').categoria, 'saida_credito')
  })

  test('frase longa traz assunto novo', () => {
    assert.ok(!ehContinuacao('e mais 30 que gastei no mercado da esquina ontem'))
  })
})

describe('C-1 — a descrição nunca vira lixo', () => {
  test('marcador de ligação não descreve nada', () => {
    // Sem isto, "também 15" viraria uma transação chamada "Também" na lista.
    for (const d of ['Também', 'Outro', 'E', 'De', '', null, undefined]) {
      assert.ok(descricaoVazia(d), `deveria ser vazia: ${JSON.stringify(d)}`)
    }
  })

  test('descrição de verdade é preservada', () => {
    for (const d of ['Mercado', 'Fita de led', 'Padaria do zé']) {
      assert.ok(!descricaoVazia(d), `não deveria ser vazia: ${d}`)
    }
  })

  test('o parser realmente produz esse lixo (é por isso que a peneira existe)', () => {
    // Prova que o problema é real, não hipotético: sem a peneira o campo
    // descrição destas duas frases chega assim no lançamento.
    assert.equal(parseLocal('também 15').descricao, 'Também')
    assert.equal(parseLocal('e outro de 40').descricao, 'Outro')
  })
})

describe('C-1 — o alvo é exatamente o valor sem direção', () => {
  test('"e mais 30" chega como valor_ambiguo com o valor lido', () => {
    const p = parseLocal('e mais 30')
    assert.equal(p.intencao, 'valor_ambiguo')
    assert.equal(p.valor, 30)
    assert.equal(p.categoria, null)
  })

  test('quando a própria frase diz a categoria, não há o que herdar', () => {
    // "e mais 30 na farmacia" já sai resolvido — a continuação nem é consultada.
    const p = parseLocal('e mais 30 na farmacia')
    assert.equal(p.intencao, 'lancar')
    assert.equal(p.categoria, 'saida')
    assert.equal(p.tipo, 'Farmácia')
  })
})

describe('C-1 — a fiação no engine', () => {
  test('a herança está ligada ao valor_ambiguo + marcador', () => {
    assert.match(CODIGO, /local\.intencao === 'valor_ambiguo' && ehContinuacao\(text\)/)
  })

  test('vem DEPOIS do comerciante aprendido e ANTES da IA', () => {
    // Ordem é o comportamento: o histórico do usuário (B12) é sinal mais forte
    // que a frase anterior — "e mais 30 no ifood" merece a categoria do ifood.
    // E tudo isto precisa acontecer antes de gastar token com a IA, que não
    // recebe o contexto da conversa e chutaria a direção.
    const b12 = CODIGO.indexOf('applyLearned(text)')
    const c1  = CODIGO.indexOf('ehContinuacao(text)')
    const ia  = CODIGO.indexOf('await parseWithAI(')
    assert.ok(b12 > 0 && c1 > 0 && ia > 0, 'os três marcos precisam existir')
    assert.ok(b12 < c1, 'o comerciante aprendido tem precedência sobre a herança')
    assert.ok(c1 < ia,  'a herança resolve no aparelho, sem chamar a IA')
  })

  test('a descrição NÃO é herdada do contexto', () => {
    // "e mais 30" depois de "50 de pão" é outro item, não mais pão.
    const bloco = CODIGO.slice(CODIGO.indexOf('ehContinuacao(text)'), CODIGO.indexOf('const offline'))
    assert.ok(!/descricao:\s*ctx\.descricao/.test(bloco),
      'herdar a descrição renomearia o novo lançamento com o item anterior')
    assert.match(bloco, /descricaoVazia\(local\.descricao\)/)
  })

  test('o contexto tem prazo de validade', () => {
    assert.match(CODIGO, /JANELA_CONTEXTO_MS = 10 \* 60 \* 1000/)
    assert.match(CODIGO, /#contextoLancamento\(\)/)
    // Aba aberta desde ontem não é conversa.
    assert.match(CODIGO, /Date\.now\(\) - c\._em < JANELA_CONTEXTO_MS/)
  })

  test('contexto sem carimbo de tempo REPROVA', () => {
    // A comparação é negada (`!(dt < janela)`) porque um contexto gravado por
    // uma versão anterior, ainda vivo em memória num aparelho que não
    // recarregou, dá NaN — e NaN passaria por qualquer `>=`.
    assert.match(CODIGO, /if \(!\(Date\.now\(\) - c\._em < JANELA_CONTEXTO_MS\)\) return null;/)
  })

  test('o carimbo é gravado junto do último lançamento', () => {
    assert.match(CODIGO, /#lastLancamentoCmd = \{[^}]*_em: Date\.now\(\)/)
  })

  test('a meta da reserva é herdada com a chave que o toCommand LÊ', () => {
    // Armadilha real, pega durante a implementação: o parser emite `meta_hint`
    // (snake) e o toCommand converte para `metaHint`. Escrever `metaHint:` no
    // objeto que vai PARA o toCommand compila, não quebra teste nenhum e é
    // ignorado em silêncio — "guardei 100 na viagem" → "e mais 50" perderia a
    // meta e voltaria a perguntar qual é.
    const NORM = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/normalize.js'), 'utf8')
    assert.match(NORM, /metaHint:\s*clampStr\(parse\.meta_hint/,
      'se o toCommand passar a ler outra chave, o engine precisa acompanhar')

    const bloco = CODIGO.slice(CODIGO.indexOf('ehContinuacao(text)'), CODIGO.indexOf('const offline'))
    assert.match(bloco, /meta_hint:\s*local\.meta_hint \|\| ctx\.metaHint/)
  })

  test('o contexto morre no logout', () => {
    // E45: nenhum valor pendente pode sobreviver à troca de conta.
    assert.match(CODIGO, /this\.#lastUndo = this\.#lastQuery = this\.#lastTxInfo = this\.#lastLancamentoCmd = null;/)
  })

  test('o carimbo não vaza para os dados gravados', () => {
    // buildTransaction monta a transação campo a campo; se algum dia alguém
    // trocar por um spread do cmd, `_em` entra no blob do usuário.
    const TX = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/tx-builder.js'), 'utf8')
    const fn = TX.match(/export function buildTransaction[\s\S]*?\n\}/)[0]
    assert.ok(!/\.\.\.cmd/.test(fn),
      'buildTransaction precisa continuar montando campo a campo')
  })
})
