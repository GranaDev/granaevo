// ---------------------------------------------------------------------------
// _restore-core.js — núcleo PURO do restore POR PERFIL (RF-09)
//
// POR QUE ISTO EXISTE: até 2026-07-24 o restore sobrescrevia o `data_json`
// INTEIRO da conta — um convidado restaurando revertia TODOS os perfis do plano
// à data do snapshot (a dor nº 1 do RF-09). Este núcleo troca APENAS o slot do
// perfil pedido, preservando os demais byte-a-byte.
//
// Runtime-agnóstico DE PROPÓSITO: usa só APIs globais (crypto.subtle, atob,
// btoa, TextEncoder/Decoder) presentes em Deno E Node 20+. NENHUMA API de Deno
// aqui (a chave entra por parâmetro) → o edge importa isto E os testes em
// `node --test` exercem exatamente o mesmo código. Sem cópia divergente.
//
// ⚠️ A CRIPTO É RÉPLICA EXATA de save-user-data / get-user-data:
//    HKDF-SHA256(salt=userId, info='granaevo-data-v2') → AES-256-GCM,
//    envelope "v2:base64(iv[12] + ciphertext + authTag)".
//    Se divergir em UM byte, get-user-data não decifra o que gravarmos e o
//    usuário perde a conta. Qualquer mudança aqui precisa casar com aquelas duas.
// ---------------------------------------------------------------------------

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// base64 de um Uint8Array sem estourar a pilha (o spread `...arr` do save-user-data
// quebra em blobs grandes). Saída idêntica a btoa(String.fromCharCode(...arr)).
function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function deriveUserKey(keyBase64, userId) {
  if (!keyBase64) return null;
  const masterBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const masterKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ENC.encode(userId), info: ENC.encode('granaevo-data-v2') },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptData(keyBase64, plaintext, userId) {
  const key = await deriveUserKey(keyBase64, userId);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(plaintext));
  const combined = new Uint8Array(iv.byteLength + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.byteLength);
  return 'v2:' + bytesToB64(combined);
}

export async function decryptData(keyBase64, encrypted, userId) {
  if (typeof encrypted !== 'string' || !keyBase64) return null;
  try {
    let key;
    let payload;
    if (encrypted.startsWith('v2:')) {
      const derived = await deriveUserKey(keyBase64, userId);
      if (!derived) return null;
      key = derived;
      payload = encrypted.slice(3);
    } else if (encrypted.startsWith('v1:')) {
      const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
      key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
      payload = encrypted.slice(3);
    } else {
      return null;
    }
    const combined = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return DEC.decode(plain);
  } catch {
    return null;
  }
}

// Abre o data_json armazenado em claro. Retorna { plain, wasEncrypted }.
// Lança em falha de decifragem/JSON (NUNCA devolve algo parcial — abortar é o
// que impede corromper o blob).
export async function openBlob(keyBase64, dataJson, userId) {
  if (dataJson && typeof dataJson._enc === 'string') {
    const plain = await decryptData(keyBase64, dataJson._enc, userId);
    if (plain == null) throw new Error('decrypt_failed');
    let obj;
    try { obj = JSON.parse(plain); } catch { throw new Error('json_invalido'); }
    return { plain: obj, wasEncrypted: true };
  }
  // Legado não-cifrado: objeto { profiles } ou array cru.
  if (Array.isArray(dataJson)) return { plain: { profiles: dataJson }, wasEncrypted: false };
  if (dataJson && typeof dataJson === 'object') return { plain: dataJson, wasEncrypted: false };
  throw new Error('shape_invalido');
}

function profilesDe(plain) {
  if (Array.isArray(plain)) return plain;
  if (plain && Array.isArray(plain.profiles)) return plain.profiles;
  return null;
}

// PURO: array de perfis atual com APENAS o slot `profileId` trocado pelo do
// snapshot. Não muta entradas (troca a referência do slot). Lança em erro de
// entrada — o chamador aborta sem gravar.
export function mergeProfileSlot(currentProfiles, snapshotProfiles, profileId) {
  if (!Array.isArray(currentProfiles)) throw new Error('current_nao_array');
  if (!Array.isArray(snapshotProfiles)) throw new Error('snapshot_nao_array');
  const pid = String(profileId ?? '');
  if (!pid) throw new Error('profile_id_vazio');

  const fromSnap = snapshotProfiles.find((p) => p && String(p.id) === pid);
  if (!fromSnap) throw new Error('perfil_ausente_no_snapshot');

  const out = currentProfiles.slice();
  const idx = out.findIndex((p) => p && String(p.id) === pid);
  if (idx === -1) {
    // Perfil existe no snapshot mas não no atual (foi apagado depois): re-adiciona.
    out.push(fromSnap);
    return { profiles: out, outcome: 'readded' };
  }
  out[idx] = fromSnap;
  return { profiles: out, outcome: 'replaced' };
}

// Orquestra o restore por-slot ponta a ponta e devolve o data_json a GRAVAR.
// Preserva o envelope do ATUAL (version/user/metadata), troca só `profiles`, e
// re-cifra se houver chave (mesma política do save-user-data). Se QUALQUER etapa
// falha, LANÇA — nunca devolve um blob a meio caminho.
export async function buildRestoredBlob({ keyBase64, currentDataJson, snapshotDataJson, profileId, userId, now }) {
  const cur = await openBlob(keyBase64, currentDataJson, userId);
  const snap = await openBlob(keyBase64, snapshotDataJson, userId);

  const curProfiles = profilesDe(cur.plain);
  const snapProfiles = profilesDe(snap.plain);
  if (!curProfiles) throw new Error('current_sem_profiles');
  if (!snapProfiles) throw new Error('snapshot_sem_profiles');

  const { profiles, outcome } = mergeProfileSlot(curProfiles, snapProfiles, profileId);

  // Reembala preservando tudo do envelope atual, trocando só `profiles`.
  const base = (cur.plain && typeof cur.plain === 'object' && !Array.isArray(cur.plain))
    ? cur.plain
    : {};
  const novoPlain = { ...base, profiles };
  if (novoPlain.metadata && typeof novoPlain.metadata === 'object') {
    novoPlain.metadata = {
      ...novoPlain.metadata,
      lastSync: now || new Date().toISOString(),
      totalProfiles: profiles.length,
    };
  }

  if (keyBase64) {
    const enc = await encryptData(keyBase64, JSON.stringify(novoPlain), userId);
    if (!enc) throw new Error('encrypt_failed');
    return { dataToStore: { _enc: enc }, outcome };
  }
  return { dataToStore: novoPlain, outcome };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXCLUSÃO DE PERFIL (2026-08-15) — ver docs/exclusao-de-perfil-desenho.md
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PURO: tira o perfil `profileId` da lista de MEMBROS de toda reserva
 * compartilhada dos perfis que ficam.
 *
 * O valor que ele já aportou PERMANECE na reserva — decisão do dono. Os demais
 * membros são avisados e podem ajustar o saldo pela tela; mexer no total aqui
 * seria alterar uma meta compartilhada sem que ninguém aprovasse.
 *
 * Devolve também `afetadas`, para o chamador saber a quem notificar. Reserva
 * sem membros declarados não é tocada.
 */
export function sairDasReservas(profiles, profileId) {
  const pid = String(profileId ?? '');
  if (!pid) throw new Error('profile_id_vazio');
  if (!Array.isArray(profiles)) throw new Error('profiles_nao_array');

  const afetadas = [];
  const out = profiles.map((p) => {
    if (!p || String(p.id) === pid) return p;          // o próprio sai inteiro
    const metas = Array.isArray(p.metas) ? p.metas : null;
    if (!metas) return p;

    let mexeu = false;
    const novasMetas = metas.map((m) => {
      if (!m || !Array.isArray(m.membros)) return m;
      if (!m.membros.some((x) => String(x?.id ?? x) === pid)) return m;
      mexeu = true;
      afetadas.push({ perfil: String(p.id), meta: String(m.id ?? ''), nome: m.nome ?? m.titulo ?? '' });
      return { ...m, membros: m.membros.filter((x) => String(x?.id ?? x) !== pid) };
    });

    return mexeu ? { ...p, metas: novasMetas } : p;
  });

  return { profiles: out, afetadas };
}

/**
 * PURO: separa o slot do perfil do resto da lista.
 *
 * `slot` é o que vai para o backup de 7 dias — é o conteúdo financeiro inteiro
 * daquele perfil. `restantes` é o que fica no blob, já sem ele e já fora das
 * reservas dos outros.
 *
 * Lança se o perfil não está lá: o chamador aborta ANTES de gravar qualquer
 * coisa, e o perfil segue vivo. Um backup vazio seria pior que nenhum.
 */
export function extrairProfileSlot(profiles, profileId) {
  if (!Array.isArray(profiles)) throw new Error('profiles_nao_array');
  const pid = String(profileId ?? '');
  if (!pid) throw new Error('profile_id_vazio');

  const slot = profiles.find((p) => p && String(p.id) === pid);
  if (!slot) throw new Error('perfil_ausente_no_blob');

  const semEle = profiles.filter((p) => !p || String(p.id) !== pid);
  const { profiles: restantes, afetadas } = sairDasReservas(semEle, pid);
  return { slot, restantes, afetadas };
}

/** Reembala `profiles` no envelope atual e cifra. Mesma política do save. */
async function fecharBlob(keyBase64, plainAtual, profiles, userId, now) {
  const base = (plainAtual && typeof plainAtual === 'object' && !Array.isArray(plainAtual))
    ? plainAtual : {};
  const novoPlain = { ...base, profiles };
  if (novoPlain.metadata && typeof novoPlain.metadata === 'object') {
    novoPlain.metadata = {
      ...novoPlain.metadata,
      lastSync: now || new Date().toISOString(),
      totalProfiles: profiles.length,
    };
  }
  if (keyBase64) {
    const enc = await encryptData(keyBase64, JSON.stringify(novoPlain), userId);
    if (!enc) throw new Error('encrypt_failed');
    return { _enc: enc };
  }
  return novoPlain;
}

/**
 * Blob SEM o perfil, mais o slot para guardar no backup.
 *
 * LANÇA em qualquer erro — nunca devolve um blob a meio caminho. O chamador só
 * grava se isto voltar inteiro, e é isso que garante a ordem do desenho:
 * backup primeiro, blob depois, desativar por último.
 */
export async function buildBlobSemPerfil({ keyBase64, currentDataJson, profileId, userId, now }) {
  const cur = await openBlob(keyBase64, currentDataJson, userId);
  const curProfiles = profilesDe(cur.plain);
  if (!curProfiles) throw new Error('current_sem_profiles');

  const { slot, restantes, afetadas } = extrairProfileSlot(curProfiles, profileId);
  const dataToStore = await fecharBlob(keyBase64, cur.plain, restantes, userId, now);
  return { dataToStore, slot, afetadas, restantes: restantes.length };
}

/**
 * Blob COM o perfil de volta, a partir do slot guardado no backup.
 *
 * Não restaura a participação nas reservas dos outros: quem saiu, saiu. Voltar
 * a inscrever alguém numa meta compartilhada sem os demais saberem seria pior
 * que a perda — e o valor aportado já ficou lá.
 */
export async function buildBlobComPerfil({ keyBase64, currentDataJson, slot, userId, now }) {
  if (!slot || typeof slot !== 'object' || !slot.id) throw new Error('slot_invalido');
  const cur = await openBlob(keyBase64, currentDataJson, userId);
  const curProfiles = profilesDe(cur.plain);
  if (!curProfiles) throw new Error('current_sem_profiles');

  const pid = String(slot.id);
  // Idempotente: se já está lá (retentativa depois de uma falha), substitui em
  // vez de duplicar. Perfil duplicado no blob é a origem do "órfão que oscila".
  const idx = curProfiles.findIndex((p) => p && String(p.id) === pid);
  const profiles = curProfiles.slice();
  if (idx === -1) profiles.push(slot); else profiles[idx] = slot;

  const dataToStore = await fecharBlob(keyBase64, cur.plain, profiles, userId, now);
  return { dataToStore, total: profiles.length };
}
