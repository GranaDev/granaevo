-- ROLLBACK de 20260821000000_purgas_falham_alto_e_fotos_orfas.sql
--
-- ⚠️ Fica em supabase/rollbacks/ de propósito: `.down.sql` dentro de
--    supabase/migrations/ faz o `db push` tentar APLICÁ-LO como migration.
--    Ver supabase/rollbacks/ROLLBACK_CONVENTION.md.
--
-- ⚠️ Reverter os ACHADOS 1a/1b devolve o modo de falha SILENCIOSO: 100% das
--    exclusões podem falhar e os crons continuarão gravando `succeeded`. Só
--    reverta se a propagação de exceção estiver derrubando um job por um motivo
--    que você JÁ entendeu — e prefira corrigir a causa a religar o silêncio.
--
-- Os corpos abaixo são cópia fiel do que estava em produção antes de 2026-08-21
-- (lidos de pg_proc.prosrc), inclusive o search_path `public, extensions, pg_temp`.

BEGIN;

-- ── Desfaz o ACHADO 2 ───────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.listar_fotos_orfas();

-- ── Desfaz o ACHADO 1a ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_unpaid_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
      AND NOT EXISTS (
        SELECT 1 FROM public.account_members am
        WHERE am.member_user_id = u.id
          AND am.is_active = true
      )
  LOOP
    BEGIN
      DELETE FROM public.account_members      WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members      WHERE owner_user_id  = v_user_id;
      DELETE FROM public.user_data            WHERE user_id        = v_user_id;
      DELETE FROM public.profiles             WHERE user_id        = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id        = v_user_id;
      DELETE FROM auth.users                  WHERE id             = v_user_id;

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

-- ── Desfaz o ACHADO 1b ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '90 days';
BEGIN
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.stripe_subscriptions s
    WHERE  s.status  = 'canceled'
      AND  s.user_id IS NOT NULL
      AND  COALESCE(s.current_period_end, s.canceled_at, s.created_at) < v_cutoff
      AND  NOT EXISTS (
             SELECT 1 FROM public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
           )
      AND  NOT EXISTS (
             SELECT 1 FROM public.account_members am
             WHERE  am.member_user_id = s.user_id
               AND  am.is_active = true
           )
  LOOP
    BEGIN
      DELETE FROM public.user_data            WHERE user_id = v_user_id;
      DELETE FROM public.profiles             WHERE user_id = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users                  WHERE id      = v_user_id;

      v_count := v_count + 1;
      RAISE LOG '[purge_expired] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$function$;

COMMIT;
