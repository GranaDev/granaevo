// critical-css.test.js — O-2: o CSS crítico da landing e seu hash de CSP.
//
// POR QUE ESTE ARQUIVO EXISTE
// A landing inline o CSS do loader para o LCP não ficar preso atrás de 12 KB de
// folha de estilo. Mas ela tem `style-src 'self'` — sem `'unsafe-inline'` —,
// então o navegador só aceita esse <style> se o **hash** dele estiver na CSP.
//
// Se o hash e o conteúdo saírem de sincronia, o resultado é o pior possível: a
// landing carrega **sem estilo nenhum**, e nada no build reclama. Estes testes
// existem para que isso não chegue em produção.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ler = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');

const HTML = ler('index.html');
const estilo = () => {
  const i = HTML.indexOf('<style>');
  const f = HTML.indexOf('</style>');
  assert.ok(i > 0 && f > i, 'index.html perdeu o <style> do CSS crítico.');
  return HTML.slice(i + 7, f);
};
const hashDo = (css) => 'sha256-' + createHash('sha256').update(css, 'utf8').digest('base64');

describe('O-2 — CSS crítico inline', () => {
  test('o bloco existe e cobre o que pinta primeiro', () => {
    const css = estilo();
    for (const sel of ['.loading-screen', '.loader-logo', '.logo-img-loader']) {
      assert.ok(css.includes(sel),
        `O crítico não cobre ${sel}. Sem ele o logo — que é o LCP desta página — `
        + 'só aparece depois do CSS externo, que é exatamente o que se queria evitar.');
    }
  });

  test('nenhuma variável CSS sobrou sem resolver', () => {
    // Os tokens são declarados no CSS externo, que ainda não carregou quando
    // este bloco é lido. `var(--x)` aqui vira "sem valor" e o loader nasce
    // sem cor nenhuma.
    assert.ok(!/var\(--/.test(estilo()),
      'Sobrou var(--…) no CSS crítico. Rode `npm run critical:build`.');
  });

  test('o hash na CSP do <meta> bate com o conteúdo', () => {
    const h = hashDo(estilo());
    assert.ok(HTML.includes(h),
      `O hash do <meta> não corresponde ao <style> atual (esperado ${h.slice(0, 24)}…). `
      + 'Com CSP estrita, isso faz a landing carregar SEM ESTILO. Rode `npm run critical:build`.');
  });

  test('o hash no vercel.json bate — é o header que vale de verdade', () => {
    // O <meta> é defesa em profundidade; o navegador aplica a política mais
    // restritiva entre header e meta. Só o meta correto não salva.
    const h = hashDo(estilo());
    const vercel = JSON.parse(ler('vercel.json'));
    for (const rota of ['/', '/landingpage']) {
      const bloco = vercel.headers.find((x) => x.source === rota);
      assert.ok(bloco, `vercel.json perdeu a rota ${rota}.`);
      const csp = bloco.headers.find((x) => /content-security-policy/i.test(x.key));
      assert.ok(csp, `A rota ${rota} ficou sem CSP.`);
      assert.ok(csp.value.includes(h),
        `A CSP de ${rota} não tem o hash atual. O header HTTP é o que o navegador obedece: `
        + 'sem ele o <style> é descartado e a página fica sem estilo.');
    }
  });

  test('a landing NÃO ganhou unsafe-inline', () => {
    // O caminho preguiçoso seria afrouxar a CSP da página mais exposta do site.
    // O hash existe justamente para não precisar disso.
    const vercel = JSON.parse(ler('vercel.json'));
    const csp = vercel.headers.find((x) => x.source === '/')
      .headers.find((x) => /content-security-policy/i.test(x.key)).value;
    const st = csp.match(/style-src[^;]*/)[0];
    assert.ok(!st.includes('unsafe-inline'),
      'A landing ganhou style-src unsafe-inline. O hash torna isso desnecessário.');
  });

  test('o CSS pesado sai do caminho crítico, com rede de segurança', () => {
    assert.match(HTML, /media="print" data-async-style/,
      'O CSS voltou a bloquear a pintura.');
    assert.match(HTML, /<noscript>[\s\S]*?stylesheet[\s\S]*?<\/noscript>/,
      'Sem o <noscript>, quem desativa JavaScript fica sem estilo.');
    assert.match(HTML, /src="\/css-boot\.js"/,
      'Sem o css-boot.js, o CSS baixado com media="print" nunca é aplicado.');
  });
});
