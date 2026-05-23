-- =============================================================================
-- GranaEvo — Restaura triggers de segurança removidos pela migration 000006
--
-- A migration 000006 removeu TODOS os triggers de profiles para eliminar
-- o que estava referenciando subscriptions. Este script restaura os que
-- têm propósito de segurança legítimo, já corrigidos.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. enforce_user_id_immutable — impede que o user_id de um perfil seja alterado
--    após a criação (proteção contra escalada de privilégios via UPDATE)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_profiles_enforce_user_id_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'user_id de um perfil não pode ser alterado após a criação';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_user_id_immutable ON public.profiles;

CREATE TRIGGER enforce_user_id_immutable
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_profiles_enforce_user_id_immutable();

COMMENT ON FUNCTION public.trg_profiles_enforce_user_id_immutable() IS
    'Impede alteração de user_id em perfis existentes. Proteção contra escalada de privilégios via UPDATE direto.';
