-- 20260811020000_user_data_sem_escrita_do_cliente.down.sql
-- GranaEvo — Rollback: 20260811020000_user_data_sem_escrita_do_cliente.sql
-- ATENCAO: so em emergencia. Devolve ao cliente a escrita direta em user_data
-- por PostgREST — o caminho que pula a guarda anti-wipe, a trava de versao, o
-- merge por perfil, o gate de 2FA e a cifragem.
--
-- So faz sentido se algum caminho legitimo passar a escrever em user_data pelo
-- PostgREST, o que hoje NAO acontece (conferido: zero ocorrencias no cliente).
-- Se esse dia chegar, a pergunta certa nao e "como devolvo o grant" — e "por que
-- este caminho nao passa pelo save-user-data como todos os outros".

GRANT INSERT, UPDATE, DELETE ON public.user_data TO authenticated;
