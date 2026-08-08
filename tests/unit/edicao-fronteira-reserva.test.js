/**
 * A edição de transação não pode atravessar a fronteira da reserva.
 *
 * ACHADO em 2026-08-07, ao conferir o risco que o roadmap tinha anexado ao C-10
 * ("o formulário de edição já permite trocar a categoria para retirada_reserva,
 * e isso grava sem mexer no saldo da reserva — vale conferir antes de expor o
 * fluxo novo"). Era pior do que estava escrito, e estava EM PRODUÇÃO, ao alcance
 * de qualquer usuário pelo botão de editar.
 *
 * A conta, feita sobre a fórmula real do saldo (dashboard.js:3257-3260):
 *
 *   entrada          → saldo += valor
 *   saida            → saldo -= valor
 *   reserva          → saldo -= valor   (e a meta recebe)
 *   retirada_reserva → saldo += valor   (e a meta devolve)
 *
 * Trocar uma SAÍDA de R$100 para RETIRADA DE RESERVA move o saldo de −100 para
 * +100: **R$200 do nada**. E nenhuma reserva é debitada, porque o ajuste da meta
 * no salvar só roda `if (diff !== 0 && t.metaId)` — e saída não tem `metaId`.
 *
 * Puro, sem DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { categoriasEditaveis } from '../../src/scripts/modules/categorias-edicao.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

const TX   = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/db-transacoes.js'), 'utf8'))
const DASH = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))

// A fórmula do saldo, copiada do dashboard. Se ela mudar lá e não aqui, o teste
// "o dinheiro não aparece do nada" abaixo acusa a divergência.
const saldoDe = (txs) => txs.reduce((s, t) => {
  if (t.categoria === 'entrada')          return s + t.valor
  if (t.categoria === 'saida')            return s - t.valor
  if (t.categoria === 'reserva')          return s - t.valor
  if (t.categoria === 'retirada_reserva') return s + t.valor
  return s
}, 0)

describe('⭐ o tamanho do estrago, em números', () => {
  test('saída → retirada de reserva move o saldo em 2× o valor', () => {
    const antes  = saldoDe([{ categoria: 'saida', valor: 100 }])
    const depois = saldoDe([{ categoria: 'retirada_reserva', valor: 100 }])
    assert.equal(antes, -100)
    assert.equal(depois, 100)
    assert.equal(depois - antes, 200, 'R$200 apareceriam do nada')
  })

  test('e a reserva não seria debitada — o ajuste exige metaId, que a saída não tem', () => {
    // A guarda no salvar: `if (diff !== 0 && t.metaId)`. Uma saída nunca tem
    // metaId, então nem entra no bloco que mexeria na meta.
    assert.match(TX, /if \(diff !== 0 && t\.metaId\)/)
  })

  test('a fórmula do saldo continua a que este teste assume', () => {
    // Se alguém mudar os sinais lá, a conta acima deixa de valer e o teste
    // precisa ser relido — não silenciosamente.
    assert.match(DASH, /t\.categoria === 'saida'\)\s+saldoTotal -= valor/)
    assert.match(DASH, /t\.categoria === 'retirada_reserva'\)\s+saldoTotal \+= valor/)
  })
})

describe('a trava: a edição só oferece o mesmo lado da fronteira', () => {
  // A REGRA É EXECUTADA, não lida por regex. Na 1ª versão deste arquivo a
  // asserção era textual, e uma mutação que neutralizasse a condição
  // (`false && …`) passava batido: o texto continuava lá, o comportamento não.
  const vals = (cat) => categoriasEditaveis(cat).map((c) => c.value)

  test('transação de reserva só pode continuar sendo o que é', () => {
    assert.deepEqual(vals('reserva'), ['reserva'])
    assert.deepEqual(vals('retirada_reserva'), ['retirada_reserva'])
  })

  test('⭐ transação comum NUNCA recebe as categorias de reserva', () => {
    // É a metade que inventava dinheiro.
    for (const cat of ['entrada', 'saida', 'saida_credito']) {
      const v = vals(cat)
      assert.ok(!v.includes('reserva'), `${cat} ofereceu reserva`)
      assert.ok(!v.includes('retirada_reserva'), `${cat} ofereceu retirada`)
      assert.deepEqual(v, ['entrada', 'saida', 'saida_credito'])
    }
  })

  test('categoria desconhecida cai no lado comum, não no de reserva', () => {
    assert.ok(!vals('coisa_nova').includes('retirada_reserva'))
  })

  test('a categoria atual está sempre na lista — senão o select trocaria sozinho', () => {
    for (const cat of ['entrada', 'saida', 'saida_credito', 'reserva', 'retirada_reserva']) {
      assert.ok(vals(cat).includes(cat), `${cat} sumiu da própria lista`)
    }
  })

  test('valor, descrição e tipo continuam editáveis', () => {
    // A trava é só de categoria: travar o resto seria punir o usuário por um
    // defeito nosso.
    assert.match(TX, /t\.descricao = novaDesc/)
    assert.match(TX, /t\.valor\s+= novoValor/)
    assert.match(TX, /t\.tipo\s+= novoTipo/)
  })

  test('o motivo está escrito onde alguém vai editar', () => {
    // Sem a explicação, a próxima pessoa "completa" a lista de categorias
    // achando que faltava uma — e o buraco volta.
    const cru = readFileSync(join(RAIZ, 'src/scripts/modules/categorias-edicao.js'), 'utf8')
    assert.match(cru, /POR QUE A FRONTEIRA EXISTE/)
    assert.match(cru, /R\$200 aparecem do nada/)
  })
})
