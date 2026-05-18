-- =============================================================================
-- GranaEvo — Snapshots diários de user_data (backup rolling 5 dias)
--
-- Objetivo: recuperar dados em caso de reset acidental (zero acidental no
--           frontend que o debounce-save escreveu por cima dos dados reais).
--
-- Funcionamento:
--   • pg_cron dispara diariamente às 03:15 UTC
--   • Copia user_data.data_json (já criptografado) para user_data_snapshots
--   • Deduplicação por checksum: pula se blob idêntico já foi salvo nos
--     últimos 5 dias (usuário não usou o app desde o último snapshot)
--   • Após 5 dias o snapshot é deletado automaticamente
--
-- Segurança:
--   • RLS: authenticated só pode SELECT no próprio user_id
--   • Escrita exclusiva via service_role (Edge Function user-data-backup)
--   • Dados armazenados já criptografados (AES-256-GCM, mesma chave do produção)
--   • Sem exposição de data_json via listagem — apenas metadados na API
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. TABELA: user_data_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_data_snapshots (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    user_email    TEXT        NOT NULL DEFAULT '',
    snapshot_date DATE        NOT NULL DEFAULT CURRENT_DATE,
    data_json     JSONB       NOT NULL,
    size_bytes    INTEGER     NOT NULL DEFAULT 0,
    checksum      TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_snapshot_user_date UNIQUE (user_id, snapshot_date)
);

-- Índice principal: consultas por usuário, ordem decrescente de data
CREATE INDEX IF NOT EXISTS idx_snapshots_user_date
    ON public.user_data_snapshots (user_id, snapshot_date DESC);

-- Índice para limpeza diária (DELETE por data)
CREATE INDEX IF NOT EXISTS idx_snapshots_cleanup
    ON public.user_data_snapshots (snapshot_date);

-- Índice para dedup por checksum (NOT EXISTS no insert do cron)
CREATE INDEX IF NOT EXISTS idx_snapshots_dedup
    ON public.user_data_snapshots (user_id, checksum);

-- ---------------------------------------------------------------------------
-- 2. RLS — authenticated lê próprios snapshots; escrita service_role only
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_data_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_data_snapshots FORCE ROW LEVEL SECURITY;

-- Usuário lê apenas seus próprios snapshots (para listagem de datas)
CREATE POLICY "snapshots_select_own" ON public.user_data_snapshots
    FOR SELECT USING (auth.uid() = user_id);

-- Sem policy de INSERT/UPDATE/DELETE para authenticated — apenas service_role
REVOKE ALL ON TABLE public.user_data_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.user_data_snapshots FROM anon;
REVOKE ALL ON TABLE public.user_data_snapshots FROM authenticated;
GRANT SELECT ON TABLE public.user_data_snapshots TO authenticated;
GRANT ALL   ON TABLE public.user_data_snapshots TO service_role;

-- ---------------------------------------------------------------------------
-- 3. FUNÇÃO: take_daily_snapshot()
--    Chamada pelo pg_cron — cria snapshot do dia para usuários com dados
--    novos, remove snapshots expirados (> 5 dias).
--
--    Retorna: número de snapshots criados no ciclo.
--
--    Dedup: NÃO cria snapshot se o checksum do blob atual já existe nos
--    últimos 5 dias (dado não mudou desde o último snapshot).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.take_daily_snapshot()
RETURNS integer
SECURITY DEFINER
SET search_path = extensions, public, auth
LANGUAGE plpgsql
AS $$
DECLARE
    v_inserted integer := 0;
    v_deleted  integer := 0;
BEGIN
    -- Cria snapshot do dia para usuários cujos dados mudaram
    INSERT INTO public.user_data_snapshots
        (user_id, user_email, snapshot_date, data_json, size_bytes, checksum)
    SELECT
        ud.user_id,
        COALESCE(ud.email, ''),
        CURRENT_DATE,
        ud.data_json,
        length(ud.data_json::text),
        md5(ud.data_json::text)
    FROM public.user_data ud
    WHERE ud.data_json IS NOT NULL
      -- Idempotência: pula se snapshot de hoje já existe
      AND NOT EXISTS (
          SELECT 1 FROM public.user_data_snapshots s
          WHERE s.user_id       = ud.user_id
            AND s.snapshot_date = CURRENT_DATE
      )
      -- Dedup: pula se blob idêntico foi salvo nos últimos 5 dias
      AND NOT EXISTS (
          SELECT 1 FROM public.user_data_snapshots s2
          WHERE s2.user_id  = ud.user_id
            AND s2.checksum = md5(ud.data_json::text)
            AND s2.snapshot_date >= CURRENT_DATE - INTERVAL '5 days'
      )
    ON CONFLICT (user_id, snapshot_date) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    -- Remove snapshots com mais de 5 dias (retenção rolling)
    DELETE FROM public.user_data_snapshots
    WHERE snapshot_date < CURRENT_DATE - INTERVAL '5 days';

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_inserted > 0 OR v_deleted > 0 THEN
        RAISE LOG '[take_daily_snapshot] % snapshot(s) criado(s), % expirado(s) removido(s)',
            v_inserted, v_deleted;
    END IF;

    RETURN v_inserted;
END;
$$;

-- Apenas pg_cron (superuser) e service_role chamam esta função
REVOKE ALL ON FUNCTION public.take_daily_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.take_daily_snapshot() FROM anon;
REVOKE ALL ON FUNCTION public.take_daily_snapshot() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.take_daily_snapshot() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. pg_cron — diário às 03:15 UTC
--    Separado dos outros crons (02:30 / 14:30) para não concorrer com I/O.
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('granaevo-daily-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-daily-snapshot');

SELECT cron.schedule(
    'granaevo-daily-snapshot',
    '15 3 * * *',
    $$ SELECT public.take_daily_snapshot(); $$
);

-- ---------------------------------------------------------------------------
-- 5. COMENTÁRIOS DE AUDITORIA
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.user_data_snapshots IS
    'Snapshots diários de user_data.data_json (blob criptografado AES-256-GCM). '
    'Retenção: 5 dias rolling. Dedup por checksum (MD5 do blob). '
    'Escrita exclusiva via service_role (pg_cron). '
    'Restauração via Edge Function user-data-backup. '
    'Listagem retorna apenas metadados — data_json nunca exposto via API.';

COMMENT ON FUNCTION public.take_daily_snapshot() IS
    'Cria snapshot diário de user_data para usuários com dados novos (dedup por checksum). '
    'Remove snapshots com mais de 5 dias. '
    'Chamado pelo pg_cron às 03:15 UTC.';
