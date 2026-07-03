// session-lock.js — trava OPT-IN de abertura (PIN ou biometria)
// ---------------------------------------------------------------------------
// IMPORTANTE: isto é uma trava de CONVENIÊNCIA local do dispositivo, não a
// fronteira de autenticação. A auth real continua sendo o cookie HttpOnly +
// JWT (supabase-client). O PIN nunca é salvo em claro — só um hash PBKDF2 com
// salt aleatório. A biometria usa WebAuthn como gate de presença do dono do
// aparelho (não substitui o login). Padrão do app: SEM trava (sessão longa).
// ---------------------------------------------------------------------------

const PBKDF2_ITERS = 150_000;

function key(userId, suffix) { return `ge_asst_lock_${userId || 'anon'}_${suffix}`; }
function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function fromB64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

async function hashPIN(pin, salt) {
    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' }, material, 256);
    return b64(bits);
}

export function getMode(userId) {
    try { return localStorage.getItem(key(userId, 'mode')) || null; } catch { return null; }
}
export function isEnabled(userId) { return !!getMode(userId); }

// ── PIN ──────────────────────────────────────────────────────────────────────
export async function setupPIN(userId, pin) {
    if (!/^\d{4,8}$/.test(pin)) return false;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await hashPIN(pin, salt);
    try {
        localStorage.setItem(key(userId, 'salt'), b64(salt));
        localStorage.setItem(key(userId, 'hash'), hash);
        localStorage.setItem(key(userId, 'mode'), 'pin');
    } catch { return false; }
    return true;
}

export async function verifyPIN(userId, pin) {
    try {
        const salt = localStorage.getItem(key(userId, 'salt'));
        const stored = localStorage.getItem(key(userId, 'hash'));
        if (!salt || !stored) return false;
        const hash = await hashPIN(pin, fromB64(salt));
        // Comparação em tempo ~constante (mesmo comprimento base64).
        if (hash.length !== stored.length) return false;
        let diff = 0;
        for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.charCodeAt(i);
        return diff === 0;
    } catch { return false; }
}

// ── Biometria (WebAuthn — gate de presença) ───────────────────────────────────
export function biometricSupported() {
    return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

export async function setupBiometric(userId) {
    if (!biometricSupported()) return false;
    try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const uidBytes = new TextEncoder().encode(String(userId || 'anon')).slice(0, 64);
        const cred = await navigator.credentials.create({
            publicKey: {
                challenge,
                rp: { name: 'GranaEvo', id: location.hostname },
                user: { id: uidBytes, name: 'assistente', displayName: 'Assistente GranaEvo' },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
                timeout: 60_000,
            },
        });
        if (!cred) return false;
        localStorage.setItem(key(userId, 'credid'), b64(cred.rawId));
        localStorage.setItem(key(userId, 'mode'), 'biometric');
        return true;
    } catch { return false; }
}

export async function unlockBiometric(userId) {
    if (!biometricSupported()) return false;
    try {
        const idB64 = localStorage.getItem(key(userId, 'credid'));
        if (!idB64) return false;
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{ type: 'public-key', id: fromB64(idB64) }],
                userVerification: 'required',
                timeout: 60_000,
            },
        });
        return !!assertion;
    } catch { return false; }
}

export function disableLock(userId) {
    for (const s of ['mode', 'salt', 'hash', 'credid']) {
        try { localStorage.removeItem(key(userId, s)); } catch {}
    }
}
