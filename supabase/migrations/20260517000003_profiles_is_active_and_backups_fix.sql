-- ============================================================
-- GranaEvo: Adiciona is_active em profiles + corrige profile_backups
-- para suportar IDs inteiros da tabela profiles
-- ============================================================

-- ── 1. Coluna is_active em profiles ──────────────────────────
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Índice para busca eficiente de perfis ativos por usuário
CREATE INDEX IF NOT EXISTS idx_profiles_user_active
    ON public.profiles (user_id, is_active)
    WHERE is_active = true;

-- RLS: usuário pode ver seus perfis inativos também (para restauração)
-- A política existente profiles_select_own já cobre (user_id = auth.uid())

-- ── 2. Atualiza profile_backups para suportar ambos os tipos ──
-- original_member_id passa de UUID para TEXT (suporta IDs inteiros de profiles)
ALTER TABLE public.profile_backups
    ALTER COLUMN original_member_id TYPE TEXT USING original_member_id::TEXT;

-- Adiciona coluna para distinguir a tabela de origem
ALTER TABLE public.profile_backups
    ADD COLUMN IF NOT EXISTS source_table TEXT NOT NULL DEFAULT 'profiles'
    CONSTRAINT profile_backups_source_check
        CHECK (source_table IN ('profiles', 'account_members'));

-- Remove índice único antigo e recria com source_table
DROP INDEX IF EXISTS idx_profile_backups_active_per_member;

CREATE UNIQUE INDEX idx_profile_backups_active_per_member
    ON public.profile_backups (owner_user_id, original_member_id, source_table)
    WHERE status IN ('pending', 'active');

-- ── 3. Atualiza pg_cron para também tratar perfis da tabela profiles ──
-- INSTRUÇÃO: Atualize o job existente no SQL Editor:
--
--   SELECT cron.unschedule('granaevo-expire-profile-backups');
--
--   SELECT cron.schedule(
--     'granaevo-expire-profile-backups',
--     '0 3 * * *',
--     $$
--       -- Perfis da tabela profiles (ID inteiro)
--       UPDATE public.profiles
--       SET is_active = false
--       FROM public.profile_backups pb
--       WHERE pb.status          = 'active'
--         AND pb.backup_expires_at <= NOW()
--         AND pb.source_table    = 'profiles'
--         AND pb.original_member_id = public.profiles.id::TEXT
--         AND public.profiles.user_id = pb.owner_user_id;
--
--       -- Membros da tabela account_members (UUID)
--       UPDATE public.account_members am
--       SET is_active = false
--       FROM public.profile_backups pb
--       WHERE pb.status          = 'active'
--         AND pb.backup_expires_at <= NOW()
--         AND pb.source_table    = 'account_members'
--         AND pb.original_member_id = am.id::TEXT
--         AND am.owner_user_id  = pb.owner_user_id;
--
--       -- Limpa PII dos backups expirados (LGPD)
--       UPDATE public.profile_backups
--       SET  status       = 'deleted',
--            member_data  = '{}',
--            member_name  = '[Excluído]',
--            member_email = null,
--            updated_at   = NOW()
--       WHERE status          = 'active'
--         AND backup_expires_at <= NOW();
--     $$
--   );

COMMENT ON COLUMN public.profiles.is_active IS
    'false = perfil desativado por downgrade (backup ativo por 90 dias). true = perfil ativo normalmente.';
COMMENT ON COLUMN public.profile_backups.source_table IS
    'profiles = perfil próprio do usuário | account_members = convidado (guest)';
