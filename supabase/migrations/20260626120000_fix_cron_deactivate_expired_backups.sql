-- =============================================================================
-- GranaEvo — Conserta cron de desativação/limpeza de backups expirados (job 17)
-- Rollback: ver 20260626120000_fix_cron_deactivate_expired_backups.down.sql
--
-- Bug: o comando do cron (diário 3am) fazia `UPDATE profiles/account_members
--   SET ... updated_at = NOW()`, mas NENHUMA dessas tabelas tem coluna `updated_at`
--   (profiles: id,user_id,name,photo_url,created_at,is_active; account_members usa
--   `removed_at`). Como o job é transacional (BEGIN..COMMIT), o erro no passo 1
--   abortava os 3 passos — incluindo a limpeza de PII (LGPD, retenção 90 dias).
--   Falhava todo dia desde ~2026-06-23.
--
-- Fix: remove `updated_at` dos UPDATEs de profiles e account_members
--   (account_members tem trigger account_members_set_removed_at que cuida do
--   timestamp ao desativar). Passo 3 (profile_backups) mantém updated_at — essa
--   tabela TEM a coluna. Aplicado LIVE via cron.alter_job e validado (no-op atual:
--   profile_backups vazia) em 2026-06-26.
-- =============================================================================

-- 0. Desagenda o cron morto `sync-pending-orders` (legado Cakto): falhava a cada
--    15min ("schema net does not exist" + Bearer YOUR_ANON_KEY + edge function
--    inexistente). Idempotente, por match de comando.
DO $$
DECLARE j bigint;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE command ILIKE '%sync-pending-orders%'
  LOOP
    PERFORM cron.unschedule(j);
  END LOOP;
END $$;

SELECT cron.alter_job(17, command := $job$
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

-- 2. Desativa membros cujos backups expiraram (trigger seta removed_at)
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
$job$);
