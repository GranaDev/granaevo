-- =============================================================================
-- GranaEvo — ROLLBACK: 20260531000001_feature_flags.sql
-- ⚠️  Execute apenas em emergência. Este script destrói a tabela feature_flags
--     e todos os dados de configuração de flags.
--
-- Como executar:
--   psql $DATABASE_URL -f supabase/migrations/20260531000001_feature_flags.down.sql
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Reverte em ordem INVERSA ao UP
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Remover função helper
DROP FUNCTION IF EXISTS public.is_feature_enabled(text, uuid, text);

-- 2. Remover trigger e trigger function
DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON public.feature_flags;
-- Nota: set_updated_at() pode ser usada por outras tabelas — não dropar

-- 3. Remover índices
DROP INDEX IF EXISTS public.idx_feature_flags_user;
DROP INDEX IF EXISTS public.idx_feature_flags_key;

-- 4. Remover políticas RLS
DROP POLICY IF EXISTS "feature_flags_select_auth" ON public.feature_flags;

-- 5. ⚠️ DESTRÓI DADOS — remove tabela e todos os dados de feature flags
DROP TABLE IF EXISTS public.feature_flags;
