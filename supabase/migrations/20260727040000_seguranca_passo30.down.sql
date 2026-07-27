-- 20260727040000_seguranca_passo30.down.sql
-- GranaEvo — Rollback de 20260727040000_seguranca_passo30.sql
--
-- ⚠️ Este rollback REABRE as falhas S-3, S-4, S-5 e S-6 e volta a permitir que a
-- purga apague um convidado ativo (M-4). Só use se algo aqui tiver quebrado
-- funcionalidade — e, nesse caso, reverta o item específico, não o bloco todo.

-- S-3
REVOKE SELECT ON public.user_data_snapshots FROM authenticated;
GRANT  SELECT ON public.user_data_snapshots TO authenticated;

-- S-4
GRANT UPDATE, DELETE ON public.terms_acceptance TO authenticated;

-- S-5 (as policies eram inertes; recriadas iguais ao estado anterior)
CREATE POLICY "Users can delete own profiles" ON public.profiles
    FOR DELETE TO public USING (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.user_profile_management
    FOR UPDATE TO public USING (auth.uid() = user_id);
CREATE POLICY feature_flags_select_auth ON public.feature_flags
    FOR SELECT TO authenticated USING (true);

ALTER TABLE public.chat_parse_usage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.edge_rate_limits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.login_lockouts   NO FORCE ROW LEVEL SECURITY;

-- S-6 — volta a aceitar só o GUC, sem exigir current_user
CREATE OR REPLACE FUNCTION public.bloquear_alteracao_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('granaevo.audit_retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '[SEGURANCA] Audit log e imutavel. Operacao bloqueada: % na tabela %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END;
$function$;

-- M-4 — remove a guarda de convidado (NÃO recomendado: foi o bug de 2026-07-01)
CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user_id   UUID;
  v_count     integer := 0;
  v_cutoff    TIMESTAMPTZ := NOW() - INTERVAL '90 days';
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
  LOOP
    BEGIN
      DELETE FROM public.user_data            WHERE user_id = v_user_id;
      DELETE FROM public.profiles             WHERE user_id = v_user_id;
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;
      DELETE FROM auth.users                  WHERE id      = v_user_id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$function$;

NOTIFY pgrst, 'reload schema';
