-- =============================================================================
-- GranaEvo — Fecha bypass do limite de perfis por plano (/god-eyes 2026-06-26)
-- Rollback: ver 20260626000000_fix_profile_limit_bypass.down.sql
--
-- Contexto (achado ALTO):
--   `authenticated` insere em profiles direto (client). Havia 2 policies INSERT
--   permissivas (OR): profiles_insert_own (com can_create_profile()) e
--   guest_can_insert_owner_profiles (com o ramo self-insert `auth.uid()=user_id`).
--   Como permissivas combinam por OR, o self-insert escapava do limite → um plano
--   individual podia criar perfis ilimitados via PostgREST com a anon key pública.
--
--   ATENÇÃO: NÃO usar a função legada check_profile_limit()/max_profiles_for_user()
--   para isso — ela lê a relação `subscriptions` que NÃO existe mais (hoje é
--   stripe_subscriptions) e quebra todo INSERT. (Ver god-eyes 2026-06-25.)
--
-- Correção (defesa em profundidade):
--   1) RLS: remove o ramo self-insert da policy de convidado. Self-insert passa a
--      depender de profiles_insert_own (que exige can_create_profile()).
--   2) Trigger BEFORE INSERT que valida o limite para NEW.user_id (o DONO) usando a
--      fonte VIVA (stripe_subscriptions). Cobre TODOS os caminhos (own, convidado,
--      service_role/RPC). Semântica: limite por conta/dono (casal=2 total etc.).
--      Degrade seguro: sem plano ativo => 1 (nunca 0, não trava 1º perfil).
--
-- Verificado em prod (transação + ROLLBACK): at-limit bloqueia (PLAN_LIMIT_EXCEEDED),
-- under-limit permite; nenhuma edge function do Stripe faz INSERT em profiles.
-- =============================================================================

-- 1) RLS — só o ramo de membro ativo
ALTER POLICY "guest_can_insert_owner_profiles" ON public.profiles
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.account_members
      WHERE account_members.owner_user_id  = profiles.user_id
        AND account_members.member_user_id = auth.uid()
        AND account_members.is_active = true
    )
  );

-- 2) Trigger de limite (fonte viva: stripe_subscriptions)
CREATE OR REPLACE FUNCTION public.enforce_profile_limit_stripe()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_count int;
    v_plan  text;
    v_max   int;
BEGIN
    -- Lock anti-race nas linhas do dono-alvo
    PERFORM 1 FROM public.profiles WHERE user_id = NEW.user_id FOR UPDATE;

    SELECT COUNT(*) INTO v_count
    FROM public.profiles WHERE user_id = NEW.user_id;

    -- Plano vivo do dono-alvo (NEW.user_id), por user_id ou email confirmado
    SELECT lower(ss.plan_name) INTO v_plan
    FROM public.stripe_subscriptions ss
    WHERE (ss.user_id = NEW.user_id
           OR lower(ss.user_email) = lower((SELECT email FROM auth.users WHERE id = NEW.user_id)))
      AND ss.status IN ('active', 'trialing')
      AND (ss.current_period_end IS NULL OR ss.current_period_end > now())
    ORDER BY ss.created_at DESC
    LIMIT 1;

    v_max := CASE v_plan
        WHEN 'individual' THEN 1
        WHEN 'casal'      THEN 2
        WHEN 'familia'    THEN 4
        ELSE 1                        -- sem plano ativo => 1 (degrade seguro, NÃO 0)
    END;

    IF v_count >= v_max THEN
        RAISE EXCEPTION 'PLAN_LIMIT_EXCEEDED: limite de % perfis atingido', v_max;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_profile_limit_stripe ON public.profiles;
CREATE TRIGGER enforce_profile_limit_stripe
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_limit_stripe();
