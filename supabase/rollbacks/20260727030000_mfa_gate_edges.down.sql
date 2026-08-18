-- 20260727030000_mfa_gate_edges.down.sql
-- GranaEvo — Rollback de 20260727030000_mfa_gate_edges.sql
--
-- ⚠️ ORDEM IMPORTA: as Edge Functions `get-user-data` e `save-user-data` chamam
-- `mfa_bloqueia` e FALHAM FECHADO se a RPC der erro — dropar a função com as
-- edges no ar deixa TODO MUNDO sem carregar nem salvar dados.
-- Faça o rollback das edges (redeploy do commit anterior) ANTES de rodar isto.

-- (nenhum indice a remover: a migration UP nao cria nenhum)
DROP FUNCTION IF EXISTS public.mfa_bloqueia(uuid, text);

NOTIFY pgrst, 'reload schema';
