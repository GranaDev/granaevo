/**
 * GranaEvo — supabase-client.js  (modelo híbrido httpOnly)
 *
 * ============================================================
 * SEGURANÇA — POR QUE ESTE MODELO
 * ============================================================
 * O REFRESH TOKEN nunca toca em JavaScript. Ele vive exclusivamente num cookie
 * HttpOnly; Secure; SameSite=Strict gerido por /api/auth-session — inalcançável
 * por XSS. O ACCESS TOKEN (curto, ~1h) vive APENAS em memória (nunca em
 * localStorage/sessionStorage) e é injetado no supabase-js via setSession, de
 * modo que supabase.from()/RPC/Realtime continuam funcionando normalmente.
 *
 * Fluxo:
 *   login     → POST /api/auth-session {login}   → setSession(access) em memória
 *   refresh   → POST /api/auth-session {refresh}  (usa o cookie) → setSession(novo access)
 *   logout    → POST /api/auth-session {logout}   → limpa cookie + sessão local
 *
 * autoRefreshToken fica DESLIGADO: o refresh é nosso (não há refresh token em JS
 * para o supabase-js usar). Um agendador renova o access antes de expirar.
 *
 * A anon key é pública por design — a segurança dos dados vem do RLS no Supabase.
 */

import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL      = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Configuração do cliente Supabase indisponível.');
}

const AUTH_ENDPOINT   = '/api/auth-session';
const REFRESH_SKEW_MS = 60_000;            // renova 60s antes de expirar
// Placeholder: o supabase-js exige um refresh_token em setSession, mas o real
// é HttpOnly e nunca vem ao JS. Com autoRefreshToken desligado e o access
// sempre renovado por nós antes de expirar, este valor nunca é usado.
const RT_PLACEHOLDER  = 'httponly-managed-server-side';

// ── "Lembrar de mim": apenas intenção; a persistência real é o Max-Age do cookie
//    decidido no servidor. Mantemos a flag para compatibilidade com login.js. ──
const _REMEMBER_KEY = '_ge_remember';
export function setRememberMe(remember) {
    try {
        if (remember) localStorage.setItem(_REMEMBER_KEY, '1');
        else          localStorage.removeItem(_REMEMBER_KEY);
    } catch {}
}
export function isRememberMe() {
    try { return localStorage.getItem(_REMEMBER_KEY) === '1'; } catch { return false; }
}
export function clearRememberMe() {
    try { localStorage.removeItem(_REMEMBER_KEY); } catch {}
    // Limpeza defensiva de qualquer token legado deixado pelo modelo antigo
    try { localStorage.removeItem('ge_auth');   } catch {}
    try { sessionStorage.removeItem('ge_auth');  } catch {}
}

// ── Storage em memória (NUNCA Web Storage) ─────────────────────────────────────
// supabase-js persiste a sessão aqui; ao recarregar a página, ela some — e é
// reidratada via /api/auth-session refresh (cookie HttpOnly) no boot.
const _mem = new Map();
const _memoryStorage = {
    getItem(k)    { return _mem.has(k) ? _mem.get(k) : null; },
    setItem(k, v) { _mem.set(k, v); },
    removeItem(k) { _mem.delete(k); },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession:     true,
        autoRefreshToken:   false,           // refresh é gerido por nós
        detectSessionInUrl: false,
        storageKey:         'ge_auth',
        storage:            _memoryStorage,
    },
});

// ── Sessão e agendador de refresh ──────────────────────────────────────────────
let _expiresAt    = 0;       // epoch (segundos) do access atual
let _refreshTimer = null;
let _refreshInFlight = null; // single-flight

function _scheduleRefresh(expiresInSecs) {
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    const delay = Math.max((expiresInSecs * 1000) - REFRESH_SKEW_MS, 5_000);
    _refreshTimer = setTimeout(() => { refreshSession().catch(() => {}); }, delay);
}

async function _applyGrant(data) {
    // data: { access_token, expires_at, expires_in, user }
    const { error } = await supabase.auth.setSession({
        access_token:  data.access_token,
        refresh_token: RT_PLACEHOLDER,
    });
    if (error) throw error;
    _expiresAt = data.expires_at ?? (Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600));
    _scheduleRefresh(data.expires_in ?? Math.max(_expiresAt - Math.floor(Date.now() / 1000), 60));
    return data;
}

async function _callAuth(action, extra = {}, withAuthHeader = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuthHeader) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`;
    }
    return fetch(AUTH_ENDPOINT, {
        method:      'POST',
        headers,
        credentials: 'same-origin',          // envia o cookie HttpOnly ge_rt
        body:        JSON.stringify({ action, ...extra }),
    });
}

/** Login server-side. Lança Error com .status em falha. */
export async function loginWithPassword(email, password, remember) {
    const res = await _callAuth('login', { email, password, remember: !!remember });
    if (!res.ok) {
        let err = 'login_failed';
        try { err = (await res.json())?.error ?? err; } catch {}
        throw Object.assign(new Error(err), { status: res.status });
    }
    return _applyGrant(await res.json());
}

/**
 * Renova o access via cookie HttpOnly. Single-flight.
 *   - 200 com access_token  → renova e retorna o grant ({ access_token, ... })
 *   - 200 com session:null  → DEFINITIVO (deslogado): limpa sessão local e retorna null
 *   - 5xx / rede            → TRANSITÓRIO: lança erro (chamador NÃO deve deslogar)
 */
export async function refreshSession() {
    if (_refreshInFlight) return _refreshInFlight;
    _refreshInFlight = (async () => {
        const res = await _callAuth('refresh', { remember: isRememberMe() }); // rede → throw
        if (!res.ok) {
            // Apenas erro real de gateway (5xx/504) → transitório
            throw Object.assign(new Error('refresh_transient'), { status: res.status });
        }
        const data = await res.json();
        if (!data?.access_token) {
            // 200 { session: null } = deslogado (sem cookie ou refresh rejeitado)
            await supabase.auth.signOut().catch(() => {});
            _expiresAt = 0;
            return null;
        }
        return _applyGrant(data);
    })().finally(() => { _refreshInFlight = null; });
    return _refreshInFlight;
}

/** Logout: revoga server-side, limpa cookie e sessão local. */
export async function logout() {
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    try { await _callAuth('logout', {}, /* withAuthHeader */ true); } catch {}
    await supabase.auth.signOut().catch(() => {});
    _expiresAt = 0;
    clearRememberMe();
}

/** Garante um access token válido (renova se perto de expirar). */
export async function getValidAccessToken() {
    const nowSecs = Math.floor(Date.now() / 1000);
    if (_expiresAt && nowSecs < _expiresAt - REFRESH_SKEW_MS / 1000) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) return session.access_token;
    }
    try {
        const s = await refreshSession();
        return s?.access_token ?? null;
    } catch {
        return null;   // transitório — sem token agora; o chamador trata
    }
}

// ── Boot: reidrata a sessão a partir do cookie HttpOnly ─────────────────────────
// supabaseReady resolve após a primeira tentativa de refresh, garantindo que
// getSession() já reflita a sessão restaurada antes de qualquer guarda de rota.
let _resolveReady;
export const supabaseReady = new Promise(resolve => { _resolveReady = resolve; });
refreshSession()
    .catch(() => null)
    .finally(() => _resolveReady());

// Renova de forma defensiva ao voltar o foco para a aba (cobre sleep > 1h).
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !_expiresAt) return;
        const nowSecs = Math.floor(Date.now() / 1000);
        if (nowSecs >= _expiresAt - REFRESH_SKEW_MS / 1000) refreshSession().catch(() => {});
    });
}
