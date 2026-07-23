-- 20260723000000_drop_orphan_srm_functions.down.sql
-- GranaEvo — Rollback: 20260723000000_drop_orphan_srm_functions.sql
-- ATENCAO: so em emergencia. Restaura as 2 funcoes orfas e o grant publico de
-- purge_signup_email_codes ao estado pre-fix (MENOS seguro — reintroduz os WARN
-- do linter). So faz sentido se a feature "reserva compartilhada" for reativada.
--
-- Ordem inversa ao UP: primeiro restaura o grant, depois recria as funcoes.
-- Nota: srm_barrar_delete_negativo referencia shared_reserve_movements (tabela
-- inexistente hoje). O corpo plpgsql so e validado em execucao, entao o CREATE
-- funciona; a funcao so seria util com a tabela de volta.

GRANT EXECUTE ON FUNCTION public.purge_signup_email_codes() TO PUBLIC;

CREATE OR REPLACE FUNCTION public.srm_anonimizar_membro_excluido()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- Dispara quando o FK ON DELETE SET NULL corta o vinculo (exclusao de conta).
    -- O movimento sobrevive para o saldo fechar; a identidade some.
    IF OLD.member_user_id IS NOT NULL AND NEW.member_user_id IS NULL THEN
        NEW.member_name := 'Membro removido';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.srm_barrar_delete_negativo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_saldo numeric(12,2);
BEGIN
    -- Mesmo lock do INSERT (mesma chave): serializa DELETE contra INSERT
    -- concorrente na MESMA reserva, senao os dois leem o saldo pre-mudanca.
    PERFORM pg_advisory_xact_lock(hashtext(OLD.reserve_id::text)::bigint);

    SELECT COALESCE(SUM(CASE WHEN tipo = 'aporte' THEN valor ELSE -valor END), 0)
    INTO v_saldo
    FROM public.shared_reserve_movements
    WHERE reserve_id = OLD.reserve_id
      AND id <> OLD.id;               -- saldo SEM a linha que esta saindo

    IF v_saldo < 0 THEN
        RAISE EXCEPTION 'desfazer este lancamento deixaria a reserva negativa (saldo ficaria %)', v_saldo;
    END IF;

    RETURN OLD;
END;
$function$;
