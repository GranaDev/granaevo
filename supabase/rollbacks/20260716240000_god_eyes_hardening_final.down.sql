-- Rollback de 20260716240000_god_eyes_hardening_final.sql
-- ⚠️ Reabre: dono trocando ocupante do assento sem convite; policies do radar
-- valendo para `public`; nome de membro excluído perpetuado na trilha (LGPD).
DROP TRIGGER  IF EXISTS trg_srm_anonimizar_membro ON public.shared_reserve_movements;
DROP FUNCTION IF EXISTS public.srm_anonimizar_membro_excluido();
GRANT UPDATE ON public.account_members TO authenticated;
ALTER TABLE public.shared_reserves          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shared_reserve_movements NO FORCE ROW LEVEL SECURITY;
