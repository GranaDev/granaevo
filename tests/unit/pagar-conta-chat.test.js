// pagar-conta-chat.test.js — C-6: pagar conta pelo chat.
//
// POR QUE ESTE ARQUIVO EXISTE
// O fluxo estava inteiro implementado (`resolveContaFixa`, `applyPagamentoConta`,
// `undoPagamentoConta` + `#doPagarConta` no engine) e **sem um único teste** —
// enquanto o roadmap ainda o listava como "falta a ação".
//
// É um caminho que MEXE EM DINHEIRO por comando de texto: marca a conta como
// paga, avança o vencimento e cria uma transação de saída. Uma frase ambígua
// interpretada errada aqui paga a conta errada. As funções são puras (recebem o
// perfil, devolvem o resultado), então dá para testar sem browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContaFixa, applyPagamentoConta, undoPagamentoConta,
} from '../../src/scripts/modules/assistant/tx-builder.js';

const perfil = (contas) => ({ transacoes: [], contasFixas: contas });

const conta = (over = {}) => ({
  id: 1, descricao: 'Luz', valor: 180, vencimento: '2026-08-10', pago: false, ...over,
});

describe('C-6 — achar a conta certa', () => {
  test('nome exato resolve', () => {
    const p = perfil([conta(), conta({ id: 2, descricao: 'Internet' })]);
    const r = resolveContaFixa(p, 'luz');
    assert.equal(r.status, 'ok');
    assert.equal(r.conta.descricao, 'Luz');
  });

  test('typo ainda resolve (fuzzy)', () => {
    const r = resolveContaFixa(perfil([conta({ descricao: 'Internet' })]), 'internete');
    assert.equal(r.status, 'ok', 'Errar uma letra não pode impedir de pagar.');
  });

  test('duas contas parecidas NÃO adivinham — perguntam', () => {
    const p = perfil([
      conta({ id: 1, descricao: 'Luz casa' }),
      conta({ id: 2, descricao: 'Luz escritório' }),
    ]);
    const r = resolveContaFixa(p, 'luz');
    assert.equal(r.status, 'ambiguous',
      'Com duas candidatas, adivinhar significa pagar a conta errada.');
    assert.equal(r.opcoes.length, 2);
  });

  test('conta já paga sai da lista de candidatas', () => {
    const p = perfil([conta({ pago: true })]);
    assert.equal(resolveContaFixa(p, 'luz').status, 'none');
  });

  test('fatura de cartão vira handoff, não pagamento', () => {
    // Fatura tem parcelas e ciclo próprios; quitar por aqui bagunçaria o
    // controle de cartão. O assistente manda para a tela certa.
    const p = perfil([conta({ descricao: 'Fatura Nubank', tipoContaFixa: 'fatura_cartao' })]);
    assert.equal(resolveContaFixa(p, 'nubank').status, 'handoff');
  });

  test('sem hint e com uma só conta simples em aberto, resolve', () => {
    assert.equal(resolveContaFixa(perfil([conta()]), null).status, 'ok');
  });

  test('sem hint e com várias, pergunta em vez de escolher', () => {
    const p = perfil([conta(), conta({ id: 2, descricao: 'Água' })]);
    assert.equal(resolveContaFixa(p, null).status, 'choose');
  });
});

describe('C-6 — aplicar o pagamento', () => {
  test('cria a saída, marca como paga e avança o vencimento', () => {
    const c = conta();
    const p = perfil([c]);
    const r = applyPagamentoConta(p, c);

    assert.equal(r.ok, true);
    assert.equal(p.transacoes.length, 1);
    assert.equal(p.transacoes[0].categoria, 'saida');
    assert.equal(p.transacoes[0].valor, 180);
    assert.equal(p.transacoes[0].contaFixaId, 1, 'A transação precisa apontar para a conta.');
    assert.equal(c.pago, true);
    assert.equal(c.vencimento, '2026-09-10', 'O vencimento avança um mês.');
  });

  test('valor informado no comando vence o valor cadastrado', () => {
    // "paguei 200 de luz" quando a conta é 180 — a conta veio mais cara.
    const c = conta();
    applyPagamentoConta(perfil([c]), c, 200);
    assert.equal(c.pago, true);
  });

  test('recusa pagar duas vezes', () => {
    const c = conta({ pago: true });
    assert.deepEqual(applyPagamentoConta(perfil([c]), c), { ok: false, reason: 'ja_paga' });
  });

  test('recusa valor absurdo', () => {
    const c = conta();
    const r = applyPagamentoConta(perfil([c]), c, 99_999_999);
    assert.equal(r.ok, false, 'Um erro de digitação não pode virar transação de milhões.');
    assert.equal(c.pago, false, 'E não pode deixar a conta marcada como paga.');
  });

  test('fatura de cartão é recusada mesmo se chegar até aqui', () => {
    const c = conta({ tipoContaFixa: 'fatura_cartao' });
    assert.equal(applyPagamentoConta(perfil([c]), c).reason, 'handoff');
  });
});

describe('C-6 — desfazer volta ao estado exato', () => {
  test('remove a transação e restaura vencimento e pago', () => {
    const c = conta();
    const p = perfil([c]);
    const antes = { venc: c.vencimento, pago: c.pago };

    const r = applyPagamentoConta(p, c);
    assert.equal(p.transacoes.length, 1);

    undoPagamentoConta(p, r.transaction, r.snapshot);

    assert.equal(p.transacoes.length, 0, 'A transação do pagamento tem de sumir.');
    assert.equal(c.vencimento, antes.venc, 'O vencimento volta ao original.');
    assert.equal(c.pago, antes.pago, 'A conta volta a ficar em aberto.');
  });

  test('desfazer não leva junto uma transação parecida do usuário', () => {
    // O undo casa por descrição + valor + data + hora. Uma saída manual do
    // usuário com valor igual não pode ser apagada no lugar.
    const c = conta();
    const p = perfil([c]);
    p.transacoes.push({ categoria: 'saida', tipo: 'Conta Fixa', descricao: 'Outra coisa', valor: 180, data: '01/01/2026', hora: '10:00' });

    const r = applyPagamentoConta(p, c);
    undoPagamentoConta(p, r.transaction, r.snapshot);

    assert.equal(p.transacoes.length, 1);
    assert.equal(p.transacoes[0].descricao, 'Outra coisa', 'Apagou a transação errada.');
  });
});
