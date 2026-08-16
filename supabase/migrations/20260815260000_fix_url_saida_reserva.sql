-- FIX: a notificação de saída de reserva apontava para a âncora errada.
--
-- Eu usei '/dashboard#metas'; a notificação de CONVITE — que já funcionava e
-- foi meu modelo — usa '/dashboard#reservas'. Clicar não levava a lugar nenhum
-- útil. Duas notificações sobre o mesmo assunto precisam levar ao mesmo lugar.
--
-- Só o literal da URL muda; o resto da função é idêntico à 20260815250000.

CREATE OR REPLACE FUNCTION public.notificar_saida_de_reserva(
    p_owner_user_id uuid,
    p_nome_perfil   text,
    p_reservas      jsonb
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

    v_title := left(v_nome || ' saiu de uma reserva', 80);
    v_body  := left(
        v_nome || ' foi excluído e saiu de ' ||
        CASE WHEN v_qtd = 1 THEN 'uma reserva compartilhada'
             ELSE v_qtd || ' reservas compartilhadas' END ||
        '. O valor que ele guardou continua lá. Toque para ajustar o saldo.',
        200);

    v_dedupe := left('saida_reserva:' || v_nome || ':' || to_char(now(), 'YYYYMMDDHH24MI'), 120);

    INSERT INTO public.radar_notifications
        (user_id, dedupe_key, tipo, title, body, url, fire_at, status)
    SELECT u, v_dedupe, 'saida_reserva', v_title, v_body,
           '/dashboard#reservas',   -- mesma âncora do convite_reserva
           now(), 'pending'
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
