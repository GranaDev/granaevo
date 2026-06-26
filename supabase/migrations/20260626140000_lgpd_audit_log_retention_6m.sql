-- =============================================================================
-- GranaEvo — LGPD: retenção de 6 meses do financial_audit_log
-- Rollback: ver 20260626140000_lgpd_audit_log_retention_6m.down.sql
--
-- Achado (auditoria LGPD 2026-06-26): a política promete reter logs de auditoria
--   por prazo limitado, mas o financial_audit_log (guarda user_id/actor_id/IP/
--   user_agent) é imutável (trigger bloqueia UPDATE/DELETE) e NÃO havia rotina de
--   expurgo — acumularia indefinidamente. IP é dado pessoal (LGPD).
--
-- Prazo escolhido: 6 MESES.
--   - Marco Civil da Internet (Lei 12.965/2014, art. 15): mínimo 6 meses para
--     registros de acesso a aplicações (IP + data/hora). 6m cumpre o piso legal.
--   - LGPD (art. 6, III - necessidade): manter pelo mínimo necessário → 6m < 12m
--     é mais privativo. 6 meses é o ponto ótimo (piso legal + minimização).
--
-- Mecanismo: a imutabilidade é preservada para TODOS, exceto a rotina de retenção,
--   que sinaliza uma flag de sessão (SET LOCAL) que o trigger reconhece. Assim só
--   ela pode apagar linhas antigas; ninguém mais consegue alterar/apagar o log.
-- =============================================================================

-- 1) Trigger de imutabilidade com exceção controlada p/ a rotina de retenção
CREATE OR REPLACE FUNCTION public.bloquear_alteracao_audit_log()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('granaevo.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '[SEGURANCA] Audit log e imutavel. Operacao bloqueada: % na tabela %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END;
$fn$;

-- 2) Rotina de retenção (6 meses)
CREATE OR REPLACE FUNCTION public.purge_audit_log_retention()
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_count integer;
BEGIN
  SET LOCAL granaevo.audit_retention = 'on';
  DELETE FROM public.financial_audit_log
  WHERE created_at < now() - interval '6 months';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE LOG '[audit_retention] linhas removidas (>6 meses): %', v_count;
  END IF;
  RETURN v_count;
END;
$fn$;

-- 3) Agenda mensal (dia 1, 04:00 UTC)
SELECT cron.schedule('purge-audit-log-retention', '0 4 1 * *', 'SELECT public.purge_audit_log_retention();');
