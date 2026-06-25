-- =============================================================================
-- GranaEvo — Limpeza de políticas RLS redundantes em user_data (varredura 2026-06-25)
-- Rollback: ver 20260625000001_cleanup_user_data_redundant_policies.down.sql
--
-- Contexto:
--   A tabela user_data acumulou pares de políticas PERMISSIVE sobrepostas. Como
--   políticas permissivas são combinadas com OR, a política redundante de cada par
--   não amplia nem restringe o acesso — é apenas cruft que confunde auditoria.
--
--   1) INSERT: `user_data_owner_insert` é IDÊNTICA a `user_data_insert`
--      (with_check `user_id = auth.uid()` vs `auth.uid() = user_id` — mesma condição).
--      → remove `user_data_owner_insert`, mantém `user_data_insert`.
--
--   2) SELECT: `user_data_owner_select` (role public, qual `user_id = auth.uid()`) é um
--      SUBCONJUNTO ESTRITO de `user_data_select` (role authenticated, qual
--      `auth.uid() = user_id OR (membro ativo em account_members)`). O primeiro disjunto
--      de user_data_select já cobre a condição de dono; para anon, `auth.uid()` é NULL e
--      a política não retorna linha alguma. Logo owner_select não concede nada extra.
--      → remove `user_data_owner_select`, mantém `user_data_select`
--        (esta carrega o compartilhamento casal/família via account_members — NÃO remover).
--
-- Efeito: nenhuma mudança de acesso efetivo. Apenas reduz duplicidade.
-- Idempotente: DROP POLICY IF EXISTS.
-- =============================================================================

DROP POLICY IF EXISTS user_data_owner_insert ON public.user_data;
DROP POLICY IF EXISTS user_data_owner_select ON public.user_data;
