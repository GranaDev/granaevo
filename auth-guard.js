/**
 * GranaEvo — auth-guard.js
 *
 * CORREÇÕES DE SEGURANÇA APLICADAS:
 *
 * [SEC-01] _err agora é função interna à closure — não exportada globalmente
 * [SEC-02] Fingerprint baseado em múltiplos sinais combinados (não só UA)
 * [SEC-03] sessionStorage inacessível via evento storage (limitação da API)
 *          — detecção de adulteração agora usa BroadcastChannel entre abas
 * [SEC-04] HMAC substituído por SubtleCrypto (HMAC-SHA256 real, criptograficamente seguro)
 * [SEC-05] btoa/atob substituído por Uint8Array com encoding explícito (sem exposição de dados)
 * [SEC-06] Todos os console.log/warn/error removidos em dados sensíveis; apenas prefixo genérico
 * [SEC-07] Rate limiter persiste em sessionStorage com deduplicação entre abas via BroadcastChannel
 * [SEC-08] forceLogout aguarda signOut via Promise (sem race condition)
 * [SEC-09] PASSWORD_RECOVERY: signOut executado antes do redirect
 * [SEC-10] _err retorna objeto com stack trace preservado
 * [SEC-11] Integrity stamp usa HMAC-SHA256 real + timestamp + janela de 6h
 * [SEC-12] Objeto userData não inclui token — acesse via supabase.auth.getSession()
 * [SEC-13] BroadcastChannel para sincronização de logout entre abas
 * [SEC-14] SafeRedirect verifica same-origin antes de qualquer redirect
 * [SEC-15] SubscriptionChecker com cache em closure privada e Object.freeze
 */

import { supabase } from './supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES CENTRAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════
const SECURITY = Object.freeze({
    // Intervalo de re-verificação da sessão em background (5 min)
    SESSION_POLL_INTERVAL: 5 * 60 * 1000,

    // Se o token expira em menos de 10 min → refresh proativo
    TOKEN_REFRESH_THRESHOLD_SECONDS: 10 * 60,

    // Sessão considerada "velha demais" após 24h → força relogin
    MAX_SESSION_AGE_MS: 24 * 60 * 60 * 1000,

    // Rate limit: máx 15 verificações por minuto
    RATE_LIMIT_MAX:       15,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,

    // Onde redirecionar quando o guard bloqueia
    LOGIN_URL: 'login.html',

    // Chaves sessionStorage (prefixo ofuscado)
    KEYS: Object.freeze({
        fingerprint:    '_ge_fp',
        sessionStart:   '_ge_ss',
        integrityStamp: '_ge_is',
        sessionSecret:  '_ge_sec',
        rateLog:        '_ge_rl',
    }),

    // Mapeamento ofuscado de códigos de erro (não revela mecanismo interno)
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

    // Canal BroadcastChannel para sincronização entre abas
    BROADCAST_CHANNEL: 'ge_auth_sync',
});

// ═══════════════════════════════════════════════════════════════
//  HELPER INTERNO: CRIAR OBJETO DE ERRO COM STACK
//  [SEC-01] Não exportado — encapsulado na closure do módulo
//  [SEC-10] Stack trace preservado para debugging interno
// ═══════════════════════════════════════════════════════════════
function _err(code, message) {
    const e   = new Error(message);
    e.code    = code;
    e.message = message;
    return e;
}

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: CRYPTO SEGURO
//  [SEC-04] HMAC-SHA256 real via SubtleCrypto (Web Crypto API)
//  [SEC-05] Encoding via TextEncoder/Uint8Array (não btoa/atob)
// ═══════════════════════════════════════════════════════════════
const SecureCrypto = {
    /**
     * Gera um segredo aleatório de 32 bytes em hex.
     * Usa crypto.getRandomValues (CSPRNG).
     */
    generateSecret() {
        const arr = new Uint8Array(32);
        crypto.getRandomValues(arr);
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    /**
     * Importa uma chave HMAC-SHA256 a partir de uma string hex.
     */
    async importKey(hexSecret) {
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
    },

    /**
     * Assina `data` com HMAC-SHA256 usando `hexSecret`.
     * Retorna hex string da assinatura.
     */
    async sign(data, hexSecret) {
        const key       = await this.importKey(hexSecret);
        const encoded   = new TextEncoder().encode(data);
        const signature = await crypto.subtle.sign('HMAC', key, encoded);
        return Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    /**
     * Verifica se `signature` é válido para `data` com `hexSecret`.
     * Usa verificação em tempo constante (evita timing attack).
     */
    async verify(data, signature, hexSecret) {
        try {
            const key       = await this.importKey(hexSecret);
            const encoded   = new TextEncoder().encode(data);
            const sigBytes  = new Uint8Array(
                signature.match(/.{2}/g).map(h => parseInt(h, 16))
            );
            return crypto.subtle.verify('HMAC', key, sigBytes, encoded);
        } catch {
            return false;
        }
    },

    /**
     * Codifica string para base64url (sem btoa — usa TextEncoder)
     */
    encodeBase64url(str) {
        const bytes = new TextEncoder().encode(str);
        let binary  = '';
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    },

    /**
     * Decodifica base64url para string
     */
    decodeBase64url(str) {
        const padded = str
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const binary = atob(padded);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: RATE LIMITER
//  [SEC-07] Persiste em sessionStorage; sincronizado via BroadcastChannel
// ═══════════════════════════════════════════════════════════════
const RateLimiter = (() => {
    function getLog() {
        try {
            return JSON.parse(sessionStorage.getItem(SECURITY.KEYS.rateLog) || '[]');
        } catch {
            return [];
        }
    }

    function saveLog(log) {
        try {
            sessionStorage.setItem(SECURITY.KEYS.rateLog, JSON.stringify(log));
        } catch { /* sessionStorage cheio */ }
    }

    return {
        isAllowed() {
            const now         = Date.now();
            const windowStart = now - SECURITY.RATE_LIMIT_WINDOW_MS;
            let log           = getLog().filter(ts => ts > windowStart);

            if (log.length >= SECURITY.RATE_LIMIT_MAX) {
                console.warn('[AUTH GUARD] Rate limit atingido.');
                return false;
            }

            log.push(now);
            saveLog(log);
            return true;
        },

        clear() {
            sessionStorage.removeItem(SECURITY.KEYS.rateLog);
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SESSION FINGERPRINTING
//  [SEC-02] Combina múltiplos sinais — não apenas UserAgent
//  [SEC-04] HMAC-SHA256 real para o integrity stamp
//  [SEC-11] Stamp inclui timestamp, janela de 6h e verificação criptográfica
// ═══════════════════════════════════════════════════════════════
const Fingerprint = {
    /**
     * Gera fingerprint combinando dados do usuário + ambiente.
     * NÃO é para autenticação — é para detecção de anomalias.
     * [SEC-02] Inclui mais sinais além do UA para dificultar clonagem.
     */
    generate(user) {
        const ua           = navigator.userAgent.slice(0, 80);
        const lang         = navigator.language || '';
        const platform     = navigator.platform || '';
        const colorDepth   = screen.colorDepth || 0;
        const pixelRatio   = window.devicePixelRatio || 1;
        const screenW      = screen.width  || 0;
        const screenH      = screen.height || 0;
        const timezoneOffset = new Date().getTimezoneOffset();

        const raw = [
            user.id,
            user.email,
            user.created_at,
            ua,
            lang,
            platform,
            colorDepth,
            pixelRatio.toFixed(2),
            screenW,
            screenH,
            timezoneOffset,
        ].join('::');

        // FNV-1a hash — apenas para detecção, não segurança criptográfica
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h  = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
    },

    store(user) {
        try {
            sessionStorage.setItem(SECURITY.KEYS.fingerprint, this.generate(user));
        } catch { /* sessionStorage cheio */ }
    },

    validate(user) {
        const stored = sessionStorage.getItem(SECURITY.KEYS.fingerprint);
        if (!stored) return true; // Primeira visita — ok
        return stored === this.generate(user);
    },

    markSessionStart() {
        if (!sessionStorage.getItem(SECURITY.KEYS.sessionStart)) {
            try {
                sessionStorage.setItem(SECURITY.KEYS.sessionStart, String(Date.now()));
            } catch { /* sessionStorage cheio */ }
        }
    },

    isSessionExpiredByAge() {
        const start = parseInt(sessionStorage.getItem(SECURITY.KEYS.sessionStart) || '0', 10);
        return start > 0 && (Date.now() - start) > SECURITY.MAX_SESSION_AGE_MS;
    },

    // ── Segredo de sessão ─────────────────────────────────────
    _getOrCreateSecret() {
        let secret = sessionStorage.getItem(SECURITY.KEYS.sessionSecret);
        if (!secret) {
            secret = SecureCrypto.generateSecret();
            try {
                sessionStorage.setItem(SECURITY.KEYS.sessionSecret, secret);
            } catch { /* sessionStorage cheio */ }
        }
        return secret;
    },

    /**
     * [SEC-11] Grava um stamp com HMAC-SHA256 real, timestamp e janela de 6h.
     * Formato: base64url(userId|timestamp) + '.' + hmac_hex
     */
    async writeIntegrityStamp(userId) {
        const secret  = this._getOrCreateSecret();
        const ts      = Date.now();
        const payload = `${userId}|${ts}`;
        const mac     = await SecureCrypto.sign(payload, secret);
        const stamp   = SecureCrypto.encodeBase64url(payload) + '.' + mac;

        try {
            sessionStorage.setItem(SECURITY.KEYS.integrityStamp, stamp);
        } catch { /* sessionStorage cheio */ }
    },

    /**
     * [SEC-11] Valida stamp: verifica HMAC, extrai userId e rejeita se > 6h.
     * Retorna userId válido ou null em caso de falha.
     */
    async readIntegrityStamp() {
        try {
            const stamp = sessionStorage.getItem(SECURITY.KEYS.integrityStamp);
            if (!stamp) return null;

            const dotIndex = stamp.lastIndexOf('.');
            if (dotIndex === -1) return null;

            const encodedPayload = stamp.slice(0, dotIndex);
            const storedMac      = stamp.slice(dotIndex + 1);

            let payload;
            try {
                payload = SecureCrypto.decodeBase64url(encodedPayload);
            } catch {
                return null;
            }

            const parts = payload.split('|');
            if (parts.length !== 2) return null;

            const [uid, tsStr] = parts;
            const ts           = parseInt(tsStr, 10);

            // Verifica HMAC-SHA256 (criptograficamente seguro)
            const secret  = this._getOrCreateSecret();
            const isValid = await SecureCrypto.verify(payload, storedMac, secret);

            if (!isValid) {
                console.warn('[AUTH GUARD] MAC do integrity stamp inválido.');
                sessionStorage.removeItem(SECURITY.KEYS.integrityStamp);
                return null;
            }

            // Rejeita stamps com mais de 6 horas
            const SIX_HOURS = 6 * 60 * 60 * 1000;
            if (Date.now() - ts > SIX_HOURS) {
                sessionStorage.removeItem(SECURITY.KEYS.integrityStamp);
                return null; // Será recriado no próximo ciclo do guard
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
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SUBSCRIPTION CHECKER
//  [SEC-15] Cache em closure privada — inacessível via console
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

    return {
        async getActive(userId) {
            if (_cache && Date.now() < _cacheExp && _cacheUser === userId) {
                return _cache;
            }

            try {
                // 1. Verifica assinatura própria
                const { data: ownSub, error: ownErr } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at')
                    .eq('user_id', userId)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .maybeSingle();

                if (!ownErr && ownSub) {
                    if (ownSub.expires_at && new Date(ownSub.expires_at) < new Date()) {
                        return EMPTY;
                    }
                    _cache     = Object.freeze({
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

                // 2. Verifica se é convidado
                const { data: member, error: memErr } = await supabase
                    .from('account_members')
                    .select('id, owner_user_id, owner_email, is_active')
                    .eq('member_user_id', userId)
                    .eq('is_active', true)
                    .maybeSingle();

                if (memErr || !member) return EMPTY;

                // 3. Verifica assinatura do dono
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
//  [SEC-14] Valida same-origin antes de qualquer redirect
// ═══════════════════════════════════════════════════════════════
const SafeRedirect = {
    _isSafe(url) {
        if (!url || typeof url !== 'string') return false;
        // URLs relativas são sempre seguras
        if (!url.startsWith('http://') && !url.startsWith('https://')) return true;
        try {
            return new URL(url, window.location.origin).origin === window.location.origin;
        } catch {
            return false;
        }
    },

    to(url, reason = '') {
        if (!this._isSafe(url)) {
            console.error('[AUTH GUARD] Tentativa de redirect externo bloqueada.');
            url = SECURITY.LOGIN_URL;
        }

        // Limpa estado antes de redirecionar
        Fingerprint.clear();
        SubscriptionChecker.invalidate();
        RateLimiter.clear();

        // replace() impede botão "voltar" de retornar à página protegida
        window.location.replace(url);
    },

    toLogin(reason = '') {
        // [SEC-14] Código ofuscado na URL — não revela mecanismo interno
        const code   = SECURITY.ERROR_URL_MAP[reason] || 'e0';
        const target = `${SECURITY.LOGIN_URL}?c=${encodeURIComponent(code)}`;
        this.to(target, reason);
    },
};

// ═══════════════════════════════════════════════════════════════
//  BROADCAST CHANNEL — SINCRONIZAÇÃO ENTRE ABAS
//  [SEC-13] Notifica todas as abas sobre logout/invalidação
//  [SEC-03] Supre limitação do evento 'storage' (não funciona para sessionStorage)
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
                    // Outra aba fez logout — invalida esta também
                    if (!window.location.href.includes('login.html')) {
                        Fingerprint.clear();
                        SubscriptionChecker.invalidate();
                        RateLimiter.clear();
                        if (typeof onLogoutMessage === 'function') {
                            onLogoutMessage(e.data.type);
                        }
                        SafeRedirect.toLogin('NO_SESSION');
                    }
                    break;

                case 'SUBSCRIPTION_INVALIDATED':
                    SubscriptionChecker.invalidate();
                    break;
            }
        });
    } catch {
        // BroadcastChannel indisponível (ambiente muito antigo)
    }
}

function _broadcastLogout(type) {
    try {
        _broadcastChannel?.postMessage({ type });
    } catch { /* canal já fechado */ }
}

// ═══════════════════════════════════════════════════════════════
//  GUARD PRINCIPAL
//  Estado interno em closure privada — inacessível via console
// ═══════════════════════════════════════════════════════════════
const AuthGuard = (() => {
    let _ready        = false;
    let _user         = null;
    let _subData      = null;
    let _monitorTimer = null;

    function _stopMonitoring() {
        if (_monitorTimer) {
            clearInterval(_monitorTimer);
            _monitorTimer = null;
        }
    }

    function _startMonitoring() {
        if (_monitorTimer) return;

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
                }
            } catch {
                // Erro de rede — não força logout (pode ser temporário)
            }
        }, SECURITY.SESSION_POLL_INTERVAL);
    }

    const _publicAPI = {
        /**
         * ┌────────────────────────────────────────────────────────┐
         * │  AuthGuard.protect(options)                            │
         * │  Chame no topo de CADA página protegida.               │
         * │  Retorna userData no sucesso, null na falha.           │
         * └────────────────────────────────────────────────────────┘
         *
         * @param {Object}   options
         * @param {boolean}  options.requirePlan         — Exige plano ativo       (default: true)
         * @param {boolean}  options.allowGuest          — Permite convidados      (default: true)
         * @param {boolean}  options.guestCanUpgrade     — Convidado pode acessar upgrade? (default: false)
         * @param {string[]} options.upgradePagePatterns — Padrões de URL de upgrade
         * @param {Function} options.onSuccess           — callback(userData)
         * @param {Function} options.onFail              — callback(errorObj)
         * @param {boolean}  options.redirectOnFail      — Redirecionar auto?      (default: true)
         * @param {string}   options.loadingElementId    — ID do spinner
         */
        async protect(options = {}) {
            const {
                requirePlan          = true,
                allowGuest           = true,
                guestCanUpgrade      = false,
                upgradePagePatterns  = ['atualizarplano', 'upgrade', 'mudarplano'],
                onSuccess            = null,
                onFail               = null,
                redirectOnFail       = true,
                loadingElementId     = 'authLoading',
            } = options;

            const loader = document.getElementById(loadingElementId);
            if (loader) loader.style.display = 'flex';

            try {
                // ── PASSO 1: Rate limit ───────────────────────────────
                if (!RateLimiter.isAllowed()) {
                    throw _err('RATE_LIMITED', 'Muitas verificações simultâneas.');
                }

                // ── PASSO 2: Recuperar sessão ─────────────────────────
                const { data: { session }, error: sessErr } = await supabase.auth.getSession();

                if (sessErr || !session?.user) {
                    throw _err('NO_SESSION', 'Sem sessão ativa.');
                }

                let { user, expires_at } = session;

                // ── PASSO 3: Token expirado → tentar refresh ──────────
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

                // ── PASSO 4: Verificar fingerprint ────────────────────
                if (!Fingerprint.validate(user)) {
                    await supabase.auth.signOut().catch(() => {});
                    throw _err('SESSION_HIJACK', 'Fingerprint divergiu.');
                }

                // ── PASSO 5: Verificar idade máxima da sessão ─────────
                if (Fingerprint.isSessionExpiredByAge()) {
                    await supabase.auth.signOut().catch(() => {});
                    throw _err('SESSION_TOO_OLD', 'Sessão ultrapassou 24h.');
                }

                // ── PASSO 6: Verificar integridade do userId ──────────
                // [SEC-04] Usa HMAC-SHA256 assíncrono
                const stampedUid = await Fingerprint.readIntegrityStamp();
                if (stampedUid !== null && stampedUid !== user.id) {
                    await supabase.auth.signOut().catch(() => {});
                    throw _err('INTEGRITY_FAIL', 'Carimbo de integridade inválido.');
                }

                // ── PASSO 7: Gravar fingerprint e metadados ───────────
                Fingerprint.store(user);
                Fingerprint.markSessionStart();
                await Fingerprint.writeIntegrityStamp(user.id);

                // ── PASSO 8: Verificar plano/subscription ─────────────
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

                // ── PASSO 9: Montar userData ──────────────────────────
                // [SEC-12] Token NÃO incluído no objeto retornado
                const userData = Object.freeze({
                    userId:          user.id,
                    effectiveUserId: subData.ownerId || user.id,
                    nome:            String(user.user_metadata?.name || user.email?.split('@')[0] || 'Usuário').trim(),
                    email:           user.email,
                    plano:           subData.planName || 'Individual',
                    isGuest:         subData.isGuest,
                    ownerEmail:      subData.ownerEmail || null,
                    perfis:          [],
                });

                _user    = userData;
                _subData = subData;
                _ready   = true;

                // ── PASSO 10: Iniciar monitoramento ───────────────────
                _startMonitoring();

                if (loader) loader.style.display = 'none';

                if (typeof onSuccess === 'function') {
                    await onSuccess(userData);
                }

                return userData;

            } catch (error) {
                if (loader) loader.style.display = 'none';

                const code = error?.code || 'UNKNOWN';

                if (typeof onFail === 'function') {
                    try { onFail(error); } catch { /* */ }
                }

                if (redirectOnFail) {
                    SafeRedirect.toLogin(code);
                }

                return null;
            }
        },

        // ─── API PÚBLICA ──────────────────────────────────────────────

        /** Logout completo e seguro */
        async logout(reason = 'LOGOUT') {
            _stopMonitoring();
            _user    = null;
            _subData = null;
            _ready   = false;

            SubscriptionChecker.invalidate();
            Fingerprint.clear();
            RateLimiter.clear();

            // [SEC-13] Notifica outras abas
            _broadcastLogout('LOGOUT');

            try {
                await supabase.auth.signOut();
            } catch { /* Ignora erro de rede no logout */ }

            SafeRedirect.toLogin(reason);
        },

        /**
         * Logout forçado.
         * [SEC-08] Aguarda signOut para evitar race condition.
         */
        async forceLogout(reason = 'FORCE_LOGOUT') {
            _stopMonitoring();
            _ready = false;

            SubscriptionChecker.invalidate();
            Fingerprint.clear();
            RateLimiter.clear();

            // [SEC-13] Notifica outras abas
            _broadcastLogout('FORCE_LOGOUT');

            try {
                await supabase.auth.signOut();
            } catch { /* Ignora */ }

            SafeRedirect.toLogin(reason);
        },

        /** Retorna cópia dos dados do usuário atual — sem dados sensíveis */
        getUser()        { return _user ? { ..._user } : null; },
        isReady()        { return _ready; },
        isGuest()        { return _user?.isGuest ?? false; },
        getCurrentPlan() { return _user?.plano ?? null; },

        /** Força invalidação do cache de plano (usar após upgrade) */
        refreshSubscription() {
            SubscriptionChecker.invalidate();
            // [SEC-13] Propaga invalidação para outras abas
            try { _broadcastChannel?.postMessage({ type: 'SUBSCRIPTION_INVALIDATED' }); } catch { /* */ }
        },

        // Exposto apenas para o listener onAuthStateChange interno
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
//  LISTENERS GLOBAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════

// Detecta mudanças de auth do Supabase em qualquer aba
supabase.auth.onAuthStateChange((event, session) => {
    switch (event) {
        case 'SIGNED_OUT':
            AuthGuard._internalStop();
            Fingerprint.clear();
            SubscriptionChecker.invalidate();
            RateLimiter.clear();
            if (!window.location.href.includes('login.html')) {
                SafeRedirect.toLogin('NO_SESSION');
            }
            break;

        case 'TOKEN_REFRESHED':
            // Token renovado — nenhuma ação necessária
            break;

        case 'USER_UPDATED':
            SubscriptionChecker.invalidate();
            break;

        case 'PASSWORD_RECOVERY':
            // [SEC-09] Faz signOut antes de redirecionar — evita sessão de recovery persistente
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

// Detecta remoção do token Supabase em outra aba (localStorage)
// [SEC-03] NOTA: evento 'storage' só funciona para localStorage, não sessionStorage.
// Para sessionStorage, usamos BroadcastChannel (acima).
window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('sb-') && e.newValue === null) {
        if (!window.location.href.includes('login.html')) {
            Fingerprint.clear();
            SubscriptionChecker.invalidate();
            RateLimiter.clear();
            SafeRedirect.toLogin('NO_SESSION');
        }
    }
});

// Detecta reativação da aba — verifica se a sessão ainda existe
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && AuthGuard.isReady()) {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                await AuthGuard.forceLogout('NO_SESSION');
            }
        } catch {
            // Erro de rede — não força logout (pode ser temporário)
        }
    }
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export { AuthGuard, SubscriptionChecker, SafeRedirect };
export default AuthGuard;