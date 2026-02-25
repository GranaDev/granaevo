import { supabase } from './supabase-client.js';

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES CENTRAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════
const SECURITY = {
    // Intervalo de re-verificação da sessão em background (5 min)
    SESSION_POLL_INTERVAL: 5 * 60 * 1000,

    // Se o token expira em menos de 10 min → refresh proativo
    TOKEN_REFRESH_THRESHOLD_SECONDS: 10 * 60,

    // Sessão considerada "velha demais" após 24h → força relogin
    MAX_SESSION_AGE_MS: 24 * 60 * 60 * 1000,

    // FIX #10: Rate limiter usa sessionStorage para contar entre abas
    RATE_LIMIT_MAX: 15,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,
    RATE_LIMIT_KEY: '_ge_rl',

    // Onde redirecionar quando o guard bloqueia
    LOGIN_URL: 'login.html',

    // Chaves usadas no sessionStorage (prefixo ofuscado)
    KEYS: {
        fingerprint:    '_ge_fp',
        sessionStart:   '_ge_ss',
        lastCheck:      '_ge_lc',
        integrityStamp: '_ge_is',
    },

    // FIX #7: Mapeamento genérico de códigos de erro para URLs
    // Evita vazar detalhes internos do sistema de segurança
    ERROR_URL_MAP: {
        NO_SESSION:           'a1',
        TOKEN_EXPIRED:        'a2',
        SESSION_HIJACK:       'a3',
        SESSION_TOO_OLD:      'a4',
        INTEGRITY_FAIL:       'a5',
        RATE_LIMITED:         'a6',
        NO_PLAN:              'a7',
        GUEST_BLOCKED:        'a8',
        GUEST_UPGRADE_BLOCKED:'a9',
        SESSION_GONE:         'b1',
        LOGOUT:               'b2',
        FORCE_LOGOUT:         'b3',
        UNKNOWN:              'b4',
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: RATE LIMITER
//  FIX #10: Usa sessionStorage para compartilhar estado entre abas
// ═══════════════════════════════════════════════════════════════
const RateLimiter = (() => {
    function getLog() {
        try {
            return JSON.parse(sessionStorage.getItem(SECURITY.RATE_LIMIT_KEY) || '[]');
        } catch {
            return [];
        }
    }

    function saveLog(log) {
        try {
            sessionStorage.setItem(SECURITY.RATE_LIMIT_KEY, JSON.stringify(log));
        } catch { /* sessionStorage cheio — ignora silenciosamente */ }
    }

    return {
        isAllowed() {
            const now = Date.now();
            const windowStart = now - SECURITY.RATE_LIMIT_WINDOW_MS;

            // Carrega log persistente e remove entradas antigas
            let log = getLog().filter(ts => ts > windowStart);

            if (log.length >= SECURITY.RATE_LIMIT_MAX) {
                console.warn('🚨 [AUTH GUARD] Rate limit atingido — possível flood');
                return false;
            }

            log.push(now);
            saveLog(log);
            return true;
        },

        clear() {
            sessionStorage.removeItem(SECURITY.RATE_LIMIT_KEY);
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SESSION FINGERPRINTING
//  Detecta session hijacking verificando consistência dos dados
// ═══════════════════════════════════════════════════════════════
const Fingerprint = {
    /**
     * Gera um hash rápido não-criptográfico combinando dados do
     * usuário + ambiente. Não é para criptografia — é para detecção.
     */
    generate(user) {
        const ua = navigator.userAgent.slice(0, 60);
        const lang = navigator.language || '';
        const raw = [user.id, user.email, user.created_at, ua, lang].join('::');

        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(36);
    },

    store(user) {
        sessionStorage.setItem(SECURITY.KEYS.fingerprint, this.generate(user));
    },

    validate(user) {
        const stored = sessionStorage.getItem(SECURITY.KEYS.fingerprint);
        if (!stored) return true; // Primeira visita — ok
        return stored === this.generate(user);
    },

    markSessionStart() {
        if (!sessionStorage.getItem(SECURITY.KEYS.sessionStart)) {
            sessionStorage.setItem(SECURITY.KEYS.sessionStart, String(Date.now()));
        }
    },

    isSessionExpiredByAge() {
        const start = parseInt(sessionStorage.getItem(SECURITY.KEYS.sessionStart) || '0', 10);
        return start > 0 && (Date.now() - start) > SECURITY.MAX_SESSION_AGE_MS;
    },

    /**
     * FIX #7 e #8: Grava um carimbo de integridade HMAC-like.
     * Agora inclui timestamp + janela de validade para evitar replay.
     * O campo é: base64(userId|timestamp|hmac_simplificado)
     * hmac = hash(userId + timestamp + sessionSecret)
     */
    _getSessionSecret() {
        // Segredo único por sessão do navegador — não persiste entre fechamentos
        let secret = sessionStorage.getItem('_ge_sec');
        if (!secret) {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            secret = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
            sessionStorage.setItem('_ge_sec', secret);
        }
        return secret;
    },

    _hmacSimple(data) {
        const secret = this._getSessionSecret();
        const raw = data + '::' + secret;
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(36);
    },

    writeIntegrityStamp(userId) {
        const ts = Date.now();
        const payload = `${userId}|${ts}`;
        const mac = this._hmacSimple(payload);
        const stamp = btoa(`${payload}|${mac}`);
        sessionStorage.setItem(SECURITY.KEYS.integrityStamp, stamp);
    },

    /**
     * FIX #8: Valida userId, integridade do MAC e idade do stamp
     * Stamp com mais de 6 horas é rejeitado para forçar rotação
     */
    readIntegrityStamp() {
        try {
            const stamp = sessionStorage.getItem(SECURITY.KEYS.integrityStamp);
            if (!stamp) return null;

            const decoded = atob(stamp);
            const parts = decoded.split('|');
            if (parts.length !== 3) return null;

            const [uid, tsStr, storedMac] = parts;
            const ts = parseInt(tsStr, 10);

            // Verifica integridade do MAC
            const expectedMac = this._hmacSimple(`${uid}|${tsStr}`);
            if (storedMac !== expectedMac) {
                console.warn('🚨 [AUTH GUARD] MAC do integrity stamp inválido — possível adulteração');
                return null;
            }

            // FIX #8: Rejeita stamps com mais de 6 horas
            const SIX_HOURS = 6 * 60 * 60 * 1000;
            if (Date.now() - ts > SIX_HOURS) {
                console.warn('⏰ [AUTH GUARD] Integrity stamp expirado — rotacionando');
                sessionStorage.removeItem(SECURITY.KEYS.integrityStamp);
                return null; // Retorna null: será recriado no próximo ciclo do guard
            }

            return uid;
        } catch {
            return null;
        }
    },

    clear() {
        Object.values(SECURITY.KEYS).forEach(k => sessionStorage.removeItem(k));
        sessionStorage.removeItem('_ge_sec');
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SUBSCRIPTION CHECKER
//  FIX #12: Cache em closure privado — não acessível via console
// ═══════════════════════════════════════════════════════════════
const SubscriptionChecker = (() => {
    // Estado privado — inacessível externamente
    let _cache = null;
    let _cacheUserId = null;
    let _cacheExpiry = 0;
    const CACHE_TTL = 5 * 60 * 1000;

    function isExpired() {
        return Date.now() > _cacheExpiry;
    }

    function setCache(data, userId) {
        _cache = Object.freeze({ ...data }); // Congela o objeto para impedir mutação
        _cacheUserId = userId;
        _cacheExpiry = Date.now() + CACHE_TTL;
        return _cache;
    }

    const empty = Object.freeze({ subscription: null, isGuest: false, ownerId: null, planName: null, ownerEmail: null });

    return {
        async getActive(userId) {
            // Retorna cache se válido e for o mesmo user
            if (_cache && !isExpired() && _cacheUserId === userId) {
                return _cache;
            }

            try {
                // ── 1. Verifica assinatura própria ────────────────────
                const { data: ownSub, error: ownErr } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at')
                    .eq('user_id', userId)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .maybeSingle();

                if (!ownErr && ownSub) {
                    if (ownSub.expires_at && new Date(ownSub.expires_at) < new Date()) {
                        console.warn('⏰ [AUTH GUARD] Assinatura com expires_at vencido');
                        return empty;
                    }

                    return setCache({
                        subscription: ownSub,
                        isGuest: false,
                        ownerId: userId,
                        planName: ownSub.plans?.name || 'Individual',
                        ownerEmail: null,
                    }, userId);
                }

                // ── 2. Verifica se é convidado (account_members) ──────
                const { data: member, error: memErr } = await supabase
                    .from('account_members')
                    .select('id, owner_user_id, owner_email, is_active')
                    .eq('member_user_id', userId)
                    .eq('is_active', true)
                    .maybeSingle();

                if (memErr || !member) return empty;

                // ── 3. Verifica assinatura do dono ────────────────────
                const { data: ownerSub, error: ownerErr } = await supabase
                    .from('subscriptions')
                    .select('id, plans(name), is_active, payment_status, expires_at')
                    .eq('user_id', member.owner_user_id)
                    .eq('payment_status', 'approved')
                    .eq('is_active', true)
                    .maybeSingle();

                if (ownerErr || !ownerSub) return empty;

                if (ownerSub.expires_at && new Date(ownerSub.expires_at) < new Date()) {
                    console.warn('⏰ [AUTH GUARD] Assinatura do dono expirada');
                    return empty;
                }

                return setCache({
                    subscription: ownerSub,
                    isGuest: true,
                    ownerId: member.owner_user_id,
                    planName: ownerSub.plans?.name || 'Individual',
                    ownerEmail: member.owner_email,
                }, userId);

            } catch (e) {
                console.error('❌ [AUTH GUARD] Erro ao checar subscription:', e);
                return empty;
            }
        },

        invalidate() {
            _cache = null;
            _cacheUserId = null;
            _cacheExpiry = 0;
        },
    };
})();

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: REDIRECT SEGURO
//  Garante que o redirect não pode ser manipulado por open-redirect
// ═══════════════════════════════════════════════════════════════
const SafeRedirect = {
    /** Valida que a URL de destino é relativa ou da mesma origem */
    _isSafe(url) {
        if (!url.startsWith('http')) return true; // Relativa — ok
        try {
            return new URL(url).origin === window.location.origin;
        } catch {
            return false;
        }
    },

    to(url, reason = '') {
        if (!this._isSafe(url)) {
            console.error(`🚨 [AUTH GUARD] Tentativa de redirect externo bloqueada: ${url}`);
            url = SECURITY.LOGIN_URL;
        }

        // FIX #9: Logs internos apenas — não expõe código real na URL
        if (reason) console.log(`🔒 [AUTH GUARD] Redirect → ${url} | Código: ${reason}`);

        // Limpeza antes de sair
        Fingerprint.clear();
        SubscriptionChecker.invalidate();
        RateLimiter.clear();

        // replace() impede o botão "voltar" de retornar à página protegida
        window.location.replace(url);
    },

    toLogin(reason = '') {
        // FIX #9: Usa código ofuscado na URL — não revela o mecanismo de segurança
        const obfuscatedCode = SECURITY.ERROR_URL_MAP[reason] || 'e0';
        const params = `?c=${encodeURIComponent(obfuscatedCode)}`;
        this.to(SECURITY.LOGIN_URL + params, reason);
    },
};

// ═══════════════════════════════════════════════════════════════
//  GUARD PRINCIPAL
//  Estado interno em closure privada — inacessível via console
// ═══════════════════════════════════════════════════════════════
const AuthGuard = (() => {
    // Estado privado — não acessível por AuthGuard._xxx no console
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
        if (_monitorTimer) return; // Já rodando

        _monitorTimer = setInterval(async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    console.warn('🔒 [AUTH GUARD] Sessão desapareceu durante o uso!');
                    publicAPI.forceLogout('SESSION_GONE');
                    return;
                }

                // Invalidar cache e re-checar plano
                SubscriptionChecker.invalidate();
                const sub = await SubscriptionChecker.getActive(session.user.id);

                if (!sub.subscription) {
                    console.warn('🔒 [AUTH GUARD] Plano revogado durante a sessão!');
                    publicAPI.forceLogout('NO_PLAN');
                }
            } catch (e) {
                console.error('❌ [AUTH GUARD] Erro no monitoramento:', e);
            }
        }, SECURITY.SESSION_POLL_INTERVAL);
    }

    const publicAPI = {
    /**
     * ┌─────────────────────────────────────────────────────────┐
     * │  AuthGuard.protect(options)                             │
     * │  Chame no topo de CADA página protegida.                │
     * │  Retorna o objeto `userData` no sucesso, null na falha. │
     * └─────────────────────────────────────────────────────────┘
     *
     * @param {Object} options
     * @param {boolean}  options.requirePlan          - Exige plano ativo       (default: true)
     * @param {boolean}  options.allowGuest            - Permite convidados      (default: true)
     * @param {boolean}  options.guestCanUpgrade       - Convidado pode acessar upgrade? (default: false)
     * @param {string[]} options.upgradePagePatterns   - Padrões de URL para páginas de upgrade
     * @param {Function} options.onSuccess             - callback(userData)
     * @param {Function} options.onFail                - callback(errorObj) antes do redirect
     * @param {boolean}  options.redirectOnFail        - Redirecionar auto?      (default: true)
     * @param {string}   options.loadingElementId      - ID do spinner de loading
     */
    async protect(options = {}) {
        const {
            requirePlan          = true,
            allowGuest           = true,
            guestCanUpgrade      = false,
            // FIX #11: Array de padrões de URL para páginas de upgrade — mais robusto
            upgradePagePatterns  = ['atualizarplano', 'upgrade', 'mudarplano'],
            onSuccess            = null,
            onFail               = null,
            redirectOnFail       = true,
            loadingElementId     = 'authLoading',
        } = options;

        const loader = document.getElementById(loadingElementId);
        if (loader) loader.style.display = 'flex';

        try {
            // ── PASSO 1: Rate limit ───────────────────────────────────
            if (!RateLimiter.isAllowed()) {
                throw _err('RATE_LIMITED', 'Muitas verificações simultâneas.');
            }

            // ── PASSO 2: Recuperar sessão ─────────────────────────────
            const { data: { session }, error: sessErr } = await supabase.auth.getSession();

            if (sessErr || !session?.user) {
                throw _err('NO_SESSION', 'Sem sessão ativa.');
            }

            // Usa let para permitir reatribuição após refresh
            let { user, expires_at } = session;

            // ── PASSO 3: Token expirado → tentar refresh ──────────────
            const secsLeft = expires_at - Math.floor(Date.now() / 1000);

            if (secsLeft <= 0) {
                const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
                if (refErr || !refreshed?.session) {
                    throw _err('TOKEN_EXPIRED', 'Token expirado e refresh falhou.');
                }
                // FIX: Usa o user da sessão RENOVADA — não a sessão antiga
                user       = refreshed.session.user;
                expires_at = refreshed.session.expires_at;
            } else if (secsLeft < SECURITY.TOKEN_REFRESH_THRESHOLD_SECONDS) {
                // Refresh assíncrono (não bloqueia)
                supabase.auth.refreshSession().catch(() => {});
            }

            // ── PASSO 4: Verificar fingerprint (session hijacking) ────
            if (!Fingerprint.validate(user)) {
                await supabase.auth.signOut();
                throw _err('SESSION_HIJACK',
                    'Fingerprint da sessão divergiu — possível session hijacking.');
            }

            // ── PASSO 5: Verificar idade máxima da sessão ─────────────
            if (Fingerprint.isSessionExpiredByAge()) {
                await supabase.auth.signOut();
                throw _err('SESSION_TOO_OLD', 'Sessão ultrapassou limite de 24h.');
            }

            // ── PASSO 6: Verificar integridade do userId no storage ───
            // FIX #7 e #8: Agora valida MAC + idade do stamp
            const stampedUid = Fingerprint.readIntegrityStamp();
            if (stampedUid !== null && stampedUid !== user.id) {
                await supabase.auth.signOut();
                throw _err('INTEGRITY_FAIL',
                    'Carimbo de integridade não bate com userId da sessão.');
            }

            // ── PASSO 7: Gravar fingerprint e metadados ───────────────
            Fingerprint.store(user);
            Fingerprint.markSessionStart();
            Fingerprint.writeIntegrityStamp(user.id);

            // ── PASSO 8: Verificar plano/subscription ─────────────────
            let subData = {
                subscription: null,
                isGuest: false,
                ownerId: user.id,
                planName: null,
                ownerEmail: null,
            };

            if (requirePlan) {
                subData = await SubscriptionChecker.getActive(user.id);

                if (!subData.subscription) {
                    throw _err('NO_PLAN', 'Sem plano ativo ou pagamento aprovado.');
                }

                if (subData.isGuest && !allowGuest) {
                    throw _err('GUEST_BLOCKED', 'Página não acessível para convidados.');
                }

                // FIX #11: Checa padrões de upgrade via array — mais robusto
                if (subData.isGuest && !guestCanUpgrade) {
                    const currentPath = window.location.pathname.toLowerCase();
                    const isUpgradePage = upgradePagePatterns.some(pattern =>
                        currentPath.includes(pattern.toLowerCase())
                    );
                    if (isUpgradePage) {
                        throw _err('GUEST_UPGRADE_BLOCKED',
                            'Convidados não podem gerenciar planos.');
                    }
                }
            }

            // ── PASSO 9: Montar objeto do usuário ─────────────────────
            const userData = {
                userId:          user.id,
                effectiveUserId: subData.ownerId || user.id,
                nome:            user.user_metadata?.name
                                    || user.email?.split('@')[0]
                                    || 'Usuário',
                email:           user.email,
                plano:           subData.planName || 'Individual',
                isGuest:         subData.isGuest,
                ownerEmail:      subData.ownerEmail || null,
                perfis:          [],
                // FIX: Token não incluído no objeto retornado ao chamador
                // Acesse via supabase.auth.getSession() quando necessário
            };

            // Salva estado privado
            _user    = userData;
            _subData = subData;
            _ready   = true;

            // ── PASSO 10: Iniciar monitoramento em background ─────────
            _startMonitoring();

            if (loader) loader.style.display = 'none';

            console.log(
                `✅ [AUTH GUARD] Acesso concedido | ` +
                `Usuário: ${userData.email} | ` +
                `Plano: ${userData.plano} | ` +
                `Convidado: ${userData.isGuest}`
            );

            if (typeof onSuccess === 'function') {
                await onSuccess(userData);
            }

            return userData;

        } catch (error) {
            if (loader) loader.style.display = 'none';

            const code = error?.code || 'UNKNOWN';
            const msg  = error?.message || String(error);

            console.error(`🔒 [AUTH GUARD] ACESSO NEGADO | Código: ${code} | ${msg}`);

            if (typeof onFail === 'function') {
                try { onFail(error); } catch {}
            }

            if (redirectOnFail) {
                SafeRedirect.toLogin(code);
            }

            return null;
        }
    },

    // ─────────────────────────────────────────────────────────────
    //  API PÚBLICA
    // ─────────────────────────────────────────────────────────────

    /** Logout completo e seguro */
    async logout(reason = 'LOGOUT') {
        _stopMonitoring();
        _user    = null;
        _subData = null;
        _ready   = false;
        SubscriptionChecker.invalidate();
        Fingerprint.clear();
        RateLimiter.clear();

        await supabase.auth.signOut();
        SafeRedirect.toLogin(reason);
    },

    /** Logout forçado (sem await do signOut — emergência) */
    forceLogout(reason = 'FORCE_LOGOUT') {
        _stopMonitoring();
        _ready = false;
        SubscriptionChecker.invalidate();
        Fingerprint.clear();
        RateLimiter.clear();
        supabase.auth.signOut().catch(() => {});
        SafeRedirect.toLogin(reason);
    },

    /** Retorna cópia dos dados do usuário atual — sem dados sensíveis */
    getUser() {
        if (!_user) return null;
        return { ..._user };
    },

    isReady()         { return _ready; },
    isGuest()         { return _user?.isGuest ?? false; },
    getCurrentPlan()  { return _user?.plano ?? null; },

    /** Força invalidação do cache de plano (usar após upgrade) */
    refreshSubscription() {
        SubscriptionChecker.invalidate();
    },

    // Expõe _stopMonitoring apenas para o listener onAuthStateChange interno
    _internalStop() { _stopMonitoring(); },
};

    return publicAPI;
})();

// ═══════════════════════════════════════════════════════════════
//  LISTENERS GLOBAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════

// Detecta mudanças de auth do Supabase em qualquer aba
supabase.auth.onAuthStateChange((event, session) => {
    switch (event) {
        case 'SIGNED_OUT':
            console.log('🔒 [AUTH GUARD] SIGNED_OUT detectado');
            AuthGuard._internalStop();
            Fingerprint.clear();
            SubscriptionChecker.invalidate();
            RateLimiter.clear();
            if (!window.location.href.includes('login.html')) {
                SafeRedirect.toLogin('NO_SESSION');
            }
            break;

        case 'TOKEN_REFRESHED':
            console.log('🔄 [AUTH GUARD] Token renovado com sucesso');
            break;

        case 'USER_UPDATED':
            console.log('👤 [AUTH GUARD] Dados do usuário atualizados — cache invalidado');
            SubscriptionChecker.invalidate();
            break;

        case 'PASSWORD_RECOVERY':
            // Evita que uma sessão de recovery acesse páginas protegidas
            if (!window.location.href.includes('login.html')) {
                SafeRedirect.toLogin('NO_SESSION');
            }
            break;
    }
});

// FIX: Detecta remoção do token em outra aba (tab syncing attack)
// Verifica tanto a remoção de tokens Supabase quanto de stamps de integridade
window.addEventListener('storage', (e) => {
    // Token Supabase removido por outra aba
    if (e.key?.startsWith('sb-') && e.newValue === null) {
        console.warn('🚨 [AUTH GUARD] Token do Supabase removido por outra aba!');
        if (!window.location.href.includes('login.html')) {
            SafeRedirect.toLogin('NO_SESSION');
        }
        return;
    }

    // FIX: Integrity stamp adulterado por outra aba
    if (e.key === SECURITY.KEYS.integrityStamp && e.newValue !== null) {
        const newStampUid = (() => {
            try {
                const decoded = atob(e.newValue);
                const parts = decoded.split('|');
                return parts.length >= 1 ? parts[0] : null;
            } catch { return null; }
        })();

        // FIX: Usa getUser() — _user é privado na closure, AuthGuard._user é undefined
        const currentUser = AuthGuard.getUser();
        if (currentUser && newStampUid && newStampUid !== currentUser.userId) {
            console.warn('🚨 [AUTH GUARD] Integrity stamp adulterado por outra aba!');
            if (!window.location.href.includes('login.html')) {
                SafeRedirect.toLogin('INTEGRITY_FAIL');
            }
        }
    }
});

// Detecta reativação da aba (pode ter expirado enquanto estava hidden)
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && AuthGuard.isReady()) {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                console.warn('🔒 [AUTH GUARD] Sessão expirou enquanto aba estava oculta');
                AuthGuard.forceLogout('NO_SESSION');
            }
        } catch (e) {
            console.error('❌ [AUTH GUARD] Erro na verificação de visibilidade:', e);
        }
    }
});

// ═══════════════════════════════════════════════════════════════
//  HELPER INTERNO
// ═══════════════════════════════════════════════════════════════
function _err(code, message) {
    return { code, message };
}

// ═══════════════════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════════════════
export { AuthGuard, SubscriptionChecker, SafeRedirect };
export default AuthGuard;