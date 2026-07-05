-- 20260702000000_chat_parse_rate_backstop.down.sql
-- GranaEvo — Rollback: 20260702000000_chat_parse_rate_backstop.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
-- Efeito: a Edge chat-parse volta a depender SÓ do rate limit do proxy Vercel.
--
-- Nota: a Edge chama chat_parse_bump em try/catch fail-open — se a função sumir,
-- a chamada RPC falha e o assistente segue funcionando (sem o backstop). Ainda
-- assim, prefira reverter a Edge junto para não fazer uma RPC fadada a falhar.

-- Ordem inversa ao UP: primeiro a função, depois a tabela.
DROP FUNCTION IF EXISTS public.chat_parse_bump(UUID, INTEGER);

-- ⚠️ DESTRÓI DADOS: descarta os contadores diários (não são PII; sem impacto).
DROP TABLE IF EXISTS public.chat_parse_usage;
