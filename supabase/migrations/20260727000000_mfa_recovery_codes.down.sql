-- 20260727000000_mfa_recovery_codes.down.sql
-- GranaEvo — Rollback da migration 20260727000000_mfa_recovery_codes.sql
--
-- ⚠️ ANTES DE RODAR: se algum usuário estiver com MFA ATIVO, este rollback apaga
-- os códigos de recuperação dele. Quem perder o celular depois disso fica sem
-- caminho de volta. Confira antes:
--   SELECT count(*) FROM auth.mfa_factors WHERE status = 'verified';
-- Se retornar > 0, desative o MFA desses usuários (ou avise-os) antes de reverter.

DROP POLICY IF EXISTS mfa_recovery_deny_all ON public.mfa_recovery_codes;
DROP INDEX  IF EXISTS public.idx_mfa_recovery_user_unused;
DROP TABLE  IF EXISTS public.mfa_recovery_codes;

NOTIFY pgrst, 'reload schema';
