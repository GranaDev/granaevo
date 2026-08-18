-- Rollback de 20260716180000_fix_null_period_grants_forever.sql
--
-- ⚠️ ATENÇÃO: reverter isto REABRE o vazamento de receita. O ramo
-- `current_period_end IS NULL` volta a conceder acesso permanente a qualquer
-- assinatura Stripe gravada sem período. Só reverta se a correção do webhook
-- (mesmo commit) também for revertida E você aceitar o acesso gratuito eterno.
ALTER TABLE public.stripe_subscriptions DROP CONSTRAINT IF EXISTS stripe_sub_ativa_exige_periodo;
-- A versão anterior de get_user_access_data está em
-- 20260606000001_get_user_access_rpc.sql — reaplique-a manualmente se necessário.
