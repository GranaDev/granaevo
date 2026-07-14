-- 20260714130000_document_existing_crons.sql
-- Passo 4 do docs/roadmap-melhorias-dev.md — governança IaC (2026-07-14).
--
-- Estes 10 cron jobs foram criados ad-hoc (fora de migration) ao longo do tempo e
-- estavam VIVOS em produção sem rastro no repo (drift de disaster-recovery). Esta
-- migration os DOCUMENTA de forma declarativa e idempotente: cada `cron.schedule`
-- é guardado por `NOT EXISTS` no jobname → em produção é NO-OP (os jobs já existem);
-- num rebuild-from-scratch (DR via psql), recria cada um fielmente.
--
-- NÃO é destrutiva e NÃO altera os jobs vivos. Os outros 5 crons (push-subscriptions,
-- purge-audit-log-retention, purge-radar-notifications, limpar-user-devices,
-- purge-payment-events-pii) já estão versionados em migrations próprias.
--
-- Aplicada ao ledger como registro do estado atual (efeito já presente no banco).

-- 1) Códigos de reset de senha expirados/usados
SELECT cron.schedule('cleanup-expired-reset-codes', '0 3 * * *', $c$
    DELETE FROM password_reset_codes
    WHERE used = true
       OR expires_at < now() - interval '1 day';
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-reset-codes');

-- 2) Lockouts de login antigos (48h)
SELECT cron.schedule('granaevo-limpar-lockouts', '0 3 * * *', $c$
    DELETE FROM public.login_lockouts
     WHERE (locked_until IS NULL     AND last_attempt_at < now() - interval '48 hours')
        OR (locked_until IS NOT NULL AND locked_until     < now() - interval '48 hours');
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-limpar-lockouts');

-- 3) Rate limits de edge functions (janelas > 2h)
SELECT cron.schedule('granaevo-limpar-rate-limits', '0 * * * *', $c$
    DELETE FROM public.edge_rate_limits
     WHERE window_start < now() - interval '2 hours';
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-limpar-rate-limits');

-- 4) Nonces de convite expirados (10 min)
SELECT cron.schedule('granaevo-limpar-nonces', '*/15 * * * *', $c$
    DELETE FROM public.invite_nonces
     WHERE expires_at < now() - interval '10 minutes';
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-limpar-nonces');

-- 5) Rate limit de convites expirado (30 min)
SELECT cron.schedule('granaevo-limpar-invite-rate-limit', '30 * * * *', $c$
    DELETE FROM public.invite_rate_limit
     WHERE expires_at < now() - interval '30 minutes';
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-limpar-invite-rate-limit');

-- 6) Limpeza de contas abandonadas (nunca pagaram / expiraram)
SELECT cron.schedule('cleanup-abandoned-accounts', '0 3 * * *', $c$
    SELECT cleanup_abandoned_accounts();
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-abandoned-accounts');

-- 7) Purga de contas canceladas expiradas
SELECT cron.schedule('purge-expired-cancelled-accounts', '0 3 * * *', $c$
    SELECT public.purge_expired_cancelled_accounts();
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-cancelled-accounts');

-- 8) Expiração de backups de perfil + limpeza de PII (LGPD, retenção 90d)
SELECT cron.schedule('granaevo-expire-profile-backups', '0 3 * * *', $c$
BEGIN;
-- 1. Desativa perfis cujos backups expiraram
UPDATE public.profiles p
SET    is_active = false
FROM   public.profile_backups pb
WHERE  pb.status = 'active'
  AND  pb.backup_expires_at <= NOW()
  AND  pb.source_table = 'profiles'
  AND  pb.original_member_id = p.id::TEXT
  AND  p.user_id = pb.owner_user_id;

-- 2. Desativa membros cujos backups expiraram (trigger account_members_set_removed_at seta removed_at)
UPDATE public.account_members am
SET    is_active = false
FROM   public.profile_backups pb
WHERE  pb.status = 'active'
  AND  pb.backup_expires_at <= NOW()
  AND  pb.source_table = 'account_members'
  AND  pb.original_member_id = am.id::TEXT
  AND  am.owner_user_id = pb.owner_user_id;

-- 3. Limpa PII de backups expirados (LGPD - retencao 90 dias)
UPDATE public.profile_backups
SET    status       = 'deleted',
       member_data  = '{}',
       member_name  = '[Excluido]',
       member_email = NULL,
       updated_at   = NOW()
WHERE  status = 'active'
  AND  backup_expires_at <= NOW();
COMMIT;
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-expire-profile-backups');

-- 9) Snapshot diário (recuperação anti-wipe)
SELECT cron.schedule('granaevo-daily-snapshot', '15 3 * * *', $c$
    SELECT public.take_daily_snapshot();
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-daily-snapshot');

-- 10) Purga de contas não pagas (2x/dia)
SELECT cron.schedule('granaevo-purge-unpaid-accounts', '30 2,14 * * *', $c$
    SELECT public.purge_unpaid_accounts();
$c$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-unpaid-accounts');
