-- =============================================================================
-- GranaEvo — LGPD: anonimiza PII órfã no arquivo Cakto + auto-strip futuro
-- Rollback: ver 20260626130000_lgpd_anonymize_cakto_archive_pii.down.sql
--
-- Achado (auditoria LGPD 2026-06-26): subscriptions_cakto_archive tem FK
--   user_id -> auth.users com ON DELETE SET NULL. Ao excluir a conta, user_id vira
--   NULL mas user_email/user_name/user_cpf/user_phone PERMANECIAM — retendo PII
--   (incluindo CPF) de usuários já excluídos, indefinidamente. Contradizia a
--   promessa "todos os dados serão excluídos permanentemente" e violava
--   minimização/retenção (LGPD art. 15-16). Estado encontrado: 10 linhas órfãs,
--   10 com CPF.
--
-- Correção:
--   1) Anonimiza a PII das linhas já órfãs (mantém payment_id/datas/plano como
--      registro de transação anonimizado — base de retenção fiscal).
--   2) Trigger BEFORE UPDATE: quando uma linha ficar órfã (user_id -> NULL via o
--      SET NULL da FK ao excluir o usuário), zera a PII automaticamente.
-- =============================================================================

-- 1) Anonimiza órfãos existentes
UPDATE public.subscriptions_cakto_archive
SET    user_email = NULL,
       user_name  = NULL,
       user_cpf   = NULL,
       user_phone = NULL
WHERE  user_id IS NULL
  AND  (user_email IS NOT NULL OR user_name IS NOT NULL
        OR user_cpf IS NOT NULL OR user_phone IS NOT NULL);

-- 2) Auto-anonimização futura
CREATE OR REPLACE FUNCTION public.cakto_archive_strip_pii_on_orphan()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.user_id IS NULL AND OLD.user_id IS NOT NULL THEN
    NEW.user_email := NULL;
    NEW.user_name  := NULL;
    NEW.user_cpf   := NULL;
    NEW.user_phone := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS cakto_archive_strip_pii ON public.subscriptions_cakto_archive;
CREATE TRIGGER cakto_archive_strip_pii
  BEFORE UPDATE ON public.subscriptions_cakto_archive
  FOR EACH ROW EXECUTE FUNCTION public.cakto_archive_strip_pii_on_orphan();
