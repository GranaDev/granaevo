// crypto-store.js — histórico do chat cifrado EM REPOUSO no aparelho
// ---------------------------------------------------------------------------
// O histórico da conversa contém valores (o usuário digitou "gastei 300…").
// Antes ficava em claro no localStorage; agora é AES-GCM com uma CryptoKey
// NÃO-extraível guardada no IndexedDB (a chave nunca existe como string — nem
// pra nós). Um script que leia localStorage/IndexedDB de fora do contexto da
// página não consegue exportar a chave; o dado cifrado sozinho é inútil.
//
// Fallback honesto: se WebCrypto/IndexedDB não existem (browser antigo/modo
// privado), NÃO persistimos nada — histórico vive só em memória na sessão.
// ---------------------------------------------------------------------------

const DB_NAME = 'ge-assistant';
const STORE = 'keys';

function _idbOpen() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('no-idb'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function _idbGet(db, k) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
        tx.onsuccess = () => resolve(tx.result ?? null);
        tx.onerror = () => reject(tx.error);
    });
}

function _idbPut(db, k, v) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k);
        tx.onsuccess = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function _idbDel(db, k) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(k);
        tx.onsuccess = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function _getKey(userId, create) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    let db;
    try { db = await _idbOpen(); } catch { return null; }
    try {
        const id = `hist_${userId || 'anon'}`;
        let key = await _idbGet(db, id);
        if (!key && create) {
            key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            await _idbPut(db, id, key);
        }
        return key || null;
    } catch { return null; }
    finally { try { db.close(); } catch { /* ignore */ } }
}

/** Cifra uma string → base64(iv || ciphertext), ou null se cripto indisponível. */
export async function encryptText(userId, plain) {
    const key = await _getKey(userId, true);
    if (!key) return null;
    try {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
        const buf = new Uint8Array(iv.length + ct.byteLength);
        buf.set(iv, 0);
        buf.set(new Uint8Array(ct), iv.length);
        let bin = '';
        for (const b of buf) bin += String.fromCharCode(b);
        return btoa(bin);
    } catch { return null; }
}

/** Decifra base64(iv || ciphertext) → string, ou null (chave errada/corrompido). */
export async function decryptText(userId, b64) {
    const key = await _getKey(userId, false);
    if (!key || typeof b64 !== 'string') return null;
    try {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const iv = raw.slice(0, 12);
        const ct = raw.slice(12);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(pt);
    } catch { return null; }
}

/** Apaga a chave do usuário (logout) — o que sobrou cifrado vira lixo ilegível. */
export async function destroyKey(userId) {
    try {
        const db = await _idbOpen();
        await _idbDel(db, `hist_${userId || 'anon'}`);
        try { db.close(); } catch { /* ignore */ }
    } catch { /* ignore */ }
}
