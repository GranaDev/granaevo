// boot-cache.test.js — cache de boot cifrado (Passo 9, metade display-only).
//
// O QUE DÁ PARA PROVAR AQUI, E O QUE NÃO DÁ
// Este módulo só existe dentro do browser: precisa de localStorage, WebCrypto e
// IndexedDB. Em Node dá para stubbar o localStorage, mas WebCrypto com chave
// não-extraível guardada no IndexedDB, não — então o caminho "cifra e decifra
// de verdade" NÃO está coberto por teste automatizado, e isso tem que ser dito
// em voz alta em vez de ficar implícito num teste que passa por engano.
//
// O que ESTES testes garantem:
//  1. sem cripto disponível, NADA é persistido (o fallback honesto do módulo);
//  2. a purga das chaves em texto claro da v1 realmente apaga — é a correção de
//     segurança desta mudança (saldo em claro no localStorage);
//  3. limparTudo() no logout leva as duas gerações de chave.
// O caminho cifrado real depende de teste manual no navegador.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── stub mínimo de localStorage ──────────────────────────────────────────────
function instalarStorage(inicial = {}) {
    const mapa = new Map(Object.entries(inicial));
    globalThis.localStorage = {
        get length() { return mapa.size; },
        key: (i) => [...mapa.keys()][i] ?? null,
        getItem: (k) => (mapa.has(k) ? mapa.get(k) : null),
        setItem: (k, v) => { mapa.set(k, String(v)); },
        removeItem: (k) => { mapa.delete(k); },
    };
    return mapa;
}

// Sem WebCrypto/IndexedDB: é o estado natural do Node e também o do browser em
// modo privado/antigo — exatamente o cenário de fallback que queremos exercer.
delete globalThis.indexedDB;

const mod = await import('../../src/scripts/modules/boot-cache.js');

test('sem cripto disponível, não persiste nada (fallback honesto)', async () => {
    const mapa = instalarStorage();
    const ok = await mod.guardarKpis('user-1', 'perf-1', {
        entradas: 100, saidas: 40, saldo: 60, reservas: 10,
    });
    assert.equal(ok, false, 'deveria recusar gravar sem cripto');
    assert.equal(mapa.size, 0, 'nada pode sobrar no storage');
});

test('leitura devolve null quando não há nada guardado', async () => {
    instalarStorage();
    assert.equal(await mod.lerKpis('user-1', 'perf-1'), null);
});

test('leitura devolve null sem userId ou perfilId', async () => {
    instalarStorage();
    assert.equal(await mod.lerKpis(null, 'perf-1'), null);
    assert.equal(await mod.lerKpis('user-1', null), null);
});

test('purgarClaro apaga as chaves v1 (saldo em texto claro) e só elas', () => {
    const mapa = instalarStorage({
        'ge_boot_kpi_user-1_perf-1': '{"v":1,"sa":4820.55}',
        'ge_boot_kpi_user-1_perf-2': '{"v":1,"sa":10}',
        'ge_bootc_user-1_perf-1':    'cifrado-intocado',
        'ge_perfil_id':              'perf-1',
    });

    const n = mod.purgarClaro();

    assert.equal(n, 2, 'deveria remover as duas chaves em claro');
    assert.equal(mapa.has('ge_boot_kpi_user-1_perf-1'), false);
    assert.equal(mapa.has('ge_boot_kpi_user-1_perf-2'), false);
    assert.equal(mapa.get('ge_bootc_user-1_perf-1'), 'cifrado-intocado', 'cifrado não é alvo da purga');
    assert.equal(mapa.get('ge_perfil_id'), 'perf-1', 'chave alheia não pode ser tocada');
});

test('limparTudo (logout) leva cifradas E em claro, sem tocar no resto', () => {
    const mapa = instalarStorage({
        'ge_bootc_user-1_perf-1':    'x',
        'ge_bootc_user-2_perf-9':    'y',
        'ge_boot_kpi_user-1_perf-1': 'z',
        'ge_remember_me':            'mantem',
    });

    const n = mod.limparTudo();

    assert.equal(n, 3);
    assert.equal(mapa.size, 1);
    assert.equal(mapa.get('ge_remember_me'), 'mantem');
});

test('storage indisponível não derruba o app', async () => {
    globalThis.localStorage = {
        get length() { throw new Error('bloqueado'); },
        key: () => { throw new Error('bloqueado'); },
        getItem: () => { throw new Error('bloqueado'); },
        setItem: () => { throw new Error('bloqueado'); },
        removeItem: () => { throw new Error('bloqueado'); },
    };

    assert.equal(mod.purgarClaro(), 0);
    assert.equal(mod.limparTudo(), 0);
    assert.equal(await mod.lerKpis('u', 'p'), null);
    assert.equal(await mod.guardarKpis('u', 'p', { entradas: 1, saidas: 1, saldo: 0, reservas: 0 }), false);
});
