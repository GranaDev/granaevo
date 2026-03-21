// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from './supabase-client.js';

// ========== CONSTANTES PRIVADAS (module-scope, inacessíveis externamente) ==========
const MAX_PAYLOAD_BYTES   = 4_900_000; // 4.9MB — margem antes do limite RPC (5MB)
const MAX_PROFILES        = 200;       // Limite de quantidade de perfis por save
const MAX_QUEUE_DEPTH     = 3;         // Máximo de saves enfileirados simultâneos (anti-flood)
const RPC_TIMEOUT_MS      = 15_000;    // 15s — aborta se Supabase travar
const DEBOUNCE_DELAY_MS   = 800;       // Coalescing: agrupa saves rápidos em 1 único RPC
const IS_DEV              = ['localhost', '127.0.0.1'].includes(window.location.hostname);
// ✅ FIX: Proxy interno — oculta o endpoint real da Edge Function.
//    O endpoint direto do Supabase NÃO deve ser exposto no front-end:
//    qualquer pessoa poderia descobri-lo e fazer flood mesmo sem autenticação.
//    O proxy /api/save-user-data recebe a requisição, aplica rate limit / firewall
//    e só então repassa internamente para a Edge Function.
const SUPABASE_BEACON_URL = `${window.location.origin}/api/save-user-data`;

// ========== VALIDADORES INTERNOS ==========

// ✅ FIX: Regex que restringe profile.id a caracteres seguros.
//    Sem isso, um atacante poderia enviar IDs como "../../etc/passwd" ou
//    o ID de outro usuário — causando path traversal ou overwrite de perfil errado
//    se o backend usar o ID diretamente para localizar registros no JSON.
//    Aceita: letras, números, hífen e underscore. Máximo 64 caracteres.
const PROFILE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Deep validation mínima do objeto de perfil.
 * Garante que campos críticos têm o tipo esperado antes de enviar ao servidor.
 * Não substitui validação server-side, mas evita que dados claramente
 * malformados cheguem até o RPC.
 *
 * @param {unknown} profile
 * @returns {string|null} Mensagem de erro, ou null se válido
 */
function validateProfileShape(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return 'perfil deve ser um objeto';
    }

    // ✅ CORREÇÃO: aceita tanto UUID string quanto inteiro positivo (SERIAL do Supabase).
    //    Antes: typeof profile.id !== 'string' rejeitava qualquer ID numérico,
    //    descartando TODOS os perfis salvos com SERIAL/BIGSERIAL no banco.
    //    Agora: inteiro positivo OU string não-vazia são aceitos.
    const isIntId  = Number.isInteger(profile.id) && profile.id > 0;
    const isStrId  = typeof profile.id === 'string' && profile.id.trim() !== '';

    if (!isIntId && !isStrId) {
        return 'profile.id ausente ou inválido';
    }

    // ✅ Para IDs string: normaliza e valida formato seguro (bloqueia path traversal).
    //    Para IDs inteiros: converte para string apenas para a validação de regex,
    //    sem alterar o tipo original no objeto (evita quebrar comparações === downstream).
    if (isStrId) {
        const trimmedId = profile.id.trim();

        // PROFILE_ID_REGEX: [a-zA-Z0-9_-]{1,64}
        // UUIDs passam (apenas alfanumérico + hífen).
        // IDs com path traversal ("../../etc"), separadores ("/", "\") ou
        // caracteres de controle são bloqueados aqui.
        if (!PROFILE_ID_REGEX.test(trimmedId)) {
            return 'profile.id possui caracteres inválidos (use apenas letras, números, hífen e underscore, máx. 64 chars)';
        }

        // Normaliza string (remove espaços nas bordas)
        profile.id = trimmedId;
    }
    // IDs inteiros não precisam de normalização — são imunes a path traversal por natureza.

    // typeof NaN === 'number' é true em JS — Number.isFinite é obrigatório aqui.
    if ('balance' in profile && !Number.isFinite(profile.balance)) {
        return 'profile.balance deve ser um número finito (NaN e Infinity não são aceitos)';
    }
    if ('name' in profile && (typeof profile.name !== 'string' || profile.name.length > 256)) {
        return 'profile.name inválido ou muito longo';
    }
    return null; // válido
}

/**
 * Valida um array inteiro de perfis.
 * @param {unknown[]} profiles
 * @returns {{ ok: boolean, error?: string }}
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

    // Private class fields — invisíveis via console, Object.keys, extensões, XSS
    #userId       = null;
    #userEmail    = null;
    #isSaving     = false;
    #lastSaveTime = null;
get userId() {
    return this.#userId;
}

    // Fila Promise chain — sem polling, sem setInterval, sem CPU waste.
    // saveUserData e saveProfileData compartilham a mesma fila (nunca paralelas).
    #saveQueue  = Promise.resolve();
    #queueDepth = 0;

    // Debounce: coalescing de saves rápidos para evitar RPCs redundantes.
    #debounceTimer    = null;
    #debounceResolve  = null;
    #debouncePending  = null; // dados mais recentes pendentes no debounce

    // ============================
    // INICIALIZAÇÃO
    // ============================

    /**
     * Inicializa o DataManager com as credenciais do usuário logado.
     * Deve ser chamado uma única vez após o login bem-sucedido.
     *
     * @param {string} userId   UUID do usuário (Supabase Auth)
     * @param {string} userEmail Email do usuário
     * @returns {Promise<boolean>}
     */
    async initialize(userId, userEmail) {
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            console.error('❌ [DATA-MANAGER] userId inválido na inicialização');
            return false;
        }
        if (!userEmail || typeof userEmail !== 'string' || userEmail.trim() === '') {
            console.error('❌ [DATA-MANAGER] userEmail inválido na inicialização');
            return false;
        }

        this.#userId    = userId.trim();
        this.#userEmail = userEmail.trim();

        if (IS_DEV) {
            console.log('📦 DataManager inicializado');
            console.log('👤 UserID:', this.#userId);
            console.log('📧 Email:', this.#userEmail);
        }

        return true;
    }

    /**
     * ✅ FIX NOVO: Limpa o estado interno do DataManager ao deslogar.
     * Impede que credenciais do usuário anterior permaneçam na memória.
     * Cancela qualquer debounce pendente antes de limpar.
     */
    reset() {
        // Cancela debounce pendente — dados do usuário anterior não devem ser salvos
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer   = null;
            this.#debouncePending = null;

            // Resolve a promise pendente com false — o caller sabe que foi cancelado
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

    // ============================
    // CARREGAR DADOS DO USUÁRIO
    // ============================

    /**
     * Carrega os dados do usuário do Supabase.
     * Cria a estrutura inicial se o registro não existir.
     *
     * @returns {Promise<{ version: string, profiles: object[] }>}
     */
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

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);

            const { data, error } = await supabase
                .from('user_data')
                .select('data_json')
                .eq('user_id', this.#userId)
                .abortSignal(signal)
                .single();

            cleanup();

            // Nenhum registro ainda — cria via RPC
            if (error?.code === 'PGRST116') {
                if (IS_DEV) console.log('⚠️ [DATA-MANAGER] Nenhum dado encontrado, criando estrutura inicial...');
                return await this.#createInitialRecord();
            }

            if (error) {
                console.error('❌ [DATA-MANAGER] Erro ao carregar:', error.message ?? error);
                return this.#emptyStructure();
            }

            if (!data?.data_json) {
                console.warn('⚠️ [DATA-MANAGER] data_json vazio, retornando estrutura padrão');
                return this.#emptyStructure();
            }

            const userData = data.data_json;

            // Garante estrutura mínima válida mesmo se o banco tiver dados parciais
            if (!Array.isArray(userData.profiles)) userData.profiles = [];
            if (!userData.version)                  userData.version  = '1.0';

            // ✅ FIX NOVO: Sanitiza perfis vindos do banco — descarta shapes inválidos
            //    silenciosamente ao invés de deixar chegar na aplicação.
            //    Loga os descartados para diagnóstico em dev.
            const validProfiles = [];
            for (let i = 0; i < userData.profiles.length; i++) {
                const err = validateProfileShape(userData.profiles[i]);
                if (err) {
                    console.warn(`⚠️ [DATA-MANAGER] Perfil [${i}] do banco ignorado (shape inválido): ${err}`);
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

    // ============================
    // SALVAR DADOS DO USUÁRIO (array completo de perfis) — com debounce
    // ============================

    /**
     * Salva o array completo de perfis do usuário.
     *
     * Inclui debounce de 800ms: chamadas rápidas sucessivas são coalesced em
     * um único RPC, evitando requests desnecessários durante edições rápidas
     * (ex: digitação em tempo real, sliders).
     *
     * @param {object[]} profilesData
     * @returns {Promise<boolean>}
     */
    async saveUserData(profilesData) {
        // Validação antecipada — rejeita dados inválidos antes de entrar na fila
        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [DATA-MANAGER] ${validation.error} — save rejeitado antes da fila`);
            return false;
        }

        // ✅ FIX NOVO: Debounce — coalescing de saves rápidos.
        //    Ao invés de enfileirar 3 saves idênticos, apenas o último (mais recente)
        //    é efetivamente enviado ao RPC após DEBOUNCE_DELAY_MS de inatividade.
        //    Saves com >= DEBOUNCE_DELAY_MS de intervalo entre si não sofrem atraso.
        return new Promise((resolve) => {
            // Atualiza os dados pendentes com o snapshot mais recente
            this.#debouncePending = profilesData;

            // Se já há um timer rodando, apenas atualiza os dados e aguarda
            if (this.#debounceTimer !== null) {
                // Resolve a promise anterior com false (foi substituída por save mais recente)
                if (this.#debounceResolve) this.#debounceResolve(false);
                this.#debounceResolve = resolve;
                clearTimeout(this.#debounceTimer);
            } else {
                this.#debounceResolve = resolve;
            }

            this.#debounceTimer = setTimeout(() => {
                this.#debounceTimer = null;
                const pendingData   = this.#debouncePending;
                const pendingResolve = this.#debounceResolve;
                this.#debouncePending  = null;
                this.#debounceResolve  = null;

                // Enfileira o save com os dados mais recentes
                this.#enqueue(() => this.#doSaveUserData(pendingData))
                    .then(pendingResolve)
                    .catch(() => pendingResolve(false));

            }, DEBOUNCE_DELAY_MS);
        });
    }

    /**
     * Força o salvamento imediatamente, ignorando o debounce.
     * Use em situações onde a latência de 800ms é inaceitável
     * (ex: botão "Salvar agora", troca de aba, fechar modal).
     *
     * @param {object[]} profilesData
     * @returns {Promise<boolean>}
     */
    async saveUserDataNow(profilesData) {
        // Cancela debounce pendente — este save síncrono toma prioridade
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

        this.#isSaving = true;

        try {
            // Deep clone — imunidade a mutação externa durante a execução assíncrona do RPC
            const safeProfiles = structuredClone(profilesData);

            // ✅ FIX: userId e email REMOVIDOS do payload RPC.
            //    O servidor DEVE identificar o usuário pelo JWT (cookie sb-access-token),
            //    nunca por campos do body — que podem ser forjados (IDOR).
            //    Mantemos apenas version, profiles e metadata.
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

            if (IS_DEV) {
                console.log('💾 [SUPABASE] Iniciando salvamento via RPC...');
                console.log('📊 Total de perfis:', safeProfiles.length);
                console.log('📦 Tamanho dos dados:', serialized.length, 'bytes');
            }

            if (serialized.length > MAX_PAYLOAD_BYTES) {
                console.error('❌ [DATA-MANAGER] Payload excede 4.9MB — salvamento abortado');
                return false;
            }

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);

            const { data: result, error } = await supabase
                .rpc('salvar_dados_usuario', { p_data_json: dataToSave })
                .abortSignal(signal);

            cleanup();

            if (error) {
                if (error.name === 'AbortError') {
                    console.error('❌ [RPC] Timeout ao salvar dados (>15s)');
                } else {
                    console.error('❌ [RPC] Erro de comunicação:', error.message);
                }
                return false;
            }

            if (!result?.ok) {
                console.error('❌ [RPC] Salvamento recusado pelo servidor:', result?.erro);
                if (result?.erro?.includes('Limite')) {
                    console.warn('⚠️ [RATE LIMIT] Muitos salvamentos em pouco tempo. Aguarde.');
                }
                return false;
            }

            this.#lastSaveTime = new Date();

            if (IS_DEV) {
                console.log('✅ [SUPABASE] Dados salvos com sucesso!');
                console.log('🕐 Horário:', this.#lastSaveTime.toLocaleTimeString());
            }

            return true;

        } catch (err) {
            console.error('❌ [SUPABASE] Erro crítico ao salvar:', err?.message ?? err);
            return false;

        } finally {
            this.#isSaving = false;
        }
    }

    // ============================
    // SALVAR PERFIL ESPECÍFICO (cirúrgico — apenas 1 perfil)
    // ============================

    /**
     * Salva um único perfil via RPC cirúrgica (upsert no array do banco).
     * Não passa pelo debounce — sempre enfileirado diretamente.
     *
     * @param {object} dadosPerfil
     * @returns {Promise<boolean>}
     */
    async saveProfileData(dadosPerfil) {
        const validationError = validateProfileShape(dadosPerfil);
        if (validationError) {
            console.error('❌ [DATA-MANAGER] Perfil inválido:', validationError);
            return false;
        }

        return this.#enqueue(() => this.#doSaveProfileData(dadosPerfil));
    }

    async #doSaveProfileData(dadosPerfil) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] Não é possível salvar: UserID não definido');
            return false;
        }

        // Clone defensivo — blinda contra mutação externa durante o RPC
        let safeProfile;
        try {
            safeProfile = structuredClone(dadosPerfil);
        } catch (cloneErr) {
            console.error('❌ [DATA-MANAGER] Falha ao clonar perfil:', cloneErr?.message);
            return false;
        }

        let serialized;
        try {
            serialized = JSON.stringify(safeProfile);
        } catch (serErr) {
            console.error('❌ [DATA-MANAGER] Falha ao serializar perfil:', serErr?.message);
            return false;
        }

        if (serialized.length > MAX_PAYLOAD_BYTES) {
            console.error('❌ [DATA-MANAGER] Perfil excede 4.9MB — salvamento abortado');
            return false;
        }

        this.#isSaving = true;

        try {
            if (IS_DEV) {
                console.log('💾 [SUPABASE] Salvando perfil via RPC cirúrgica...');
                console.log('🆔 Profile ID:', safeProfile.id);
            }

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);

            const { data: result, error } = await supabase
                .rpc('salvar_perfil_usuario', {
                    p_profile_id:   safeProfile.id,
                    p_profile_data: safeProfile
                })
                .abortSignal(signal);

            cleanup();

            if (error) {
                if (error.name === 'AbortError') {
                    console.error('❌ [RPC] Timeout ao salvar perfil (>15s)');
                } else {
                    console.error('❌ [RPC] Erro de comunicação:', error.message);
                }
                return false;
            }

            if (!result?.ok) {
                console.error('❌ [RPC] Salvamento recusado:', result?.erro);
                return false;
            }

            this.#lastSaveTime = new Date();

            if (IS_DEV) {
                console.log('✅ [SUPABASE] Perfil salvo com sucesso!');
                console.log('🕐 Horário:', this.#lastSaveTime.toLocaleTimeString());
            }

            return true;

        } catch (err) {
            console.error('❌ [SUPABASE] Erro crítico ao salvar perfil:', err?.message ?? err);
            return false;

        } finally {
            this.#isSaving = false;
        }
    }

    // ============================
    // SALVAMENTO IMEDIATO (beforeunload via sendBeacon)
    // ============================

    /**
     * Envia dados via sendBeacon (best-effort) no evento beforeunload.
     * Cancela qualquer debounce pendente antes de enviar o snapshot mais recente.
     *
     * @param {object[]} profilesData
     * @returns {boolean} true se o beacon foi enfileirado pelo browser
     */
    saveImmediate(profilesData) {
        if (!this.#userId) return false;

        // ✅ FIX NOVO: Cancela debounce pendente — no beforeunload queremos
        //    garantir que os dados mais recentes sejam enviados, não uma versão
        //    antiga que estava esperando o debounce expirar.
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
            // Usa os dados pendentes do debounce se profilesData não for fornecido
            // (chamador pode passar this.#debouncePending diretamente)
            if (this.#debounceResolve) {
                this.#debounceResolve(false); // salvo via beacon em seguida
                this.#debounceResolve = null;
            }
            this.#debouncePending = null;
        }

        // ✅ FIX: Valida o array E o shape de cada perfil — mesma proteção do RPC
        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [BEACON] ${validation.error} — beacon cancelado`);
            return false;
        }

        // userId e userEmail REMOVIDOS — autenticação via cookie sb-access-token.
        // A Edge Function DEVE validar o JWT via cookie, nunca via body.userId.
        let payload;
        try {
            payload = JSON.stringify({ profiles: profilesData });
        } catch (serErr) {
            console.error('❌ [BEACON] Falha ao serializar:', serErr?.message);
            return false;
        }

        // sendBeacon tem limite de ~64KB em alguns browsers.
        // Falha silenciosa é inevitável (API não permite retry).
        if (payload.length > 60_000) {
            console.warn('⚠️ [BEACON] Payload excede 60KB — beacon cancelado para evitar falha silenciosa');
            return false;
        }

        const sent = navigator.sendBeacon(
            SUPABASE_BEACON_URL,
            new Blob([payload], { type: 'application/json' })
        );

        // sendBeacon retorna false se o browser recusou enfileirar.
        // Não há como saber se o servidor recebeu — é best-effort por design.
        if (IS_DEV) {
            console.log(sent
                ? '✅ [BEACON] Enfileirado com sucesso (entrega não garantida)'
                : '❌ [BEACON] Browser recusou enfileirar beacon — dados podem ser perdidos'
            );
        }

        return sent;
    }

    // ============================
    // EXPORTAR DADOS (backup local)
    // ============================

    /**
     * Baixa os dados completos do usuário como arquivo JSON.
     * Email é sanitizado para uso seguro como nome de arquivo.
     */
    async exportUserData() {
        let url;
        try {
            const data = await this.loadUserData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            url = URL.createObjectURL(blob);

            // Sanitiza email para uso seguro em nome de arquivo (evita path traversal)
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
            // Garante limpeza do ObjectURL mesmo em caso de erro
            if (url) URL.revokeObjectURL(url);
        }
    }

    // ============================
    // STATUS DO SISTEMA (somente leitura, sem expor dados sensíveis)
    // ============================

    /**
     * Retorna snapshot imutável do estado interno para debug.
     * userId e email NÃO são expostos.
     *
     * @returns {Readonly<object>}
     */
    getStatus() {
        return Object.freeze({
            initialized:    !!this.#userId,
            isSaving:       this.#isSaving,
            queueDepth:     this.#queueDepth,
            debouncing:     this.#debounceTimer !== null,
            lastSaveTime:   this.#lastSaveTime
        });
    }

    // ============================
    // PRIVADOS — Utilitários internos
    // ============================

    /**
     * Enfileira uma função de save com proteção de flood.
     * Rejeita imediatamente se MAX_QUEUE_DEPTH for atingido.
     *
     * @param {() => Promise<boolean>} fn
     * @returns {Promise<boolean>}
     */
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

    /**
     * AbortController com cleanup automático para evitar memory leak.
     * Sempre chame cleanup() após a operação (mesmo em caso de erro).
     *
     * @param {number} timeoutMs
     * @returns {{ signal: AbortSignal, cleanup: () => void }}
     */
    #makeAbortSignal(timeoutMs) {
        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), timeoutMs);
        return {
            signal:  controller.signal,
            cleanup: () => clearTimeout(timer)
        };
    }

    /**
     * Cria o registro inicial do usuário via RPC.
     * Chamado apenas quando loadUserData não encontra registro (PGRST116).
     *
     * @returns {Promise<{ version: string, profiles: object[] }>}
     */
    async #createInitialRecord() {
        const initialData = this.#emptyStructure();
        const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);

        const { data: rpcResult, error: rpcError } = await supabase
            .rpc('salvar_dados_usuario', { p_data_json: initialData })
            .abortSignal(signal);

        cleanup();

        if (rpcError || !rpcResult?.ok) {
            console.error('❌ [DATA-MANAGER] Erro ao criar registro inicial:', rpcError?.message || rpcResult?.erro);
        } else if (IS_DEV) {
            console.log('✅ [DATA-MANAGER] Registro inicial criado com sucesso!');
        }

        return initialData; // Retorna a estrutura vazia mesmo se o RPC falhar
    }

    /**
     * Estrutura mínima padrão retornada em caso de erro ou usuário novo.
     * @returns {{ version: string, profiles: [] }}
     */
    #emptyStructure() {
        return { version: '1.0', profiles: [] };
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();

// Exposição global APENAS em desenvolvimento.
// Em produção: window.dataManager === undefined.
// Extensões maliciosas e scripts XSS não conseguem chamar saveUserData() pelo console.
if (IS_DEV) {
    window.dataManager = dataManagerInstance;

    window.debugDataManager = () => {
        console.log('=== DATA MANAGER STATUS ===');
        console.log(dataManagerInstance.getStatus());
        console.log('==========================');
    };
}

export const dataManager = dataManagerInstance;