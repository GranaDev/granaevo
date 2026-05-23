-- =============================================================================
-- GranaEvo — Garante schema correto das tabelas de convidados
--
-- Contexto: guest_invitations, invite_nonces e invite_rate_limit foram criadas
-- manualmente no Dashboard (sem migration), e podem estar faltando colunas
-- adicionadas posteriormente no código da edge function.
--
-- Sintoma: verify-guest-invite retorna 400 porque o INSERT em invite_nonces
-- falha silenciosamente (coluna expires_at inexistente), consumeNonce não
-- encontra o nonce e retorna false.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. guest_invitations — cria se não existir com schema completo
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guest_invitations (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    owner_email            TEXT        NOT NULL,
    owner_name             TEXT,
    guest_name             TEXT        NOT NULL,
    guest_email            TEXT        NOT NULL,
    code_hash              TEXT        NOT NULL,
    verification_attempts  INTEGER     NOT NULL DEFAULT 0,
    used                   BOOLEAN     NOT NULL DEFAULT false,
    expires_at             TIMESTAMPTZ NOT NULL,
    used_at                TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Colunas adicionadas depois (idempotente)
ALTER TABLE public.guest_invitations
    ADD COLUMN IF NOT EXISTS owner_name   TEXT,
    ADD COLUMN IF NOT EXISTS used_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Índices para as queries da edge function
CREATE INDEX IF NOT EXISTS idx_guest_inv_email_used_expires
    ON public.guest_invitations (guest_email, used, expires_at);
CREATE INDEX IF NOT EXISTS idx_guest_inv_owner
    ON public.guest_invitations (owner_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. invite_nonces — cria se não existir + garante coluna expires_at
--
-- A edge function verify-guest-invite usa:
--   INSERT INTO invite_nonces (nonce, expires_at)
--   O campo expires_at é OBRIGATÓRIO — sem ele o insert falha silenciosamente
--   e consumeNonce retorna false → 400 sempre.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invite_nonces (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nonce       TEXT        NOT NULL,
    used        BOOLEAN     NOT NULL DEFAULT false,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garante coluna expires_at (caso tabela existia sem ela)
ALTER TABLE public.invite_nonces
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Preenche expires_at NULL com valores razoáveis (nonces antigos sem data)
UPDATE public.invite_nonces
SET expires_at = created_at + INTERVAL '2 minutes'
WHERE expires_at IS NULL;

-- Garante coluna used (caso tabela existia sem ela)
ALTER TABLE public.invite_nonces
    ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT false;

-- UNIQUE index em nonce (para atomicidade do consume)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_nonces_nonce_unique
    ON public.invite_nonces (nonce);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS em guest_invitations — service_role only (edge function usa service key)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.guest_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_invitations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.guest_invitations FROM PUBLIC;
REVOKE ALL ON TABLE public.guest_invitations FROM anon;
REVOKE ALL ON TABLE public.guest_invitations FROM authenticated;
GRANT ALL ON TABLE public.guest_invitations TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS em invite_nonces — service_role only
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invite_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_nonces FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invite_nonces FROM PUBLIC;
REVOKE ALL ON TABLE public.invite_nonces FROM anon;
REVOKE ALL ON TABLE public.invite_nonces FROM authenticated;
GRANT ALL ON TABLE public.invite_nonces TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verifica schema final — RAISE EXCEPTION se expires_at ainda não existe
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'invite_nonces'
          AND column_name  = 'expires_at'
    ) THEN
        RAISE EXCEPTION '[fix_guest_tables] FALHA: invite_nonces ainda não tem coluna expires_at!';
    END IF;

    RAISE NOTICE '[fix_guest_tables] OK — invite_nonces.expires_at existe. Schema correto.';
END $$;
