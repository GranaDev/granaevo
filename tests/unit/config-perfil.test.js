/**
 * GranaEvo — Sanitização do `config` por perfil (Fase 2 do RF-09).
 *
 * Trava a regra que já derrubou dados em produção: se esta função parar de
 * emitir `viagem` ou `horasVida`, o save DESCARTA o campo em silêncio (o
 * `dadosPerfil` é allow-list) e o recurso "some no reload". E prova a invariante
 * do isolamento por perfil: a função é PURA e SEM ESTADO, então sanitizar o
 * perfil A e depois o B nunca vaza dado de um para o outro.
 *
 * Puro, sem rede/DOM. Roda no CI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizarConfigPerfil } from '../../src/scripts/modules/config-perfil.js';

// Réplica mínima do _sanitizeText do dashboard só para o teste de injeção.
const sanitizeText = (s) => String(s ?? '').replace(/[<>]/g, '');

const viagemOk = { ativa: true, nome: 'Bahia', inicio: '2026-07-10', fim: '2026-07-15', inicioHora: '08:00:00', fimHora: '20:00:00' };
const horasOk  = { ativo: true, valorHora: 25, modo: 'mes', valorBase: 5000, horasDia: 8, horasSemana: 40 };

describe('preserva viagem E horasVida (a armadilha do allow-list)', () => {
  test('config com os dois → os dois sobrevivem', () => {
    const r = sanitizarConfigPerfil({ viagem: viagemOk, horasVida: horasOk }, sanitizeText);
    assert.ok(r.viagem, 'viagem foi descartada — o bug histórico');
    assert.ok(r.horasVida, 'horasVida foi descartada');
    assert.equal(r.viagem.inicio, '2026-07-10');
    assert.equal(r.horasVida.valorHora, 25);
  });
  test('só viagem → só viagem; só horasVida → só horasVida', () => {
    const soV = sanitizarConfigPerfil({ viagem: viagemOk }, sanitizeText);
    assert.ok(soV.viagem); assert.equal(soV.horasVida, undefined);
    const soH = sanitizarConfigPerfil({ horasVida: horasOk }, sanitizeText);
    assert.ok(soH.horasVida); assert.equal(soH.viagem, undefined);
  });
  test('a HORA de início/fim é preservada (bug 2026-07-16)', () => {
    const r = sanitizarConfigPerfil({ viagem: viagemOk }, sanitizeText);
    assert.equal(r.viagem.inicioHora, '08:00:00');
    assert.equal(r.viagem.fimHora, '20:00:00');
  });
});

describe('isolamento por perfil — pureza (não retém estado entre chamadas)', () => {
  test('sanitizar A (com viagem) e depois B (sem viagem) não vaza A em B', () => {
    const A = sanitizarConfigPerfil({ viagem: viagemOk, horasVida: horasOk }, sanitizeText);
    const B = sanitizarConfigPerfil({ horasVida: { ...horasOk, valorHora: 99 } }, sanitizeText);
    assert.ok(A.viagem);                  // A tem viagem
    assert.equal(B.viagem, undefined);    // B NÃO herdou a viagem de A
    assert.equal(B.horasVida.valorHora, 99);
    // E A não foi mutado pela chamada de B.
    assert.equal(A.horasVida.valorHora, 25);
  });
  test('a mesma entrada chamada 2× produz saídas equivalentes e independentes', () => {
    const entrada = { viagem: viagemOk };
    const r1 = sanitizarConfigPerfil(entrada, sanitizeText);
    const r2 = sanitizarConfigPerfil(entrada, sanitizeText);
    assert.notEqual(r1, r2);                 // objetos distintos
    assert.deepEqual({ ...r1 }, { ...r2 });  // conteúdo igual
  });
  test('não muta a entrada', () => {
    const entrada = { viagem: { ...viagemOk }, horasVida: { ...horasOk } };
    const copia = JSON.parse(JSON.stringify(entrada));
    sanitizarConfigPerfil(entrada, sanitizeText);
    assert.deepEqual(entrada, copia);
  });
});

describe('robustez — entrada corrompida vira config limpa', () => {
  test('entrada inválida → objeto vazio de protótipo nulo', () => {
    for (const mau of [null, undefined, 42, 'x', [], []]) {
      const r = sanitizarConfigPerfil(mau, sanitizeText);
      assert.equal(Object.getPrototypeOf(r), null, 'deve ser Object.create(null)');
      assert.equal(Object.keys(r).length, 0);
    }
  });
  test('__proto__ na entrada não polui', () => {
    const r = sanitizarConfigPerfil(JSON.parse('{"__proto__":{"x":1},"viagem":' + JSON.stringify(viagemOk) + '}'), sanitizeText);
    assert.equal(({}).x, undefined);
    assert.ok(r.viagem);
  });
  test('horasVida fora dos limites é descartada', () => {
    assert.equal(sanitizarConfigPerfil({ horasVida: { valorHora: 0, modo: 'mes' } }, sanitizeText).horasVida, undefined);
    assert.equal(sanitizarConfigPerfil({ horasVida: { valorHora: 200000, modo: 'mes' } }, sanitizeText).horasVida, undefined);
    assert.equal(sanitizarConfigPerfil({ horasVida: { valorHora: 25, modo: 'invalido' } }, sanitizeText).horasVida, undefined);
  });
  test('viagem sem inicio válido é descartada; fim < inicio zera o fim', () => {
    assert.equal(sanitizarConfigPerfil({ viagem: { ...viagemOk, inicio: 'xx' } }, sanitizeText).viagem, undefined);
    const r = sanitizarConfigPerfil({ viagem: { ...viagemOk, fim: '2026-07-01' } }, sanitizeText);
    assert.equal(r.viagem.fim, null);
    assert.equal(r.viagem.fimHora, null);
  });
  test('nome da viagem passa pelo sanitizeText injetado', () => {
    const r = sanitizarConfigPerfil({ viagem: { ...viagemOk, nome: '<script>Férias' } }, sanitizeText);
    assert.equal(r.viagem.nome, 'scriptFérias');
  });
  test('sem sanitizeText injetado → usa fallback String() (não quebra)', () => {
    const r = sanitizarConfigPerfil({ viagem: viagemOk });
    assert.equal(r.viagem.nome, 'Bahia');
  });
});
