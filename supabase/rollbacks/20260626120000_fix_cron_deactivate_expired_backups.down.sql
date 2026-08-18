-- =============================================================================
-- GranaEvo — Rollback: 20260626120000_fix_cron_deactivate_expired_backups.sql
-- ATENÇÃO: reverte ao comando ANTERIOR (QUEBRADO — referencia updated_at
-- inexistente em profiles/account_members). Só use se precisar do estado exato
-- anterior; o job voltará a falhar diariamente. Normalmente NÃO reverter.
-- =============================================================================

SELECT cron.alter_job(17, command := $job$
    BEGIN;
    UPDATE public.profiles p
    SET    is_active   = false,
           updated_at  = NOW()
    FROM   public.profile_backups pb
    WHERE  pb.status            = 'active'
      AND  pb.backup_expires_at <= NOW()
      AND  pb.source_table      = 'profiles'
      AND  pb.original_member_id = p.id::TEXT
      AND  p.user_id            = pb.owner_user_id;

    UPDATE public.account_members am
    SET    is_active   = false,
           updated_at  = NOW()
    FROM   public.profile_backups pb
    WHERE  pb.status            = 'active'
      AND  pb.backup_expires_at <= NOW()
      AND  pb.source_table      = 'account_members'
      AND  pb.original_member_id = am.id::TEXT
      AND  am.owner_user_id     = pb.owner_user_id;

    UPDATE public.profile_backups
    SET    status           = 'deleted',
           member_data      = '{}',
           member_name      = '[Excluido]',
           member_email     = NULL,
           updated_at       = NOW()
    WHERE  status           = 'active'
      AND  backup_expires_at <= NOW();
    COMMIT;
$job$);
