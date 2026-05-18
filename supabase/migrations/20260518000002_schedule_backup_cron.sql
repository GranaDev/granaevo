-- =============================================================================
-- GranaEvo — Migration: Agendamento pg_cron para expiração de backups de perfis
-- Corrige: pg_cron do sistema de backup estava em comentário (instrução manual).
-- Após aplicar esta migration, verificar com:
--   SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobid;
-- =============================================================================

-- Remove job anterior se existir (idempotência)
SELECT cron.unschedule('granaevo-expire-profile-backups')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-expire-profile-backups');

-- Agenda limpeza diária às 3h UTC (fora do horário de pico BR)
SELECT cron.schedule(
  'granaevo-expire-profile-backups',
  '0 3 * * *',
  $$
    BEGIN;

    -- ── 1. Desativa perfis da tabela profiles cujos backups expiraram ─────────
    -- Marca is_active = false para perfis que estavam em backup ativo e expiraram.
    -- A query compara original_member_id (TEXT) com profiles.id::TEXT.
    UPDATE public.profiles p
    SET    is_active   = false,
           updated_at  = NOW()
    FROM   public.profile_backups pb
    WHERE  pb.status            = 'active'
      AND  pb.backup_expires_at <= NOW()
      AND  pb.source_table      = 'profiles'
      AND  pb.original_member_id = p.id::TEXT
      AND  p.user_id            = pb.owner_user_id;

    -- ── 2. Desativa membros da tabela account_members cujos backups expiraram ──
    UPDATE public.account_members am
    SET    is_active   = false,
           updated_at  = NOW()
    FROM   public.profile_backups pb
    WHERE  pb.status            = 'active'
      AND  pb.backup_expires_at <= NOW()
      AND  pb.source_table      = 'account_members'
      AND  pb.original_member_id = am.id::TEXT
      AND  am.owner_user_id     = pb.owner_user_id;

    -- ── 3. Limpa PII dos backups expirados (LGPD — dados retidos por 90 dias) ─
    UPDATE public.profile_backups
    SET    status           = 'deleted',
           member_data      = '{}',
           member_name      = '[Excluído]',
           member_email     = NULL,
           updated_at       = NOW()
    WHERE  status           = 'active'
      AND  backup_expires_at <= NOW();

    COMMIT;
  $$
);
