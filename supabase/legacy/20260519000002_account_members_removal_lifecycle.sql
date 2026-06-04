-- =============================================================================
-- GranaEvo — Migration: Ciclo de vida de remoção de convidados
--
-- Contexto: quando o dono remove um convidado, o registro em account_members
-- fica com is_active = false mas sem timestamp de remoção. Isso impede:
--   1. Saber quando o convidado foi removido (para limpeza automática após 30 dias)
--   2. Re-convidar o mesmo email (verify-guest-invite não conseguia distinguir
--      um re-invite válido do mesmo dono de um caso de email duplicado)
--
-- Correções:
--   1. Coluna removed_at — preenchida automaticamente por trigger ao desativar
--   2. Trigger account_members_set_removed_at — auto-gerencia removed_at
--   3. Instrução de pg_cron para limpeza após 30 dias (aplicar manualmente)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Coluna removed_at
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.account_members
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Trigger: preenche removed_at automaticamente
--    - is_active: true → false  : removed_at = NOW()
--    - is_active: false → true  : removed_at = NULL  (re-convite / reativação)
--    Roda server-side — o cliente só precisa setar is_active
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.account_members_set_removed_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active = false AND (OLD.is_active IS NULL OR OLD.is_active = true) THEN
    NEW.removed_at = NOW();
  END IF;
  IF NEW.is_active = true THEN
    NEW.removed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_members_removed_at ON public.account_members;
CREATE TRIGGER account_members_removed_at
  BEFORE UPDATE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION public.account_members_set_removed_at();

-- Preenche removed_at para membros já desativados antes desta migration
UPDATE public.account_members
SET removed_at = COALESCE(removed_at, NOW())
WHERE is_active = false AND removed_at IS NULL;

-- Índice para a query de limpeza pg_cron
CREATE INDEX IF NOT EXISTS idx_account_members_removed_at
  ON public.account_members (removed_at)
  WHERE is_active = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pg_cron: limpeza de membros removidos há mais de 30 dias
--
-- INSTRUÇÃO: Execute manualmente no SQL Editor do Supabase
-- (requer pg_cron habilitado — Extensions → pg_cron)
--
-- O job deleta apenas o vínculo (account_members). O usuário Auth é mantido
-- para que ele possa fazer login e recuperar seus dados no período de retenção.
-- Após 30 dias, se o dono quiser re-convidar, o fluxo cria um usuário novo.
--
--   SELECT cron.schedule(
--     'granaevo-cleanup-removed-members',
--     '0 4 * * *',    -- diariamente às 4h UTC
--     $$
--       DELETE FROM public.account_members
--       WHERE is_active   = false
--         AND removed_at  IS NOT NULL
--         AND removed_at  < NOW() - INTERVAL '30 days';
--     $$
--   );
--
-- Para verificar jobs: SELECT * FROM cron.job;
-- Para remover:        SELECT cron.unschedule('granaevo-cleanup-removed-members');
-- ─────────────────────────────────────────────────────────────────────────────
