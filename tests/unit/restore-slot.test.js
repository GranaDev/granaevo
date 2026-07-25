/**
 * GranaEvo — Restore POR PERFIL (RF-09), núcleo puro + cripto.
 *
 * Prova a invariante central do RF-09: restaurar o perfil A troca SÓ o slot de A
 * e deixa B/C/D intactos byte-a-byte — mesmo com o blob cifrado em repouso.
 *
 * Exerce EXATAMENTE o código que o edge user-data-backup roda (mesmo módulo,
 * sem cópia). Puro, sem rede/DOM. Roda no CI (globais webcrypto/atob/btoa no
 * Node 20+).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptData, decryptData, mergeProfileSlot, buildRestoredBlob, openBlob,
} from '../../supabase/functions/user-data-backup/_restore-core.js';

// Chave-mestra de teste (32 bytes → base64). NÃO é a de produção.
const KEY = Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)).toString('base64');
const USER = '11111111-1111-1111-1111-111111111111';

const perfil = (id, valor) => ({
  id,
  nome: 'Perfil ' + id,
  transacoes: [{ id: 't' + id, valor, descricao: 'x' + id }],
  metas: [],
  config: {},
});

// Monta o blob-envelope como o save-user-data grava (antes de cifrar).
const envelope = (profiles) => ({
  version: '1.0',
  user: { userId: USER, email: 'a@b.com' },
  profiles,
  metadata: { lastSync: '2020-01-01T00:00:00.000Z', totalProfiles: profiles.length },
});

async function cifrar(profiles) {
  const enc = await encryptData(KEY, JSON.stringify(envelope(profiles)), USER);
  return { _enc: enc };
}

describe('cripto — round-trip idêntico ao save/get', () => {
  test('encrypt → decrypt devolve o texto original', async () => {
    const enc = await encryptData(KEY, 'olá mundo €', USER);
    assert.equal(enc.startsWith('v2:'), true);
    assert.equal(await decryptData(KEY, enc, USER), 'olá mundo €');
  });
  test('userId diferente NÃO decifra (chave derivada por usuário)', async () => {
    const enc = await encryptData(KEY, 'segredo', USER);
    assert.equal(await decryptData(KEY, enc, '22222222-2222-2222-2222-222222222222'), null);
  });
  test('sem chave → null (nunca grava lixo)', async () => {
    assert.equal(await encryptData('', 'x', USER), null);
    assert.equal(await decryptData('', 'v2:abc', USER), null);
  });
});

describe('mergeProfileSlot — puro', () => {
  const A = perfil('A', 1); const B = perfil('B', 2); const C = perfil('C', 3);
  test('troca só o slot alvo; B e C ficam por REFERÊNCIA idêntica', () => {
    const snapA = perfil('A', 999);
    const { profiles, outcome } = mergeProfileSlot([A, B, C], [snapA, perfil('B', 0)], 'A');
    assert.equal(outcome, 'replaced');
    assert.equal(profiles[0], snapA);      // A = versão do snapshot
    assert.equal(profiles[1], B);          // B intocado (mesma referência)
    assert.equal(profiles[2], C);          // C intocado
    assert.equal(profiles.length, 3);
  });
  test('id numérico vs string casam (String(id))', () => {
    const cur = [{ id: 5, nome: 'v-atual' }];
    const snap = [{ id: '5', nome: 'v-snap' }];
    const { profiles } = mergeProfileSlot(cur, snap, 5);
    assert.equal(profiles[0].nome, 'v-snap');
  });
  test('perfil apagado do atual mas presente no snapshot → re-adiciona', () => {
    const { profiles, outcome } = mergeProfileSlot([B], [perfil('A', 7)], 'A');
    assert.equal(outcome, 'readded');
    assert.equal(profiles.length, 2);
    assert.equal(profiles[1].id, 'A');
  });
  test('snapshot sem o perfil → lança (não inventa dado)', () => {
    assert.throws(() => mergeProfileSlot([A], [B], 'A'), /perfil_ausente_no_snapshot/);
  });
  test('entradas inválidas lançam', () => {
    assert.throws(() => mergeProfileSlot(null, [], 'A'), /current_nao_array/);
    assert.throws(() => mergeProfileSlot([], null, 'A'), /snapshot_nao_array/);
    assert.throws(() => mergeProfileSlot([], [], ''), /profile_id_vazio/);
  });
});

describe('buildRestoredBlob — ponta a ponta, cifrado (a invariante do RF-09)', () => {
  test('restaurar A: A volta ao snapshot; B/C/D idênticos ao ATUAL', async () => {
    const atualProfiles = [perfil('A', 10), perfil('B', 20), perfil('C', 30), perfil('D', 40)];
    const snapProfiles  = [perfil('A', 1),  perfil('B', 2),  perfil('C', 3),  perfil('D', 4)];
    const current  = await cifrar(atualProfiles);
    const snapshot = await cifrar(snapProfiles);

    const { dataToStore, outcome } = await buildRestoredBlob({
      keyBase64: KEY, currentDataJson: current, snapshotDataJson: snapshot,
      profileId: 'A', userId: USER, now: '2026-07-24T00:00:00.000Z',
    });
    assert.equal(outcome, 'replaced');
    assert.equal(typeof dataToStore._enc, 'string');

    // Decifra o resultado e confere slot a slot.
    const plano = JSON.parse(await decryptData(KEY, dataToStore._enc, USER));
    const byId = Object.fromEntries(plano.profiles.map((p) => [p.id, p]));
    assert.equal(byId.A.transacoes[0].valor, 1);   // A = snapshot
    assert.equal(byId.B.transacoes[0].valor, 20);  // B = atual (NÃO revertido)
    assert.equal(byId.C.transacoes[0].valor, 30);  // C = atual
    assert.equal(byId.D.transacoes[0].valor, 40);  // D = atual
    // Envelope preservado + metadata atualizado.
    assert.equal(plano.version, '1.0');
    assert.equal(plano.metadata.totalProfiles, 4);
    assert.equal(plano.metadata.lastSync, '2026-07-24T00:00:00.000Z');
  });

  test('decifragem impossível (chave errada) → LANÇA, nunca grava', async () => {
    const snapshot = await cifrar([perfil('A', 1)]);
    const current  = await cifrar([perfil('A', 10)]);
    const chaveErrada = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
    await assert.rejects(
      buildRestoredBlob({ keyBase64: chaveErrada, currentDataJson: current, snapshotDataJson: snapshot, profileId: 'A', userId: USER }),
      /decrypt_failed/,
    );
  });

  test('legado não-cifrado (sem chave) → merge em claro', async () => {
    const current  = envelope([perfil('A', 10), perfil('B', 20)]);
    const snapshot = envelope([perfil('A', 1)]);
    const { dataToStore, outcome } = await buildRestoredBlob({
      keyBase64: '', currentDataJson: current, snapshotDataJson: snapshot, profileId: 'A', userId: USER,
    });
    assert.equal(outcome, 'replaced');
    const byId = Object.fromEntries(dataToStore.profiles.map((p) => [p.id, p]));
    assert.equal(byId.A.transacoes[0].valor, 1);
    assert.equal(byId.B.transacoes[0].valor, 20);
  });
});

describe('openBlob — formas aceitas', () => {
  test('array cru legado vira { profiles }', async () => {
    const { plain } = await openBlob('', [perfil('A', 1)], USER);
    assert.equal(Array.isArray(plain.profiles), true);
  });
  test('_enc indecifrável lança', async () => {
    await assert.rejects(openBlob(KEY, { _enc: 'v2:naoehbase64valido!!' }, USER), /decrypt_failed/);
  });
});
