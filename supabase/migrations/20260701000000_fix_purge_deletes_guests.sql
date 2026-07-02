-- =============================================================================
-- GranaEvo — Impede que os crons de purga apaguem CONVIDADOS (plano casal/família)
-- Rollback: ver 20260701000000_fix_purge_deletes_guests.down.sql
--
-- BUG (severidade ALTA — perda de acesso do convidado):
--   Usuários de plano casal/família convidam outra pessoa. O convidado ganha uma
--   conta em auth.users e um vínculo em account_members (member_user_id), mas
--   NUNCA tem stripe_subscription própria — o acesso dele deriva da assinatura do
--   DONO (ver check-user-access/index.ts, passo 10).
--
--   As funções de purga identificam "conta não paga / abandonada" apenas pela
--   AUSÊNCIA de stripe_subscription própria:
--     • purge_unpaid_accounts()      (job 22, roda 02:30 e 14:30) → apaga contas
--       com >24h e sem assinatura → apaga o convidado ~1 dia depois de ele entrar.
--     • cleanup_abandoned_accounts() (job 11, roda 03:00) → apaga contas com >3d
--       sem assinatura E sem user_data → convidado também não tem user_data próprio.
--   Ambas fazem DELETE em account_members + auth.users do convidado. Resultado: o
--   convite "some" depois de alguns dias (observado em produção: account_members
--   ficou zerada; convidado immelziiin@gmail.com, convite usado 29/06, já não
--   existia mais em 01/07).
--
-- FIX:
--   Adiciona guarda em AMBAS as funções: nunca selecionar para exclusão um usuário
--   que seja MEMBRO ATIVO de alguma conta (account_members.member_user_id = u.id
--   AND is_active). Donos já estão protegidos pela checagem de assinatura ativa.
--   purge_expired_cancelled_accounts() não é afetada (exige linha canceled própria,
--   que convidado nunca tem) — sem alteração.
-- =============================================================================

-- ── 1. purge_unpaid_accounts() ───────────────────────────────────────────────
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
      -- Nunca teve assinatura Stripe paga (inclui usuários Cakto migrados, pois
      -- agora todos estão em stripe_subscriptions com status 'active')
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
      -- [FIX] NÃO apagar convidados: membro ativo de plano casal/família acessa
      -- pela assinatura do dono e nunca tem assinatura própria.
      AND NOT EXISTS (
        SELECT 1 FROM public.account_members am
        WHERE am.member_user_id = u.id
          AND am.is_active = true
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

-- ── 2. cleanup_abandoned_accounts() ──────────────────────────────────────────
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
          -- Sem assinatura Stripe ativa (inclui Cakto migrado)
          AND NOT EXISTS (
              SELECT 1 FROM public.stripe_subscriptions ss
              WHERE ss.user_id = u.id
                AND ss.status IN ('active', 'trialing')
          )
          -- Sem dados de uso no app
          AND NOT EXISTS (
              SELECT 1 FROM public.user_data ud
              WHERE ud.user_id = u.id
          )
          -- [FIX] NÃO apagar convidados: membro ativo de plano casal/família não
          -- tem assinatura nem user_data próprios, mas é uma conta legítima.
          AND NOT EXISTS (
              SELECT 1 FROM public.account_members am
              WHERE am.member_user_id = u.id
                AND am.is_active = true
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

    -- Limpa stripe_subscriptions sem usuário, inativas e antigas
    DELETE FROM public.stripe_subscriptions
    WHERE user_id IS NULL
      AND status NOT IN ('active', 'trialing')
      AND created_at < NOW() - INTERVAL '3 days';

    -- Limpa eventos Stripe expirados (idempotência > 90 dias)
    DELETE FROM public.stripe_events
    WHERE processed_at < NOW() - INTERVAL '90 days';

    RAISE NOTICE '[cleanup] % usuário(s) abandonado(s) removido(s).', deleted_count;
    RETURN deleted_count;
END;
$function$;
