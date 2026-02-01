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
    async loadUserData() {
        if (!this.userId) {
            throw new Error('❌ UserID não definido');
        }

        try {
            console.log('📥 Carregando dados do Supabase...');
            console.log('🔑 User ID:', this.userId);

            const { data, error } = await supabase
                .from('user_data')
                .select('data_json')
                .eq('user_id', this.userId)
                .maybeSingle();

            if (error) {
                console.error('❌ Erro ao carregar dados:', error);
                throw error;
            }

            if (!data || !data.data_json) {
                console.log('ℹ️ Nenhum dado salvo. Criando estrutura vazia.');
                return this.createEmptyStructure();
            }

            console.log('✅ Dados carregados:', {
                profiles: data.data_json.profiles?.length || 0,
                version: data.data_json.version
            });

            return data.data_json;

        } catch (e) {
            console.error('❌ Erro crítico ao carregar:', e);
            return this.createEmptyStructure();
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
            return false;
        }

        this.isSaving = true;

        try {
            console.log('💾 Iniciando salvamento...');
            console.log('📊 Perfis a salvar:', profilesData.length);

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

            // ✅ VERIFICAR SE JÁ EXISTE REGISTRO
            const { data: existing, error: checkError } = await supabase
                .from('user_data')
                .select('id')
                .eq('user_id', this.userId)
                .maybeSingle();

            if (checkError && checkError.code !== 'PGRST116') {
                throw checkError;
            }

            let result;

            if (existing) {
                console.log('🔄 Atualizando dados existentes...');
                
                result = await supabase
                    .from('user_data')
                    .update({
                        data_json: dataToSave,
                        email: this.userEmail
                    })
                    .eq('user_id', this.userId);

            } else {
                console.log('➕ Criando novo registro...');
                
                result = await supabase
                    .from('user_data')
                    .insert({
                        user_id: this.userId,
                        email: this.userEmail,
                        data_json: dataToSave
                    });
            }

            if (result.error) {
                console.error('❌ Erro ao salvar:', result.error);
                throw result.error;
            }

            this.lastSaveTime = new Date();
            console.log('✅ Dados salvos com sucesso às', this.lastSaveTime.toLocaleTimeString());
            
            return true;

        } catch (e) {
            console.error('❌ Erro crítico ao salvar:', e);
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