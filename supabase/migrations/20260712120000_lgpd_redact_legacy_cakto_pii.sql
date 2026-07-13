-- 20260712120000_lgpd_redact_legacy_cakto_pii.sql
-- LGPD — remediação dos achados /god-mode (2026-07-12). APLICADA em 2026-07-12
-- via Management API (query endpoint, statement-a-statement) por causa do histórico
-- de migrations squashed. Idempotente — segura para reaplicar via `supabase db push`.
--
-- Contexto: integração Cakto encerrada em 2026-05-21. Dois legados retinham PII sem
-- finalidade atual (viola minimização art. 6º III + eliminação art. 16):
--   (a) public.payment_events — 51 payloads crus de webhook (event_data jsonb) com
--       e-mail/CPF/telefone/nome + um `secret` de webhook em texto puro.
--   (b) subscriptions_cakto_archive — PII remanescente em linhas ainda vinculadas.
-- Verificado: NENHUM código do app lê essas colunas/blobs.

BEGIN;

-- 1. payment_events: redige o event_data, preservando só metadados não-pessoais.
UPDATE public.payment_events
SET event_data    = jsonb_build_object('_redacted', true, '_redacted_at', now(), 'event_type', event_type),
    error_message = NULL
WHERE NOT (event_data ? '_redacted');

-- 2. subscriptions_cakto_archive: anonimiza PII remanescente (mantém user_id/plan/datas).
UPDATE public.subscriptions_cakto_archive
SET user_email = NULL, user_name = NULL, user_cpf = NULL, user_phone = NULL
WHERE user_email IS NOT NULL OR user_name IS NOT NULL
   OR user_cpf  IS NOT NULL OR user_phone IS NOT NULL;

-- 3. Função de retenção contínua (LANGUAGE sql, sem ';' interno — compatível com o
--    query endpoint). Redige qualquer PII residual do payment_events > 90 dias.
CREATE OR REPLACE FUNCTION public.purge_payment_events_pii()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH upd AS (
    UPDATE public.payment_events
    SET event_data    = jsonb_build_object('_redacted', true, '_redacted_at', now(), 'event_type', event_type),
        error_message = NULL
    WHERE NOT (event_data ? '_redacted')
      AND created_at < now() - interval '90 days'
    RETURNING 1
  )
  SELECT coalesce(count(*), 0)::int FROM upd
$fn$;

REVOKE ALL ON FUNCTION public.purge_payment_events_pii() FROM PUBLIC, anon, authenticated;

-- 4. Agenda mensal de retenção (comando sem ';' final).
SELECT cron.schedule('granaevo-purge-payment-events-pii', '0 4 2 * *',
  $job$SELECT public.purge_payment_events_pii()$job$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-payment-events-pii');

-- 5. Remove o cron duplicado: 'limpar-rate-limits' == 'granaevo-limpar-rate-limits'.
SELECT cron.unschedule('limpar-rate-limits')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'limpar-rate-limits');

COMMIT;
