-- 20260818000000_otim_auditoria_e_crons.down.sql
-- GranaEvo — Rollback: 20260818000000_otim_auditoria_e_crons.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
--
-- ⚠️ O QUE VOCÊ ESTÁ DESFAZENDO — e por que provavelmente NÃO quer:
--    O UP não muda comportamento nenhum. O trigger grava exatamente os mesmos
--    valores (equivalência provada nos blobs reais de produção antes de aplicar);
--    ele só para de serializar o mesmo jsonb duas vezes por lado. Reverter
--    devolve ~5,9 MB/dia de trabalho inútil dentro da transação de save.
--
--    Se algo quebrou depois desta migration, o suspeito quase certamente NÃO é
--    ela. Confira antes: `financial_audit_log` continua recebendo linha a cada
--    save? Se sim, o trigger está bom e o problema é outro.

BEGIN;

-- Reverte em ordem INVERSA ao UP

-- O2: volta à frequência antiga (a cada 15 e a cada 30 minutos)
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'granaevo-limpar-invite-rate-limit'),
  schedule => '30 * * * *');

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'granaevo-limpar-nonces'),
  schedule => '*/15 * * * *');

-- O1: volta a serializar o blob 4x por save
CREATE OR REPLACE FUNCTION public.registrar_auditoria_user_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_hash_before text;
    v_hash_after  text;
    v_size_before integer;
    v_size_after  integer;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_hash_before  := encode(digest(OLD.data_json::text, 'sha256'), 'hex');
        v_size_before  := length(OLD.data_json::text);
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_hash_after  := encode(digest(NEW.data_json::text, 'sha256'), 'hex');
        v_size_after  := length(NEW.data_json::text);
    END IF;

    INSERT INTO financial_audit_log (
        user_id, actor_id, operation,
        data_size_before, data_size_after,
        hash_before, hash_after
    ) VALUES (
        COALESCE(NEW.user_id, OLD.user_id),
        auth.uid(),
        TG_OP,
        v_size_before, v_size_after,
        v_hash_before, v_hash_after
    );

    RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMIT;

-- ── Depois de reverter, conferir ────────────────────────────────────────────
--   SELECT jobname, schedule FROM cron.job
--    WHERE jobname IN ('granaevo-limpar-nonces','granaevo-limpar-invite-rate-limit');
--   → '*/15 * * * *' e '30 * * * *'
