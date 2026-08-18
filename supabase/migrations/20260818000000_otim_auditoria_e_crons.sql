-- OTIMIZAÇÃO — o trigger de auditoria e os crons que limpavam o vazio
-- ============================================================================
-- Auditoria de otimização de 2026-08-18. Nada aqui muda COMPORTAMENTO: os
-- mesmos dados são gravados, com os mesmos valores. O que muda é o custo.
--
-- ── O1: o trigger de auditoria serializava o blob QUATRO vezes por save ─────
--
-- `registrar_auditoria_user_data` fazia, num UPDATE:
--
--     v_hash_before := encode(digest(OLD.data_json::text, 'sha256'), 'hex');  -- 1
--     v_size_before := length(OLD.data_json::text);                           -- 2
--     v_hash_after  := encode(digest(NEW.data_json::text, 'sha256'), 'hex');  -- 3
--     v_size_after  := length(NEW.data_json::text);                           -- 4
--
-- Cada `::text` detoasta e converte o jsonb INTEIRO. Com o maior blob real em
-- 96,9 kB e 139 saves/dia medidos, são ~11,7 MB/dia de serialização dentro da
-- transação de save — para gravar 4 valores.
--
-- É a ironia do delta save: o payload da REDE caiu 99% em 2026-08-13, e este
-- trigger continuou processando o blob completo, duas vezes de cada lado. O
-- gargalo mudou de lugar e ficou invisível porque não trafega.
--
-- Serializar UMA vez por lado e reusar corta isso pela metade (~5,9 MB/dia).
--
-- EQUIVALÊNCIA PROVADA antes de aplicar, nos blobs reais de produção
-- (96,9 / 27,7 / 2,4 kB): `hash_identico = true` e `tamanho_identico = true`
-- nos três. A saída em texto do jsonb é canônica e determinística, então
-- serializar uma vez e reusar é idêntico por construção — a prova empírica só
-- confirma o que o tipo garante.
--
-- ── O2: 78% das execuções de cron limpavam tabelas mortas ──────────────────
--
-- Em 30 dias, 4.616 execuções de cron. Delas:
--     granaevo-limpar-nonces .............. 2.880  (62% de TUDO, a cada 15 min)
--     granaevo-limpar-invite-rate-limit ...   720  (a cada 30 min)
--
-- `invite_nonces` e `invite_rate_limit` têm 0 linhas e NENHUM escritor: a busca
-- em src/, api/ e supabase/functions/ não devolve uma ocorrência, e a única
-- função do banco que as menciona é `cleanup_invite_tables` — o próprio
-- limpador. `invite_nonces` acumulou 11.027 seq scans varrendo o nada.
--
-- Cada execução custa ~7 ms de escrita em `cron.job_run_details` (que por sua
-- vez precisa do próprio cron de purga). Passando as duas para diária:
-- 3.600 → 60 execuções/mês.
--
-- POR QUE NÃO REMOVI OS JOBS NEM AS TABELAS: `api/verify-invite.js:110` ainda
-- encaminha um campo `nonce` no corpo. A Edge Function o ignora hoje, então a
-- proteção de replay por nonce nunca foi ligada — mas a intenção está no código,
-- e apagar a tabela apagaria a intenção junto. Diária mantém a higiene sem
-- fingir que o assunto está resolvido.
--
-- POR QUE `granaevo-limpar-rate-limits` NÃO FOI TOCADO: apesar de também rodar
-- de hora em hora, ele limpa `rate_limit_writes` — que está VIVO (é o teto de
-- save, e `verificar_rate_limit_escrita` é chamada de verdade). Reduzir esse
-- deixaria a tabela crescer. Frequência alta ali é necessidade, não desperdício.
--
-- ── O QUE FOI ANALISADO E DELIBERADAMENTE **NÃO** FEITO ────────────────────
-- Os 21 índices sem uso (432 kB) ficam. Nenhum é PROVADAMENTE redundante — a
-- consulta de cobertura por prefixo devolveu zero pares. Derrubar índice que
-- pode ser necessário em escala, para ganhar 432 kB num banco de 10 MB, troca
-- risco de funcionalidade por quase nada.
-- ============================================================================

BEGIN;

-- ── O1 ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_auditoria_user_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_txt_before  text;
    v_txt_after   text;
    v_hash_before text;
    v_hash_after  text;
    v_size_before integer;
    v_size_after  integer;
BEGIN
    -- UMA serialização por lado. `::text` detoasta e converte o jsonb inteiro;
    -- chamá-lo de novo para medir o tamanho refazia todo o trabalho.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_txt_before  := OLD.data_json::text;
        v_hash_before := encode(digest(v_txt_before, 'sha256'), 'hex');
        v_size_before := length(v_txt_before);
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_txt_after  := NEW.data_json::text;
        v_hash_after := encode(digest(v_txt_after, 'sha256'), 'hex');
        v_size_after := length(v_txt_after);
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

-- ── O2 ───────────────────────────────────────────────────────────────────────
-- Horários escolhidos para não empilhar com os jobs de 03:00–04:40.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'granaevo-limpar-nonces'),
  schedule => '50 4 * * *');

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'granaevo-limpar-invite-rate-limit'),
  schedule => '55 4 * * *');

COMMIT;

-- ============================================================================
-- COMO PROVAR QUE FUNCIONOU
--
--   1. O trigger continua gravando, com os MESMOS valores:
--      SELECT operation, data_size_after, left(hash_after,16)
--        FROM financial_audit_log ORDER BY created_at DESC LIMIT 3;
--      → o hash de um save novo tem de bater com
--        encode(digest(data_json::text,'sha256'),'hex') da linha em user_data.
--
--   2. Os crons entraram na nova agenda:
--      SELECT jobname, schedule, active FROM cron.job
--       WHERE jobname IN ('granaevo-limpar-nonces','granaevo-limpar-invite-rate-limit');
--      → '50 4 * * *' e '55 4 * * *', active = true
--
--   3. O volume caiu (conferir daqui a alguns dias):
--      SELECT j.jobname, count(*) FROM cron.job_run_details r
--        JOIN cron.job j ON j.jobid=r.jobid
--       WHERE r.start_time > now() - interval '7 days' GROUP BY j.jobname ORDER BY 2 DESC;
--      → limpar-nonces deve sair de ~672/semana para 7
--
--   4. Nada regrediu: `npm run check:columns` e a suite continuam verdes.
--
-- ROLLBACK: ver supabase/rollbacks/20260818000000_otim_auditoria_e_crons.down.sql
-- ============================================================================
