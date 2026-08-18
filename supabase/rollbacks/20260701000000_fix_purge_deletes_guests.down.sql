-- =============================================================================
-- ROLLBACK de 20260701000000_fix_purge_deletes_guests.sql
-- Restaura as funções SEM a guarda de membro ativo (volta ao comportamento que
-- apaga convidados). Use apenas se a guarda causar algum efeito indesejado.
-- =============================================================================

-- ── 1. purge_unpaid_accounts() — versão original (sem guarda de membro) ──────
CREATE OR REPLACE FUNCTION public.purge_unpaid_accounts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'extensions', 'public', 'auth'
AS $function$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users u
    WHERE u.created_at < v_cutoff
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
  LOOP
    BEGIN
      DELETE FROM public.account_members   WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members   WHERE owner_user_id  = v_user_id;
      DELETE FROM public.user_data         WHERE user_id        = v_user_id;
      DELETE FROM public.profiles          WHERE user_id        = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id    = v_user_id;
      DELETE FROM auth.users               WHERE id             = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_unpaid] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_unpaid] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_unpaid] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$function$;

-- ── 2. cleanup_abandoned_accounts() — versão original (sem guarda de membro) ─
CREATE OR REPLACE FUNCTION public.cleanup_abandoned_accounts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
    deleted_count INTEGER := 0;
    v_id          UUID;
BEGIN
    FOR v_id IN
        SELECT u.id
        FROM auth.users u
        WHERE u.created_at < NOW() - INTERVAL '3 days'
          AND u.email NOT LIKE '%@granaevo.com'
          AND NOT EXISTS (
              SELECT 1 FROM public.stripe_subscriptions ss
              WHERE ss.user_id = u.id
                AND ss.status IN ('active', 'trialing')
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.user_data ud
              WHERE ud.user_id = u.id
          )
    LOOP
        DELETE FROM public.terms_acceptance  WHERE user_id = v_id;
        DELETE FROM public.user_data         WHERE user_id = v_id;
        DELETE FROM public.account_members
            WHERE member_user_id = v_id
               OR owner_user_id  = v_id;
        DELETE FROM public.stripe_subscriptions WHERE user_id = v_id;
        DELETE FROM auth.users WHERE id = v_id;

        deleted_count := deleted_count + 1;
    END LOOP;

    DELETE FROM public.stripe_subscriptions
    WHERE user_id IS NULL
      AND status NOT IN ('active', 'trialing')
      AND created_at < NOW() - INTERVAL '3 days';

    DELETE FROM public.stripe_events
    WHERE processed_at < NOW() - INTERVAL '90 days';

    RAISE NOTICE '[cleanup] % usuário(s) abandonado(s) removido(s).', deleted_count;
    RETURN deleted_count;
END;
$function$;
