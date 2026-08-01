-- Rollback — separa de volta nas DUAS policies originais.
--
-- Definições copiadas de `pg_policies` em produção ANTES do DROP, não escritas
-- de memória: `qual` era exatamente `(actor_id = ( SELECT auth.uid() AS uid))`
-- e `(( SELECT auth.uid() AS uid) = user_id)`.
--
-- ⚠️ Dropar a fundida ANTES de criar as duas. Se a ordem inverter e a criação
-- falhar no meio, a tabela fica sem policy de SELECT — e com RLS ligado isso
-- não é "aberto", é FECHADO: ninguém lê o próprio audit log. Rollback que
-- deixa a tabela pior que o problema não é rollback.

DROP POLICY IF EXISTS audit_log_select_own ON public.financial_audit_log;

CREATE POLICY audit_log_select_own ON public.financial_audit_log
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY audit_log_owner_select ON public.financial_audit_log
  FOR SELECT TO authenticated
  USING (actor_id = (SELECT auth.uid()));
