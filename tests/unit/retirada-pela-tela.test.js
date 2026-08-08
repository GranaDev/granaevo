/**
 * C-10 — retirar da reserva pela tela de Transações.
 *
 * Pedido do dono (2026-08-04): hoje só dá para retirar entrando em Reservas (ou
 * pelo chat). Ele listou as travas junto do pedido: perguntar de qual reserva,
 * bloquear se o saldo não cobre, e rate limit.
 *
 * ⚠️ A REGRA NÃO FOI REESCRITA. `applyRetirada` já é a réplica fiel do db-metas
 * (debita `saved`, ajusta `monthly`, grava `historicoRetiradas`) e já valida
 * reserva vazia e valor que excede. Uma TERCEIRA cópia divergiria — foi assim
 * que o modelo antigo e o novo de fatura passaram a coexistir e a fatura exibiu
 * valor errado. Este arquivo testa a função REAL, com o mesmo shim que a tela
 * usa.
 *
 * Puro, sem DOM. Roda no CI: node --test tests/unit/
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyRetirada } from '../../src/scripts/modules/assistant/tx-builder.js'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')
const TX   = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/db-transacoes.js'), 'utf8'))
const HTML = readFileSync(join(RAIZ, 'dashboard.html'), 'utf8')

// O MESMO shim da tela: `applyRetirada` fala a linguagem de perfil, a tela guarda
// as coleções soltas. Ele muta os mesmos arrays.
const cena = (saved) => ({ transacoes: [], metas: [{ id: 'm1', descricao: 'Viagem', saved, monthly: {} }] })

describe('⭐ a retirada debita a reserva — as duas metades, sempre', () => {
  test('cria a transação E tira o dinheiro da meta', () => {
    // O defeito que a fronteira do outro arquivo impedia era exatamente isto
    // acontecer pela metade: transação dizendo que saiu, reserva intacta.
    const p = cena(500)
    const r = applyRetirada(p, { valor: 200, metaId: 'm1', descricao: 'Conserto do carro' })
    assert.equal(r.ok, true)
    assert.equal(p.transacoes.length, 1)
    assert.equal(p.transacoes[0].categoria, 'retirada_reserva')
    assert.equal(p.metas[0].saved, 300, 'a reserva TEM de ter sido debitada')
  })

  test('a descrição do usuário é preservada', () => {
    // A tela tem um campo de descrição; jogá-lo fora obrigaria a uma segunda
    // cópia da função só para respeitá-lo.
    const p = cena(500)
    applyRetirada(p, { valor: 100, metaId: 'm1', descricao: 'Conserto do carro' })
    assert.equal(p.transacoes[0].descricao, 'Conserto do carro')
  })

  test('sem descrição, cai no padrão do chat', () => {
    const p = cena(500)
    applyRetirada(p, { valor: 100, metaId: 'm1' })
    assert.equal(p.transacoes[0].descricao, 'Retirada: Viagem')
  })

  test('o motivo entra na transação e no histórico', () => {
    const p = cena(500)
    applyRetirada(p, { valor: 100, metaId: 'm1', motivoRetirada: 'Retirada pela tela de Transações' })
    assert.equal(p.transacoes[0].motivoRetirada, 'Retirada pela tela de Transações')
    assert.equal(p.metas[0].historicoRetiradas[0].motivo, 'Retirada pela tela de Transações')
  })

  test('o histórico registra saldo antes e depois', () => {
    const p = cena(500)
    applyRetirada(p, { valor: 200, metaId: 'm1' })
    const h = p.metas[0].historicoRetiradas[0]
    assert.equal(h.saldoAnterior, 500)
    assert.equal(h.saldoPosterior, 300)
  })
})

describe('as travas que o dono pediu', () => {
  test('⭐ valor maior que o disponível é RECUSADO, e nada é gravado', () => {
    const p = cena(100)
    const r = applyRetirada(p, { valor: 200, metaId: 'm1' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'excede')
    assert.equal(r.disponivel, 100)
    assert.equal(p.transacoes.length, 0, 'não pode gravar transação')
    assert.equal(p.metas[0].saved, 100, 'não pode mexer na reserva')
  })

  test('reserva vazia é recusada', () => {
    const p = cena(0)
    const r = applyRetirada(p, { valor: 10, metaId: 'm1' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'reserva_vazia')
  })

  test('retirar exatamente o saldo é permitido, e zera', () => {
    const p = cena(150)
    assert.equal(applyRetirada(p, { valor: 150, metaId: 'm1' }).ok, true)
    assert.equal(p.metas[0].saved, 0)
  })

  test('reserva inexistente é recusada', () => {
    const p = cena(500)
    assert.equal(applyRetirada(p, { valor: 10, metaId: 'nao-existe' }).ok, false)
    assert.equal(p.transacoes.length, 0)
  })

  test('valor zero ou negativo é recusado', () => {
    for (const v of [0, -10]) {
      assert.equal(applyRetirada(cena(500), { valor: v, metaId: 'm1' }).ok, false)
    }
  })
})

describe('a tela: o que ela oferece e o que ela exige', () => {
  test('a categoria existe no formulário de criação', () => {
    assert.match(HTML, /<option value="retirada_reserva">Retirada de Reserva<\/option>/)
  })

  test('⭐ só lista reservas COM saldo, e mostra quanto', () => {
    // Oferecer uma reserva vazia é convidar o usuário a um erro que a gente já
    // sabe que vai bloquear. E "quanto posso tirar?" se responde na própria
    // lista, sem sair da tela.
    assert.match(TX, /_ctx\.metas\.filter\(m => Number\(m\.saved \|\| 0\) > 0\)/)
    assert.match(TX, /disponível`/)
    assert.match(TX, /Nenhuma reserva com saldo/)
  })

  test('exige escolher a reserva antes de lançar', () => {
    // A CONDIÇÃO, não a mensagem: `if (false)` deixaria o texto vivo num ramo
    // morto e o teste passaria com a exigência desligada.
    assert.match(TX, /if \(!tipo \|\| !tipo\.startsWith\('meta_'\)\) \{/)
    assert.match(TX, /Escolha de qual reserva vai sair o dinheiro/)
  })

  test('bloqueia no cliente ANTES de chamar a regra', () => {
    // A trava do `applyRetirada` é a que vale; esta é para o usuário ver a
    // mensagem no campo certo, com o valor disponível.
    assert.match(TX, /Essa reserva tem \$\{formatBRL\(disponivel\)\} disponível/)
    const iCheck = TX.indexOf('if (valor > disponivel)')
    const iApply = TX.indexOf('const r = applyRetirada(')
    assert.ok(iCheck > 0 && iApply > iCheck)
  })

  test('confirma antes, mostrando o que sobra', () => {
    assert.match(TX, /Sobra \$\{formatBRL\(disponivel - valor\)\} na reserva/)
  })

  test('rate limit: 3 em 10 segundos', () => {
    // Retirada mexe em DOIS lugares. Um duplo-clique tira o dobro, e desfazer
    // exige entender as duas metades.
    assert.match(TX, /_RETIRADAS_JANELA_MS = 10_000/)
    assert.match(TX, /_RETIRADAS_MAX\s+= 3/)
    assert.match(TX, /if \(!_podeRetirarAgora\(\)\)/)
    // Só conta o que DEU CERTO — recusa não pode gastar a cota.
    //
    // Recortado ao BLOCO: `indexOf('_registrarRetirada()')` no arquivo inteiro
    // acha a DEFINIÇÃO da função, que vem antes de tudo. Mesma armadilha de
    // assertar identificador que aparece na definição e no uso.
    const bloco = TX.slice(TX.indexOf("if (categoria === 'retirada_reserva')"))
    const iApply = bloco.indexOf('const r = applyRetirada(')
    const iOk    = bloco.indexOf('_registrarRetirada();')
    assert.ok(iApply > 0 && iOk > iApply, 'a cota só é consumida depois da retirada dar certo')
  })

  test('a regra vem do módulo compartilhado, não de uma cópia local', () => {
    assert.match(TX, /import \{ applyRetirada \} from '\.\.\/modules\/assistant\/tx-builder\.js'/)
    // Nenhuma aritmética de saldo de meta escrita aqui.
    assert.ok(!/meta\.saved = Number\(\(disponivel/.test(TX))
    assert.ok(!/historicoRetiradas\.push/.test(TX))
  })
})
