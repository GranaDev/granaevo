-- Rollback: 20260818010000_acesso_do_usuario_uma_ida.sql
-- ATENCAO: so remove a RPC. Enquanto check-user-access nao a usar, remover nao
-- afeta nada em producao.
BEGIN;
DROP FUNCTION IF EXISTS public.acesso_do_usuario(uuid, text, text);
COMMIT;
