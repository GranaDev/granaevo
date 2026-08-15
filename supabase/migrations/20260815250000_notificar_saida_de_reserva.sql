-- ─────────────────────────────────────────────────────────────────────────────
-- ETAPA 4: avisar os demais participantes quando um perfil sai da reserva
--
-- Desenho: docs/exclusao-de-perfil-desenho.md. Decisão do dono: quem sai deixa
-- o valor na reserva, e os demais recebem um aviso com ação de ajustar o saldo.
--
-- ⚠️ O TIPO PRECISOU ENTRAR NO CHECK. `radar_notifications_tipo_check` tem uma
-- lista fechada, e um tipo novo seria rejeitado no INSERT — o mesmo erro que o
-- CHECK de plano de `profile_backups` me custou hoje. Desta vez li as
-- constraints ANTES de escrever o INSERT.
--
-- Os outros limites da tabela, todos respeitados abaixo:
--   title       1..80 chars
--   body        1..200 chars
--   url         ~ '^/[a-zA-Z0-9/_#?=&-]{0,199}$'
--   dedupe_key  3..120 chars, UNIQUE (user_id, dedupe_key)
--   fire_at     < created_at + 60 dias
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.radar_notifications
  DROP CONSTRAINT IF EXISTS radar_notifications_tipo_check;

ALTER TABLE public.radar_notifications
  ADD CONSTRAINT radar_notifications_tipo_check CHECK (tipo = ANY (ARRAY[
    'conta_vence', 'fatura_fecha', 'assinatura_renova', 'orcamento_estouro',
    'lembrete', 'resumo_semanal', 'meta_batida', 'convite_reserva',
    'saida_reserva'
  ]));

-- ── A notificação ───────────────────────────────────────────────────────────
--
-- Quem recebe: o DONO da conta e os convidados ativos, menos ninguém — as
-- reservas são intra-conta (perfis da mesma conta), e a caixa do sino é por
-- `user_id`. Quem excluiu o perfil também recebe: numa conta família, quem
-- clicou pode não ser quem participava da reserva.
--
-- `fire_at = now()`: é aviso de algo que JÁ aconteceu, não agendamento.
--
-- IDEMPOTENTE por construção: `UNIQUE (user_id, dedupe_key)` + ON CONFLICT.
-- Excluir o mesmo perfil duas vezes não enche a caixa de entrada.
CREATE OR REPLACE FUNCTION public.notificar_saida_de_reserva(
    p_owner_user_id uuid,
    p_nome_perfil   text,
    p_reservas      jsonb   -- [{perfil, meta, nome}] vindo da edge
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_nome    text := left(COALESCE(NULLIF(trim(p_nome_perfil), ''), 'Um perfil'), 40);
    v_qtd     int  := COALESCE(jsonb_array_length(p_reservas), 0);
    v_title   text;
    v_body    text;
    v_dedupe  text;
    v_criadas int  := 0;
BEGIN
    IF p_owner_user_id IS NULL OR v_qtd = 0 THEN
        RETURN 0;
    END IF;

    -- Dentro dos limites da tabela (80 / 200). O nome já vem cortado em 40.
    v_title := left(v_nome || ' saiu de uma reserva', 80);
    v_body  := left(
        v_nome || ' foi excluído e saiu de ' ||
        CASE WHEN v_qtd = 1 THEN 'uma reserva compartilhada'
             ELSE v_qtd || ' reservas compartilhadas' END ||
        '. O valor que ele guardou continua lá. Toque para ajustar o saldo.',
        200);

    -- Uma entrada por saída de perfil, por dia. Sem a data, uma exclusão e uma
    -- restauração seguidas no mesmo perfil colidiriam para sempre.
    v_dedupe := left('saida_reserva:' || v_nome || ':' || to_char(now(), 'YYYYMMDDHH24MI'), 120);

    INSERT INTO public.radar_notifications
        (user_id, dedupe_key, tipo, title, body, url, fire_at, status)
    SELECT u, v_dedupe, 'saida_reserva', v_title, v_body, '/dashboard#metas', now(), 'pending'
    FROM (
        SELECT p_owner_user_id AS u
        UNION
        SELECT am.member_user_id
        FROM public.account_members am
        WHERE am.owner_user_id = p_owner_user_id AND am.is_active = true
    ) alvos
    WHERE u IS NOT NULL
    ON CONFLICT (user_id, dedupe_key) DO NOTHING;

    GET DIAGNOSTICS v_criadas = ROW_COUNT;
    RETURN v_criadas;
END;
$function$;

REVOKE ALL ON FUNCTION public.notificar_saida_de_reserva(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notificar_saida_de_reserva(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.notificar_saida_de_reserva(uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.notificar_saida_de_reserva(uuid, text, jsonb) TO service_role;
