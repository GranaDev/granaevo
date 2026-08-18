-- =============================================================================
-- DOWN — reverte 20260627000000_god_mode_hardening.sql
-- ATENÇÃO: restaura superfícies de ataque. Use apenas para rollback controlado.
-- =============================================================================

BEGIN;

-- [GM-03] / [GM-02] restaurar EXECUTE a PUBLIC (estado anterior)
GRANT EXECUTE ON FUNCTION public.set_profile_user_id()             TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_profile_limit_stripe()    TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.identificar_dados_para_retencao() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_push_subscriptions()      TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_rate_limits()     TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_audit_log_retention()       TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_abandoned_accounts()      TO PUBLIC;

-- [GM-01] restaurar UPDATE no cliente + policy de claim
GRANT UPDATE ON public.stripe_subscriptions TO authenticated;
CREATE POLICY "stripe_sub_update_claim"
  ON public.stripe_subscriptions FOR UPDATE
  TO authenticated
  USING ((user_id IS NULL) AND (lower(user_email) = lower((auth.jwt() ->> 'email'))))
  WITH CHECK (auth.uid() = user_id);

NOTIFY pgrst, 'reload schema';

COMMIT;
