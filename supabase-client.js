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

// ✅ CORREÇÃO: esm.sh em vez de cdn.jsdelivr.net
//    O jsdelivr gerava sub-imports sem versão fixa que causavam falha de SRI
//    e instanciação duplicada do GoTrueClient (Multiple GoTrueClient warning)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2';

// ==========================================
// CONFIGURAÇÃO — exportadas para os módulos
// que precisam fazer fetch direto às Edge Functions
// com o header 'apikey' (obrigatório pelo gateway do Supabase)
// ==========================================

/** URL do projeto Supabase — exportada para uso em fetchWithTimeout */
export const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

/**
 * Anon Key do projeto Supabase — exportada para uso no header 'apikey'
 * das chamadas às Edge Functions.
 *
 * [FIX-RENAME] Antes chamada de SUPABASE_KEY (não exportada).
 * Renomeada para SUPABASE_ANON_KEY e exportada para corrigir
 * o erro crítico que quebrava todo o fluxo de Primeiro Acesso.
 */
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Configuração do cliente Supabase indisponível.');
}

// ==========================================
// CLIENTE SUPABASE
// ==========================================
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        /**
         * Persiste sessão no localStorage (padrão do Supabase).
         * Necessário para que o AuthGuard detecte remoção de token em outra aba
         * e para que o usuário permaneça logado após fechar e reabrir o browser.
         */
        persistSession: true,

        /**
         * Detecta parâmetros de sessão na URL após redirect do Supabase
         * (ex: confirmação de email, magic link). Mantido true para compatibilidade
         * com fluxos de recuperação de senha.
         */
        detectSessionInUrl: true,

        /**
         * Renova o JWT automaticamente antes de expirar (padrão: 60s antes).
         * Evita que o usuário seja deslogado durante uso ativo.
         */
        autoRefreshToken: true,

        /**
         * Chave customizada no localStorage.
         * Evita colisão de nomes caso haja múltiplas instâncias do Supabase
         * na mesma origem. Não é medida de segurança — apenas organização.
         */
        storageKey: 'ge_auth',
    },
});