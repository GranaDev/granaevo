// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from './supabase-client.js';

class DataManager {
    constructor() {
        this.userId = null;
        this.userEmail = null;
        this.saveQueue = [];
        this.isSaving = false;
        this.lastSaveTime = null;
    }

    // ========== INICIALIZAÇÃO ==========
    async initialize(userId, userEmail) {
        this.userId = userId;
        this.userEmail = userEmail;
        
        console.log('📦 DataManager inicializado');
        console.log('👤 UserID:', userId);
        console.log('📧 Email:', userEmail);
        
        return true;
    }

    // ========== CARREGAR DADOS DO USUÁRIO ==========
// ✅ CARREGAR DADOS DO USUÁRIO (VERSÃO CORRIGIDA)
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

        if (error) {
            if (error.code === 'PGRST116') {
                console.log('⚠️ [DATA-MANAGER] Nenhum dado encontrado, criando estrutura inicial...');
                
                // ✅ CRIAR REGISTRO INICIAL
                const initialData = { version: '1.0', profiles: [] };
                
                const { data: created, error: createError } = await supabase
                    .from('user_data')
                    .insert({
                        user_id: this.userId,
                        email: this.email,
                        data_json: initialData
                    })
                    .select()
                    .single();

                if (createError) {
                    console.error('❌ [DATA-MANAGER] Erro ao criar registro:', createError);
                    return initialData;
                }

                console.log('✅ [DATA-MANAGER] Registro criado com sucesso!');
                return initialData;
            }
            
            console.error('❌ [DATA-MANAGER] Erro ao carregar:', error);
            return { version: '1.0', profiles: [] };
        }

        // ✅ VERIFICAR SE data_json EXISTE
        if (!data || !data.data_json) {
            console.log('⚠️ [DATA-MANAGER] data_json está vazio, retornando estrutura padrão');
            return { version: '1.0', profiles: [] };
        }

        const userData = data.data_json;
        
        console.log('✅ [DATA-MANAGER] Dados carregados com sucesso:', {
            profiles: userData.profiles?.length || 0,
            version: userData.version || '1.0'
        });

        // ✅ GARANTIR QUE profiles É SEMPRE UM ARRAY
        if (!Array.isArray(userData.profiles)) {
            userData.profiles = [];
        }

        // ✅ GARANTIR QUE version EXISTE
        if (!userData.version) {
            userData.version = '1.0';
        }

        return userData;

    } catch (error) {
        console.error('❌ [DATA-MANAGER] Erro crítico ao carregar dados:', error);
        return { version: '1.0', profiles: [] };
    }
}

    // ========== SALVAR DADOS DO USUÁRIO ==========
    async saveUserData(profilesData) {
        if (!this.userId) {
            console.error('❌ Não é possível salvar: UserID não definido');
            return false;
        }

        if (this.isSaving) {
            console.log('⏳ Salvamento em andamento, aguardando...');
            
            // ✅ AGUARDAR O SALVAMENTO ATUAL TERMINAR
            await new Promise(resolve => {
                const checkInterval = setInterval(() => {
                    if (!this.isSaving) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            });
        }

        this.isSaving = true;

        try {
            console.log('💾 [SUPABASE] Iniciando salvamento...');
            console.log('📊 Total de perfis:', profilesData.length);
            console.log('🔑 User ID:', this.userId);

            const dataToSave = {
                version: '1.0',
                user: {
                    userId: this.userId,
                    email: this.userEmail
                },
                profiles: profilesData,
                metadata: {
                    lastSync: new Date().toISOString(),
                    totalProfiles: profilesData.length
                }
            };

            console.log('📦 Tamanho dos dados:', JSON.stringify(dataToSave).length, 'bytes');

            // ✅ VERIFICAR SE JÁ EXISTE REGISTRO
            const { data: existing, error: checkError } = await supabase
                .from('user_data')
                .select('id')
                .eq('user_id', this.userId)
                .maybeSingle();

            if (checkError && checkError.code !== 'PGRST116') {
                console.error('❌ Erro ao verificar dados existentes:', checkError);
                throw checkError;
            }

            let result;

            if (existing) {
                console.log('🔄 Registro encontrado. Atualizando...');
                
                result = await supabase
                    .from('user_data')
                    .update({
                        data_json: dataToSave,
                        email: this.userEmail,
                        last_modified: new Date().toISOString()
                    })
                    .eq('user_id', this.userId);

            } else {
                console.log('➕ Nenhum registro encontrado. Criando novo...');
                
                result = await supabase
                    .from('user_data')
                    .insert({
                        user_id: this.userId,
                        email: this.userEmail,
                        data_json: dataToSave
                    });
            }

            if (result.error) {
                console.error('❌ Erro ao salvar no Supabase:', result.error);
                console.error('Código:', result.error.code);
                console.error('Mensagem:', result.error.message);
                throw result.error;
            }

            this.lastSaveTime = new Date();
            console.log('✅ [SUPABASE] Dados salvos com sucesso!');
            console.log('🕐 Horário:', this.lastSaveTime.toLocaleTimeString());
            
            return true;

        } catch (e) {
            console.error('❌ [SUPABASE] Erro crítico ao salvar:', e);
            console.error('Stack:', e.stack);
            return false;

        } finally {
            this.isSaving = false;
        }
    }

    // ========== SALVAR PERFIL ESPECÍFICO ==========
    async saveProfile(profileId, profileData) {
        try {
            console.log('💾 Salvando perfil específico:', profileId);

            // Carrega dados completos
            const fullData = await this.loadUserData();
            
            // Atualiza/adiciona o perfil específico
            const profileIndex = fullData.profiles.findIndex(p => p.id === profileId);
            
            const profileToSave = {
                ...profileData,
                lastUpdate: new Date().toISOString()
            };

            if (profileIndex !== -1) {
                console.log('📝 Atualizando perfil existente');
                fullData.profiles[profileIndex] = profileToSave;
            } else {
                console.log('➕ Adicionando novo perfil');
                fullData.profiles.push(profileToSave);
            }

            // Salva tudo de volta
            const success = await this.saveUserData(fullData.profiles);
            
            if (success) {
                console.log('✅ Perfil salvo com sucesso');
            }

            return success;

        } catch (e) {
            console.error('❌ Erro ao salvar perfil:', e);
            return false;
        }
    }

    // ========== SALVAMENTO IMEDIATO (para beforeunload) ==========
saveImmediate(profilesData) {
    if (!this.userId) return false;

    const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

    const payload = JSON.stringify({
        userId: this.userId,
        userEmail: this.userEmail,
        profiles: profilesData
    });

    // ✅ sendBeacon garante envio mesmo ao fechar/recarregar a página
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
                email: this.userEmail
            },
            profiles: [],
            metadata: {
                lastSync: new Date().toISOString(),
                totalProfiles: 0
            }
        };
    }

    // ========== EXPORTAR DADOS (BACKUP) ==========
    async exportUserData() {
        const data = await this.loadUserData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
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
            initialized: !!this.userId,
            userId: this.userId,
            email: this.userEmail,
            isSaving: this.isSaving,
            lastSaveTime: this.lastSaveTime
        };
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();

// Expor globalmente para debugging
window.dataManager = dataManagerInstance;

// Debug helper
window.debugDataManager = () => {
    console.log('=== DATA MANAGER STATUS ===');
    console.log(dataManagerInstance.getStatus());
    console.log('==========================');
};

export const dataManager = dataManagerInstance;