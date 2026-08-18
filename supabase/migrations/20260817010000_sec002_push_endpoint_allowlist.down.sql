-- 20260817010000_sec002_push_endpoint_allowlist.down.sql
-- GranaEvo — Rollback: 20260817010000_sec002_push_endpoint_allowlist.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
--
-- ⚠️ O QUE VOCÊ ESTÁ REABRINDO: o campo `endpoint` volta a aceitar qualquer
--    string, e o cliente recupera INSERT/UPDATE diretos na tabela. Como
--    `send-radar-push` faz POST para o que estiver gravado, isso devolve o SSRF
--    cego (SEC-002). As camadas do CÓDIGO (save-push-subscription e
--    send-radar-push) continuam de pé e seguram o caso comum — mas elas foram
--    desenhadas COM estas duas embaixo, não no lugar delas.
--
--    Se o motivo for "um push service novo/regional está sendo recusado", NÃO
--    reverta: acrescente o host à lista, nos dois lugares (o CHECK aqui e
--    `_shared/push-endpoint.ts`), e rode tests/unit/push-endpoint-ssrf.test.js.

BEGIN;

-- Reverte em ordem INVERSA ao UP
ALTER TABLE public.push_subscriptions DROP CONSTRAINT IF EXISTS push_endpoint_allowlist;

GRANT INSERT, UPDATE ON public.push_subscriptions TO authenticated;

COMMIT;

-- ── Depois de reverter, conferir o catálogo ─────────────────────────────────
--   SELECT conname FROM pg_constraint
--    WHERE conrelid='public.push_subscriptions'::regclass AND contype='c';
--   → push_endpoint_allowlist NÃO deve aparecer
--
--   SELECT relacl FROM pg_class WHERE oid='public.push_subscriptions'::regclass;
--   → esperado conter authenticated=arwd
