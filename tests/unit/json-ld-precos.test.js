// json-ld-precos.test.js — o preço que o Google mostra tem de ser o preço real (M-8).
//
// POR QUE ESTE TESTE EXISTE
// O JSON-LD de `planos.html` alimenta o rich snippet de preço na busca. Ele é
// texto solto num HTML: nada impede que alguém suba o valor no Stripe e esqueça
// dele aqui. O resultado seria o pior tipo de erro de marketing — a primeira
// informação que o cliente vê sobre o produto estaria errada, e ele descobriria
// no checkout.
//
// A fonte da verdade é `PLAN_PRICES_CENTS` na edge que cobra de verdade.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ler = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');

/** Extrai os blocos JSON-LD, ignorando comentários que citem a tag. */
function blocosLd(html) {
  const semComentario = html.replace(/<!--[\s\S]*?-->/g, '');
  return [...semComentario.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
}

/** A fonte da verdade: quanto a edge realmente cobra. */
function precosDoCodigo() {
  const ts = ler('supabase', 'functions', 'update-stripe-plan', 'index.ts');
  const linha = ts.match(/const PLAN_PRICES_CENTS:[^=]*=\s*\{([^}]*)\}/);
  assert.ok(linha, 'Não achei PLAN_PRICES_CENTS — a fonte da verdade dos preços mudou de lugar.');
  const out = {};
  for (const m of linha[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[m[1]] = Number(m[2]) / 100;
  return out;
}

describe('M-8 — JSON-LD de preços', () => {
  test('planos.html tem JSON-LD e ele é JSON válido', () => {
    const blocos = blocosLd(ler('planos.html'));
    assert.ok(blocos.length >= 1, 'planos.html ficou sem JSON-LD — sem ele não há rich snippet.');
    for (const b of blocos) {
      assert.doesNotThrow(() => JSON.parse(b),
        'JSON-LD inválido. O Google descarta em SILÊNCIO: a página parece certa e o snippet '
        + 'simplesmente nunca aparece.');
    }
  });

  test('os preços anunciados são os preços cobrados', () => {
    const dados = JSON.parse(blocosLd(ler('planos.html'))[0]);
    const ofertas = Array.isArray(dados.offers) ? dados.offers : [dados.offers].filter(Boolean);
    assert.equal(ofertas.length, 3, 'Esperava 3 ofertas (Individual, Casal, Família).');

    const real = precosDoCodigo();
    const porNome = { Individual: 'individual', Casal: 'casal', 'Família': 'familia' };

    for (const oferta of ofertas) {
      const chave = porNome[oferta.name];
      assert.ok(chave, `Oferta "${oferta.name}" não corresponde a nenhum plano do código.`);
      assert.equal(Number(oferta.price), real[chave],
        `"${oferta.name}" anuncia R$ ${oferta.price} e a edge cobra R$ ${real[chave]}. `
        + 'Preço errado no snippet é a PRIMEIRA informação que o cliente vê — ele descobriria '
        + 'a diferença só no checkout.');
      assert.equal(oferta.priceCurrency, 'BRL');
    }
  });

  test('a faixa do index cobre os preços reais', () => {
    // O index declara AggregateOffer com lowPrice/highPrice. Se um plano sair
    // da faixa, o dado estruturado passa a mentir por omissão.
    const graph = JSON.parse(blocosLd(ler('index.html'))[0]);
    const nos = graph['@graph'] ?? [graph];
    const agg = nos.map((n) => n.offers).find((o) => o && o['@type'] === 'AggregateOffer');
    assert.ok(agg, 'O index perdeu o AggregateOffer.');

    const real = Object.values(precosDoCodigo());
    assert.equal(Number(agg.lowPrice), Math.min(...real), 'lowPrice não é o plano mais barato.');
    assert.equal(Number(agg.highPrice), Math.max(...real), 'highPrice não é o plano mais caro.');
    assert.equal(Number(agg.offerCount), real.length, 'offerCount não bate com a quantidade de planos.');
  });

  test('nenhum dado estruturado inventa avaliação', () => {
    // Não há usuários ativos. aggregateRating aqui seria prova social fabricada —
    // decisão explícita do dono do produto, e violação das diretrizes do Google.
    for (const arq of ['index.html', 'planos.html']) {
      for (const b of blocosLd(ler(arq))) {
        assert.ok(!/aggregateRating|"reviewCount"/.test(b),
          `${arq} declara avaliação no JSON-LD. Não há usuários para avaliar.`);
      }
    }
  });
});
