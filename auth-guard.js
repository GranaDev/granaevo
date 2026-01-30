// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from './supabase-client.js';

class DataManager {
    constructor() {
        this.userId = null;
        this.userEmail = null;
        this.autoSaveInterval = null;
        this.saveQueue = [];
        this.isSaving = false;
        this.lastSaveTime = null;
    }

    // ========== INICIALIZAÇÃO ==========
    async initialize(userId, userEmail) {
        this.userId = userId;
        this.userEmail = userEmail;
        
        console.log('📦 DataManager inicializado para:', userEmail);
        
        // Iniciar auto-save a cada 30 segundos
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

    // ========== SALVAR DADOS DO USUÁRIO - VERSÃO CORRIGIDA ==========
    async saveUserData(profilesData) {
        if (!this.userId) {
            console.error('❌ Não é possível salvar: UserID não definido');
            return false;
        }

        // ✅ Evitar salvamentos duplicados
        if (this.isSaving) {
            console.log('⏳ Salvamento já em progresso, adicionando à fila...');
            this.queueSave(profilesData);
            return true;
        }

        this.isSaving = true;

        try {
            console.log('💾 Salvando dados do usuário...', {
                userId: this.userId,
                email: this.userEmail,
                totalPerfis: profilesData.length
            });

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

            // ✅ Verifica se já existe registro
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
                // ✅ UPDATE
                console.log('🔄 Atualizando registro existente...');
                result = await supabase
                    .from('user_data')
                    .update({
                        data_json: dataToSave,
                        email: this.userEmail,
                        last_modified: new Date().toISOString()
                    })
                    .eq('user_id', this.userId);
            } else {
                // ✅ INSERT
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

            this.lastSaveTime = new Date().toISOString();
            console.log('✅ Dados salvos com sucesso no Supabase!', {
                timestamp: this.lastSaveTime,
                perfisCount: profilesData.length
            });
            
            return true;

        } catch (e) {
            console.error('❌ Erro crítico ao salvar dados:', e);
            return false;
        } finally {
            this.isSaving = false;
        }
    }

    // ========== AUTO-SAVE - VERSÃO MELHORADA ==========
    startAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
        }

        this.autoSaveInterval = setInterval(() => {
            if (this.saveQueue.length > 0 && !this.isSaving) {
                console.log('⏰ Auto-save: processando fila...');
                this.processSaveQueue();
            }
        }, 30000); // 30 segundos

        console.log('⏰ Auto-save ativado (30s)');
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
        console.log('📋 Dados adicionados à fila de salvamento');
    }

    async processSaveQueue() {
        if (this.saveQueue.length === 0 || this.isSaving) return;

        const dataToSave = this.saveQueue.pop();

        try {
            await this.saveUserData(dataToSave);
            this.saveQueue = []; // Limpa fila após sucesso
        } catch (e) {
            console.error('❌ Erro ao processar fila de salvamento:', e);
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

    // ========== FORÇA SALVAMENTO IMEDIATO ==========
    async forceSave(profilesData) {
        console.log('🚨 Salvamento forçado iniciado...');
        
        // Limpa a fila e salva imediatamente
        this.saveQueue = [];
        
        return await this.saveUserData(profilesData);
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();
window.dataManager = dataManagerInstance;

export const dataManager = dataManagerInstance;