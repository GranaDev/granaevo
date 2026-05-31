-- =============================================================================
-- GranaEvo — Migration: feature_flags
-- Rollback: ver 20260531000001_feature_flags.down.sql
--
-- Objetivo: Tabela de feature flags para rollout gradual de features.
-- Permite ativar/desativar features por usuário, plano ou globalmente
-- sem necessidade de deploy.
--
-- Exemplos de uso no código:
--   SELECT is_enabled FROM feature_flags WHERE flag_key = 'pwa_install_prompt';
--   SELECT is_enabled FROM feature_flags WHERE flag_key = 'ai_insights' AND target_plan = 'Família';
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabela de feature flags
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.feature_flags (
    id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    flag_key    text        NOT NULL,
    is_enabled  boolean     NOT NULL DEFAULT false,
    -- null = todos os planos; 'Individual', 'Casal', 'Família' = plano específico
    target_plan text        DEFAULT NULL,
    -- null = todos os usuários; UUID = usuário específico (override individual)
    target_user_id uuid    DEFAULT NULL,
    description text        DEFAULT '',
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    CONSTRAINT feature_flags_key_plan_user_unique UNIQUE (flag_key, target_plan, target_user_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Índice para lookup rápido por flag_key
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_feature_flags_key
    ON public.feature_flags(flag_key);

CREATE INDEX IF NOT EXISTS idx_feature_flags_user
    ON public.feature_flags(target_user_id)
    WHERE target_user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trigger para updated_at automático
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON public.feature_flags;
CREATE TRIGGER trg_feature_flags_updated_at
    BEFORE UPDATE ON public.feature_flags
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS — apenas leitura para autenticados, escrita via service_role
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags FORCE ROW LEVEL SECURITY;

-- Usuários autenticados podem ler flags globais e as direcionadas ao seu plano/id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename = 'feature_flags' AND policyname = 'feature_flags_select_auth'
    ) THEN
        CREATE POLICY "feature_flags_select_auth" ON public.feature_flags
            FOR SELECT TO authenticated
            USING (
                target_user_id IS NULL   -- flag global ou por plano
                OR target_user_id = auth.uid() -- override individual
            );
    END IF;
END $$;

-- Anon não acessa feature flags
REVOKE ALL ON public.feature_flags FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Função helper: is_feature_enabled(flag_key, user_id, plan_name)
--    Retorna true se a feature está habilitada para o contexto do usuário.
--    Precedência: override de usuário > override de plano > global > false
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_feature_enabled(
    p_flag_key    text,
    p_user_id     uuid    DEFAULT NULL,
    p_plan_name   text    DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
AS $$
DECLARE
    v_result boolean;
BEGIN
    -- 1. Override por usuário específico (maior precedência)
    IF p_user_id IS NOT NULL THEN
        SELECT is_enabled INTO v_result
          FROM public.feature_flags
         WHERE flag_key = p_flag_key
           AND target_user_id = p_user_id
         LIMIT 1;
        IF FOUND THEN RETURN v_result; END IF;
    END IF;

    -- 2. Override por plano
    IF p_plan_name IS NOT NULL THEN
        SELECT is_enabled INTO v_result
          FROM public.feature_flags
         WHERE flag_key = p_flag_key
           AND target_plan = p_plan_name
           AND target_user_id IS NULL
         LIMIT 1;
        IF FOUND THEN RETURN v_result; END IF;
    END IF;

    -- 3. Flag global (sem target_plan e sem target_user_id)
    SELECT is_enabled INTO v_result
      FROM public.feature_flags
     WHERE flag_key = p_flag_key
       AND target_plan IS NULL
       AND target_user_id IS NULL
     LIMIT 1;
    IF FOUND THEN RETURN v_result; END IF;

    -- 4. Default: desabilitado
    RETURN false;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Seed: flags iniciais do GranaEvo
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag_key, is_enabled, target_plan, description) VALUES
    ('pwa_install_prompt',     true,  NULL,        'Exibe banner de instalação PWA para todos os usuários'),
    ('ai_insights',            false, NULL,        'Insights financeiros via IA (em desenvolvimento)'),
    ('ai_insights',            false, 'Individual', 'AI insights — disponível apenas para planos Família/Casal primeiro'),
    ('ai_insights',            false, 'Casal',      'AI insights para plano Casal — aguardando testes'),
    ('recurring_transactions', false, NULL,        'Transações recorrentes automáticas (feature em beta)'),
    ('bank_import_csv',        false, NULL,        'Importação de extrato CSV (em desenvolvimento)'),
    ('sentry_reporting',       true,  NULL,        'Relatório de erros via Sentry (habilitado em prod)')
ON CONFLICT (flag_key, target_plan, target_user_id) DO NOTHING;
