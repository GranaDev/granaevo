-- GOD MODE follow-up (2026-06-28): limpeza de índices duplicados + monitor de cron (M2).
-- Aplicado via `supabase db push` (MCP é read-only). 100% aditivo/idempotente.

-- ── 1. Índices duplicados ────────────────────────────────────────────────────
-- Cada DROP remove o gêmeo IDÊNTICO de um índice que permanece. NUNCA remove o
-- índice que sustenta uma constraint UNIQUE.
DROP INDEX IF EXISTS public.idx_invite_nonces_nonce_unique;       -- gêmeo de invite_nonces_nonce_unique (esse sustenta a constraint → fica)
DROP INDEX IF EXISTS public.idx_password_reset_codes_email_used;  -- idêntico a idx_password_reset_codes_email
DROP INDEX IF EXISTS public.profiles_user_id_idx;                 -- idêntico a idx_profiles_user
DROP INDEX IF EXISTS public.idx_subscriptions_cakto_order_unique; -- idêntico a idx_subscriptions_cakto_order_id_unique
DROP INDEX IF EXISTS public.idx_subscriptions_user_email;         -- idêntico a idx_subscriptions_email

-- ── 2. Monitor de saúde dos cron jobs (M2) ───────────────────────────────────
-- Retorna jobs ATIVOS que falharam nas últimas 24h. SECURITY DEFINER porque o
-- schema `cron` pertence ao postgres e service_role não tem SELECT direto.
-- Sem argumentos, sem SQL dinâmico. EXECUTE apenas para service_role (consumido
-- pela edge function cron-health-alert via x-proxy-secret).
CREATE OR REPLACE FUNCTION public.get_cron_failures_24h()
RETURNS TABLE(jobname text, fails bigint, last_message text, last_fail timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, public, pg_temp
AS $$
  SELECT j.jobname::text,
         count(1)                      AS fails,
         max(r.return_message)::text   AS last_message,
         max(r.start_time)             AS last_fail
  FROM cron.job_run_details r
  JOIN cron.job j ON j.jobid = r.jobid
  WHERE r.status = 'failed'
    AND r.start_time > now() - interval '24 hours'
  GROUP BY j.jobname
  ORDER BY fails DESC;
$$;

REVOKE ALL    ON FUNCTION public.get_cron_failures_24h() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cron_failures_24h() TO service_role;

COMMENT ON FUNCTION public.get_cron_failures_24h() IS
  'Monitor M2: jobs cron que falharam nas últimas 24h. EXECUTE só service_role (edge cron-health-alert).';
