-- O-3 (Passo 32) — funde as DUAS policies permissivas de SELECT do audit log
-- ===========================================================================
-- Com duas policies PERMISSIVE no mesmo comando, o Postgres avalia AS DUAS em
-- toda linha e faz OR do resultado. Numa tabela de 21.577 linhas — a maior do
-- banco, e a que mais cresce — isso é trabalho repetido em toda leitura.
--
-- A fusão é mecânica e SEM mudança de semântica: as duas cobriam colunas
-- diferentes e independentes, então `A OR B` é exatamente o que já acontecia.
--
--   audit_log_select_own    →  auth.uid() = user_id
--   audit_log_owner_select  →  actor_id   = auth.uid()
--   fundida                 →  user_id = auth.uid() OR actor_id = auth.uid()
--
-- POR QUE SÓ ESTA, SE O ADVISOR APONTA TRÊS
-- `profiles` (10 linhas) e `stripe_subscriptions` (7 linhas) também têm o par,
-- e ficam como estão de propósito. Em tabela desse tamanho o ganho é
-- imensurável, e a de `profiles` é INSERT — exatamente a área do S-1, o bypass
-- de limite de perfis corrigido em 20260727010000. Trocar risco de RLS por
-- ganho que não dá para medir é mau negócio. Otimizar RLS é mexer em controle
-- de acesso com roupa de performance.
--
-- `(SELECT auth.uid())` e não `auth.uid()`: o subselect é avaliado UMA vez por
-- consulta em vez de uma vez por linha. É a forma que as policies atuais já
-- usam, mantida aqui.
-- ===========================================================================

DROP POLICY IF EXISTS audit_log_select_own   ON public.financial_audit_log;
DROP POLICY IF EXISTS audit_log_owner_select ON public.financial_audit_log;

CREATE POLICY audit_log_select_own ON public.financial_audit_log
  FOR SELECT TO authenticated
  USING (
        user_id  = (SELECT auth.uid())
     OR actor_id = (SELECT auth.uid())
  );
