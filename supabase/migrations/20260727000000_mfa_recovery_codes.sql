-- 20260727000000_mfa_recovery_codes.sql
-- GranaEvo — Migration: códigos de recuperação do MFA/TOTP (Passo 31 · B-1)
-- Rollback: ver 20260727000000_mfa_recovery_codes.down.sql
--
-- POR QUE ESTA TABELA EXISTE
--   O Supabase Auth NÃO emite códigos de recuperação para TOTP — a recomendação
--   oficial é cadastrar um segundo autenticador. Para um app de finanças pessoais
--   isso é uma armadilha: quem troca ou perde o celular perde a conta, e o suporte
--   não tem caminho seguro para devolver o acesso. Estes códigos são esse caminho.
--
-- MODELO DE AMEAÇA
--   Um código de recuperação vale tanto quanto o segundo fator. Portanto:
--     • NUNCA em claro — só o SHA-256 (mesma disciplina de signup_email_codes).
--     • Uso único: `used_at` carimbado no consumo; código usado não volta.
--     • Sem grant nenhum para `authenticated`/`anon`: quem lê a linha consegue
--       montar ataque offline contra o hash. Só a Edge Function (service_role)
--       toca aqui, e ela é a única que decide se um código confere.
--     • CASCADE em auth.users: conta excluída não deixa chave de destravamento
--       órfã (LGPD art. 16 + higiene de credencial).
--
-- CICLO DE VIDA
--   ativar MFA   → 10 códigos gerados (linhas novas, as antigas apagadas)
--   usar 1 código→ used_at carimbado E o MFA é DESLIGADO pela Edge Function
--   desativar MFA→ purge: todas as linhas do usuário somem
--   Não há cron de retenção de propósito: a linha morre com o fator ou com a conta.

CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    code_hash  text        NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mfa_recovery_codes IS
    'Codigos de recuperacao do MFA/TOTP. Uso unico. NUNCA em claro: so code_hash SHA-256. Somente service_role (Edge Function mfa-recovery) toca. Ver migration 20260727000000.';
COMMENT ON COLUMN public.mfa_recovery_codes.code_hash IS
    'SHA-256 hex do codigo normalizado (maiusculas, sem hifen). O codigo em claro so existe uma vez, na tela de ativacao.';
COMMENT ON COLUMN public.mfa_recovery_codes.used_at IS
    'Carimbo do consumo. NOT NULL = queimado, nunca mais aceito.';

-- Busca do consumo: user_id + ainda não usado.
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user_unused
    ON public.mfa_recovery_codes (user_id)
    WHERE used_at IS NULL;

-- ── RLS: fail-closed em duas camadas ────────────────────────────────────────
-- Camada 1 (GRANT): nenhum privilégio para anon/authenticated. Sem grant, o
--   PostgREST devolve 42501 antes mesmo de a policy ser avaliada.
-- Camada 2 (RLS):  policy explícita negando tudo, para o caso de alguém conceder
--   um grant no futuro sem perceber o que está abrindo. FORCE faz a regra valer
--   inclusive para o dono da tabela.
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_recovery_codes FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON public.mfa_recovery_codes FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS mfa_recovery_deny_all ON public.mfa_recovery_codes;
CREATE POLICY mfa_recovery_deny_all
    ON public.mfa_recovery_codes
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

NOTIFY pgrst, 'reload schema';
