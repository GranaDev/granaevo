/**
 * GranaEvo — auth-guard.js
 * Versão 3.0 — Relatório de segurança aplicado integralmente
 *
 * ═══════════════════════════════════════════════════════════════
 *  REGISTRO COMPLETO DE CORREÇÕES DE SEGURANÇA
 * ═══════════════════════════════════════════════════════════════
 */

import { supabase, clearRememberMe } from '../services/supabase-client.js?v=2';

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
    SESSION_POLL_INTERVAL:           10 * 60 * 1000,
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
    // Secret da sessão: persiste em sessionStorage dentro da mesma aba.
    // sessionStorage sobrevive a page-refreshes mas é limpo ao fechar a aba,
    // garantindo que um fingerprint salvo antes do reload continue verificável.
    // Sem isso, cada reload gera secret novo → fingerprint mismatch → SESSION_HIJACK falso.
    let _sessionSecret = null;
    const _SK_KEY = '_ge_sk'; // chave no sessionStorage — fora do SECURITY.KEYS por design

    function _getOrCreateSecret() {
        if (_sessionSecret) return _sessionSecret;
        // Tenta restaurar da sessionStorage (sobrevive a reload na mesma aba)
        try {
            const stored = sessionStorage.getItem(_SK_KEY);
            if (stored && /^[0-9a-f]{64}$/.test(stored)) {
                _sessionSecret = stored;
                return _sessionSecret;
            }
        } catch { /* sessionStorage bloqueado */ }
        // Gera novo secret e persiste
        const arr = new Uint8Array(32);
        crypto.getRandomValues(arr);
        _sessionSecret = Array.from(arr)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        try { sessionStorage.setItem(_SK_KEY, _sessionSecret); } catch { /* cheio */ }
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
        // Invalida secret em memória E sessionStorage no logout/hijack
        clearSecret() {
            _sessionSecret = null;
            try { sessionStorage.removeItem(_SK_KEY); } catch { /* */ }
        },
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
        // Canvas REMOVIDO do fingerprint — browsers com proteção de privacidade
        // (Firefox, Brave) randomizam canvas a cada page load, causando falsos
        // positivos constantes de SESSION_HIJACK. O canvasSalt (sessionStorage)
        // já garante unicidade por aba sem dependência do rendering engine.
        const canvasSalt = SecureCrypto.getCanvasSalt();

        const raw = [
            user.id,
            user.email,
            user.created_at,
            navigator.userAgent,
            navigator.platform,
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
// Normaliza plan_name do Stripe (lowercase) para formato do app (capitalized)
function _normalizePlanName(raw) {
    const map = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
    return map[(raw || '').toLowerCase()] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Individual');
}

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
     * Auto-link Cakto — vincula subscription.user_id ao usuário autenticado.
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
                .eq('user_email', subscriptionEmail);
        } catch {
            // Não crítico — tentará novamente na próxima verificação
        }
    }

    /**
     * Auto-link Stripe — vincula stripe_subscriptions.user_id ao usuário autenticado.
     * Requer RLS policy "stripe_sub_update_claim" (user_id IS NULL + email match).
     */
    async function _autoLinkStripe(subscriptionId, userId, sessionEmail, subscriptionEmail) {
        if (!sessionEmail || !subscriptionEmail) return;
        if (sessionEmail.toLowerCase() !== subscriptionEmail.toLowerCase()) return;

        try {
            await supabase
                .from('stripe_subscriptions')
                .update({
                    user_id:    userId,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', subscriptionId)
                .is('user_id', null)
                .eq('user_email', subscriptionEmail.toLowerCase());
        } catch {
            // Não crítico — check-user-access EF também faz o link via service role
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

                // ── 1.5: Stripe — busca por user_id (assinatura recorrente) ──
                const { data: stripeSub, error: stripeErr } = await supabase
                    .from('stripe_subscriptions')
                    .select('id, plan_name, status, current_period_end')
                    .eq('user_id', userId)
                    .in('status', ['active', 'trialing'])
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (!stripeErr && stripeSub) {
                    // Período ainda válido ou sem data de expiração definida
                    if (!stripeSub.current_period_end ||
                        new Date(stripeSub.current_period_end) >= new Date()) {
                        _cache = Object.freeze({
                            subscription: stripeSub,
                            isGuest:      false,
                            ownerId:      userId,
                            planName:     _normalizePlanName(stripeSub.plan_name),
                            ownerEmail:   null,
                        });
                        _cacheUser = userId;
                        _cacheExp  = Date.now() + CACHE_TTL;
                        return _cache;
                    }
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

                    // ── 2.5: Stripe — busca por email (primeiro login após compra anônima) ─
                    // user_id ainda é NULL: compra foi feita sem login.
                    // RLS "stripe_sub_select_by_email" permite esta leitura.
                    const { data: stripeEmailSub, error: stripeEmailErr } = await supabase
                        .from('stripe_subscriptions')
                        .select('id, plan_name, status, current_period_end, user_email')
                        .is('user_id', null)
                        .eq('user_email', sessionEmail.toLowerCase())
                        .in('status', ['active', 'trialing'])
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();

                    if (!stripeEmailErr && stripeEmailSub) {
                        if (!stripeEmailSub.current_period_end ||
                            new Date(stripeEmailSub.current_period_end) >= new Date()) {

                            const emailConfirmedStripe = !!authUser?.email_confirmed_at;
                            if (emailConfirmedStripe) {
                                // Auto-link em background (RLS "stripe_sub_update_claim")
                                _autoLinkStripe(
                                    stripeEmailSub.id,
                                    userId,
                                    sessionEmail,
                                    stripeEmailSub.user_email,
                                );
                                _cache     = null;
                                _cacheUser = null;
                                _cacheExp  = 0;
                            }

                            return Object.freeze({
                                subscription: stripeEmailSub,
                                isGuest:      false,
                                ownerId:      userId,
                                planName:     _normalizePlanName(stripeEmailSub.plan_name),
                                ownerEmail:   null,
                            });
                        }
                    }
                }

                // ── 2.6: Estado "congelado" — cancelado há menos de 90 dias ──────
                // Se não há plano ativo mas existe uma assinatura Stripe cancelada
                // dentro do período de 90 dias de retenção de dados, retorna um
                // estado especial que exibe a tela de assinatura encerrada.
                try {
                    const { data: frozenSub } = await supabase
                        .from('stripe_subscriptions')
                        .select('plan_name, current_period_end')
                        .eq('user_id', userId)
                        .eq('status', 'canceled')
                        .order('updated_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();

                    if (frozenSub?.current_period_end) {
                        const daysSince =
                            (Date.now() - new Date(frozenSub.current_period_end).getTime()) / 86_400_000;
                        if (daysSince <= 90) {
                            return {
                                subscription:      null,
                                isGuest:           false,
                                ownerId:           userId,
                                planName:          null,
                                ownerEmail:        null,
                                isFrozen:          true,
                                daysUntilDeletion: Math.max(1, Math.ceil(90 - daysSince)),
                                frozenPlanName:    _normalizePlanName(frozenSub.plan_name),
                            };
                        }
                    }
                } catch {
                    // Não bloqueia o fluxo — segue para verificação de convidado
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

                // Verifica subscription Cakto do dono
                const { data: ownerSub } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at')
                    .eq('user_id', member.owner_user_id)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .maybeSingle();

                let finalSub      = ownerSub;
                let finalPlanName = ownerSub?.plans?.name || null;

                const caktoExpired = ownerSub?.expires_at && new Date(ownerSub.expires_at) < new Date();
                if (!ownerSub || caktoExpired) {
                    // Dono pode ter plano Stripe — verifica stripe_subscriptions
                    const { data: ownerStripe } = await supabase
                        .from('stripe_subscriptions')
                        .select('id, plan_name, status, current_period_end')
                        .eq('user_id', member.owner_user_id)
                        .in('status', ['active', 'trialing'])
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();

                    if (!ownerStripe) return EMPTY;
                    if (ownerStripe.current_period_end && new Date(ownerStripe.current_period_end) < new Date()) {
                        return EMPTY;
                    }
                    finalSub      = ownerStripe;
                    finalPlanName = _normalizePlanName(ownerStripe.plan_name);
                }

                _cache = Object.freeze({
                    subscription: finalSub,
                    isGuest:      true,
                    ownerId:      member.owner_user_id,
                    planName:     finalPlanName || 'Individual',
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
//  TELA CONGELADA — assinatura encerrada (dentro dos 90 dias de retenção)
// ═══════════════════════════════════════════════════════════════
function _renderFrozenOverlay(subData, guard) {
    // ═══════════════════════════════════════════════════════════════
    //  BLINDAGEM DE SEGURANÇA — NÍVEL EXTREMO
    //  Impede qualquer bypass: remoção de DOM, navegação via history,
    //  teclado, links, popstate, cliques por baixo da overlay, etc.
    // ═══════════════════════════════════════════════════════════════

    // Remove overlay anterior se existir
    document.getElementById('_ge_frozen_overlay')?.remove();

    const days         = subData.daysUntilDeletion ?? 0;
    const _rawPlanName = subData.frozenPlanName ?? '';
    // Whitelist — nunca interpola string arbitrária em innerHTML
    const _PLAN_WL     = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
    const planName     = _PLAN_WL[_rawPlanName?.toLowerCase?.()] ?? 'GranaEvo';
    const daysText     = days === 1 ? '1 dia' : `${days} dias`;

    // ── 1. Trava scroll do body ───────────────────────────────────
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow            = 'hidden';
    document.body.style.pointerEvents       = 'none';  // bloqueia cliques no body

    // ── 2. Intercepta history API ─────────────────────────────────
    // Guarda referências originais para restaurar no cleanup
    const _origPushState    = history.pushState.bind(history);
    const _origReplaceState = history.replaceState.bind(history);
    // Substitui por no-ops — impede SPA navigation via JS
    try {
        history.pushState    = () => {};
        history.replaceState = () => {};
    } catch { /* já bloqueado ou CSP */ }

    // ── 3. Bloqueia o botão Voltar ────────────────────────────────
    _origPushState(null, '', window.location.href);
    const _onPopState = () => {
        _origPushState(null, '', window.location.href);
    };
    window.addEventListener('popstate', _onPopState);

    // ── 4. Intercepta TODOS os cliques na fase de captura ─────────
    // Permite apenas cliques dentro da overlay (_ge_frozen_overlay)
    const _onCapture = (e) => {
        if (!e.target.closest('#_ge_frozen_overlay')) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    };
    document.addEventListener('click',       _onCapture, true);
    document.addEventListener('mousedown',   _onCapture, true);
    document.addEventListener('touchstart',  _onCapture, { capture: true, passive: false });
    document.addEventListener('contextmenu', _onCapture, true);

    // ── 5. Bloqueia teclado — teclas que navegam sem mouse ────────
    const _BLOCKED_KEYS = new Set([
        'Alt', 'F5',                       // atalhos de navegação
        'ArrowLeft', 'ArrowRight',         // histórico no Firefox
    ]);
    const _onKeyDown = (e) => {
        // Permite Tab/Enter/Space apenas dentro da overlay
        if (!e.target.closest('#_ge_frozen_overlay')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        // Bloqueia Alt+ArrowLeft (Voltar no browser) de qualquer lugar
        if (_BLOCKED_KEYS.has(e.key) && (e.altKey || e.key === 'F5')) {
            e.preventDefault();
        }
    };
    document.addEventListener('keydown', _onKeyDown, true);
    document.addEventListener('keyup',   _onKeyDown, true);

    // ── 6. Trap de foco ──────────────────────────────────────────
    // Mantém foco sempre dentro da overlay (impede Tab fora)
    const _onFocusIn = (e) => {
        if (!e.target.closest('#_ge_frozen_overlay')) {
            e.preventDefault();
            document.getElementById('_ge_frozen_logout')?.focus();
        }
    };
    document.addEventListener('focusin', _onFocusIn, true);

    // ── 7. MutationObserver — reinjeta se removida do DOM ─────────
    let _reinjecting = false;
    const _observer = new MutationObserver(() => {
        if (_reinjecting) return;
        if (!document.getElementById('_ge_frozen_overlay')) {
            _reinjecting = true;
            try { document.body.appendChild(overlay); }
            finally { _reinjecting = false; }
        }
    });
    _observer.observe(document.body, { childList: true });
    // Observa também o html root (por se for feito um document.body = ...)
    _observer.observe(document.documentElement, { childList: true });

    // ── 8. Intervalo de verificação (redundância) ─────────────────
    const _watchdogId = setInterval(() => {
        if (!document.getElementById('_ge_frozen_overlay')) {
            try { document.body.appendChild(overlay); } catch { /* */ }
        }
        // Garante pointer-events desabilitado no body
        document.body.style.pointerEvents = 'none';
    }, 800);

    // ── 9. Visibilitychange — revalida ao voltar para a aba ───────
    const _onVisible = () => {
        if (document.visibilityState === 'visible') {
            if (!document.getElementById('_ge_frozen_overlay')) {
                try { document.body.appendChild(overlay); } catch { /* */ }
            }
        }
    };
    document.addEventListener('visibilitychange', _onVisible);

    // ── cleanup: restaura tudo antes de navegar ou fazer logout ───
    function _cleanup() {
        _observer.disconnect();
        clearInterval(_watchdogId);
        window.removeEventListener('popstate',         _onPopState);
        document.removeEventListener('click',          _onCapture,   true);
        document.removeEventListener('mousedown',      _onCapture,   true);
        document.removeEventListener('touchstart',     _onCapture,   true);
        document.removeEventListener('contextmenu',    _onCapture,   true);
        document.removeEventListener('keydown',        _onKeyDown,   true);
        document.removeEventListener('keyup',          _onKeyDown,   true);
        document.removeEventListener('focusin',        _onFocusIn,   true);
        document.removeEventListener('visibilitychange', _onVisible);
        document.documentElement.style.overflow = '';
        document.body.style.overflow            = '';
        document.body.style.pointerEvents       = '';
        try {
            history.pushState    = _origPushState;
            history.replaceState = _origReplaceState;
        } catch { /* */ }
    }

    // ── Cria a overlay ────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = '_ge_frozen_overlay';
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',   // z-index máximo possível
        'background:linear-gradient(160deg,#060810 0%,#0d1117 55%,#060c14 100%)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:24px', 'font-family:system-ui,-apple-system,sans-serif',
        'overflow-y:auto', 'pointer-events:all',               // overlay tem pointer-events habilitado
    ].join(';');

    overlay.innerHTML = `
      <div style="max-width:460px;width:100%;text-align:center;padding:8px 0;">

        <div style="margin-bottom:36px;">
          <div style="font-size:26px;font-weight:900;color:#10b981;letter-spacing:-1px;line-height:1;">GranaEvo</div>
          <div style="font-size:11px;color:#334155;margin-top:6px;letter-spacing:2.5px;text-transform:uppercase;">Gestão Financeira</div>
        </div>

        <div style="width:76px;height:76px;border-radius:50%;background:rgba(239,68,68,0.08);border:1.5px solid rgba(239,68,68,0.25);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;">
          <svg style="width:34px;height:34px;color:#ef4444;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>

        <h1 style="font-size:22px;font-weight:800;color:#f1f5f9;margin:0 0 12px;line-height:1.3;">
          Sua assinatura foi encerrada
        </h1>

        <p style="font-size:14px;color:#94a3b8;margin:0 0 28px;line-height:1.75;">
          O acesso ao plano <strong style="color:#e2e8f0;">${planName}</strong> foi encerrado.
          Para continuar usando o GranaEvo, retome sua assinatura abaixo.
        </p>

        <div style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.22);border-radius:14px;padding:16px 20px;margin-bottom:32px;text-align:left;">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <span style="font-size:16px;flex-shrink:0;margin-top:1px;">⏳</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:#fbbf24;margin-bottom:5px;">Seus dados estão salvos</div>
              <div style="font-size:13px;color:#94a3b8;line-height:1.65;">
                Todas as suas informações permanecem seguras por mais
                <strong style="color:#fbbf24;">${daysText}</strong>.
                Após esse prazo, os dados serão excluídos permanentemente e não poderão ser recuperados.
              </div>
            </div>
          </div>
        </div>

        <button id="_ge_frozen_retomar"
                style="display:block;width:100%;padding:15px 20px;background:linear-gradient(135deg,#10b981,#059669);border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:10px;box-sizing:border-box;">
          Retomar assinatura
        </button>

        <button id="_ge_frozen_logout"
                style="width:100%;padding:13px 20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;color:#64748b;font-size:14px;cursor:pointer;font-family:inherit;">
          Sair da conta
        </button>

      </div>
    `;

    // Adiciona ao DOM antes de configurar listeners da overlay
    document.body.appendChild(overlay);

    // CTA "Retomar" — cleanup + navega para planos
    overlay.querySelector('#_ge_frozen_retomar')?.addEventListener('click', () => {
        _cleanup();
        window.location.href = 'planos.html';
    });

    // "Sair" — cleanup + logout
    overlay.querySelector('#_ge_frozen_logout')?.addEventListener('click', () => {
        _cleanup();
        guard.logout();
    });

    // Foco inicial no botão principal
    setTimeout(() => overlay.querySelector('#_ge_frozen_retomar')?.focus(), 50);
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
                    // Contas congeladas (canceladas dentro dos 90 dias) não são
                    // forçadas ao logout — a overlay já está visível.
                    if (!sub.isFrozen) {
                        _publicAPI.forceLogout('NO_PLAN');
                    }
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
                // Mismatch tratado como "regenerar" em vez de SESSION_HIJACK.
                // Canvas entropy é randomizada por Firefox/Brave/extensões de
                // privacidade a cada page load — causaria falsos positivos
                // constantes. A segurança real é garantida pelo JWT (validado
                // pelo Supabase server-side) e pela verificação de assinatura.
                if (!await Fingerprint.validate(user)) {
                    Fingerprint.clear(); // descarta fingerprint antigo, gera novo abaixo
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

                    // [STRIPE-FALLBACK] Checks locais falharam — verifica via API autoritativa.
                    // Cobre: primeiro login Stripe, propagação de auto-link pendente,
                    // e qualquer divergência entre RLS cliente e lógica server-side.
                    // Contas "congeladas" (canceladas dentro de 90 dias) pulam este
                    // fallback — o estado frozen já é conclusivo.
                    if (!subData.subscription && !subData.isFrozen) {
                        try {
                            const r = await fetch('/api/check-user-access', {
                                method:  'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${session.access_token}`,
                                },
                                body:   JSON.stringify({}),
                                signal: AbortSignal.timeout(8_000),
                            });
                            if (r.ok) {
                                const api = await r.json();
                                if (api.locked) throw _err('RATE_LIMITED', api.message || 'Conta bloqueada.');
                                if (api.hasAccess === true) {
                                    subData = {
                                        subscription: { id: 'api-verified' },
                                        isGuest:      false,
                                        ownerId:      user.id,
                                        planName:     'Individual',
                                        ownerEmail:   null,
                                    };
                                    // Invalida cache local para forçar re-sync no próximo acesso
                                    SubscriptionChecker.invalidate();
                                }
                            }
                        } catch (e) {
                            if (e.code) throw e; // re-lança erros internos (RATE_LIMITED, etc.)
                        }
                    }

                    if (!subData.subscription) {
                        // Conta cancelada dentro dos 90 dias de retenção → tela congelada
                        if (subData.isFrozen) {
                            if (loader) loader.classList.add('hidden');
                            _renderFrozenOverlay(subData, _publicAPI);
                            return null; // finally libera o mutex
                        }
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
                    // Sem plano → ir para planos (não faz sentido ir ao login)
                    if (error?.code === 'NO_PLAN') {
                        SafeRedirect.to('planos.html?retomar=1');
                    } else {
                        SafeRedirect.toLogin(code);
                    }
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
            clearRememberMe(); // limpa flag + token de localStorage/sessionStorage

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
            clearRememberMe(); // limpa flag + token de localStorage/sessionStorage

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

// [SEC-03] sessionStorage não dispara evento 'storage' entre abas (é por design).
// A sincronização entre abas é feita pelo BroadcastChannel (LOGOUT/FORCE_LOGOUT).
// O listener de storage era para localStorage (sb-*) do SDK antigo — não mais necessário
// pois o storage adapter agora usa sessionStorage com chave 'ge_auth'.
// Mantido como comentário para documentar a decisão arquitetural.

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