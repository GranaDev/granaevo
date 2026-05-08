/**
 * GranaEvo — supabase-client.js
 *
 * ============================================================
 * CORREÇÕES NESTE ARQUIVO
 * ============================================================
 *
 * [FIX-CDN] CRÍTICO — trocado cdn.jsdelivr.net por esm.sh
 *   O jsdelivr com @2.49.2/+esm carregava sub-dependências via
 *   @supabase/supabase-js@2 (sem versão), causando:
 *   - Erro de SRI: "Failed to find a valid digest in the integrity attribute"
 *   - Multiple GoTrueClient instances (recurso bloqueado → tentativa de reload)
 *   - Upload de foto bloqueado (cliente instanciado incorretamente)
 *   O esm.sh serve ES modules puros sem sub-imports problemáticos.
 *
 * [FIX-EXPORTS] CRÍTICO — SUPABASE_URL e SUPABASE_ANON_KEY exportados
 *   corretamente para uso em primeiroacesso.js e demais módulos.
 *
 * [FIX-RENAME] SUPABASE_KEY renomeada para SUPABASE_ANON_KEY para
 *   consistência com os demais módulos.
 *
 * ============================================================
 * SEGURANÇA
 * ============================================================
 *
 * A anon key é INTENCIONALMENTE pública — é projetada para uso no
 * frontend. A segurança dos dados é garantida exclusivamente pelas
 * políticas de Row Level Security (RLS) configuradas no Supabase.
 * Nunca use a service_role key no frontend.
 *
 * storageKey customizada ('ge_auth') evita colisão caso haja múltiplas
 * instâncias do Supabase na mesma origem — não é uma medida de segurança,
 * pois qualquer script na mesma origem pode ler o localStorage normalmente.
 */

import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL      = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Configuração do cliente Supabase indisponível.');
}

// Chave que persiste o estado "Lembrar de mim" no localStorage.
// É apenas uma flag booleana — não contém tokens.
const _REMEMBER_KEY = '_ge_remember';

// Verifica se o usuário escolheu "Lembrar de mim" na última sessão de login.
function _isRemembered() {
    try { return localStorage.getItem(_REMEMBER_KEY) === '1'; } catch { return false; }
}

// Storage dinâmico: usa localStorage quando "Lembrar de mim" está ativo,
// sessionStorage caso contrário (limpo ao fechar o browser).
// removeItem sempre limpa de ambos para não deixar token órfão.
const _dynamicStorageAdapter = {
    getItem(key) {
        try {
            if (_isRemembered()) {
                // Prioriza localStorage; sessionStorage como fallback de migração
                const v = localStorage.getItem(key);
                return v !== null ? v : sessionStorage.getItem(key);
            }
            return sessionStorage.getItem(key);
        } catch { return null; }
    },
    setItem(key, value) {
        try {
            if (_isRemembered()) {
                localStorage.setItem(key, value);
                try { sessionStorage.removeItem(key); } catch {}
            } else {
                sessionStorage.setItem(key, value);
                try { localStorage.removeItem(key); } catch {}
            }
        } catch {}
    },
    removeItem(key) {
        try { localStorage.removeItem(key);   } catch {}
        try { sessionStorage.removeItem(key); } catch {}
    },
};

/**
 * Define se a sessão deve persistir entre fechamentos do browser.
 * Deve ser chamada ANTES de supabase.auth.signInWithPassword().
 */
export function setRememberMe(remember) {
    try {
        if (remember) {
            localStorage.setItem(_REMEMBER_KEY, '1');
        } else {
            localStorage.removeItem(_REMEMBER_KEY);
        }
    } catch {}
}

/**
 * Limpa o estado "Lembrar de mim" e remove a sessão persistida.
 * Deve ser chamada em todos os caminhos de logout.
 */
export function clearRememberMe() {
    try { localStorage.removeItem(_REMEMBER_KEY); } catch {}
    try { localStorage.removeItem('ge_auth');      } catch {}
    try { sessionStorage.removeItem('ge_auth');    } catch {}
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession:     true,
        detectSessionInUrl: true,
        autoRefreshToken:   true,
        storageKey:         'ge_auth',
        storage:            _dynamicStorageAdapter,
    },
});