// ==========================================
// SUPABASE CLIENT - CONFIGURAÇÃO CORRIGIDA
// ==========================================

const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

// Criar cliente Supabase
export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Log de inicialização
console.log('✅ Supabase Client inicializado:', {
    url: SUPABASE_URL,
    connected: !!supabase
});