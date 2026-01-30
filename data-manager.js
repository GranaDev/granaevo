// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase } from './supabase-client.js';

class DataManager {
    constructor() {
        this.userId = null;
        this.userEmail = null;
        this.isInitialized = false; // ✅ NOVO
    }

    // ========== INICIALIZAÇÃO ==========
    async initialize(userId, userEmail) {
        if (!userId || !userEmail) {
            console.error('❌ Initialize chamado sem userId ou email');
            return false;
        }

        this.userId = userId;
        this.userEmail = userEmail;
        this.isInitialized = true; // ✅ NOVO
        
        console.log('✅ DataManager inicializado:', { userId, userEmail });
        return true;
    }

    // ========== VALIDAÇÃO ANTES DE SALVAR ==========
    validateBeforeSave() {
        if (!this.isInitialized) {
            console.error('❌ DataManager não inicializado');
            return false;
        }
        if (!this.userId) {
            console.error('❌ UserID não definido');
            return false;
        }
        return true;
    }

    // ========== CARREGAR DADOS DO USUÁRIO ==========
    async loadUserData() {
        if (!this.validateBeforeSave()) {
            return this.createEmptyStructure();
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
                console.log('ℹ️ Nenhum dado salvo. Retornando estrutura vazia.');
                return this.createEmptyStructure();
            }

            console.log('✅ Dados carregados com sucesso');
            return data.data_json;

        } catch (e) {
            console.error('❌ Erro crítico ao carregar:', e);
            return this.createEmptyStructure();
        }
    }

    // ========== SALVAR DADOS (VERSÃO SIMPLIFICADA E FUNCIONAL) ==========
    async saveUserData(profilesData) {
        if (!this.validateBeforeSave()) {
            console.error('❌ Salvamento bloqueado: validação falhou');
            return false;
        }

        try {
            console.log('💾 Salvando dados...', {
                userId: this.userId,
                email: this.userEmail,
                profiles: profilesData.length
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

            // ✅ UPSERT simplificado
            const { error } = await supabase
                .from('user_data')
                .upsert({
                    user_id: this.userId,
                    email: this.userEmail,
                    data_json: dataToSave
                }, {
                    onConflict: 'user_id'
                });

            if (error) {
                console.error('❌ Erro no Supabase:', error);
                throw error;
            }

            console.log('✅ Dados salvos com sucesso!');
            return true;

        } catch (e) {
            console.error('❌ Erro crítico ao salvar:', e);
            return false;
        }
    }

    // ✅ NOVO: Salvamento imediato (sem fila)
    async forceSave(profilesData) {
        return await this.saveUserData(profilesData);
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
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();
window.dataManager = dataManagerInstance;

export const dataManager = dataManagerInstance;