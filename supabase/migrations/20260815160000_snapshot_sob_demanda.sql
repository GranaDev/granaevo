-- ─────────────────────────────────────────────────────────────────────────────
-- SNAPSHOT SOB DEMANDA — o backup que a tela do reset PROMETIA e não fazia
--
-- ACHADO (2026-08-15, encontrado pelo dono durante o smoke test):
-- O popup de "Resetar Perfil" afirma, em verde e com escudo:
--
--     "Backup automático será criado — Antes de resetar, seus dados atuais
--      serão salvos como backup nomeado 'Antes do reset — <perfil>'.
--      Este backup ficará disponível por 5 dias."
--
-- e o botão exibe "⏳ Salvando backup…". Nada disso acontecia. O código fazia:
--
--     _setBackupNome(hoje, nomeBackup);   -- grava um RÓTULO no localStorage
--     await _ctx.salvarDados();           -- salva o blob, que já estava salvo
--
-- O helper `_salvarSafetyBackup` explicita a premissa errada em comentário:
-- "Simplesmente trigger a salvarDados que gera um snapshot no servidor."
-- `salvarDados` NÃO gera snapshot. Quem cria snapshot é `take_daily_snapshot()`,
-- chamada UMA VEZ POR DIA pelo cron `granaevo-daily-snapshot` (03:15 UTC).
--
-- CONSEQUÊNCIA MEDIDA: o dono resetou às ~13:30 UTC. O único snapshot do dia era
-- o das 03:15. Ao restaurar "Antes do reset" ele recebeu o estado de DEZ HORAS
-- ANTES — todo o trabalho do dia entre 03:15 e o reset foi perdido, depois de a
-- interface ter garantido que estava salvo.
--
-- E o caminho estava fechado dos DOIS lados: mesmo que o app chamasse
-- `take_daily_snapshot()` na hora do reset, ela pularia, porque tem guarda de
-- idempotência `AND NOT EXISTS (... WHERE s.snapshot_date = CURRENT_DATE)`.
--
-- ── POR QUE UPSERT, E NÃO UM SNAPSHOT NOVO ──────────────────────────────────
-- `user_data_snapshots` tem `UNIQUE (user_id, snapshot_date)`: cabe um por dia.
-- Permitir vários exigiria mudar o esquema E o restore (que busca por
-- `snapshot_date`, não por id) — muito mais superfície, num caminho que grava
-- dinheiro.
--
-- O upsert é estritamente melhor que o status quo e não perde nada:
--   ANTES  restaurar "antes do reset" → estado das 03:15 (perde o dia inteiro)
--   DEPOIS restaurar "antes do reset" → estado de segundos antes do reset
-- O snapshot que ele substitui é o MAIS VELHO do mesmo dia, e o de ontem
-- continua intacto (a retenção é de 5 dias). Para o caso de uso real — desfazer
-- um reset — o recente é o único que serve.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.snapshot_sob_demanda(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_tem boolean;
BEGIN
    -- Sem linha em user_data não há o que fotografar. Devolve false para que a
    -- edge recuse o reset em vez de seguir sem rede de proteção.
    SELECT EXISTS (
        SELECT 1 FROM public.user_data
         WHERE user_id = p_user_id AND data_json IS NOT NULL
    ) INTO v_tem;

    IF NOT v_tem THEN
        RETURN false;
    END IF;

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
    WHERE ud.user_id = p_user_id
    ON CONFLICT (user_id, snapshot_date) DO UPDATE
        SET data_json  = EXCLUDED.data_json,
            size_bytes = EXCLUDED.size_bytes,
            checksum   = EXCLUDED.checksum,
            -- `created_at` reflete a foto QUE ESTÁ ALI, não a primeira do dia.
            -- Sem isto o histórico mostraria "03:15" para um snapshot tirado às
            -- 13:30 — e a hora é justamente o que o usuário usa para escolher.
            created_at = now();

    RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.snapshot_sob_demanda(uuid) IS
  'Fotografa user_data AGORA, substituindo o snapshot de hoje. Chamada pela edge user-data-backup antes de operações destrutivas (reset de perfil). Ver migration 20260815160000.';

-- Mesma postura das outras DEFINER deste projeto: ninguém do lado do cliente
-- alcança. Sem isto, `authenticated` poderia sobrescrever o próprio snapshot do
-- dia à vontade — inclusive DEPOIS de um reset, destruindo a única cópia boa.
REVOKE ALL ON FUNCTION public.snapshot_sob_demanda(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snapshot_sob_demanda(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.snapshot_sob_demanda(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_sob_demanda(uuid) TO service_role;
