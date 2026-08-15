-- ROLLBACK de 20260815160000_snapshot_sob_demanda.sql
--
-- ⚠️ Só reverta JUNTO com o cliente e a edge. Sozinho, o reset volta a
-- prometer na tela um backup que não existe — que é o defeito que a migration
-- existe para corrigir. A edge recusa o reset quando a RPC falha, então o
-- rollback isolado deixa o botão de reset inoperante (falha fechada, que é o
-- lado seguro, mas não é o comportamento pretendido).
--
-- Os snapshots já gravados por ela permanecem: são linhas normais de
-- `user_data_snapshots` e seguem a retenção de 5 dias.

DROP FUNCTION IF EXISTS public.snapshot_sob_demanda(uuid);
