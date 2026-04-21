// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from '../services/supabase-client.js?v=2';

// ========== CONSTANTES PRIVADAS ==========
const MAX_PAYLOAD_BYTES  = 4_900_000;
const MAX_PROFILES       = 200;
const MAX_QUEUE_DEPTH    = 3;
const RPC_TIMEOUT_MS     = 15_000;
const DEBOUNCE_DELAY_MS  = 800;
const IS_DEV             = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const SUPABASE_BEACON_URL = `${window.location.origin}/api/save-user-data`;

// ========== VALIDADORES ==========

// ✅ Regex segura para IDs string (path traversal prevention)
const PROFILE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validador ESTRITO — usado apenas no SAVE.
 * Impede que dados malformados ou injetados cheguem ao banco.
 */
function validateProfileShape(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return 'perfil deve ser um objeto';
    }
    const isIntId = Number.isInteger(profile.id) && profile.id > 0;
    const isStrId = typeof profile.id === 'string' && profile.id.trim() !== '';
    if (!isIntId && !isStrId) {
        return 'profile.id ausente ou inválido';
    }
    if (isStrId) {
        const trimmedId = profile.id.trim();
        if (!PROFILE_ID_REGEX.test(trimmedId)) {
            return 'profile.id possui caracteres inválidos (use apenas letras, números, hífen e underscore, máx. 64 chars)';
        }
    }
    if ('balance' in profile && !Number.isFinite(profile.balance)) {
        return 'profile.balance deve ser um número finito (NaN e Infinity não são aceitos)';
    }
    if ('name' in profile && (typeof profile.name !== 'string' || profile.name.length > 256)) {
        return 'profile.name inválido ou muito longo';
    }
    return null;
}

/**
 * Validador LENIENTE — usado apenas no LOAD.
 * Dados vindos do banco já foram validados no save. Ser estrito aqui
 * causa rejeição de perfis legítimos salvos antes da migração de segurança
 * (ex: id inteiro SERIAL, id ausente em dados antigos, etc).
 * Apenas descartamos o que claramente não é um objeto.
 */
function validateProfileShapeForLoad(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return 'perfil deve ser um objeto';
    }
    // ✅ Sem validação de id no load — dados do banco são confiáveis.
    //    A validação estrita ocorre exclusivamente no save.
    return null;
}

/**
 * Valida array completo de perfis — usado antes de qualquer save.
 */
function validateProfilesArray(profiles) {
    if (!Array.isArray(profiles)) {
        return { ok: false, error: 'profilesData não é um array' };
    }
    if (profiles.length > MAX_PROFILES) {
        return { ok: false, error: `número de perfis (${profiles.length}) excede o limite de ${MAX_PROFILES}` };
    }
    for (let i = 0; i < profiles.length; i++) {
        const err = validateProfileShape(profiles[i]);
        if (err) return { ok: false, error: `perfil [${i}] inválido: ${err}` };
    }
    return { ok: true };
}

// ========== CLASSE ==========
class DataManager {

    // ── Private class fields — invisíveis via console, XSS e extensões ──────
    #userId       = null;
    #userEmail    = null;
    #isSaving     = false;
    #lastSaveTime = null;
    #saveQueue    = Promise.resolve();
    #queueDepth   = 0;
    #debounceTimer   = null;
    #debounceResolve = null;
    #debouncePending = null;

    // ── Getter público — somente leitura ─────────────────────────────────────
    get userId() {
        return this.#userId;
    }

    async #getAuthToken() {
        const { data: { session } } = await supabase.auth.getSession();
        return session?.access_token ?? null;
    }

    // ============================ //
    //        INICIALIZAÇÃO         //
    // ============================ //

    async initialize(userId, userEmail) {
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            console.error('❌ [DATA-MANAGER] userId inválido na inicialização — deve ser string não-vazia');
            return false;
        }
        if (!userEmail || typeof userEmail !== 'string' || userEmail.trim() === '') {
            console.error('❌ [DATA-MANAGER] userEmail inválido na inicialização — deve ser string não-vazia');
            return false;
        }

        // ✅ Define ANTES de qualquer await para evitar race conditions
        this.#userId    = userId.trim();
        this.#userEmail = userEmail.trim();

        if (IS_DEV) {
            console.log('📦 [DATA-MANAGER] Inicializado com sucesso.');
            console.log('👤 UserID definido:', !!this.#userId);
            console.log('📧 Email definido:',  !!this.#userEmail);
        }

        return true;
    }

    /**
     * Limpa estado interno ao deslogar.
     * Cancela debounce pendente antes de limpar.
     */
    reset() {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer   = null;
            this.#debouncePending = null;
            if (this.#debounceResolve) {
                this.#debounceResolve(false);
                this.#debounceResolve = null;
            }
        }
        this.#userId       = null;
        this.#userEmail    = null;
        this.#isSaving     = false;
        this.#lastSaveTime = null;
        this.#queueDepth   = 0;
        this.#saveQueue    = Promise.resolve();
        if (IS_DEV) console.log('🔒 [DATA-MANAGER] Estado limpo — usuário deslogado');
    }

    // ============================ //
    //     CARREGAR DADOS           //
    // ============================ //

    async loadUserData() {
        try {
            if (!this.#userId) {
                console.error('❌ [DATA-MANAGER] userId não definido — faça initialize() primeiro');
                return this.#emptyStructure();
            }

            if (IS_DEV) {
                console.log('📥 [DATA-MANAGER] Carregando dados do Supabase...');
                console.log('🔑 [DATA-MANAGER] User ID:', this.#userId);
            }

            const token = await this.#getAuthToken();
            if (!token) {
                console.error('❌ [DATA-MANAGER] Sessão inativa — faça login novamente');
                return this.#emptyStructure();
            }

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
            let resp;
            try {
                resp = await fetch('/api/get-user-data', {
                    headers: { 'Authorization': `Bearer ${token}` },
                    signal,
                });
            } finally {
                cleanup();
            }

            // Proxy indisponível — retorna estrutura vazia SEM sobrescrever o banco.
            // O registro existe no banco; o erro é temporário (deploy, proxy, rede).
            if (!resp.ok) {
                if (resp.status === 404) {
                    // Pode ser um usuário genuinamente novo — retorna vazio.
                    // O upsert em saveUserData criará o registro no primeiro save.
                    if (IS_DEV) console.log('⚠️ [DATA-MANAGER] Nenhum dado encontrado (404)');
                } else {
                    console.error(`❌ [DATA-MANAGER] Erro ao carregar: HTTP ${resp.status}`);
                }
                return this.#emptyStructure();
            }

            const result = await resp.json();

            if (!result?.data_json) {
                console.warn('⚠️ [DATA-MANAGER] data_json vazio, retornando estrutura padrão');
                return this.#emptyStructure();
            }

            const userData = result.data_json;

            if (!Array.isArray(userData.profiles)) userData.profiles = [];
            if (!userData.version)                  userData.version  = '1.0';

            // ✅ CORREÇÃO CRÍTICA: usa validador LENIENTE no load.
            //    O validador estrito (validateProfileShape) rejeita perfis legítimos
            //    já gravados no banco (ex: id inteiro SERIAL, dados antes da migração).
            //    No load, apenas descartamos o que claramente não é um objeto.
            //    A validação estrita ocorre EXCLUSIVAMENTE no save.
            const validProfiles = [];
            for (let i = 0; i < userData.profiles.length; i++) {
                const err = validateProfileShapeForLoad(userData.profiles[i]);
                if (err) {
                    console.warn(`⚠️ [DATA-MANAGER] Perfil [${i}] ignorado no load: ${err}`);
                } else {
                    validProfiles.push(userData.profiles[i]);
                }
            }
            userData.profiles = validProfiles;

            if (IS_DEV) {
                console.log('✅ [DATA-MANAGER] Dados carregados:', {
                    profiles: userData.profiles.length,
                    version:  userData.version
                });
            }

            return userData;

        } catch (err) {
            if (err?.name === 'AbortError') {
                console.error('❌ [DATA-MANAGER] Timeout ao carregar dados (>15s)');
            } else {
                console.error('❌ [DATA-MANAGER] Erro crítico ao carregar dados:', err?.message ?? err);
            }
            return this.#emptyStructure();
        }
    }

    // ============================ //
    //     SALVAR (com debounce)    //
    // ============================ //

    async saveUserData(profilesData) {
        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [DATA-MANAGER] ${validation.error} — save rejeitado antes da fila`);
            return false;
        }

        // ✅ Debounce: coalescing de saves rápidos → apenas o último chega ao banco
        return new Promise((resolve) => {
            this.#debouncePending = profilesData;

            if (this.#debounceTimer !== null) {
                if (this.#debounceResolve) this.#debounceResolve(false);
                this.#debounceResolve = resolve;
                clearTimeout(this.#debounceTimer);
            } else {
                this.#debounceResolve = resolve;
            }

            this.#debounceTimer = setTimeout(() => {
                this.#debounceTimer = null;
                const pendingData    = this.#debouncePending;
                const pendingResolve = this.#debounceResolve;
                this.#debouncePending  = null;
                this.#debounceResolve  = null;

                this.#enqueue(() => this.#doSaveUserData(pendingData))
                    .then(pendingResolve)
                    .catch(() => pendingResolve(false));

            }, DEBOUNCE_DELAY_MS);
        });
    }

    /**
     * Save imediato — ignora o debounce.
     * Use em situações urgentes: beforeunload, fechar modal, troca de aba.
     */
    async saveUserDataNow(profilesData) {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
            if (this.#debounceResolve) {
                this.#debounceResolve(false);
                this.#debounceResolve = null;
            }
            this.#debouncePending = null;
        }
        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [DATA-MANAGER] ${validation.error} — saveNow rejeitado`);
            return false;
        }
        return this.#enqueue(() => this.#doSaveUserData(profilesData));
    }

    async #doSaveUserData(profilesData) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] Não é possível salvar: UserID não definido');
            return false;
        }

        // TEMP DIAG
        console.warn('💾 [SAVE-DIAG] doSave iniciado. Perfis:', profilesData?.length, '| userId:', !!this.#userId);

        this.#isSaving = true;

        try {
            // Deep clone — imunidade a mutação externa durante operações assíncronas
            const safeProfiles = structuredClone(profilesData);

            // ✅ userId e email NÃO vão no payload — servidor identifica via JWT.
            //    Apenas dados estruturais são enviados ao banco.
            const dataToSave = {
                version:  '1.0',
                profiles: safeProfiles,
                metadata: {
                    lastSync:      new Date().toISOString(),
                    totalProfiles: safeProfiles.length
                }
            };

            let serialized;
            try {
                serialized = JSON.stringify(dataToSave);
            } catch (serErr) {
                console.error('❌ [DATA-MANAGER] Falha ao serializar dados:', serErr?.message);
                return false;
            }

            if (serialized.length > MAX_PAYLOAD_BYTES) {
                console.error('❌ [DATA-MANAGER] Payload excede 4.9MB — salvamento abortado');
                return false;
            }

            if (IS_DEV) {
                console.log('💾 [DATA-MANAGER] Salvando dados...');
                console.log('📊 Perfis:', safeProfiles.length);
                console.log('📦 Tamanho:', serialized.length, 'bytes');
            }

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
            let saveResp;
            try {
                const saveToken = await this.#getAuthToken();
                saveResp = await fetch('/api/save-user-data', {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': saveToken ? `Bearer ${saveToken}` : '',
                    },
                    body:   serialized,
                    signal,
                });
            } finally {
                cleanup();
            }

            // TEMP DIAG
            console.warn('💾 [SAVE-DIAG] POST status:', saveResp.status);

            if (!saveResp.ok) {
                const errText = await saveResp.text().catch(() => '');
                console.error('❌ [DATA-MANAGER] Erro ao salvar no banco:', saveResp.status, errText);
                return false;
            }

            this.#lastSaveTime = new Date();
            console.warn('✅ [SAVE-DIAG] Save OK às', this.#lastSaveTime.toLocaleTimeString());

            return true;

        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro crítico ao salvar:', err?.message ?? err);
            return false;

        } finally {
            this.#isSaving = false;
        }
    }

    // ============================ //
    //   SALVAR PERFIL ESPECÍFICO   //
    // ============================ //

    async saveProfileData(dadosPerfil) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] saveProfileData: UserID não definido — faça initialize() primeiro');
            return false;
        }
        const validationError = validateProfileShape(dadosPerfil);
        if (validationError) {
            console.error('❌ [DATA-MANAGER] Perfil inválido:', validationError);
            return false;
        }
        return this.#enqueue(() => this.#doSaveProfileData(dadosPerfil));
    }

    async #doSaveProfileData(dadosPerfil) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] Não é possível salvar perfil: UserID não definido');
            return false;
        }

        let safeProfile;
        try {
            safeProfile = structuredClone(dadosPerfil);
        } catch (cloneErr) {
            console.error('❌ [DATA-MANAGER] Falha ao clonar perfil:', cloneErr?.message);
            return false;
        }

        try {
            // Carrega o estado atual, atualiza apenas o perfil específico, salva tudo
            const userData = await this.loadUserData();

            const idx = userData.profiles.findIndex(
                p => String(p.id) === String(safeProfile.id)
            );

            if (idx !== -1) {
                userData.profiles[idx] = safeProfile;
            } else {
                userData.profiles.push(safeProfile);
            }

            // ✅ Chama diretamente #doSaveUserData (já estamos dentro da fila)
            return await this.#doSaveUserData(userData.profiles);

        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro ao salvar perfil:', err?.message ?? err);
            return false;
        }
    }

    // ============================ //
    //  SALVAMENTO IMEDIATO BEACON  //
    // ============================ //

    saveImmediate(profilesData) {
        if (!this.#userId) return false;

        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
            if (this.#debounceResolve) {
                this.#debounceResolve(false);
                this.#debounceResolve = null;
            }
            this.#debouncePending = null;
        }

        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [BEACON] ${validation.error} — beacon cancelado`);
            return false;
        }

        let payload;
        try {
            payload = JSON.stringify({ profiles: profilesData });
        } catch (serErr) {
            console.error('❌ [BEACON] Falha ao serializar:', serErr?.message);
            return false;
        }

        if (payload.length > 60_000) {
            console.warn('⚠️ [BEACON] Payload excede 60KB — beacon cancelado');
            return false;
        }

        const sent = navigator.sendBeacon(
            SUPABASE_BEACON_URL,
            new Blob([payload], { type: 'application/json' })
        );

        if (IS_DEV) {
            console.log(sent
                ? '✅ [BEACON] Enfileirado com sucesso'
                : '❌ [BEACON] Browser recusou enfileirar beacon'
            );
        }

        return sent;
    }

    // ============================ //
    //     EXPORTAR BACKUP LOCAL    //
    // ============================ //

    async exportUserData() {
        let url;
        try {
            const data = await this.loadUserData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            url = URL.createObjectURL(blob);

            const safeEmail = (this.#userEmail ?? 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
            const dateStr   = new Date().toISOString().slice(0, 10);

            const a = document.createElement('a');
            a.href     = url;
            a.download = `granaevo_backup_${safeEmail}_${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            if (IS_DEV) console.log('✅ Backup exportado com sucesso!');

        } catch (err) {
            console.error('❌ [EXPORT] Falha ao exportar backup:', err?.message ?? err);
        } finally {
            if (url) URL.revokeObjectURL(url);
        }
    }

    // ============================ //
    //    STATUS (sem dados PII)    //
    // ============================ //

    getStatus() {
        return Object.freeze({
            initialized:  !!this.#userId,
            isSaving:     this.#isSaving,
            queueDepth:   this.#queueDepth,
            debouncing:   this.#debounceTimer !== null,
            lastSaveTime: this.#lastSaveTime
        });
    }

    // ============================ //
    //     PRIVADOS — UTILITÁRIOS   //
    // ============================ //

    #enqueue(fn) {
        if (this.#queueDepth >= MAX_QUEUE_DEPTH) {
            console.warn(`⚠️ [DATA-MANAGER] Fila cheia (${this.#queueDepth}/${MAX_QUEUE_DEPTH}) — save descartado`);
            return Promise.resolve(false);
        }
        this.#queueDepth++;
        this.#saveQueue = this.#saveQueue
            .then(() => fn())
            .finally(() => { this.#queueDepth--; });
        return this.#saveQueue;
    }

    #makeAbortSignal(timeoutMs) {
        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), timeoutMs);
        return {
            signal:  controller.signal,
            cleanup: () => clearTimeout(timer)
        };
    }

    async #createInitialRecord() {
        const initialData = this.#emptyStructure();
        try {
            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
            let resp;
            try {
                const initToken = await this.#getAuthToken();
                resp = await fetch('/api/save-user-data', {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': initToken ? `Bearer ${initToken}` : '',
                    },
                    body:   JSON.stringify({ profiles: [] }),
                    signal,
                });
            } finally {
                cleanup();
            }
            if (IS_DEV) {
                if (resp.ok) console.log('✅ [DATA-MANAGER] Registro inicial criado com sucesso!');
                else         console.error('❌ [DATA-MANAGER] Erro ao criar registro inicial:', resp.status);
            }
        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro crítico ao criar registro:', err?.message ?? err);
        }
        return initialData;
    }

    #emptyStructure() {
        return { version: '1.0', profiles: [] };
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();

// ✅ Exposição global APENAS em desenvolvimento
if (IS_DEV) {
    window.dataManager = dataManagerInstance;
    window.debugDataManager = () => {
        console.log('=== DATA MANAGER STATUS ===');
        console.log(dataManagerInstance.getStatus());
        console.log('==========================');
    };
}

export const dataManager = dataManagerInstance;