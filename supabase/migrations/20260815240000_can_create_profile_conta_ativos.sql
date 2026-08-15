-- ─────────────────────────────────────────────────────────────────────────────
-- FIX: a POLICY de INSERT também contava perfis excluídos
--
-- ACHADO no teste 4 (2026-08-15): criar perfil depois de excluir um devolvia
-- 403 Forbidden do PostgREST — RLS, não o trigger.
--
--   profiles_insert_own  WITH CHECK (user_id = auth.uid() AND can_create_profile())
--
-- e `can_create_profile()` fazia:
--
--   SELECT COUNT(*) FROM public.profiles WHERE user_id = v_user_id;
--
-- sem filtrar `is_active`. Ou seja: o perfil excluído seguia ocupando a vaga na
-- checagem que realmente barra o INSERT.
--
-- ⚠️ ESTE É O TERCEIRO LUGAR QUE CONTA PERFIS. Eu conhecia dois — o trigger
-- `enforce_profile_limit_stripe` (corrigido) e `restaurar_perfil` (escrito
-- correto) — e não sabia da policy. Mesma falha das outras correções de hoje:
-- mudei o SIGNIFICADO de `is_active` e não varri todos os caminhos que dependem
-- dele. Auditar quem ESCREVE não basta; é preciso auditar quem CONTA.
--
-- Agora as três usam `limite_de_perfis()`, a fonte única criada na migration
-- 20260815210000. Três cópias da regra de plano divergiriam com o tempo — e é
-- ela que decide se alguém passa do teto pago.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.can_create_profile()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_user_id       uuid := auth.uid();
    v_profile_count int;
BEGIN
    IF v_user_id IS NULL THEN RETURN false; END IF;

    -- `is_active = true` entrou em 2026-08-15, com a exclusão de perfil. Um
    -- perfil excluído NÃO ocupa vaga — senão excluir não libertaria espaço e o
    -- usuário ficaria preso, que foi exatamente o sintoma do teste 4.
    --
    -- Quem impede a burla (excluir 3, criar 3, restaurar os 3) é
    -- `restaurar_perfil`, que confere a soma FINAL no instante em que o perfil
    -- volta a existir. A assimetria é de propósito.
    SELECT COUNT(*) INTO v_profile_count
    FROM public.profiles
    WHERE user_id = v_user_id AND is_active = true;

    -- Fonte ÚNICA do teto (migration 20260815210000). Antes esta função tinha a
    -- própria cópia da tabela de planos; com três cópias vivas, uma divergiria.
    RETURN v_profile_count < public.limite_de_perfis(v_user_id);
END;
$function$;

COMMENT ON FUNCTION public.can_create_profile() IS
  'Usada pela policy profiles_insert_own. Conta apenas perfis ATIVOS: excluído não '
  'ocupa vaga. A trava contra burlar o limite fica em restaurar_perfil. '
  'Ver docs/exclusao-de-perfil-desenho.md';
