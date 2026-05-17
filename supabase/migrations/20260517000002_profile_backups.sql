-- ============================================================
-- GranaEvo: Sistema de backup de perfis para downgrade
-- LGPD: dados retidos por 90 dias, depois excluídos permanentemente
-- ============================================================

-- ── Tabela principal ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_backups (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    original_member_id     UUID        NOT NULL,   -- ID em account_members (mesmo após desativação)
    member_name            TEXT,
    member_email           TEXT,
    member_data            JSONB       NOT NULL DEFAULT '{}', -- snapshot completo do membro
    scheduled_removal_at   TIMESTAMPTZ NOT NULL,   -- data em que o downgrade entra em vigor
    activated_at           TIMESTAMPTZ,            -- quando backup ficou 'active' (renewal concluído)
    backup_expires_at      TIMESTAMPTZ,            -- activated_at + 90 dias (preenchido ao ativar)
    status                 TEXT        NOT NULL DEFAULT 'pending',
    original_plan          TEXT        NOT NULL,   -- plano no momento do agendamento
    target_plan            TEXT        NOT NULL,   -- plano para o qual está fazendo downgrade
    stripe_subscription_id TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT profile_backups_status_check
        CHECK (status IN ('pending', 'active', 'restored', 'cancelled', 'deleted')),
    CONSTRAINT profile_backups_plan_check
        CHECK (original_plan IN ('individual', 'casal', 'familia')),
    CONSTRAINT profile_backups_target_plan_check
        CHECK (target_plan IN ('individual', 'casal', 'familia'))
);

-- Apenas 1 backup ativo/pendente por membro por dono ao mesmo tempo
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_backups_active_per_member
    ON profile_backups (owner_user_id, original_member_id)
    WHERE status IN ('pending', 'active');

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_profile_backups_owner
    ON profile_backups (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_profile_backups_status
    ON profile_backups (status);
CREATE INDEX IF NOT EXISTS idx_profile_backups_expires
    ON profile_backups (backup_expires_at)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_profile_backups_member
    ON profile_backups (original_member_id);

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE profile_backups ENABLE ROW LEVEL SECURITY;

-- Usuário lê apenas seus próprios backups
CREATE POLICY "profile_backups_select_own" ON profile_backups
    FOR SELECT USING (auth.uid() = owner_user_id);

-- Nenhuma operação de escrita pelo cliente (service_role only)
-- INSERT, UPDATE, DELETE acontecem exclusivamente via Edge Functions

-- ── Trigger: updated_at automático ───────────────────────────
CREATE OR REPLACE FUNCTION profile_backups_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER profile_backups_updated_at
    BEFORE UPDATE ON profile_backups
    FOR EACH ROW EXECUTE FUNCTION profile_backups_set_updated_at();

-- ── View de backups ativos (para monitoramento interno) ───────
CREATE OR REPLACE VIEW active_profile_backups
WITH (security_invoker = true) AS
SELECT
    id, owner_user_id, original_member_id,
    member_name, member_email,
    status, original_plan, target_plan,
    scheduled_removal_at, activated_at, backup_expires_at,
    created_at, updated_at
FROM profile_backups
WHERE status IN ('pending', 'active');

-- ── pg_cron: limpeza diária de backups expirados (LGPD) ──────
-- INSTRUÇÃO: Execute no SQL Editor do Supabase (requer pg_cron habilitado):
--
-- Habilitar pg_cron (se não estiver habilitado):
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--
-- Agendar limpeza diária às 3h UTC:
--   SELECT cron.schedule(
--     'granaevo-expire-profile-backups',
--     '0 3 * * *',
--     $$
--       BEGIN;
--
--       -- 1. Excluir permanentemente os registros em account_members
--       --    cujos backups expiraram (90 dias após ativação)
--       DELETE FROM account_members am
--       USING profile_backups pb
--       WHERE pb.status          = 'active'
--         AND pb.backup_expires_at <= NOW()
--         AND pb.original_member_id = am.id
--         AND am.is_active         = false;
--
--       -- 2. Limpar PII dos backups e marcar como deleted (LGPD)
--       UPDATE profile_backups
--       SET  status           = 'deleted',
--            member_data      = '{}',
--            member_name      = '[Excluído]',
--            member_email     = null,
--            updated_at       = NOW()
--       WHERE status          = 'active'
--         AND backup_expires_at <= NOW();
--
--       COMMIT;
--     $$
--   );
--
-- Para verificar jobs agendados: SELECT * FROM cron.job;

-- ── Comentários de documentação ───────────────────────────────
COMMENT ON TABLE profile_backups IS
    'Backup de perfis removidos em downgrades. Retidos por 90 dias (LGPD). Gerenciado exclusivamente por Edge Functions via service_role.';
COMMENT ON COLUMN profile_backups.status IS
    'pending: agendado mas renovação ainda não ocorreu | active: desativado, dentro dos 90 dias | restored: restaurado por upgrade | cancelled: agendamento cancelado | deleted: 90 dias expirados, PII removido';
COMMENT ON COLUMN profile_backups.backup_expires_at IS
    'Preenchido quando status muda de pending→active (= activated_at + 90 dias). Após esta data o perfil é excluído permanentemente pelo pg_cron.';
