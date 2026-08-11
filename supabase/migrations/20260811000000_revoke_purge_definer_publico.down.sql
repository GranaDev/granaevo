-- 20260811000000_revoke_purge_definer_publico.down.sql
-- GranaEvo — Rollback: 20260811000000_revoke_purge_definer_publico.sql
-- ATENCAO: so em emergencia. Restaura o estado MENOS seguro — devolve a
-- anonimos o poder de disparar duas funcoes SECURITY DEFINER que ESCREVEM no
-- banco (DELETE em guest_invitations, UPDATE em profile_backups) e reintroduz
-- os 4 WARN do linter nativo (lints 0028 e 0029).
--
-- So faz sentido se algum caminho legitimo da aplicacao passar a depender de
-- chamar estas RPCs como anon/authenticated — o que hoje NAO acontece: quem as
-- executa e o pg_cron (jobs 29 e 30), como `postgres`, que nao usa estes grants.
--
-- Ordem inversa ao UP: o UP revogou; o DOWN concede.

GRANT EXECUTE ON FUNCTION public.purge_guest_invitations()        TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_profile_backups_terminal() TO PUBLIC;
