-- 20260727070000_retencao_backups_e_convites.sql
-- GranaEvo — Migration: retenção de profile_backups terminais e guest_invitations (M-5)
-- Rollback: ver 20260727070000_retencao_backups_e_convites.down.sql
-- Origem: auditoria /god-mode + /god-eyes de 2026-07-27.
--
-- O PROBLEMA
--   Duas tabelas guardavam PII SEM PRAZO NENHUM:
--
--   1. `profile_backups` nos status terminais. O cron `granaevo-expire-profile-backups`
--      só redige PII de `status='active' AND backup_expires_at <= now()`. Mas o ciclo
--      real é pending → active(+90d) → deleted, e `update-stripe-plan` também produz
--      `cancelled` (downgrade desfeito) e `restored` (upgrade de volta). Nesses três
--      status a linha guarda `member_data` — o SNAPSHOT COMPLETO do perfil, com as
--      transações — mais nome e e-mail, para sempre. E `backup_expires_at` só é
--      preenchido pelo webhook, então nem existe prazo para eles.
--      Contraria `privacidade.html`, que promete "backups de perfil por 90 dias".
--
--   2. `guest_invitations` não tinha rotina nenhuma: owner_email, owner_name,
--      guest_name, guest_email e code_hash ficavam indefinidamente, mesmo depois de o
--      convite ser usado ou expirar.
--
--   Nos dois casos o volume hoje é pequeno (0 e 3 linhas). São defeitos LATENTES —
--   o tipo que só aparece quando a base cresce e aí já são milhares de linhas.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. profile_backups — status terminais
-- ════════════════════════════════════════════════════════════════════════════
-- Redige em vez de apagar, igual ao que o cron existente faz com os `active`:
-- a linha vira `deleted` com member_data vazio, o que preserva o rastro de que
-- houve um downgrade (útil em disputa de cobrança) sem preservar o dado pessoal.
--
-- 90 dias porque é o prazo que a Política declara. Dava para argumentar por menos
-- (num `restored` o usuário já recebeu o perfil de volta, o backup não serve mais
-- para nada), mas alinhar ao prazo publicado é o que torna a promessa verificável.
--
-- `coalesce(updated_at, created_at)`: `backup_expires_at` só é preenchido pelo
-- webhook e nestes status costuma ser NULL — usá-lo faria a rotina não pegar nada.
CREATE OR REPLACE FUNCTION public.purge_profile_backups_terminal()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
    UPDATE public.profile_backups
       SET status       = 'deleted',
           member_data  = '{}'::jsonb,
           member_name  = '[Excluido]',
           member_email = NULL,
           updated_at   = now()
     WHERE status IN ('pending', 'cancelled', 'restored')
       AND coalesce(updated_at, created_at) < now() - interval '90 days';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
        RAISE LOG '[purge_profile_backups_terminal] % backup(s) redigido(s)', v_n;
    END IF;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.purge_profile_backups_terminal() IS
    'Redige PII de profile_backups nos status terminais (pending/cancelled/restored) apos 90 dias. O cron granaevo-expire-profile-backups so cobre status=active. Ver migration 20260727070000.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. guest_invitations
-- ════════════════════════════════════════════════════════════════════════════
-- Aqui é DELETE, não redação: um convite usado ou expirado não tem propósito
-- nenhum depois. Quem virou membro está em `account_members`, que é o registro
-- que importa — e não há FK apontando para cá (conferido antes de escrever),
-- então apagar não deixa referência quebrada.
--
-- Prazos diferentes de propósito:
--   • usado (30d): dá janela para investigar "quem me adicionou nesse plano?"
--   • não usado (7d após expirar): não virou nada; só sobra PII de duas pessoas
CREATE OR REPLACE FUNCTION public.purge_guest_invitations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
    DELETE FROM public.guest_invitations
     WHERE (used = true  AND used_at    < now() - interval '30 days')
        OR (coalesce(used, false) = false AND expires_at < now() - interval '7 days');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
        RAISE LOG '[purge_guest_invitations] % convite(s) removido(s)', v_n;
    END IF;
    RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.purge_guest_invitations() IS
    'Apaga convites usados (>30d) e expirados nao usados (>7d). Contem owner_email/name e guest_email/name. Ver migration 20260727070000.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Agendamento
-- ════════════════════════════════════════════════════════════════════════════
-- 3h45 e 3h50: depois do cron 17 (3h00, que trata os `active`) e do snapshot
-- diário (3h15), para não competir por I/O na mesma janela.
SELECT cron.unschedule('granaevo-purge-profile-backups-terminais')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-profile-backups-terminais');
SELECT cron.schedule(
    'granaevo-purge-profile-backups-terminais',
    '45 3 * * *',
    $$SELECT public.purge_profile_backups_terminal();$$
);

SELECT cron.unschedule('granaevo-purge-guest-invitations')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-guest-invitations');
SELECT cron.schedule(
    'granaevo-purge-guest-invitations',
    '50 3 * * *',
    $$SELECT public.purge_guest_invitations();$$
);
