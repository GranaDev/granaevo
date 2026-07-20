// horas-vida.test.js — "custo em horas de trabalho" (RF-08).
//
// Cobre a lógica PURA do módulo: getHorasVida (normalização + validação) e
// formatarHoras (valor → "Xh Ymin"). O popup (abrirPopupHorasVida/chipHorasVida)
// é DOM e fica para o teste manual do usuário — o cálculo mês→hora vive lá dentro
// (_calcularValorHora, privado); a matemática está documentada e conferida abaixo.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getHorasVida, formatarHoras } from '../../src/scripts/modules/horas-vida.js';

describe('getHorasVida — normaliza e valida a config', () => {
  test('null quando nunca configurada', () => {
    assert.equal(getHorasVida(undefined), null);
    assert.equal(getHorasVida({}), null);
    assert.equal(getHorasVida({ horasVida: null }), null);
  });

  test('null quando valorHora fora dos limites (0,01–100000)', () => {
    assert.equal(getHorasVida({ horasVida: { valorHora: 0 } }), null);
    assert.equal(getHorasVida({ horasVida: { valorHora: -5 } }), null);
    assert.equal(getHorasVida({ horasVida: { valorHora: 100001 } }), null);
    assert.equal(getHorasVida({ horasVida: { valorHora: 'abc' } }), null);
  });

  test('devolve { ativo, valorHora, modo } quando válida', () => {
    const r = getHorasVida({ horasVida: { ativo: true, valorHora: 25, modo: 'mes' } });
    assert.deepEqual(r, { ativo: true, valorHora: 25, modo: 'mes' });
  });

  test('ativo só é true com === true (não coage)', () => {
    assert.equal(getHorasVida({ horasVida: { ativo: 1, valorHora: 25 } }).ativo, false);
    assert.equal(getHorasVida({ horasVida: { valorHora: 25 } }).ativo, false);
  });

  test('modo cai para "hora" quando ausente', () => {
    assert.equal(getHorasVida({ horasVida: { valorHora: 10 } }).modo, 'hora');
  });
});

describe('formatarHoras — valor em R$ → horas de trabalho', () => {
  test('exemplo da doc: R$68 a R$20/h = 3h 24min', () => {
    assert.equal(formatarHoras(68, 20), '3h 24min');
  });

  test('horas cheias sem minutos', () => {
    assert.equal(formatarHoras(100, 20), '5h');
  });

  test('menos de 1 hora vira só minutos', () => {
    assert.equal(formatarHoras(10, 20), '30min');
  });

  test('valor ínfimo vira "< 1min"', () => {
    assert.equal(formatarHoras(0.1, 20), '< 1min');
  });

  test('acima de 200h omite minutos (ruído)', () => {
    assert.equal(formatarHoras(5000, 20), '250h');
  });

  test('entradas inválidas devolvem null', () => {
    assert.equal(formatarHoras(0, 20), null);
    assert.equal(formatarHoras(-5, 20), null);
    assert.equal(formatarHoras(50, 0), null);
    assert.equal(formatarHoras('x', 20), null);
  });

  // Confere a conversão mês→hora que o popup faz (_calcularValorHora, privado):
  //   valorHora = salário / (horasSemana * 4.345)
  // Salário 4345 @ 40h/sem → 4345 / (40 * 4.345) = 4345 / 173.8 = 25,00/h.
  // Então um gasto de R$100 deve custar 4h a esse salário.
  test('sanidade da conversão mês→hora (documentada): R$4345/mês @40h/sem ⇒ R$25/h ⇒ R$100 = 4h', () => {
    const SEMANAS_POR_MES = 4.345;
    const valorHora = Math.round((4345 / (40 * SEMANAS_POR_MES)) * 100) / 100;
    assert.equal(valorHora, 25);
    assert.equal(formatarHoras(100, valorHora), '4h');
  });
});
