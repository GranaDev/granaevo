// ==========================================
// SUPABASE CLIENT - ES MODULES
// ==========================================

// ✅ Importar do CDN com ES Modules
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

// ✅ Verificar configurações
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Configurações do Supabase não encontradas!');
    throw new Error('Supabase não configurado corretamente');
}

// ✅ Criar cliente Supabase
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ✅ Log de inicialização
console.log('✅ Supabase Client inicializado (ES Modules):', {
    url: SUPABASE_URL,
    connected: !!supabase,
    hasAuth: !!supabase.auth
});

// ✅ Teste de conexão
supabase.auth.getSession()
    .then(({ data, error }) => {
        if (error) {
            console.warn('⚠️ Erro ao verificar sessão:', error.message);
        } else {
            console.log('🔐 Status da sessão:', data.session ? '✅ Ativa' : '⭕ Inativa');
        }
    })
    .catch(err => {
        console.error('❌ Erro crítico ao conectar:', err);
    });