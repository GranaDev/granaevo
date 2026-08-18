-- Rollback de 20260716230000_god_eyes_locks_e_invariantes.sql
-- ⚠️ Reabre: saldo negativo na reserva via DELETE; 2 perfis no plano individual
-- por corrida no 1º INSERT; teto de reservas burlável. Versões antigas no git.
DROP TRIGGER  IF EXISTS trg_srm_barrar_delete_negativo ON public.shared_reserve_movements;
DROP FUNCTION IF EXISTS public.srm_barrar_delete_negativo();
