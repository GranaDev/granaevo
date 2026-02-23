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

    // Rate limiter: máx 15 chamadas por minuto por aba
    RATE_LIMIT_MAX: 15,
    RATE_LIMIT_WINDOW_MS: 60 * 1000,

    // Onde redirecionar quando o guard bloqueia
    LOGIN_URL: 'login.html',

    // Chaves usadas no sessionStorage (prefixo ofuscado)
    KEYS: {
        fingerprint:    '_ge_fp',
        sessionStart:   '_ge_ss',
        lastCheck:      '_ge_lc',
        integrityStamp: '_ge_is',
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: RATE LIMITER
//  Previne flood de requisições de verificação (DoS interno)
// ═══════════════════════════════════════════════════════════════
const RateLimiter = (() => {
    const log = [];

    return {
        isAllowed() {
            const now = Date.now();
            const windowStart = now - SECURITY.RATE_LIMIT_WINDOW_MS;

            // Expira entradas antigas
            while (log.length && log[0] < windowStart) log.shift();

            if (log.length >= SECURITY.RATE_LIMIT_MAX) {
                console.warn('🚨 [AUTH GUARD] Rate limit atingido — possível flood');
                return false;
            }

            log.push(now);
            return true;
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
     * Grava um "carimbo de integridade" baseado no userId + timestamp.
     * Detecta se alguém trocou o userId no sessionStorage externamente.
     */
    writeIntegrityStamp(userId) {
        const stamp = btoa(`${userId}|${Date.now()}`);
        sessionStorage.setItem(SECURITY.KEYS.integrityStamp, stamp);
    },

    readIntegrityStamp() {
        try {
            const stamp = sessionStorage.getItem(SECURITY.KEYS.integrityStamp);
            if (!stamp) return null;
            const decoded = atob(stamp);
            const [uid] = decoded.split('|');
            return uid;
        } catch {
            return null;
        }
    },

    clear() {
        Object.values(SECURITY.KEYS).forEach(k => sessionStorage.removeItem(k));
    },
};

// ═══════════════════════════════════════════════════════════════
//  MÓDULO: SUBSCRIPTION CHECKER
//  Verifica se o usuário (ou o dono dele) tem plano ativo válido.
//  Cache de 5 min para não martelas o Supabase.
// ═══════════════════════════════════════════════════════════════
const SubscriptionChecker = {
    _cache: null,
    _cacheUserId: null,
    _cacheExpiry: 0,
    CACHE_TTL: 5 * 60 * 1000,

    _isExpired() {
        return Date.now() > this._cacheExpiry;
    },

    async getActive(userId) {
        // Retorna cache se válido e for o mesmo user
        if (this._cache && !this._isExpired() && this._cacheUserId === userId) {
            return this._cache;
        }

        const empty = { subscription: null, isGuest: false, ownerId: null, planName: null, ownerEmail: null };

        try {
            // ── 1. Verifica assinatura própria ─────────────────────────
            const { data: ownSub, error: ownErr } = await supabase
                .from('subscriptions')
                .select('id, plans(name), is_active, payment_status, expires_at')
                .eq('user_id', userId)
                .eq('payment_status', 'approved')
                .eq('is_active', true)
                .maybeSingle();

            if (!ownErr && ownSub) {
                // Checa expiração explícita se campo exists
                if (ownSub.expires_at && new Date(ownSub.expires_at) < new Date()) {
                    console.warn('⏰ [AUTH GUARD] Assinatura com expires_at vencido');
                    return empty;
                }

                return this._setCache({
                    subscription: ownSub,
                    isGuest: false,
                    ownerId: userId,
                    planName: ownSub.plans?.name || 'Individual',
                    ownerEmail: null,
                }, userId);
            }

            // ── 2. Verifica se é convidado (account_members) ──────────
            const { data: member, error: memErr } = await supabase
                .from('account_members')
                .select('id, owner_user_id, owner_email, is_active')
                .eq('member_user_id', userId)
                .eq('is_active', true)
                .maybeSingle();

            if (memErr || !member) return empty;

            // ── 3. Verifica assinatura do dono ────────────────────────
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

            return this._setCache({
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

    _setCache(data, userId) {
        this._cache = data;
        this._cacheUserId = userId;
        this._cacheExpiry = Date.now() + this.CACHE_TTL;
        return data;
    },

    invalidate() {
        this._cache = null;
        this._cacheUserId = null;
        this._cacheExpiry = 0;
    },
};

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

        if (reason) console.log(`🔒 [AUTH GUARD] Redirect → ${url} | Motivo: ${reason}`);

        // Limpeza antes de sair
        Fingerprint.clear();
        SubscriptionChecker.invalidate();

        // replace() impede o botão "voltar" de retornar à página protegida
        window.location.replace(url);
    },

    toLogin(reason = '') {
        const params = reason ? `?erro=${encodeURIComponent(reason)}` : '';
        this.to(SECURITY.LOGIN_URL + params, reason);
    },
};

// ═══════════════════════════════════════════════════════════════
//  GUARD PRINCIPAL
// ═══════════════════════════════════════════════════════════════
const AuthGuard = {
    _ready: false,
    _user: null,
    _subData: null,
    _monitorTimer: null,

    /**
     * ┌─────────────────────────────────────────────────────────┐
     * │  AuthGuard.protect(options)                             │
     * │  Chame no topo de CADA página protegida.                │
     * │  Retorna o objeto `userData` no sucesso, null na falha. │
     * └─────────────────────────────────────────────────────────┘
     *
     * @param {Object} options
     * @param {boolean}  options.requirePlan       - Exige plano ativo       (default: true)
     * @param {boolean}  options.allowGuest         - Permite convidados      (default: true)
     * @param {boolean}  options.guestCanUpgrade    - Convidado pode acessar upgrade? (default: false)
     * @param {Function} options.onSuccess          - callback(userData)
     * @param {Function} options.onFail             - callback(errorObj) antes do redirect
     * @param {boolean}  options.redirectOnFail     - Redirecionar auto?      (default: true)
     * @param {string}   options.loadingElementId   - ID do spinner de loading
     */
    async protect(options = {}) {
        const {
            requirePlan       = true,
            allowGuest        = true,
            guestCanUpgrade   = false,
            onSuccess         = null,
            onFail            = null,
            redirectOnFail    = true,
            loadingElementId  = 'authLoading',
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

            const { user, access_token, expires_at } = session;

            // ── PASSO 3: Token expirado → tentar refresh ──────────────
            const secsLeft = expires_at - Math.floor(Date.now() / 1000);

            if (secsLeft <= 0) {
                const { data: refreshed, error: refErr } = await supabase.auth.refreshSession();
                if (refErr || !refreshed?.session) {
                    throw _err('TOKEN_EXPIRED', 'Token expirado e refresh falhou.');
                }
                // Usa a nova sessão
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
            const stampedUid = Fingerprint.readIntegrityStamp();
            if (stampedUid && stampedUid !== user.id) {
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

                // Convidado tentando acessar upgrade sem permissão
                if (subData.isGuest && !guestCanUpgrade &&
                    window.location.pathname.includes('atualizarplano')) {
                    throw _err('GUEST_UPGRADE_BLOCKED',
                        'Convidados não podem gerenciar planos.');
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
                _token:          access_token,  // Interno — não expor ao DOM
            };

            // Salva estado interno
            this._user    = userData;
            this._subData = subData;
            this._ready   = true;

            // ── PASSO 10: Iniciar monitoramento em background ─────────
            this._startMonitoring();

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
                const reasonMap = {
                    NO_SESSION:           'login',
                    TOKEN_EXPIRED:        'token_expirado',
                    SESSION_HIJACK:       'sessao_invalida',
                    SESSION_TOO_OLD:      'sessao_expirada',
                    INTEGRITY_FAIL:       'integridade_falhou',
                    RATE_LIMITED:         'muitas_tentativas',
                    NO_PLAN:              'sem_plano',
                    GUEST_BLOCKED:        'acesso_negado',
                    GUEST_UPGRADE_BLOCKED:'sem_permissao',
                };
                SafeRedirect.toLogin(reasonMap[code] || 'erro');
            }

            return null;
        }
    },

    // ─────────────────────────────────────────────────────────────
    //  MONITORAMENTO CONTÍNUO
    //  Re-verifica sessão e plano periodicamente em background
    // ─────────────────────────────────────────────────────────────
    _startMonitoring() {
        if (this._monitorTimer) return; // Já rodando

        this._monitorTimer = setInterval(async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();

                if (!session) {
                    console.warn('🔒 [AUTH GUARD] Sessão desapareceu durante o uso!');
                    this.forceLogout('sessao_encerrada_remotamente');
                    return;
                }

                // Invalidar cache e re-checar plano
                SubscriptionChecker.invalidate();
                const sub = await SubscriptionChecker.getActive(session.user.id);

                if (!sub.subscription) {
                    console.warn('🔒 [AUTH GUARD] Plano revogado durante a sessão!');
                    this.forceLogout('plano_revogado');
                }
            } catch (e) {
                console.error('❌ [AUTH GUARD] Erro no monitoramento:', e);
            }
        }, SECURITY.SESSION_POLL_INTERVAL);
    },

    _stopMonitoring() {
        if (this._monitorTimer) {
            clearInterval(this._monitorTimer);
            this._monitorTimer = null;
        }
    },

    // ─────────────────────────────────────────────────────────────
    //  API PÚBLICA
    // ─────────────────────────────────────────────────────────────

    /** Logout completo e seguro */
    async logout(reason = 'logout_voluntario') {
        this._stopMonitoring();
        this._user    = null;
        this._subData = null;
        this._ready   = false;
        SubscriptionChecker.invalidate();
        Fingerprint.clear();

        await supabase.auth.signOut();
        SafeRedirect.toLogin(reason);
    },

    /** Logout forçado (sem await do signOut — emergência) */
    forceLogout(reason = 'logout_forcado') {
        this._stopMonitoring();
        this._ready = false;
        SubscriptionChecker.invalidate();
        Fingerprint.clear();
        supabase.auth.signOut().catch(() => {});
        SafeRedirect.toLogin(reason);
    },

    /** Retorna cópia dos dados do usuário atual */
    getUser() {
        if (!this._user) return null;
        const { _token, ...safe } = this._user; // Remove token do retorno público
        return { ...safe };
    },

    isReady()         { return this._ready; },
    isGuest()         { return this._user?.isGuest ?? false; },
    getCurrentPlan()  { return this._user?.plano ?? null; },

    /** Força invalidação do cache de plano (usar após upgrade) */
    refreshSubscription() {
        SubscriptionChecker.invalidate();
    },
};

// ═══════════════════════════════════════════════════════════════
//  LISTENERS GLOBAIS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════

// Detecta mudanças de auth do Supabase em qualquer aba
supabase.auth.onAuthStateChange((event, session) => {
    switch (event) {
        case 'SIGNED_OUT':
            console.log('🔒 [AUTH GUARD] SIGNED_OUT detectado');
            AuthGuard._stopMonitoring();
            Fingerprint.clear();
            SubscriptionChecker.invalidate();
            if (!window.location.href.includes('login.html')) {
                SafeRedirect.toLogin('signed_out');
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
                SafeRedirect.toLogin('password_recovery_session');
            }
            break;
    }
});

// Detecta remoção do token em outra aba (tab syncing attack)
window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('sb-') && e.newValue === null) {
        console.warn('🚨 [AUTH GUARD] Token do Supabase removido por outra aba!');
        if (!window.location.href.includes('login.html')) {
            SafeRedirect.toLogin('token_removido_outra_aba');
        }
    }
});

// Detecta reativação da aba (pode ter expirado enquanto estava hidden)
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && AuthGuard.isReady()) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            console.warn('🔒 [AUTH GUARD] Sessão expirou enquanto aba estava oculta');
            AuthGuard.forceLogout('sessao_expirou_aba_oculta');
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