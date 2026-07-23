-- 20260723000000_drop_orphan_srm_functions.sql
-- GranaEvo — Migration: remove 2 funcoes orfas + fecha grant publico desnecessario
-- Rollback: ver 20260723000000_drop_orphan_srm_functions.down.sql
--
-- CONTEXTO (auditoria god-mode/god-eyes 2026-07-23, pos-migracao de JWT/chaves):
-- A migration 20260718000000_drop_shared_reserves removeu as tabelas da reserva
-- compartilhada e 2 das 4 funcoes de trigger (srm_forcar_owner, shared_reserves_limite),
-- mas ESQUECEU as outras duas. Com as tabelas/triggers ja dropados, elas ficaram
-- ORFAS no schema (0 triggers, 0 dependencias — confirmado no banco de producao):
--   . srm_anonimizar_membro_excluido()  (SECURITY DEFINER)
--   . srm_barrar_delete_negativo()      (referencia shared_reserve_movements, que nao existe mais)
-- Ambas apareciam como WARN no linter (SECURITY DEFINER/funcao executavel por anon).
-- Nenhuma e exploravel (uma erra por falta de contexto de trigger; a outra referencia
-- tabela inexistente) — sao codigo morto e saem aqui, completando o rollback da feature.
--
-- Alem disso: purge_signup_email_codes() (funcao de cron que so apaga codigos de
-- cadastro ja expirados >24h) tinha EXECUTE herdado por PUBLIC -> anon/authenticated
-- podiam chama-la via RPC. E cron-only; revogamos o acesso publico. O cron roda como
-- postgres (grant explicito preservado), entao NAO quebra.

DROP FUNCTION IF EXISTS public.srm_anonimizar_membro_excluido();
DROP FUNCTION IF EXISTS public.srm_barrar_delete_negativo();

REVOKE EXECUTE ON FUNCTION public.purge_signup_email_codes() FROM PUBLIC, anon, authenticated;
