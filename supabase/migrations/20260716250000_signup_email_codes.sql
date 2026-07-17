-- ============================================================================
-- Prova de posse do e-mail no cadastro (fecha a classe inteira)
--
-- O PROBLEMA QUE ISTO RESOLVE:
-- `/api/create-account` chamava `admin.createUser({ email_confirm: true })`.
-- Isso não "pula" a confirmação — é AFIRMAR ao banco que o e-mail foi
-- verificado, quando ninguém verificou nada. O Supabase grava
-- `email_confirmed_at = agora` e o sistema inteiro passa a acreditar numa
-- afirmação falsa.
--
-- Consequência medida em 2026-07-16: CINCO caminhos independentes decidiam
-- acesso/plano/dado por `user_email = auth.email()` — escritos em momentos
-- diferentes, todos parecendo corretos isoladamente (o e-mail vem do JWT, o JWT
-- é assinado, logo é confiável — o raciocínio só quebra num detalhe invisível
-- lá no cadastro). Pior: a defesa CERTA já existia (policy
-- `stripe_sub_select_by_email` exigia `email_confirmed_at IS NOT NULL`) e
-- estava MORTA — nunca reprovou ninguém, e ninguém notou por meses.
--
-- Fechar os 5 caminhos (feito) resolve o hoje. Isto resolve o amanhã: com o
-- e-mail realmente provado, `email_confirmed_at` volta a significar algo e todo
-- código futuro que confie nele passa a estar CERTO por construção.
--
-- Espelha `password_reset_codes` (mesmo desenho, já provado em produção):
-- code_hash SHA-256 (nunca o código em claro), tentativas limitadas, expiração,
-- used=true anti-replay.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.signup_email_codes (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 text NOT NULL,
    -- SHA-256 do código. Nunca o código: vazar a tabela não deve entregar contas.
    code_hash             text NOT NULL,
    -- O plano escolhido viaja junto para o checkout depois de verificar. Só a
    -- allow-list — o preço continua vindo do env do servidor, nunca daqui.
    plan                  text CHECK (plan IS NULL OR plan IN ('individual', 'casal', 'familia')),
    verification_attempts integer NOT NULL DEFAULT 0,
    used                  boolean NOT NULL DEFAULT false,
    used_at               timestamptz,
    expires_at            timestamptz NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);

-- Busca do fluxo: por e-mail, o mais recente não usado e não expirado.
CREATE INDEX IF NOT EXISTS idx_signup_codes_email
    ON public.signup_email_codes (lower(email), created_at DESC)
    WHERE used = false;
-- Usado pelo cron de limpeza.
CREATE INDEX IF NOT EXISTS idx_signup_codes_expires
    ON public.signup_email_codes (expires_at);

COMMENT ON TABLE public.signup_email_codes IS
    'Prova de posse do e-mail no cadastro. So service_role toca (as edges). Codigo NUNCA em claro: so code_hash SHA-256. Ver migration 20260716250000.';

-- ── RLS: ninguém no cliente toca nisto ─────────────────────────────────────
-- Só as Edge Functions (service_role) leem/escrevem. Um cliente que pudesse ler
-- `code_hash` levaria contas por força bruta offline; um que pudesse escrever
-- forjaria a própria verificação. Sem grant + policy negando = duas barreiras.
ALTER TABLE public.signup_email_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_email_codes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signup_codes_deny_client" ON public.signup_email_codes;
CREATE POLICY "signup_codes_deny_client" ON public.signup_email_codes
    FOR ALL TO authenticated, anon
    USING (false) WITH CHECK (false);

REVOKE ALL ON public.signup_email_codes FROM anon, authenticated;

-- ── Limpeza: código expirado é lixo com PII (e-mail) ───────────────────────
CREATE OR REPLACE FUNCTION public.purge_signup_email_codes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_n integer;
BEGIN
    -- 24h depois de expirar: dá margem para depurar um caso recente sem guardar
    -- e-mail de quem nunca completou o cadastro. Minimização (LGPD art. 6º, III).
    DELETE FROM public.signup_email_codes
    WHERE expires_at < now() - interval '24 hours';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_signup_email_codes() FROM anon, authenticated;

SELECT cron.schedule(
    'granaevo-purge-signup-codes',
    '20 4 * * *',
    $$SELECT public.purge_signup_email_codes();$$
);
