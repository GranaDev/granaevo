-- 20260727070000_retencao_backups_e_convites.down.sql
-- GranaEvo — Rollback de 20260727070000_retencao_backups_e_convites.sql
--
-- ⚠️ Reverter faz `profile_backups` (status terminais) e `guest_invitations`
-- voltarem a reter PII SEM PRAZO — inclusive o snapshot completo de perfis em
-- `member_data`. Contraria os 90 dias declarados em privacidade.html.
--
-- O que já foi redigido/apagado NÃO volta: são operações destrutivas por
-- natureza, que é justamente o ponto delas.

SELECT cron.unschedule('granaevo-purge-profile-backups-terminais')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-profile-backups-terminais');
SELECT cron.unschedule('granaevo-purge-guest-invitations')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-guest-invitations');

DROP FUNCTION IF EXISTS public.purge_profile_backups_terminal();
DROP FUNCTION IF EXISTS public.purge_guest_invitations();
