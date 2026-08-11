-- 20260811010000_revogar_sessoes_no_reset.down.sql
-- GranaEvo — Rollback: 20260811010000_revogar_sessoes_no_reset.sql
-- ATENCAO: so em emergencia. Reverte o SEC-008 — o reset de senha volta a NAO
-- encerrar as sessoes existentes, e uma conta comprometida continua comprometida
-- depois de a vitima trocar a senha.
--
-- ORDEM: derrube o CHAMADOR primeiro. Se a funcao sumir enquanto a Edge Function
-- ainda a invoca, todo reset de senha passa a logar erro. A chamada la e
-- best-effort (nao derruba a troca de senha), entao o usuario nao fica travado —
-- mas o log enche sem motivo.
--
--   1. deploy da versao anterior de supabase/functions/verify-and-reset-password
--   2. este script

DROP FUNCTION IF EXISTS public.revogar_sessoes_usuario(uuid);
