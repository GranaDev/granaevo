// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from './supabase-client.js';

class DataManager {
    constructor() {
        this.userId = null;
        this.userEmail = null;
        this.autoSaveInterval = null;
        this.saveQueue = [];
        this.isSaving = false;
    }

    // ========== INICIALIZAÇÃO ==========
    async initialize(userId, userEmail) {
        this.userId = userId;
        this.userEmail = userEmail;
        
        console.log('📦 DataManager inicializado para:', userEmail);
        
        // Iniciar auto-save a cada 10 segundos
        this.startAutoSave();
        
        return true;
    }

    // ========== CARREGAR DADOS DO USUÁRIO ==========
    async loadUserData() {
        if (!this.userId) {
            throw new Error('❌ UserID não definido');
        }

        try {
            console.log('📥 Carregando dados do usuário:', this.userEmail);

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
                console.log('ℹ️ Nenhum dado salvo encontrado. Retornando estrutura vazia.');
                return this.createEmptyStructure();
            }

            console.log('✅ Dados carregados com sucesso');
            return data.data_json;

        } catch (e) {
            console.error('❌ Erro crítico ao carregar dados:', e);
            return this.createEmptyStructure();
        }
    }

    // ========== SALVAR DADOS DO USUÁRIO ==========
    async saveUserData(profilesData) {
        if (!this.userId) {
            console.error('❌ Não é possível salvar: UserID não definido');
            return false;
        }

        try {
            console.log('💾 Salvando dados do usuário...');

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

            // Verifica se já existe registro
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
                // UPDATE
                result = await supabase
                    .from('user_data')
                    .update({
                        data_json: dataToSave,
                        email: this.userEmail
                    })
                    .eq('user_id', this.userId);
            } else {
                // INSERT
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

            console.log('✅ Dados salvos com sucesso!');
            return true;

        } catch (e) {
            console.error('❌ Erro crítico ao salvar dados:', e);
            return false;
        }
    }

    // ========== SALVAR PERFIL ESPECÍFICO ==========
    async saveProfile(profileId, profileData) {
        try {
            // Carrega dados completos
            const fullData = await this.loadUserData();
            
            // Atualiza/adiciona o perfil específico
            const profileIndex = fullData.profiles.findIndex(p => p.id === profileId);
            
            if (profileIndex !== -1) {
                fullData.profiles[profileIndex] = {
                    ...profileData,
                    lastUpdate: new Date().toISOString()
                };
            } else {
                fullData.profiles.push({
                    ...profileData,
                    lastUpdate: new Date().toISOString()
                });
            }

            // Salva tudo de volta
            return await this.saveUserData(fullData.profiles);

        } catch (e) {
            console.error('❌ Erro ao salvar perfil:', e);
            return false;
        }
    }

    // ========== AUTO-SAVE ==========
    startAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
        }

        this.autoSaveInterval = setInterval(() => {
            if (this.saveQueue.length > 0 && !this.isSaving) {
                this.processSaveQueue();
            }
        }, 10000); // 10 segundos

        console.log('⏰ Auto-save ativado (10s)');
    }

    stopAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
            console.log('⏸️ Auto-save desativado');
        }
    }

    // ========== FILA DE SALVAMENTO ==========
    queueSave(profilesData) {
        this.saveQueue = [profilesData]; // Substitui sempre pelo mais recente
    }

    async processSaveQueue() {
        if (this.saveQueue.length === 0 || this.isSaving) return;

        this.isSaving = true;
        const dataToSave = this.saveQueue.pop();

        try {
            await this.saveUserData(dataToSave);
            this.saveQueue = []; // Limpa fila após sucesso
        } catch (e) {
            console.error('❌ Erro ao processar fila de salvamento:', e);
        } finally {
            this.isSaving = false;
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

    // ========== IMPORTAR DADOS (RESTAURAR BACKUP) ==========
    async importUserData(fileData) {
        try {
            const data = JSON.parse(fileData);
            
            // Validação básica
            if (!data.version || !data.profiles) {
                throw new Error('Arquivo de backup inválido');
            }

            await this.saveUserData(data.profiles);
            console.log('✅ Backup restaurado com sucesso!');
            return true;

        } catch (e) {
            console.error('❌ Erro ao importar backup:', e);
            return false;
        }
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();

window.dataManager = dataManagerInstance;

// Também exportar para compatibilidade com outros módulos
export const dataManager = dataManagerInstance;