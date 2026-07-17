-- Rollback de 20260716250000_signup_email_codes.sql
-- ⚠️ Só reverta junto com a volta do email_confirm:true no create-user-account.
SELECT cron.unschedule('granaevo-purge-signup-codes');
DROP FUNCTION IF EXISTS public.purge_signup_email_codes();
DROP TABLE IF EXISTS public.signup_email_codes;
