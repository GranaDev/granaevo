// fallback-honesto.test.js — C-8: quando a IA chuta, o assistente pergunta.
//
// Até 2026-08-03 o campo `confianca` era pedido no schema da IA e NUNCA lido.
// Um palpite fraco virava lançamento com a mesma naturalidade de um parse
// certo — e num app de dinheiro isso contamina saldo, previsão e relatório,
// muitas vezes sem o usuário notar na hora.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmarIncerto } from '../../src/scripts/modules/assistant/phrases.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ler = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');
const ENGINE = ler('src', 'scripts', 'modules', 'assistant', 'engine.js');

describe('C-8 — o limiar existe e é consultado', () => {
  test('há um limiar próprio para a IA', () => {
    assert.match(ENGINE, /const CONF_IA_MIN = 0\.\d+/,
      'Sem limiar, `confianca` continua sendo um campo pedido e nunca lido.');
  });

  test('a confiança da IA é de fato lida antes de rotear', () => {
    assert.match(ENGINE, /Number\(ai\.parse\?\.confianca\)/,
      'O valor precisa sair de `ai.parse.confianca` — era exatamente o campo ignorado.');
    assert.match(ENGINE, /conf < CONF_IA_MIN/);
  });

  test('confiança inválida NÃO vira pergunta', () => {
    // Se o modelo omitir o campo, `Number(undefined)` é NaN. Sem o
    // Number.isFinite, todo parse sem confiança viraria pergunta — e o
    // assistente ficaria insuportável por causa de um campo ausente.
    assert.match(ENGINE, /Number\.isFinite\(conf\)/,
      'Sem checar isFinite, confiança ausente (NaN) cairia no ramo da dúvida.');
  });
});

describe('C-8 — só escrita é confirmada', () => {
  test('a lista de intenções que escrevem existe e é fechada', () => {
    const m = ENGINE.match(/const ESCREVE = new Set\(\[([^\]]+)\]\)/);
    assert.ok(m, 'Sumiu a lista de intenções que escrevem.');
    const itens = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    for (const esperado of ['lancar', 'pagar_conta', 'definir_orcamento', 'lembrete']) {
      assert.ok(itens.includes(esperado), `Faltou "${esperado}" na lista de escrita.`);
    }
    for (const leitura of ['consultar', 'relatorio', 'saudacao', 'ajuda']) {
      assert.ok(!itens.includes(leitura),
        `"${leitura}" só LÊ. Confirmar consulta transforma o assistente num chato: `
        + 'errar ali custa uma resposta boba que o usuário reformula.');
    }
  });

  test('o gate usa a lista', () => {
    assert.match(ENGINE, /ESCREVE\.has\(cmd\.intent\)/);
  });
});

describe('C-8 — a confirmação reusa o mecanismo existente', () => {
  test('usa #pendingConfirm, sem criar um caminho paralelo', () => {
    assert.match(ENGINE, /this\.#pendingConfirm = \{ cmd, kind: 'incerto' \}/,
      'Um segundo mecanismo de sim/não significaria duas formas de cancelar e '
      + 'dois lugares para esquecer de limpar o estado.');
  });

  test('o "sim" de uma dúvida volta pelo #route, não pelo #doLancamento', () => {
    // A dúvida pode ser sobre pagar conta, orçamento ou lembrete — mandar tudo
    // para #doLancamento criaria uma transação onde o usuário pediu outra coisa.
    assert.match(ENGINE, /if \(pend\.kind === 'incerto'\)\s+return this\.#route\(pend\.cmd\)/);
  });

  test('o contador de telemetria foi DECLARADO', () => {
    // bump() ignora em silêncio o que não está na lista de contadores.
    assert.match(ENGINE, /bump\('ia_incerta'\)/);
    assert.match(ler('src', 'scripts', 'modules', 'assistant', 'stats.js'), /ia_incerta: 0/,
      'bump() ignora contador não declarado — a telemetria pareceria existir e não contaria nada.');
  });
});

describe('C-8 — a pergunta mostra o que foi entendido', () => {
  test('repete a interpretação, em vez de perguntar no vazio', () => {
    // "É isso?" sem dizer o quê faz o usuário responder "sim" no automático,
    // e aí a dúvida não serviu para nada.
    const msg = confirmarIncerto({ intent: 'lancar', categoria: 'saida', valor: 40, tipo: 'Mercado', descricao: 'feira' });
    assert.match(msg, /40/, 'A pergunta precisa mostrar o valor.');
    assert.match(msg, /Mercado/, 'E a categoria.');
    assert.match(msg, /feira/, 'E a descrição.');
    assert.match(msg, /sim.*n[ãa]o/is, 'E dizer como responder.');
  });

  test('cada intenção que escreve tem sua própria pergunta', () => {
    const conta = confirmarIncerto({ intent: 'pagar_conta', contaHint: 'luz' });
    assert.match(conta, /luz/);
    assert.match(conta, /paga/i, 'Pagar conta não pode ser descrito como "lançar".');

    const orc = confirmarIncerto({ intent: 'definir_orcamento', valor: 600, tipo: 'Mercado' });
    assert.match(orc, /or[çc]amento/i);

    const lem = confirmarIncerto({ intent: 'lembrete', lembreteTexto: 'pagar o IPVA' });
    assert.match(lem, /IPVA/);
  });

  test('admite a incerteza em vez de fingir certeza', () => {
    const msg = confirmarIncerto({ intent: 'lancar', categoria: 'saida', valor: 10 });
    assert.match(msg, /n[ãa]o tenho certeza/i,
      'Fingir certeza em dinheiro custa a confiança de uma vez só.');
  });
});
