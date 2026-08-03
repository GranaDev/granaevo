// faq-landing.test.js — o FAQ da landing vive em DOIS lugares (P-6).
//
// A pergunta aparece na página (HTML visível) e no JSON-LD do <head>, que é o
// que alimenta o FAQ expansível na busca do Google. As diretrizes do Google
// exigem que o structured data corresponda ao conteúdo visível — divergir
// derruba o rich snippet, e sem aviso: a página continua no ar, o snippet só
// nunca aparece.
//
// Duplicação de conteúdo é sempre um convite à divergência. Aqui ela é
// inevitável (o formato exige), então fica travada por teste.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = readFileSync(join(RAIZ, 'index.html'), 'utf8');
const SEM_COMENTARIO = HTML.replace(/<!--[\s\S]*?-->/g, '');

/** Perguntas visíveis na página. */
function perguntasVisiveis() {
  const secao = SEM_COMENTARIO.match(/<section class="faq-lp-section"[\s\S]*?<\/section>/);
  assert.ok(secao, 'A seção de FAQ sumiu da landing.');
  return [...secao[0].matchAll(/<button class="faq-lp-question"[^>]*>\s*<span>([^<]+)<\/span>/g)]
    .map((m) => m[1].trim());
}

/** Perguntas declaradas no JSON-LD (FAQPage). */
function perguntasDoJsonLd() {
  const bloco = SEM_COMENTARIO.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(bloco, 'O JSON-LD sumiu do <head>.');
  const dados = JSON.parse(bloco[1]);
  const faq = (dados['@graph'] ?? [dados]).find((n) => n['@type'] === 'FAQPage');
  assert.ok(faq, 'O bloco FAQPage sumiu do JSON-LD.');
  return (faq.mainEntity ?? []).map((q) => q.name.trim());
}

describe('FAQ da landing — página e JSON-LD contam a mesma história', () => {
  test('as perguntas visíveis e as do JSON-LD são as mesmas, na mesma ordem', () => {
    assert.deepEqual(perguntasDoJsonLd(), perguntasVisiveis(),
      'O FAQ da página e o structured data divergiram. O Google exige que o dado '
      + 'estruturado corresponda ao conteúdo visível — divergir derruba o rich snippet, '
      + 'e a falha é silenciosa: a página continua no ar, o snippet só nunca aparece.');
  });

  test('P-6: a objeção do banco é respondida de frente', () => {
    const perguntas = perguntasVisiveis().join(' | ').toLowerCase();
    assert.match(perguntas, /não conecta com o meu banco/,
      'Sumiu a pergunta "por que não conecta com o meu banco". Ela é feita de qualquer '
      + 'jeito pelo visitante; omitir não a apaga, só deixa ele concluir sozinho — e '
      + 'provavelmente que o app é limitado.');
  });

  test('a resposta explica a ESCOLHA e oferece o caminho prático', () => {
    const secao = SEM_COMENTARIO.match(/<section class="faq-lp-section"[\s\S]*?<\/section>/)[0];
    const i = secao.indexOf('não conecta com o meu banco');
    const resposta = secao.slice(i, i + 2600);

    assert.match(resposta, /não é limitação técnica|decisão que define o produto/i,
      'A resposta precisa deixar claro que é escolha, não incapacidade — senão soa como desculpa.');
    assert.match(resposta, /OFX/,
      'Sem citar o import de extrato, a resposta deixa a pergunta seguinte no ar: '
      + '"então eu digito tudo à mão?".');
    assert.match(resposta, /troca é honesta|de vez em quando você baixa/i,
      'A resposta precisa admitir o custo. Vender só o lado bom de uma escolha é o que '
      + 'faz o visitante desconfiar do resto.');
  });

  test('nenhuma resposta promete conexão bancária', () => {
    // Se um dia alguém escrever "em breve conectamos ao seu banco", vira promessa
    // que contradiz a política de privacidade e a própria proposta do produto.
    const secao = SEM_COMENTARIO.match(/<section class="faq-lp-section"[\s\S]*?<\/section>/)[0];
    assert.ok(!/em breve[^.]{0,40}(conect|open finance)/i.test(secao),
      'O FAQ promete conexão bancária futura. Isso contradiz a proposta do produto e a '
      + 'política de privacidade.');
  });
});
