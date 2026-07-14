-- 20260714140000_fix_terms_acceptance_versioning.down.sql
-- GranaEvo — Rollback: 20260714140000_fix_terms_acceptance_versioning.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
--
-- Recria o unique (user_id) sozinho. ⚠️ ISSO REINTRODUZ O BUG de versionamento:
-- só faça rollback se CURRENT_TERMS_VERSION voltar a ser fixa (sem bumps). O ADD
-- CONSTRAINT falha se ja existir mais de 1 linha por user_id (aceites de versoes
-- diferentes) — nesse caso, limpe as linhas extras antes (⚠️ DESTRÓI DADOS de aceite).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'terms_acceptance_user_id_unique'
      AND conrelid = 'public.terms_acceptance'::regclass
  ) THEN
    ALTER TABLE public.terms_acceptance
      ADD CONSTRAINT terms_acceptance_user_id_unique UNIQUE (user_id);
  END IF;
END $$;
