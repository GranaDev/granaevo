-- =============================================================================
-- GranaEvo — Migration: Squash do histórico de migrations
--
-- Contexto:
--   47 migrations de April-May 2026 foram arquivadas em supabase/legacy/.
--   Todos os seus esquemas permanecem intactos no banco.
--   Esta migration remove as entradas de rastreamento antigas da tabela
--   supabase_migrations.schema_migrations, deixando apenas as migrations
--   de Junho 2026 como baseline.
--
-- Segurança:
--   - Nenhum objeto de schema é alterado (tabelas, políticas, funções intactas)
--   - Apenas metadata de rastreamento do CLI é limpo
--   - Entradas mantidas: 20260601000000, 20260604000001, 20260604000002
-- =============================================================================

-- Remove entradas de rastreamento das 47 migrations arquivadas.
-- Os objetos que elas criaram (tabelas, políticas, índices, funções, cron jobs)
-- permanecem intactos no banco — apenas o registro histórico é limpo.
DELETE FROM supabase_migrations.schema_migrations
WHERE version < '20260601000000';
