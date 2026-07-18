-- ----------------------------------------------------------------------------
-- 20260718000000 — remove as tabelas da reserva compartilhada (item 13)
--
-- POR QUE: a reserva compartilhada foi RECONSTRUÍDA como caixinha normal dentro
-- do blob (meta.compartilhada), commit 16d8860. A premissa que justificava estas
-- tabelas ("o convidado não escreve no blob") estava errada: get-user-data e
-- save-user-data resolvem o dono via account_members, então dono e convidado
-- compartilham UM blob — o convidado escreve normalmente. Manter as tabelas
-- deixaria superfície RLS morta (o /god-eyes sinaliza) e duas fontes de verdade
-- para o mesmo recurso.
--
-- SEGURANÇA DO DADO (conferido no banco de produção em 2026-07-18, antes do DROP):
--   shared_reserves ............ 1 linha (reserva vazia, criada no teste)
--   shared_reserve_movements ... 0 linhas
--   Σ aportes = R$ 0,00 · Σ retiradas = R$ 0,00
-- Ou seja: nenhum dinheiro de usuário é perdido aqui. Se este DROP for reaplicado
-- num ambiente onde os movimentos NÃO estejam zerados, PARE e migre antes.
--
-- CASCADE remove junto: policies, índices e triggers das duas tabelas. As duas
-- funções de trigger não caem com o CASCADE (não pertencem à tabela) — por isso
-- são dropadas explicitamente, senão ficariam órfãs no schema.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS public.shared_reserve_movements CASCADE;
DROP TABLE IF EXISTS public.shared_reserves          CASCADE;

DROP FUNCTION IF EXISTS public.srm_forcar_owner();
DROP FUNCTION IF EXISTS public.shared_reserves_limite();
