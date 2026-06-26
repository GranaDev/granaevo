-- =============================================================================
-- GranaEvo — Rollback: 20260626140000_lgpd_audit_log_retention_6m.sql
-- ATENÇÃO: linhas já expurgadas NÃO voltam. Este rollback apenas desliga a rotina
-- e restaura o trigger de imutabilidade ESTRITO (bloqueia qualquer UPDATE/DELETE).
-- =============================================================================

-- 3) Desagenda o cron
SELECT cron.unschedule('purge-audit-log-retention');

-- 2) Remove a rotina de retenção
DROP FUNCTION IF EXISTS public.purge_audit_log_retention();

-- 1) Restaura imutabilidade estrita (sem exceção)
CREATE OR REPLACE FUNCTION public.bloquear_alteracao_audit_log()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  RAISE EXCEPTION '[SEGURANCA] Audit log e imutavel. Operacao bloqueada: % na tabela %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END;
$fn$;
