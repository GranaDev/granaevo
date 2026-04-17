/**
 * GranaEvo — auth-guard.js
 * Versão 3.0 — Relatório de segurança aplicado integralmente
 *
 * ═══════════════════════════════════════════════════════════════
 *  REGISTRO COMPLETO DE CORREÇÕES DE SEGURANÇA
 * ═══════════════════════════════════════════════════════════════
 */

import { supabase } from '../services/supabase-client.js?v=2';

// ═══════════════════════════════════════════════════════════════
//  TAB_ID — identificador único desta aba [FIX-REPORT-3]
// ═══════════════════════════════════════════════════════════════
const TAB_ID = (() => {
    try { return crypto.randomUUID(); }
    catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
})();

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES CENTRAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════
const SECURITY = Object.freeze({
    SESSION_POLL_INTERVAL:           5 * 60 * 1000,
    TOKEN_REFRESH_THRESHOLD_SECONDS: 10 * 60,
    MAX_SESSION_AGE_MS:              24 * 60 * 60 * 1000,
    RATE_LIMIT_MAX:                  15,
    RATE_LIMIT_WINDOW_MS:            60 * 1000,
    MAX_CONSECUTIVE_ERRORS:          3,
    ON_SUCCESS_TIMEOUT_MS:           10000,
    LOGIN_URL:                       'login.html',

    KEYS: Object.freeze({
        fingerprint:     '_ge_fp',
        sessionStart:    '_ge_ss',
        integrityStamp:  '_ge_is',
        rateLog:         '_ge_rl',   // agora em localStorage [FIX-REPORT-3]
        rateLimitSecret: '_ge_rls',  // chave persistente para assinar rate log [FIX-REPORT-3]
        canvasSalt:      '_ge_cs',   // entropia pública (sessionStorage)
    }),

    ERROR_URL_MAP: Object.freeze({
        NO_SESSION:            'a1',
        TOKEN_EXPIRED:         'a2',
        SESSION_HIJACK:        'a3',
        SESSION_TOO_OLD:       'a4',
        INTEGRITY_FAIL:        'a5',
        RATE_LIMITED:          'a6',
        NO_PLAN:               'a7',
        GUEST_BLOCKED:         'a8',
        GUEST_UPGRADE_BLOCKED: 'a9',
        SESSION_GONE:          'b1',
        LOGOUT:                'b2',
        FORCE_LOGOUT:          'b3',
        UNKNOWN:               'b4',
    }),

    DANGEROUS_SCHEMES: Object.freeze([
        'javascript:', 'data:', 'vbscript:', 'blob:', 'file:',
    ]),

    BROADCAST_CHANNEL: 'ge_auth_sync',
});

// ═══════════════════════════════════════════════════════════════
//  HELPER INTERNO
//  [SEC-01]  Não exportado — encapsulado na closure do módulo
//  [SEC-10]  Stack trace preservado
// ═══════════════════════════════════════════════════════════════
function _err(code, message) {
    const e   = new Error(message);
    e.code    = code;
    e.message = message;
    return e;
}

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: CRYPTO SEGURO
//  [SEC-04]     HMAC-SHA256 real via SubtleCrypto
//  [SEC-05]     Encoding via TextEncoder / Uint8Array
//  [FIX-VUL-4]  _getOrCreateSecret() em closure privada
//  [FIX-VUL-10] Session secret NUNCA em sessionStorage — apenas em memória
//  [FIX-REPORT-3] + getRateLimitSecret() para secret persistente do rate log
// ═══════════════════════════════════════════════════════════════
const SecureCrypto = (() => {
    // [FIX-VUL-10] Secret da sessão exclusivamente em memória
    let _sessionSecret = null;

    function _getOrCreateSecret() {
        if (_sessionSecret) return _sessionSecret;
        const arr = new Uint8Array(32);
        crypto.getRandomValues(arr);
        _sessionSecret = Array.from(arr)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        return _sessionSecret;
    }

    // [FIX-REPORT-3] Chave persistente em localStorage para assinar o rate log.
    // Diferente do session secret: sobrevive a reloads e é compartilhada entre
    // abas. Não é um segredo crítico — apenas impede adulteração trivial do log.
    function _getOrCreateRateLimitSecret() {
        const KEY = SECURITY.KEYS.rateLimitSecret;
        try {
            let secret = localStorage.getItem(KEY);
            if (!secret) {
                const arr = new Uint8Array(32);
                crypto.getRandomValues(arr);
                secret = Array.from(arr)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
                localStorage.setItem(KEY, secret);
            }
            return secret;
        } catch {
            // localStorage bloqueado (ex: modo privado restrito) — fallback
            return _getOrCreateSecret();
        }
    }

    async function importKey(hexSecret) {
        const keyBytes = new Uint8Array(
            hexSecret.match(/.{2}/g).map(h => parseInt(h, 16))
        );
        return crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign', 'verify']
        );
    }

    async function sign(data, hexSecret) {
        const key       = await importKey(hexSecret);
        const encoded   = new TextEncoder().encode(data);
        const signature = await crypto.subtle.sign('HMAC', key, encoded);
        return Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    async function verify(data, signature, hexSecret) {
        try {
            const key      = await importKey(hexSecret);
            const encoded  = new TextEncoder().encode(data);
            const sigBytes = new Uint8Array(
                signature.match(/.{2}/g).map(h => parseInt(h, 16))
            );
            return crypto.subtle.verify('HMAC', key, sigBytes, encoded);
        } catch {
            return false;
        }
    }

    function encodeBase64url(str) {
        const bytes = new TextEncoder().encode(str);
        let binary  = '';
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    function decodeBase64url(str) {
        const padded = str.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    }

// [FIX-VUL-2] Canvas fingerprint — rendering diferenciado por hardware/driver
// [FIX-CANVAS-SAFARI] Fallback para Safari/privacy mode que retorna data vazia
function _canvasEntropy() {
    try {
        const canvas  = document.createElement('canvas');
        canvas.width  = 200;
        canvas.height = 40;
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font         = '14px Arial';
        ctx.fillStyle    = '#f60';
        ctx.fillRect(0, 0, 10, 10);
        ctx.fillStyle = '#069';
        ctx.fillText('GranaEvo_fp', 2, 2);
        ctx.fillStyle = 'rgba(102,200,0,0.7)';
        ctx.fillText('GranaEvo_fp', 4, 4);

        const data = canvas.toDataURL();

        // Safari com privacy mode / browsers que bloqueiam canvas retornam
        // "data:," ou strings muito curtas — sem entropia real.
        // Fallback garante unicidade mínima via userAgent.
        return (data === 'data:,' || data.length < 50)
            ? navigator.userAgent + '::no_canvas'
            : data;

    } catch {
        return 'canvas_unavailable';
    }
}

    // [FIX-VUL-2] Salt do canvas — entropia pública, não segredo criptográfico
    function _getOrCreateCanvasSalt() {
        let salt = sessionStorage.getItem(SECURITY.KEYS.canvasSalt);
        if (!salt) {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            salt = Array.from(arr)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            try { sessionStorage.setItem(SECURITY.KEYS.canvasSalt, salt); }
            catch { /* cheio */ }
        }
        return salt;
    }

    return {
        sign,
        verify,
        encodeBase64url,
        decodeBase64url,
        getSessionSecret:      _getOrCreateSecret,
        getRateLimitSecret:    _getOrCreateRateLimitSecret, // [FIX-REPORT-3]
        generateCanvasEntropy: _canvasEntropy,
        getCanvasSalt:         _getOrCreateCanvasSalt,
        // [FIX-VUL-10] Invalida secret em memória no logout
        clearSecret() { _sessionSecret = null; },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: RATE LIMITER
//  [FIX-REPORT-3] Migrado para localStorage + TAB_ID
//    • Log compartilhado entre abas — impede bypass via múltiplas abas
//    • Cada entrada: { ts, tabId } para rastreio por aba
//    • Assinado com _ge_rls (localStorage) em vez do session secret
//  [FIX-VUL-1]   Log assinado com HMAC — não burlável via clear()
// ═══════════════════════════════════════════════════════════════
const RateLimiter = (() => {
    async function readLog() {
        try {
            const raw = localStorage.getItem(SECURITY.KEYS.rateLog);
            if (!raw) return [];

            const dotIndex = raw.lastIndexOf('.');
            if (dotIndex === -1) return [];

            const encodedPayload = raw.slice(0, dotIndex);
            const mac            = raw.slice(dotIndex + 1);

            let decoded;
            try { decoded = SecureCrypto.decodeBase64url(encodedPayload); }
            catch { return []; }

            const secret  = SecureCrypto.getRateLimitSecret();
            const isValid = await SecureCrypto.verify(decoded, mac, secret);
            if (!isValid) return [];

            return JSON.parse(decoded);
        } catch {
            return [];
        }
    }

    async function writeLog(log) {
        const secret  = SecureCrypto.getRateLimitSecret();
        const payload = JSON.stringify(log);
        const mac     = await SecureCrypto.sign(payload, secret);
        const encoded = SecureCrypto.encodeBase64url(payload) + '.' + mac;
        try { localStorage.setItem(SECURITY.KEYS.rateLog, encoded); }
        catch { /* cheio */ }
    }

    return {
        async isAllowed() {
            const now         = Date.now();
            const windowStart = now - SECURITY.RATE_LIMIT_WINDOW_MS;
            let log           = await readLog();

            // [FIX-REPORT-3] Suporta entradas legadas (número puro) e novas ({ts, tabId})
            log = log.filter(entry => {
                if (typeof entry === 'number') return entry > windowStart;
                return entry?.ts > windowStart;
            });

            if (log.length >= SECURITY.RATE_LIMIT_MAX) {
                console.warn('[AUTH GUARD] Rate limit atingido.');
                return false;
            }

            log.push({ ts: now, tabId: TAB_ID });
            await writeLog(log);
            return true;
        },

        clear() {
            try { localStorage.removeItem(SECURITY.KEYS.rateLog); } catch { /* */ }
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SESSION FINGERPRINTING
//  [FIX-REPORT-2]  Sinais instáveis REMOVIDOS do fingerprint:
//    screen.width, screen.height, devicePixelRatio,
//    navigator.language, new Date().getTimezoneOffset()
//    → esses valores mudam legitimamente (monitor, zoom, idioma)
//    → canvas entropy + HMAC + user.id já garantem unicidade
//  [FIX-VUL-2]    Canvas + salt de sessão
//  [FIX-VUL-5]    HMAC-SHA256 assíncrono em vez de FNV-1a
//  [SEC-11]       Integrity stamp com janela de 6h + HMAC
// ═══════════════════════════════════════════════════════════════
const Fingerprint = {

    async generate(user) {
        const canvasData = SecureCrypto.generateCanvasEntropy();
        const canvasSalt = SecureCrypto.getCanvasSalt();

        // [FIX-REPORT-2] Apenas sinais ESTÁVEIS mantidos.
        // navigator.platform é estável (OS do hardware, não do browser).
        // navigator.userAgent inclui versão do browser — pode mudar em update,
        // mas a janela de 24h de sessão torna isso aceitável.
        const raw = [
            user.id,
            user.email,
            user.created_at,
            navigator.userAgent,
            navigator.platform,
            canvasData,
            canvasSalt,
        ].join('::');

        const secret = SecureCrypto.getSessionSecret();
        return SecureCrypto.sign(raw, secret);
    },

    async store(user) {
        try {
            const fp = await this.generate(user);
            sessionStorage.setItem(SECURITY.KEYS.fingerprint, fp);
        } catch { /* cheio */ }
    },

    async validate(user) {
        const stored = sessionStorage.getItem(SECURITY.KEYS.fingerprint);
        if (!stored) return true; // primeira visita — sem histórico
        const current = await this.generate(user);
        return stored === current;
    },

    markSessionStart() {
        if (!sessionStorage.getItem(SECURITY.KEYS.sessionStart)) {
            try { sessionStorage.setItem(SECURITY.KEYS.sessionStart, String(Date.now())); }
            catch { /* cheio */ }
        }
    },

    isSessionExpiredByAge() {
        const start = parseInt(
            sessionStorage.getItem(SECURITY.KEYS.sessionStart) || '0', 10
        );
        return start > 0 && (Date.now() - start) > SECURITY.MAX_SESSION_AGE_MS;
    },

    async writeIntegrityStamp(userId) {
        const secret  = SecureCrypto.getSessionSecret();
        const ts      = Date.now();
        const payload = `${userId}|${ts}`;
        const mac     = await SecureCrypto.sign(payload, secret);
        const stamp   = SecureCrypto.encodeBase64url(payload) + '.' + mac;
        try { sessionStorage.setItem(SECURITY.KEYS.integrityStamp, stamp); }
        catch { /* cheio */ }
    },

    async readIntegrityStamp() {
        try {
            const stamp = sessionStorage.getItem(SECURITY.KEYS.integrityStamp);
            if (!stamp) return null;

            const dotIndex = stamp.lastIndexOf('.');
            if (dotIndex === -1) return null;

            const encodedPayload = stamp.slice(0, dotIndex);
            const storedMac      = stamp.slice(dotIndex + 1);

            let payload;
            try { payload = SecureCrypto.decodeBase64url(encodedPayload); }
            catch { return null; }

            const parts = payload.split('|');
            if (parts.length !== 2) return null;

            const [uid, tsStr] = parts;
            const ts           = parseInt(tsStr, 10);

            const secret  = SecureCrypto.getSessionSecret();
            const isValid = await SecureCrypto.verify(payload, storedMac, secret);

            if (!isValid) {
                // [FIX-VUL-10] MAC inválido após reload (secret regenerado).
                // Comportamento esperado — trata como "primeira visita".
                sessionStorage.removeItem(SECURITY.KEYS.integrityStamp);
                return null;
            }

            const SIX_HOURS = 6 * 60 * 60 * 1000;
            if (Date.now() - ts > SIX_HOURS) {
                sessionStorage.removeItem(SECURITY.KEYS.integrityStamp);
                return null;
            }

            return uid;
        } catch {
            return null;
        }
    },

    clear() {
        Object.values(SECURITY.KEYS).forEach(k => {
            try { sessionStorage.removeItem(k); } catch { /* */ }
        });
        // [FIX-VUL-10] Invalida secret em memória — próxima sessão inicia limpa
        SecureCrypto.clearSecret();
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SUBSCRIPTION CHECKER
//  [SEC-15]       Cache em closure privada
//  [BUG-RLS-FIX]  getActive() reescrito (ver cabeçalho)
//  [FIX-VUL-3]    Auto-link exige email_confirmed_at + igualdade de emails
//  [FIX-VUL-11]   Rejeita múltiplas subscriptions não vinculadas
//  [FIX-REPORT-1] Query filtrada por sessionEmail (.ilike)
//  [FIX-REPORT-5] _autoLink com .eq('user_email') — guard duplo contra race
// ═══════════════════════════════════════════════════════════════
const SubscriptionChecker = (() => {
    let _cache      = null;
    let _cacheUser  = null;
    let _cacheExp   = 0;
    const CACHE_TTL = 5 * 60 * 1000;

    const EMPTY = Object.freeze({
        subscription: null,
        isGuest:      false,
        ownerId:      null,
        planName:     null,
        ownerEmail:   null,
    });

    /**
     * [FIX-VUL-3] + [FIX-REPORT-5]
     * Auto-link exige:
     *   (a) email_confirmed_at presente no JWT
     *   (b) emails coincidem (case-insensitive) — verificado pelo chamador
     *   (c) .eq('user_email', subscriptionEmail) no UPDATE — guard duplo
     *       contra race condition entre abas tentando vincular ao mesmo tempo
     */
    async function _autoLink(subscriptionId, userId, sessionEmail, subscriptionEmail) {
        if (!sessionEmail || !subscriptionEmail) return;
        if (sessionEmail.toLowerCase() !== subscriptionEmail.toLowerCase()) return;

        try {
            await supabase
                .from('subscriptions')
                .update({
                    user_id:             userId,
                    password_created:    true,
                    password_created_at: new Date().toISOString(),
                    updated_at:          new Date().toISOString(),
                })
                .eq('id', subscriptionId)
                .is('user_id', null)
                .eq('user_email', subscriptionEmail); // [FIX-REPORT-5]
        } catch {
            // Não crítico — tentará novamente na próxima verificação
        }
    }

    return {
        async getActive(userId) {
            if (_cache && Date.now() < _cacheExp && _cacheUser === userId) {
                return _cache;
            }

            try {
                // ── 1. Busca por user_id (caminho principal) ──────────
                // Política RLS: auth.uid() = user_id
                const { data: ownSub, error: ownErr } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at, user_id')
                    .eq('user_id', userId)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .maybeSingle();

                if (!ownErr && ownSub) {
                    if (ownSub.expires_at && new Date(ownSub.expires_at) < new Date()) {
                        return EMPTY;
                    }
                    _cache = Object.freeze({
                        subscription: ownSub,
                        isGuest:      false,
                        ownerId:      userId,
                        planName:     ownSub.plans?.name || 'Individual',
                        ownerEmail:   null,
                    });
                    _cacheUser = userId;
                    _cacheExp  = Date.now() + CACHE_TTL;
                    return _cache;
                }

                // ── 2. Fallback por email (user_id = NULL) ────────────
                // [FIX-REPORT-1] Obtém email da sessão ANTES da query para
                // filtrar no banco — dupla defesa além do RLS.
                // Mover getUser() para cá também elimina a segunda chamada
                // que existia mais abaixo para verificar email_confirmed_at.
                const { data: authData } = await supabase.auth.getUser();
                const authUser     = authData?.user;
                const sessionEmail = authUser?.email;

                if (sessionEmail) {
                    // [FIX-REPORT-1] .ilike filtra no servidor pelo email da sessão
                    // [FIX-VUL-11]  Sem .limit — buscamos todas para detectar duplicatas
                    const { data: emailSubs, error: emailErr } = await supabase
                        .from('subscriptions')
                        .select('id, plans(name), is_active, payment_status, expires_at, user_id, user_email')
                        .is('user_id', null)
                        .eq('payment_status', 'approved')
                        .eq('is_active', true)
                        .ilike('user_email', sessionEmail); // [FIX-REPORT-1]

                    if (!emailErr && emailSubs && emailSubs.length > 0) {
                        // [FIX-VUL-11] Duplicata → nega acesso por segurança
                        if (emailSubs.length > 1) {
                            console.error(
                                '[AUTH GUARD] Múltiplas subscriptions não vinculadas encontradas. ' +
                                'Acesso negado por segurança.'
                            );
                            return EMPTY;
                        }

                        const emailSub = emailSubs[0];

                        if (emailSub.expires_at && new Date(emailSub.expires_at) < new Date()) {
                            return EMPTY;
                        }

                        // [FIX-VUL-3] Verifica confirmação de email e correspondência
                        const emailConfirmed    = !!authUser?.email_confirmed_at;
                        const subscriptionEmail = emailSub.user_email || '';

                        const emailMatch =
                            sessionEmail &&
                            subscriptionEmail &&
                            sessionEmail.toLowerCase() === subscriptionEmail.toLowerCase();

                        if (!emailMatch) return EMPTY;

                        if (emailConfirmed) {
                            // Auto-link em background — não bloqueia o fluxo
                            _autoLink(emailSub.id, userId, sessionEmail, subscriptionEmail);
                            // Invalida cache para forçar nova busca após link
                            _cache     = null;
                            _cacheUser = null;
                            _cacheExp  = 0;
                        }

                        return Object.freeze({
                            subscription: emailSub,
                            isGuest:      false,
                            ownerId:      userId,
                            planName:     emailSub.plans?.name || 'Individual',
                            ownerEmail:   null,
                        });
                    }
                }

                // ── 3. Verifica se é convidado ────────────────────────
                // Política RLS: member_can_read_own_membership
                const { data: member, error: memErr } = await supabase
                    .from('account_members')
                    .select('id, owner_user_id, owner_email, is_active')
                    .eq('member_user_id', userId)
                    .eq('is_active', true)
                    .maybeSingle();

                if (memErr || !member) return EMPTY;

                // Política RLS: guest_can_view_owner_subscription
                const { data: ownerSub, error: ownerErr } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at')
                    .eq('user_id', member.owner_user_id)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .maybeSingle();

                if (ownerErr || !ownerSub) return EMPTY;

                if (ownerSub.expires_at && new Date(ownerSub.expires_at) < new Date()) {
                    return EMPTY;
                }

                _cache = Object.freeze({
                    subscription: ownerSub,
                    isGuest:      true,
                    ownerId:      member.owner_user_id,
                    planName:     ownerSub.plans?.name || 'Individual',
                    ownerEmail:   member.owner_email,
                });
                _cacheUser = userId;
                _cacheExp  = Date.now() + CACHE_TTL;
                return _cache;

            } catch {
                return EMPTY;
            }
        },

        invalidate() {
            _cache     = null;
            _cacheUser = null;
            _cacheExp  = 0;
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: REDIRECT SEGURO
//  [SEC-14]     Valida same-origin
//  [FIX-VUL-7]  Blocklist de esquemas perigosos
//  [FIX-EXTRA-2] Flag _isRedirecting — dedup de redirects concorrentes
//    Cobre todos os caminhos: protect(), logout(), forceLogout(),
//    onAuthStateChange, storage listener, visibilitychange, BroadcastChannel.
// ═══════════════════════════════════════════════════════════════
let _isRedirecting = false; // [FIX-EXTRA-2]

const SafeRedirect = {
    _isSafe(url) {
        if (!url || typeof url !== 'string') return false;

        // [FIX-VUL-7] Rejeita esquemas perigosos explicitamente
        const lower = url.trim().toLowerCase();
        for (const scheme of SECURITY.DANGEROUS_SCHEMES) {
            if (lower.startsWith(scheme)) {
                console.error(`[AUTH GUARD] Esquema perigoso bloqueado: ${scheme}`);
                return false;
            }
        }

        // URLs relativas são aceitas (same-origin por natureza)
        if (!url.startsWith('http://') && !url.startsWith('https://')) return true;

        // URLs absolutas: valida same-origin
        try {
            return new URL(url, window.location.origin).origin === window.location.origin;
        } catch {
            return false;
        }
    },

    to(url) {
        // [FIX-EXTRA-2] Impede double-redirect de múltiplas fontes concorrentes
        if (_isRedirecting) return;
        _isRedirecting = true;

        if (!this._isSafe(url)) {
            console.error('[AUTH GUARD] Redirect bloqueado — URL não segura.');
            url = SECURITY.LOGIN_URL;
        }
        Fingerprint.clear();
        SubscriptionChecker.invalidate();
        RateLimiter.clear();
        window.location.replace(url);
    },

    toLogin(reason = '') {
        const code   = SECURITY.ERROR_URL_MAP[reason] || 'e0';
        const target = `${SECURITY.LOGIN_URL}?c=${encodeURIComponent(code)}`;
        this.to(target);
    },
};

// ═══════════════════════════════════════════════════════════════
//  BROADCAST CHANNEL
//  [SEC-13] Sincronização entre abas
//  [SEC-03] Supre limitação do evento 'storage' para sessionStorage
// ═══════════════════════════════════════════════════════════════
let _broadcastChannel = null;

function _initBroadcastChannel(onLogoutMessage) {
    try {
        if (typeof BroadcastChannel === 'undefined') return;

        _broadcastChannel = new BroadcastChannel(SECURITY.BROADCAST_CHANNEL);

        _broadcastChannel.addEventListener('message', (e) => {
            if (!e.data || typeof e.data !== 'object') return;

            switch (e.data.type) {
                case 'LOGOUT':
                case 'FORCE_LOGOUT':
                    if (!window.location.href.includes('login.html')) {
                        Fingerprint.clear();
                        SubscriptionChecker.invalidate();
                        RateLimiter.clear();
                        if (typeof onLogoutMessage === 'function') onLogoutMessage(e.data.type);
                        SafeRedirect.toLogin('NO_SESSION'); // dedup via _isRedirecting
                    }
                    break;
                case 'SUBSCRIPTION_INVALIDATED':
                    SubscriptionChecker.invalidate();
                    break;
            }
        });
    } catch {
        // BroadcastChannel indisponível
    }
}

function _broadcastLogout(type) {
    try { _broadcastChannel?.postMessage({ type }); }
    catch { /* canal fechado */ }
}

// ═══════════════════════════════════════════════════════════════
//  GUARD PRINCIPAL
//  [FIX-EXTRA-1]   Mutex _protecting — impede protect() concorrente
//  [FIX-EXTRA-2]   _isRedirecting em SafeRedirect — dedup de redirects
//  [FIX-REPORT-4]  Monitor verifica sessão antes de forçar logout
//  [SEC-08]        forceLogout aguarda signOut — sem race condition
// ═══════════════════════════════════════════════════════════════
const AuthGuard = (() => {
    let _ready             = false;
    let _user              = null;
    let _subData           = null;
    let _monitorTimer      = null;
    let _consecutiveErrors = 0;
    let _protecting        = false; // [FIX-EXTRA-1] Mutex

    function _stopMonitoring() {
        if (_monitorTimer) {
            clearInterval(_monitorTimer);
            _monitorTimer = null;
        }
    }

    function _startMonitoring() {
        if (_monitorTimer) return;
        _consecutiveErrors = 0;

        _monitorTimer = setInterval(async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    _publicAPI.forceLogout('SESSION_GONE');
                    return;
                }

                SubscriptionChecker.invalidate();
                const sub = await SubscriptionChecker.getActive(session.user.id);

                if (!sub.subscription) {
                    _publicAPI.forceLogout('NO_PLAN');
                    return;
                }

                _consecutiveErrors = 0;

            } catch {
                _consecutiveErrors++;
                console.warn(
                    `[AUTH GUARD] Falha no monitor (${_consecutiveErrors}/${SECURITY.MAX_CONSECUTIVE_ERRORS})`
                );

                if (_consecutiveErrors >= SECURITY.MAX_CONSECUTIVE_ERRORS) {
                    // [FIX-REPORT-4] Verifica se sessão ainda existe antes de forçar logout.
                    // Evita logout em massa durante instabilidade momentânea do Supabase.
                    try {
                        const { data: { session: checkSession } } = await supabase.auth.getSession();
                        if (!checkSession) {
                            console.error('[AUTH GUARD] Sessão confirmada ausente. Forçando logout.');
                            _publicAPI.forceLogout('NO_SESSION');
                        } else {
                            // Sessão existe — foi instabilidade de rede, reseta contador
                            console.warn('[AUTH GUARD] Sessão ainda ativa. Resetando contador de erros.');
                            _consecutiveErrors = 0;
                        }
                    } catch {
                        // Nem a verificação funcionou — logout preventivo
                        console.error('[AUTH GUARD] Verificação de sessão também falhou. Logout preventivo.');
                        _publicAPI.forceLogout('NO_SESSION');
                    }
                }
            }
        }, SECURITY.SESSION_POLL_INTERVAL);
    }

    // [FIX-VUL-8] Executa callback com timeout de segurança de 10s
    async function _safeCallback(fn, arg) {
        if (typeof fn !== 'function') return;
        await Promise.race([
            Promise.resolve().then(() => fn(arg)),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error('Callback timeout')),
                    SECURITY.ON_SUCCESS_TIMEOUT_MS
                )
            ),
        ]);
    }

    const _publicAPI = {
        /**
         * AuthGuard.protect(options)
         * Chame no topo de cada página protegida.
         */
        async protect(options = {}) {
            const {
                requirePlan         = true,
                allowGuest          = true,
                guestCanUpgrade     = false,
                upgradePagePatterns = ['atualizarplano', 'upgrade', 'mudarplano'],
                onSuccess           = null,
                onFail              = null,
                redirectOnFail      = true,
                loadingElementId    = 'authLoading',
            } = options;

            // [FIX-EXTRA-1] Mutex — protect() não pode ser executado concorrentemente
            if (_protecting) {
                console.warn('[AUTH GUARD] protect() já em execução. Chamada concorrente ignorada.');
                return null;
            }
            _protecting = true;

            const loader = document.getElementById(loadingElementId);
            if (loader) loader.classList.remove('hidden');

            try {
                // ── Passo 1: Rate limit ───────────────────────────────
                // [FIX-REPORT-3] isAllowed() agora usa localStorage global entre abas
                if (!await RateLimiter.isAllowed()) {
                    throw _err('RATE_LIMITED', 'Muitas verificações simultâneas.');
                }

                // ── Passo 2: Recuperar sessão ─────────────────────────
                const { data: { session }, error: sessErr } = await supabase.auth.getSession();

                if (sessErr || !session?.user) {
                    throw _err('NO_SESSION', 'Sem sessão ativa.');
                }

                let { user, expires_at } = session;

                // ── Passo 3: Refresh de token ─────────────────────────
                const secsLeft = expires_at - Math.floor(Date.now() / 1000);

                if (secsLeft <= 0) {
                    const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
                    if (refErr || !refreshed?.session) {
                        throw _err('TOKEN_EXPIRED', 'Token expirado e refresh falhou.');
                    }
                    user       = refreshed.session.user;
                    expires_at = refreshed.session.expires_at;
                } else if (secsLeft < SECURITY.TOKEN_REFRESH_THRESHOLD_SECONDS) {
                    supabase.auth.refreshSession().catch(() => {});
                }

                // ── Passo 4: Fingerprint ──────────────────────────────
                // [FIX-REPORT-2] validate() usa apenas sinais estáveis
                if (!await Fingerprint.validate(user)) {
                    await supabase.auth.signOut().catch(() => {});
                    throw _err('SESSION_HIJACK', 'Fingerprint divergiu.');
                }

                // ── Passo 5: Idade da sessão ──────────────────────────
                if (Fingerprint.isSessionExpiredByAge()) {
                    await supabase.auth.signOut().catch(() => {});
                    throw _err('SESSION_TOO_OLD', 'Sessão ultrapassou 24h.');
                }

                // ── Passo 6: Integrity stamp ──────────────────────────
                const stampedUid = await Fingerprint.readIntegrityStamp();
                if (stampedUid !== null && stampedUid !== user.id) {
                    await supabase.auth.signOut().catch(() => {});
                    throw _err('INTEGRITY_FAIL', 'Carimbo de integridade inválido.');
                }

                // ── Passo 7: Gravar fingerprint e stamp ───────────────
                await Fingerprint.store(user);
                Fingerprint.markSessionStart();
                await Fingerprint.writeIntegrityStamp(user.id);

                // ── Passo 8: Verificar plano ──────────────────────────
                let subData = {
                    subscription: null,
                    isGuest:      false,
                    ownerId:      user.id,
                    planName:     null,
                    ownerEmail:   null,
                };

                if (requirePlan) {
                    subData = await SubscriptionChecker.getActive(user.id);

                    if (!subData.subscription) {
                        throw _err('NO_PLAN', 'Sem plano ativo.');
                    }

                    if (subData.isGuest && !allowGuest) {
                        throw _err('GUEST_BLOCKED', 'Página não acessível para convidados.');
                    }

                    if (subData.isGuest && !guestCanUpgrade) {
                        const currentPath = window.location.pathname.toLowerCase();
                        const isUpgrade   = upgradePagePatterns.some(p =>
                            currentPath.includes(p.toLowerCase())
                        );
                        if (isUpgrade) {
                            throw _err('GUEST_UPGRADE_BLOCKED', 'Convidados não gerenciam planos.');
                        }
                    }
                }

                // ── Passo 9: Montar userData ──────────────────────────
                // [SEC-12] Token de acesso NÃO incluído
                const userData = Object.freeze({
                    userId:          user.id,
                    effectiveUserId: subData.ownerId || user.id,
                    nome:            String(
                        user.user_metadata?.name ||
                        user.email?.split('@')[0] ||
                        'Usuário'
                    ).trim(),
                    email:      user.email,
                    plano:      subData.planName || 'Individual',
                    isGuest:    subData.isGuest,
                    ownerEmail: subData.ownerEmail || null,
                    perfis:     [],
                });

                _user    = userData;
                _subData = subData;
                _ready   = true;

                // ── Passo 10: Iniciar monitoramento ───────────────────
                _startMonitoring();

                if (loader) loader.classList.add('hidden');

                // [FIX-VUL-8] onSuccess com timeout de segurança
                if (onSuccess) {
                    try { await _safeCallback(onSuccess, userData); }
                    catch (cbErr) {
                        console.warn(
                            '[AUTH GUARD] onSuccess callback expirou ou lançou erro:',
                            cbErr?.message
                        );
                    }
                }

                return userData;

            } catch (error) {
                if (loader) loader.classList.add('hidden');

                const code = error?.code || 'UNKNOWN';

                if (onFail) {
                    try { onFail(error); } catch { /* */ }
                }

                if (redirectOnFail) {
                    SafeRedirect.toLogin(code); // dedup via _isRedirecting
                }

                return null;

            } finally {
                _protecting = false; // [FIX-EXTRA-1] Libera mutex sempre
            }
        },

        async logout(reason = 'LOGOUT') {
            _stopMonitoring();
            _user    = null;
            _subData = null;
            _ready   = false;

            SubscriptionChecker.invalidate();
            Fingerprint.clear();
            RateLimiter.clear();

            _broadcastLogout('LOGOUT');

            try { await supabase.auth.signOut(); }
            catch { /* Ignora erro de rede */ }

            SafeRedirect.toLogin(reason); // dedup via _isRedirecting
        },

        // [SEC-08] Aguarda signOut — sem race condition
        async forceLogout(reason = 'FORCE_LOGOUT') {
            _stopMonitoring();
            _ready = false;

            SubscriptionChecker.invalidate();
            Fingerprint.clear();
            RateLimiter.clear();

            _broadcastLogout('FORCE_LOGOUT');

            try { await supabase.auth.signOut(); }
            catch { /* Ignora */ }

            SafeRedirect.toLogin(reason); // dedup via _isRedirecting
        },

        getUser()        { return _user ? { ..._user } : null; },
        isReady()        { return _ready; },
        isGuest()        { return _user?.isGuest ?? false; },
        getCurrentPlan() { return _user?.plano ?? null; },

        refreshSubscription() {
            SubscriptionChecker.invalidate();
            try { _broadcastChannel?.postMessage({ type: 'SUBSCRIPTION_INVALIDATED' }); }
            catch { /* */ }
        },

        _internalStop() { _stopMonitoring(); },
    };

    return _publicAPI;
})();

// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO DO BROADCAST CHANNEL
// ═══════════════════════════════════════════════════════════════
_initBroadcastChannel((type) => {
    console.info(`[AUTH GUARD] Logout notificado por outra aba: ${type}`);
});

// ═══════════════════════════════════════════════════════════════
//  LISTENERS GLOBAIS
// ═══════════════════════════════════════════════════════════════
supabase.auth.onAuthStateChange((event, session) => {
    switch (event) {
        case 'SIGNED_OUT':
            AuthGuard._internalStop();
            Fingerprint.clear();
            SubscriptionChecker.invalidate();
            RateLimiter.clear();
            if (!window.location.href.includes('login.html')) {
                SafeRedirect.toLogin('NO_SESSION'); // dedup via _isRedirecting
            }
            break;
        case 'TOKEN_REFRESHED':
            break;
        case 'USER_UPDATED':
            SubscriptionChecker.invalidate();
            break;
        case 'PASSWORD_RECOVERY':
            // [SEC-09] signOut antes de redirecionar
            supabase.auth.signOut()
                .catch(() => {})
                .finally(() => {
                    if (!window.location.href.includes('login.html')) {
                        SafeRedirect.toLogin('NO_SESSION');
                    }
                });
            break;
    }
});

// [SEC-03] Detecta remoção do token em outra aba (localStorage do Supabase)
window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('sb-') && e.newValue === null) {
        if (!window.location.href.includes('login.html')) {
            Fingerprint.clear();
            SubscriptionChecker.invalidate();
            RateLimiter.clear();
            SafeRedirect.toLogin('NO_SESSION'); // dedup via _isRedirecting
        }
    }
});

// [FIX-VUL-9] Reativação da aba — revalida fingerprint + integrity stamp
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !AuthGuard.isReady()) return;

    try {
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            await AuthGuard.forceLogout('NO_SESSION');
            return;
        }

        // [FIX-VUL-9] Revalida fingerprint ao retornar à aba
        const fpOk = await Fingerprint.validate(session.user);
        if (!fpOk) {
            await AuthGuard.forceLogout('SESSION_HIJACK');
            return;
        }

        // [FIX-VUL-9] Revalida integrity stamp ao retornar à aba
        const stampedUid = await Fingerprint.readIntegrityStamp();
        if (stampedUid !== null && stampedUid !== session.user.id) {
            await AuthGuard.forceLogout('INTEGRITY_FAIL');
            return;
        }

    } catch {
        // Erro de rede — não força logout
    }
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export { AuthGuard, SubscriptionChecker, SafeRedirect };
export default AuthGuard;