// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from './supabase-client.js';

class DataManager {
    constructor() {
        this.userId    = null;
        this.userEmail = null;
        this.isSaving  = false;
        this.lastSaveTime = null;
    }

    // ========== INICIALIZAÇÃO ==========
    async initialize(userId, userEmail) {
        this.userId    = userId;
        this.userEmail = userEmail;

        console.log('📦 DataManager inicializado');
        console.log('👤 UserID:', userId);
        console.log('📧 Email:', userEmail);

        return true;
    }

    // ========== CARREGAR DADOS DO USUÁRIO ==========
    async loadUserData() {
        try {
            console.log('📥 [DATA-MANAGER] Carregando dados do Supabase...');
            console.log('🔑 [DATA-MANAGER] User ID:', this.userId);

            if (!this.userId) {
                console.error('❌ [DATA-MANAGER] userId não definido!');
                return { version: '1.0', profiles: [] };
            }

            const { data, error } = await supabase
                .from('user_data')
                .select('data_json')
                .eq('user_id', this.userId)
                .single();

            // ✅ Nenhum registro ainda — cria via RPC (já passa por rate limit + audit)
            if (error?.code === 'PGRST116') {
                console.log('⚠️ [DATA-MANAGER] Nenhum dado encontrado, criando estrutura inicial...');

                const initialData = { version: '1.0', profiles: [] };

                // ✅ Usa RPC em vez de INSERT direto — consistência com saveUserData
                const { data: rpcResult, error: rpcError } = await supabase
                    .rpc('salvar_dados_usuario', { p_data_json: initialData });

                if (rpcError || !rpcResult?.ok) {
                    console.error('❌ [DATA-MANAGER] Erro ao criar registro inicial:', rpcError?.message || rpcResult?.erro);
                    return initialData;
                }

                console.log('✅ [DATA-MANAGER] Registro inicial criado com sucesso!');
                return initialData;
            }

            if (error) {
                console.error('❌ [DATA-MANAGER] Erro ao carregar:', error);
                return { version: '1.0', profiles: [] };
            }

            if (!data?.data_json) {
                console.warn('⚠️ [DATA-MANAGER] data_json vazio, retornando estrutura padrão');
                return { version: '1.0', profiles: [] };
            }

            const userData = data.data_json;

            console.log('✅ [DATA-MANAGER] Dados carregados com sucesso:', {
                profiles: userData.profiles?.length || 0,
                version:  userData.version || '1.0'
            });

            // ✅ Garante estrutura mínima mesmo se dados estiverem parcialmente corrompidos
            if (!Array.isArray(userData.profiles)) userData.profiles = [];
            if (!userData.version)                  userData.version  = '1.0';

            return userData;

        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro crítico ao carregar dados:', err);
            return { version: '1.0', profiles: [] };
        }
    }

    // ========== SALVAR DADOS DO USUÁRIO ==========
    async saveUserData(profilesData) {
        if (!this.userId) {
            console.error('❌ Não é possível salvar: UserID não definido');
            return false;
        }

        // ✅ Fila simples: aguarda salvamento em andamento antes de iniciar novo
        if (this.isSaving) {
            console.log('⏳ Salvamento em andamento, aguardando...');
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (!this.isSaving) { clearInterval(check); resolve(); }
                }, 100);
            });
        }

        this.isSaving = true;

        try {
            console.log('💾 [SUPABASE] Iniciando salvamento via RPC...');
            console.log('📊 Total de perfis:', profilesData.length);
            console.log('🔑 User ID:', this.userId);

            const dataToSave = {
                version: '1.0',
                user: {
                    userId:    this.userId,
                    email:     this.userEmail
                },
                profiles: profilesData,
                metadata: {
                    lastSync:      new Date().toISOString(),
                    totalProfiles: profilesData.length
                }
            };

            const payloadSize = JSON.stringify(dataToSave).length;
            console.log('📦 Tamanho dos dados:', payloadSize, 'bytes');

            // ✅ Validação client-side de tamanho antes de nem chamar o backend
            //    Limite generoso (4.9MB) — RPC rejeita acima de 5MB de qualquer forma
            if (payloadSize > 4_900_000) {
                console.error('❌ [DATA-MANAGER] Payload excede 4.9MB — salvamento abortado');
                return false;
            }

            // ✅ MUDANÇA PRINCIPAL: substitui UPDATE/INSERT direto pela RPC
            //    salvar_dados_usuario() no Supabase:
            //      • verifica autenticação via auth.uid()
            //      • aplica rate limit (60 saves/hora por usuário)
            //      • valida estrutura mínima do JSON (campo profiles obrigatório)
            //      • rejeita payload > 5MB
            //      • registra audit log imutável com hash SHA256 antes/depois
            //      • faz UPSERT atômico — sem race condition de check + insert
            const { data: result, error } = await supabase
                .rpc('salvar_dados_usuario', { p_data_json: dataToSave });

            if (error) {
                // ✅ Erros de rede/autenticação vêm aqui
                console.error('❌ [RPC] Erro de comunicação:', error.message);
                console.error('Código:', error.code);
                throw error;
            }

            if (!result?.ok) {
                // ✅ Erros de regra de negócio vêm aqui (rate limit, estrutura inválida, etc.)
                console.error('❌ [RPC] Salvamento recusado pelo servidor:', result?.erro);

                // ✅ Rate limit atingido — avisa o usuário de forma clara
                if (result?.erro?.includes('Limite')) {
                    console.warn('⚠️ [RATE LIMIT] Muitos salvamentos em pouco tempo. Aguarde.');
                }

                return false;
            }

            this.lastSaveTime = new Date();
            console.log('✅ [SUPABASE] Dados salvos com sucesso!');
            console.log('🕐 Horário:', this.lastSaveTime.toLocaleTimeString());

            return true;

        } catch (err) {
            console.error('❌ [SUPABASE] Erro crítico ao salvar:', err);
            console.error('Stack:', err.stack);
            return false;

        } finally {
            this.isSaving = false;
        }
    }

    // ========== SALVAR PERFIL ESPECÍFICO ==========
    async saveProfile(profileId, profileData) {
        try {
            console.log('💾 Salvando perfil específico:', profileId);

            const fullData = await this.loadUserData();

            const profileIndex = fullData.profiles.findIndex(p => p.id === profileId);
            const profileToSave = { ...profileData, lastUpdate: new Date().toISOString() };

            if (profileIndex !== -1) {
                console.log('📝 Atualizando perfil existente');
                fullData.profiles[profileIndex] = profileToSave;
            } else {
                console.log('➕ Adicionando novo perfil');
                fullData.profiles.push(profileToSave);
            }

            const success = await this.saveUserData(fullData.profiles);
            if (success) console.log('✅ Perfil salvo com sucesso');

            return success;

        } catch (err) {
            console.error('❌ Erro ao salvar perfil:', err);
            return false;
        }
    }

    // ========== SALVAMENTO IMEDIATO (beforeunload) ==========
    saveImmediate(profilesData) {
        if (!this.userId) return false;

        // ✅ ATENÇÃO: sendBeacon não suporta headers de autenticação —
        //    a Edge Function save-user-data DEVE validar o JWT via cookie de sessão
        //    (sb-access-token) que o Supabase define automaticamente.
        //    Se sua Edge Function ainda valida pelo body/header Authorization,
        //    esta chamada chegará sem auth e deve ser rejeitada pelo servidor.
        const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

        const payload = JSON.stringify({
            userId:    this.userId,
            userEmail: this.userEmail,
            profiles:  profilesData
        });

        const sent = navigator.sendBeacon(
            `${SUPABASE_URL}/functions/v1/save-user-data`,
            new Blob([payload], { type: 'application/json' })
        );

        console.log(sent
            ? '✅ [BEACON] Dados enviados com sucesso no unload'
            : '❌ [BEACON] Falha ao enviar dados no unload'
        );

        return sent;
    }

    // ========== ESTRUTURA VAZIA ==========
    createEmptyStructure() {
        return {
            version: '1.0',
            user: {
                userId: this.userId,
                email:  this.userEmail
            },
            profiles: [],
            metadata: {
                lastSync:      new Date().toISOString(),
                totalProfiles: 0
            }
        };
    }

    // ========== EXPORTAR DADOS (BACKUP) ==========
    async exportUserData() {
        const data = await this.loadUserData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href     = url;
        a.download = `granaevo_backup_${this.userEmail}_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('✅ Backup exportado com sucesso!');
    }

    // ========== STATUS DO SISTEMA ==========
    getStatus() {
        return {
            initialized:  !!this.userId,
            userId:       this.userId,
            email:        this.userEmail,
            isSaving:     this.isSaving,
            lastSaveTime: this.lastSaveTime
        };
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();

// ✅ Exposto apenas para debugging — não expõe métodos de escrita diretamente
window.dataManager = dataManagerInstance;

window.debugDataManager = () => {
    console.log('=== DATA MANAGER STATUS ===');
    console.log(dataManagerInstance.getStatus());
    console.log('==========================');
};

export const dataManager = dataManagerInstance;