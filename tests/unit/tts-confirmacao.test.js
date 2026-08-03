// tts-confirmacao.test.js — C-5: a fala é opt-in e nunca surpreende o usuário.
//
// O motor (speak/stopSpeak) existia desde o D37 e ninguém chamava. O risco de
// "ligar" isso é o oposto do de deixá-lo morto: um app que começa a falar
// sozinho no ônibus. Estes testes travam as três decisões que evitam isso.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = readFileSync(join(RAIZ, 'src/scripts/modules/assistant/ui.js'), 'utf8');

describe('C-5 — falar a confirmação', () => {
  test('a fala é OPT-IN: nasce desligada', () => {
    // `=== '1'` com catch devolvendo false garante desligado por padrão e em
    // modo privado (onde localStorage lança).
    assert.match(UI, /localStorage\.getItem\(TTS_KEY\) === '1'/,
      'A preferência precisa ser explicitamente "1" para falar.');
    assert.match(UI, /catch \{ return false; \}/,
      'Se o localStorage falhar (modo privado), o padrão tem de ser NÃO falar.');
  });

  test('só fala quando a preferência está ligada', () => {
    assert.match(UI, /if \(ttsAtivo\(\)\) speak\(text\)/,
      'A confirmação não pode falar incondicionalmente.');
  });

  test('desfazer CALA a fala', () => {
    // Narrar um lançamento que está sendo desfeito é falar de algo que deixou
    // de ser verdade.
    const undo = UI.match(/btn\.addEventListener\('click', async \(\) => \{[\s\S]*?\}, \{ once: true \}\)/);
    assert.ok(undo, 'Não achei o handler do Desfazer.');
    assert.match(undo[0], /stopSpeak\(\)/,
      'O Desfazer precisa chamar stopSpeak().');
  });

  test('o controle fica no próprio chip, não numa tela de configurações', () => {
    assert.match(UI, /wrap\.appendChild\(_botaoFalar\(text\)\)/,
      'O botão precisa estar no chip de confirmação — é onde a voz acontece, '
      + 'logo é onde se descobre e se desliga.');
  });

  test('o ícone é SVG inline, não Font Awesome', () => {
    // fa-volume-* não está no subset; usá-lo exigiria rodar `npm run fa:subset`
    // e engordar a fonte por causa de um botão.
    assert.ok(!/faIcon\('fa-volume/.test(UI),
      'Ícone do FA aqui obrigaria a regerar o subset da fonte.');
    assert.match(UI, /createElementNS/, 'O ícone de som deve ser SVG inline.');
  });
});
