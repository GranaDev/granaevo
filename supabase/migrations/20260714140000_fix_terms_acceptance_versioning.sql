-- 20260714140000_fix_terms_acceptance_versioning.sql
-- GranaEvo — Migration: destrava o versionamento de aceite de termos (gap LGPD M2)
-- Rollback: ver 20260714140000_fix_terms_acceptance_versioning.down.sql
--
-- PROBLEMA (descoberto na auditoria 2026-07-14):
--   A tabela terms_acceptance tinha DOIS uniques conflitantes:
--     - terms_acceptance_user_id_unique       UNIQUE (user_id)                 ← bloqueador
--     - terms_acceptance_user_version_unique   UNIQUE (user_id, terms_version)  ← correto
--   Com o unique em (user_id) sozinho, ao subir CURRENT_TERMS_VERSION (ex.: 1.0 -> 1.1),
--   o INSERT do novo aceite viola esse constraint -> erro 23505 -> as Edge Functions
--   accept-terms / verify-guest-invite o tratam como "idempotente" e engolem, então o
--   aceite da nova versao NUNCA e gravado. O gate checkNeedsTermsAcceptance nunca acha a
--   linha da versao corrente -> pede re-aceite em LOOP INFINITO. O bump de versao ficaria
--   quebrado em producao sem esta correcao.
--
-- CORRECAO:
--   Remove APENAS o unique redundante (user_id). O unique (user_id, terms_version)
--   permanece e continua garantindo idempotencia POR VERSAO (o comportamento pretendido):
--   um usuario tem no maximo 1 linha por versao de termos, e pode ter varias versoes.
--
-- SEGURANCA: nao afeta RLS nem dados. Dados atuais: 4 linhas, todas versao '1.0',
--   4 user_ids distintos (0 duplicatas) -> drop seguro.
-- PRE-REQUISITO: esta migration deve ser aplicada ANTES de fazer deploy das Edge
--   Functions com a nova CURRENT_TERMS_VERSION.

ALTER TABLE public.terms_acceptance
  DROP CONSTRAINT IF EXISTS terms_acceptance_user_id_unique;

-- Fallback defensivo: em ambientes onde exista como indice avulso (sem constraint).
DROP INDEX IF EXISTS public.terms_acceptance_user_id_unique;

-- Garante que o unique correto (por versao) esta presente — idempotente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'terms_acceptance_user_version_unique'
      AND conrelid = 'public.terms_acceptance'::regclass
  ) THEN
    ALTER TABLE public.terms_acceptance
      ADD CONSTRAINT terms_acceptance_user_version_unique UNIQUE (user_id, terms_version);
  END IF;
END $$;
