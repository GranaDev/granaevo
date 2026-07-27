-- 20260727020000_mfa_aal2_enforcement.down.sql
-- GranaEvo — Rollback de 20260727020000_mfa_aal2_enforcement.sql
--
-- ⚠️ REVERTER faz o 2FA voltar a proteger apenas o LOGIN, não o DADO: uma sessão
-- `aal1` de um usuário que ATIVOU o 2FA volta a ler e gravar tudo via PostgREST.
-- Reverta se as policies restritivas causarem bloqueio indevido — e, nesse caso,
-- investigue `public.mfa_pendente()` em vez de deixar o enforcement desligado.

DO $$
DECLARE
    t text;
    alvos text[] := ARRAY[
        'account_members', 'financial_audit_log', 'profiles', 'push_subscriptions',
        'radar_notifications', 'stripe_subscriptions', 'terms_acceptance',
        'user_data', 'user_data_snapshots', 'user_devices', 'user_profile_management'
    ];
BEGIN
    FOREACH t IN ARRAY alvos LOOP
        EXECUTE format('DROP POLICY IF EXISTS exige_aal2 ON public.%I', t);
    END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.mfa_pendente();

NOTIFY pgrst, 'reload schema';
