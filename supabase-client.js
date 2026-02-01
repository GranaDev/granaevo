// ==========================================
// SUPABASE CLIENT - CONFIGURAÇÃO CORRIGIDA
// ==========================================

const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

// ✅ VERIFICAR SE SUPABASE ESTÁ DISPONÍVEL
if (typeof window.supabase === 'undefined') {
    console.error('❌ ERRO: Biblioteca Supabase não carregada!');
    console.error('📝 Adicione no HTML: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>');
    throw new Error('Supabase library not loaded');
}

// ✅ CRIAR CLIENTE SUPABASE
export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ✅ LOG DE INICIALIZAÇÃO
console.log('✅ Supabase Client inicializado:', {
    url: SUPABASE_URL,
    connected: !!supabase,
    hasAuth: !!supabase.auth
});

// ✅ TESTE DE CONEXÃO
supabase.auth.getSession()
    .then(({ data, error }) => {
        if (error) {
            console.warn('⚠️ Nenhuma sessão ativa');
        } else {
            console.log('🔐 Sessão encontrada:', data.session ? 'Ativa' : 'Inativa');
        }
    })
    .catch(err => {
        console.error('❌ Erro ao verificar sessão:', err);
    });