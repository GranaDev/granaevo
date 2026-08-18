-- Reverte APENAS as adições de schema desta migration.
-- A redação/anonimização de PII é IRREVERSÍVEL por design (LGPD: o dado deixou de existir).

SELECT cron.unschedule('granaevo-purge-payment-events-pii')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-payment-events-pii');

DROP FUNCTION IF EXISTS public.purge_payment_events_pii();
