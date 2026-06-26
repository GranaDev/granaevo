-- =============================================================================
-- GranaEvo — Rollback: 20260626130000_lgpd_anonymize_cakto_archive_pii.sql
-- ATENÇÃO: a anonimização da PII (passo 1) é IRREVERSÍVEL — os dados não voltam.
-- Este rollback apenas remove o trigger de auto-anonimização futura.
-- =============================================================================

DROP TRIGGER IF EXISTS cakto_archive_strip_pii ON public.subscriptions_cakto_archive;
DROP FUNCTION IF EXISTS public.cakto_archive_strip_pii_on_orphan();
