-- 20260819010000_account_members_guard_reativar.down.sql
-- GranaEvo — Rollback: 20260819010000_account_members_guard_reativar.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
--
-- Remove o trigger e a função que impedem o cliente de REATIVAR convidado
-- (false/NULL → true). Reverter REABRE o SEC-001d: o dono volta a poder burlar
-- o limite de convidados do plano via PATCH direto no PostgREST.
--
-- Não destrói dados. Ordem inversa ao UP: trigger antes da função.

DROP TRIGGER   IF EXISTS account_members_guard_reativar ON public.account_members;
DROP FUNCTION  IF EXISTS public.trg_account_members_guard_reativar();
