-- 20260714120000_drop_orphan_trigger_functions.sql
-- Passo 3 do docs/roadmap-melhorias-dev.md — limpeza de cruft (2026-07-14).
--
-- Remove 4 funções de trigger ÓRFÃS: nenhum trigger as referencia (verificado em
-- pg_trigger) e o EXECUTE já estava revogado de anon/authenticated (migrations
-- 20260625/20260627). Cada proteção que davam continua coberta por mecanismo ATIVO:
--   prevent_user_id_change    -> profiles: trigger `enforce_user_id_immutable`;
--                                user_data: RLS UPDATE WITH CHECK (auth.uid() = user_id)
--   set_profile_user_id       -> profiles INSERT RLS WITH CHECK (user_id = auth.uid())
--                                (+ o app envia o user_id)
--   update_updated_at         -> cada tabela usa seu próprio trigger de timestamp
--   update_updated_at_column     (ex.: user_data.trigger_update_user_data_timestamp)
--
-- Dead code. Rollback: recriar as funções (definições em git / supabase/schema/public_baseline.sql).
-- NOTA: regenerar public_baseline.sql na próxima varredura (ele ainda lista estas 4).

DROP FUNCTION IF EXISTS public.prevent_user_id_change();
DROP FUNCTION IF EXISTS public.set_profile_user_id();
DROP FUNCTION IF EXISTS public.update_updated_at();
DROP FUNCTION IF EXISTS public.update_updated_at_column();
