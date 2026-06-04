-- =============================================================================
-- GranaEvo — Migration: terms_acceptance versionado (VUL-008 FIX)
--
-- Objetivo: permitir que check-user-access retorne needsTermsAcceptance: true
-- quando o usuário não aceitou a versão corrente dos termos (LGPD).
--
-- Passos (ordem obrigatória):
--   1. Normalizar NULLs em terms_version → '1.0' (legado)
--   2. Deduplicar: manter apenas a linha mais recente por (user_id, terms_version)
--   3. Adicionar UNIQUE(user_id, terms_version) — agora seguro
--   4. Índice de suporte para lookups rápidos
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Normalizar linhas sem versão (criadas antes deste campo existir)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.terms_acceptance
   SET terms_version = '1.0'
 WHERE terms_version IS NULL OR terms_version = '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Deduplicar — keep highest id per (user_id, terms_version)
--    Sem isto, ADD CONSTRAINT falha se houver duplicatas pré-existentes.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.terms_acceptance
 WHERE id NOT IN (
     SELECT DISTINCT ON (user_id, terms_version) id
       FROM public.terms_acceptance
      ORDER BY user_id, terms_version, id DESC
 );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. UNIQUE constraint (idempotente)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname     = 'terms_acceptance_user_version_unique'
           AND conrelid    = 'public.terms_acceptance'::regclass
    ) THEN
        ALTER TABLE public.terms_acceptance
          ADD CONSTRAINT terms_acceptance_user_version_unique
          UNIQUE (user_id, terms_version);
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Índice para lookup por user_id + terms_version (check-user-access EF)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_terms_acceptance_user_version
    ON public.terms_acceptance(user_id, terms_version);
