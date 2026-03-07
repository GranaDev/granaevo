/**
 * GranaEvo — auth-guard.js
 *
 * CORREÇÕES DE SEGURANÇA APLICADAS (mantidas da versão anterior):
 * [SEC-01..SEC-15] — ver comentários inline abaixo
 *
 * CORREÇÃO NOVA:
 * [BUG-RLS-FIX] SubscriptionChecker.getActive() reescrito.
 *
 * CAUSA DO BUG:
 * A política RLS "subscriptions_select" é: auth.uid() = user_id
 * Quando user_id = NULL (link do primeiroacesso falhou silenciosamente),
 * auth.uid() = NULL é sempre FALSE em SQL — o usuário nunca enxerga
 * sua própria subscription. O fallback por user_email também falhava
 * porque NÃO EXISTIA nenhuma política RLS permitindo SELECT por email.
 *
 * SOLUÇÃO COMPLETA (duas partes):
 *   1. SQL: nova política "subscriptions_select_by_email_unlinked"
 *      (arquivo FIX_RLS.sql) — permite SELECT quando user_id IS NULL
 *      e user_email = email do JWT autenticado.
 *   2. Este arquivo: SubscriptionChecker agora faz o auto-link
 *      corretamente após encontrar a subscription pelo email,
 *      e o fluxo de polling no monitor também invalida o cache
 *      e busca novamente após o link.
 */

import { supabase } from './supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES CENTRAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════
const SECURITY = Object.freeze({
    SESSION_POLL_INTERVAL:           5 * 60 * 1000,
    TOKEN_REFRESH_THRESHOLD_SECONDS: 10 * 60,
    MAX_SESSION_AGE_MS:              24 * 60 * 60 * 1000,
    RATE_LIMIT_MAX:                  15,
    RATE_LIMIT_WINDOW_MS:            60 * 1000,
    LOGIN_URL:                       'login.html',

    KEYS: Object.freeze({
        fingerprint:    '_ge_fp',
        sessionStart:   '_ge_ss',
        integrityStamp: '_ge_is',
        sessionSecret:  '_ge_sec',
        rateLog:        '_ge_rl',
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

    BROADCAST_CHANNEL: 'ge_auth_sync',
});

// ═══════════════════════════════════════════════════════════════
//  HELPER INTERNO
//  [SEC-01] Não exportado — encapsulado na closure do módulo
//  [SEC-10] Stack trace preservado
// ═══════════════════════════════════════════════════════════════
function _err(code, message) {
    const e   = new Error(message);
    e.code    = code;
    e.message = message;
    return e;
}

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: CRYPTO SEGURO
//  [SEC-04] HMAC-SHA256 real via SubtleCrypto
//  [SEC-05] Encoding via TextEncoder/Uint8Array
// ═══════════════════════════════════════════════════════════════
const SecureCrypto = {
    generateSecret() {
        const arr = new Uint8Array(32);
        crypto.getRandomValues(arr);
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    },

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

    async sign(data, hexSecret) {
        const key       = await this.importKey(hexSecret);
        const encoded   = new TextEncoder().encode(data);
        const signature = await crypto.subtle.sign('HMAC', key, encoded);
        return Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    async verify(data, signature, hexSecret) {
        try {
            const key      = await this.importKey(hexSecret);
            const encoded  = new TextEncoder().encode(data);
            const sigBytes = new Uint8Array(
                signature.match(/.{2}/g).map(h => parseInt(h, 16))
            );
            return crypto.subtle.verify('HMAC', key, sigBytes, encoded);
        } catch {
            return false;
        }
    },

    encodeBase64url(str) {
        const bytes = new TextEncoder().encode(str);
        let binary  = '';
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    },

    decodeBase64url(str) {
        const padded = str.replace(/-/g, '+').replace(/_/g, '/');
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
//  [SEC-07]
// ═══════════════════════════════════════════════════════════════
const RateLimiter = (() => {
    function getLog() {
        try { return JSON.parse(sessionStorage.getItem(SECURITY.KEYS.rateLog) || '[]'); }
        catch { return []; }
    }
    function saveLog(log) {
        try { sessionStorage.setItem(SECURITY.KEYS.rateLog, JSON.stringify(log)); }
        catch { /* cheio */ }
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
        clear() { sessionStorage.removeItem(SECURITY.KEYS.rateLog); },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SESSION FINGERPRINTING
//  [SEC-02] Múltiplos sinais
//  [SEC-04] HMAC-SHA256
//  [SEC-11] Timestamp + janela 6h
// ═══════════════════════════════════════════════════════════════
const Fingerprint = {
    generate(user) {
        const raw = [
            user.id,
            user.email,
            user.created_at,
            navigator.userAgent.slice(0, 80),
            navigator.language || '',
            navigator.platform || '',
            screen.colorDepth  || 0,
            (window.devicePixelRatio || 1).toFixed(2),
            screen.width  || 0,
            screen.height || 0,
            new Date().getTimezoneOffset(),
        ].join('::');

        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h  = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
    },

    store(user) {
        try { sessionStorage.setItem(SECURITY.KEYS.fingerprint, this.generate(user)); }
        catch { /* cheio */ }
    },

    validate(user) {
        const stored = sessionStorage.getItem(SECURITY.KEYS.fingerprint);
        if (!stored) return true;
        return stored === this.generate(user);
    },

    markSessionStart() {
        if (!sessionStorage.getItem(SECURITY.KEYS.sessionStart)) {
            try { sessionStorage.setItem(SECURITY.KEYS.sessionStart, String(Date.now())); }
            catch { /* cheio */ }
        }
    },

    isSessionExpiredByAge() {
        const start = parseInt(sessionStorage.getItem(SECURITY.KEYS.sessionStart) || '0', 10);
        return start > 0 && (Date.now() - start) > SECURITY.MAX_SESSION_AGE_MS;
    },

    _getOrCreateSecret() {
        let secret = sessionStorage.getItem(SECURITY.KEYS.sessionSecret);
        if (!secret) {
            secret = SecureCrypto.generateSecret();
            try { sessionStorage.setItem(SECURITY.KEYS.sessionSecret, secret); }
            catch { /* cheio */ }
        }
        return secret;
    },

    async writeIntegrityStamp(userId) {
        const secret  = this._getOrCreateSecret();
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

            const secret  = this._getOrCreateSecret();
            const isValid = await SecureCrypto.verify(payload, storedMac, secret);

            if (!isValid) {
                console.warn('[AUTH GUARD] MAC do integrity stamp inválido.');
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
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SUBSCRIPTION CHECKER
//  [SEC-15] Cache em closure privada
//
//  [BUG-RLS-FIX] REESCRITO:
//
//  PROBLEMA ORIGINAL:
//  1. Busca por user_id: falha se user_id = NULL (RLS: auth.uid() = NULL → FALSE)
//  2. Fallback por user_email: também falha porque não existe política RLS
//     que permita SELECT por email com o cliente autenticado do usuário.
//
//  SOLUÇÃO (requer FIX_RLS.sql aplicado no banco):
//  A nova política "subscriptions_select_by_email_unlinked" permite que o
//  usuário autenticado veja sua subscription quando:
//    - user_id IS NULL  (link ainda não foi feito)
//    - user_email = email do JWT  (confirmação de identidade pelo banco)
//
//  Após encontrar pelo email, auto-vincula user_id imediatamente para que
//  a próxima busca já funcione pela política padrão (auth.uid() = user_id).
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
     * Tenta vincular user_id na subscription em background.
     * Falha silenciosa — não bloqueia o fluxo principal.
     */
    async function _autoLink(subscriptionId, userId) {
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
                .eq('user_id', null); // segurança: só atualiza se ainda NULL
        } catch {
            // Não crítico — na próxima verificação tentará novamente
        }
    }

    return {
        async getActive(userId) {
            // Retorna cache se ainda válido para este userId
            if (_cache && Date.now() < _cacheExp && _cacheUser === userId) {
                return _cache;
            }

            try {
                // ── 1. Busca por user_id (caminho principal) ──────────
                // Funciona quando user_id já foi vinculado corretamente.
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
                // [BUG-RLS-FIX] Funciona SOMENTE após FIX_RLS.sql aplicado.
                // Nova política: user_id IS NULL AND user_email = jwt email
                //
                // Não precisamos passar o email explicitamente — o banco
                // extrai do JWT automaticamente via auth.jwt()->>'email'.
                // Basta filtrar por is_active + payment_status.
                const { data: emailSub, error: emailErr } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at, user_id')
                    .is('user_id', null)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (!emailErr && emailSub) {
                    if (emailSub.expires_at && new Date(emailSub.expires_at) < new Date()) {
                        return EMPTY;
                    }

                    // Auto-vincula user_id em background (não aguarda)
                    _autoLink(emailSub.id, userId);

                    // Invalida cache imediatamente após link para forçar
                    // nova busca pelo caminho principal na próxima chamada
                    _cache     = null;
                    _cacheUser = null;
                    _cacheExp  = 0;

                    // Retorna o resultado sem cache (link em progresso)
                    return Object.freeze({
                        subscription: emailSub,
                        isGuest:      false,
                        ownerId:      userId,
                        planName:     emailSub.plans?.name || 'Individual',
                        ownerEmail:   null,
                    });
                }

                // ── 3. Verifica se é convidado ────────────────────────
                // Política RLS member_can_read_own_membership:
                // auth.uid() = member_user_id → funciona normalmente
                const { data: member, error: memErr } = await supabase
                    .from('account_members')
                    .select('id, owner_user_id, owner_email, is_active')
                    .eq('member_user_id', userId)
                    .eq('is_active', true)
                    .maybeSingle();

                if (memErr || !member) return EMPTY;

                // Política RLS guest_can_view_owner_subscription:
                // EXISTS(account_members WHERE owner_user_id = subscriptions.user_id
                //        AND member_user_id = auth.uid()) → funciona normalmente
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
//  [SEC-14] Valida same-origin
// ═══════════════════════════════════════════════════════════════
const SafeRedirect = {
    _isSafe(url) {
        if (!url || typeof url !== 'string') return false;
        if (!url.startsWith('http://') && !url.startsWith('https://')) return true;
        try {
            return new URL(url, window.location.origin).origin === window.location.origin;
        } catch {
            return false;
        }
    },

    to(url) {
        if (!this._isSafe(url)) {
            console.error('[AUTH GUARD] Redirect externo bloqueado.');
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
                        SafeRedirect.toLogin('NO_SESSION');
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
                // Erro de rede — não força logout
            }
        }, SECURITY.SESSION_POLL_INTERVAL);
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

            const loader = document.getElementById(loadingElementId);
            if (loader) loader.style.display = 'flex';

            try {
                // ── Passo 1: Rate limit ───────────────────────────────
                if (!RateLimiter.isAllowed()) {
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
                if (!Fingerprint.validate(user)) {
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

                // ── Passo 7: Gravar fingerprint ───────────────────────
                Fingerprint.store(user);
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
                // [SEC-12] Token NÃO incluído
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

                // ── Passo 10: Iniciar monitoramento ───────────────────
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

            SafeRedirect.toLogin(reason);
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

            SafeRedirect.toLogin(reason);
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
                SafeRedirect.toLogin('NO_SESSION');
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

// [SEC-03] Detecta remoção do token em outra aba (localStorage)
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

// Detecta reativação da aba
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && AuthGuard.isReady()) {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                await AuthGuard.forceLogout('NO_SESSION');
            }
        } catch {
            // Erro de rede — não força logout
        }
    }
});

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
export { AuthGuard, SubscriptionChecker, SafeRedirect };
export default AuthGuard;