// push-semanal.test.js — C-2: a semana sem conta vencendo não vira silêncio.
//
// O resumo semanal existia, mas só era criado quando havia conta a vencer.
// Resultado: quem tem as contas em dia — justamente quem usa bem o app — nunca
// recebia nada, e o assistente sumia da vida de quem mais o usa.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RADAR = readFileSync(join(RAIZ, 'src/scripts/modules/radar.js'), 'utf8');

// Só o código: os comentários deste arquivo citam R$ ao explicar a regra.
const CODIGO = RADAR.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

describe('C-2 — existe insight quando não há conta vencendo', () => {
  test('o helper existe e é consultado no bloco semanal', () => {
    assert.match(RADAR, /function _insightDaSemana/);
    assert.match(CODIGO, /corpo = _insightDaSemana\(ctx\)/,
      'Sem isso, a semana sem conta continua sem push nenhum.');
  });

  test('o push só é criado se houver o que dizer', () => {
    // `if (corpo)` e não `if (nContas > 0)`: notificação vazia é a forma mais
    // rápida de o usuário desligar as notificações de vez.
    assert.match(CODIGO, /if \(corpo\) \{/,
      'O push precisa depender de haver conteúdo, não de haver conta.');
    assert.match(RADAR, /return null;\s*\}/,
      'O helper precisa poder devolver null quando não há insight.');
  });

  test('usa o MESMO motor de insight do chat, não uma cópia', () => {
    assert.match(RADAR, /from '\.\/assistant\/insights\.js'/,
      'Reimplementar a micro-lição aqui criaria duas versões que divergem — '
      + 'foi o que já aconteceu com o cálculo de fechamento de fatura.');
    assert.match(RADAR, /assinaturaNaoCadastrada|microLicao/);
  });

  test('o insight nunca derruba o radar', () => {
    const fn = RADAR.match(/function _insightDaSemana[\s\S]*?\n\}/)[0];
    assert.equal((fn.match(/catch/g) ?? []).length, 2,
      'Cada chamada de insight precisa do próprio catch: um erro no complemento '
      + 'não pode impedir o aviso de conta vencendo, que é o essencial.');
  });
});

describe('C-2 — a regra de privacidade do push é mantida', () => {
  test('nenhum valor em R$ entra no corpo da notificação', () => {
    // O corpo aparece na tela de bloqueio, à vista de quem estiver por perto.
    // O cabeçalho do próprio radar.js diz: "não reintroduzir _brl() aqui".
    assert.ok(!/_brl\(|formatBRL|R\$/.test(CODIGO),
      'Voltou valor em R$ ao radar. O corpo do push é lido por quem passa pelo '
      + 'celular na mesa — por isso o resumo diz "abra pra ver os valores".');
  });

  test('a assinatura fantasma vai só pelo NOME', () => {
    const fn = RADAR.match(/function _insightDaSemana[\s\S]*?\n\}/)[0];
    assert.match(fn, /assin\?\.nome/);
    assert.ok(!/valorMensal|valorAnual/.test(fn.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
      'O valor da assinatura não pode ir no push — só o nome, e o quanto custa '
      + 'a pessoa vê ao abrir.');
  });

  test('a micro-lição usa percentual, que não revela renda nem gasto', () => {
    const fn = RADAR.match(/function _insightDaSemana[\s\S]*?\n\}/)[0];
    assert.match(fn, /licao\.pctAtual/);
    assert.match(fn, /Number\.isFinite\(licao\.pctAtual\)/,
      'Sem checar o número, um insight quebrado viraria "undefined% dos seus gastos".');
  });
});
