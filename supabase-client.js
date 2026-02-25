// ==========================================
// SUPABASE CLIENT - ES MODULES
// ==========================================


import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// A anon key é intencionalmente pública — protegida por RLS no Supabase
const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

// Falha silenciosa e segura — não loga detalhes internos
if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Configuração do cliente indisponível.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        // Persiste sessão no localStorage (padrão do Supabase)
        // Necessário para que o AuthGuard detecte remoção de token em outra aba
        persistSession:    true,
        detectSessionInUrl: true,

        // Renovação automática do token antes de expirar
        autoRefreshToken: true,

        // [SEC-04] Evita que dados da sessão sejam acessados em storages não seguros
        storageKey: 'ge_auth',
    },
});