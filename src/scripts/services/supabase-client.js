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

// [SEC-FIX] Adapter de sessionStorage em vez de localStorage.
// Requisito de segurança: tokens não persistem entre sessões de browser.
// sessionStorage é isolado por aba e limpo quando a aba fecha —
// elimina o risco de roubo de token por XSS em scripts de terceiros
// que leram localStorage de outras origens (via extension, etc.).
//
// Trade-off aceito: usuário precisa fazer login ao reabrir o browser/aba.
// Para app financeiro pessoal, este comportamento é desejável.
const _sessionStorageAdapter = {
    getItem:    (key)        => { try { return sessionStorage.getItem(key);        } catch { return null; } },
    setItem:    (key, value) => { try { sessionStorage.setItem(key, value);        } catch {} },
    removeItem: (key)        => { try { sessionStorage.removeItem(key);            } catch {} },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession:     true,
        detectSessionInUrl: true,
        autoRefreshToken:   true,
        storageKey:         'ge_auth',
        storage:            _sessionStorageAdapter,
    },
});