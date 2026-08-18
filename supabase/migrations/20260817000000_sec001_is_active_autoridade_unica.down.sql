-- 20260817000000_sec001_is_active_autoridade_unica.down.sql
-- GranaEvo — Rollback: 20260817000000_sec001_is_active_autoridade_unica.sql
-- ATENÇÃO: Este script reverte a migration. Execute apenas em emergência.
--
-- ⚠️ O QUE VOCÊ ESTÁ REABRINDO: reverter isto devolve ao cliente a capacidade de
--    escrever `profiles.is_active` por PATCH direto no PostgREST — ou seja, devolve
--    o bypass ilimitado do limite de perfis (SEC-001). Só rode se a correção estiver
--    quebrando um fluxo legítimo, e trate como janela aberta, não como estado final.
--
--    Se o motivo for "criar/renomear perfil parou de funcionar", o problema quase
--    certamente é o passo 1 (grants por coluna) e não o trigger. Prefira reverter
--    SÓ o passo 1 — a seção está isolada abaixo.

BEGIN;

-- ── Reverte em ordem INVERSA ao UP ───────────────────────────────────────────

-- 3. Autoridade única para reativação em lote
DROP FUNCTION IF EXISTS public.restaurar_perfis_em_lote(uuid, text[]);

-- 2. Backstop
DROP TRIGGER  IF EXISTS profiles_guard_is_active ON public.profiles;
DROP FUNCTION IF EXISTS public.trg_profiles_guard_is_active();

-- 1. Grants por coluna → volta ao grant amplo de tabela.
--    (Revogar o de coluna antes: GRANT de tabela não substitui GRANT de coluna,
--     os dois coexistem e o de coluna ficaria órfão no catálogo.)
REVOKE UPDATE (name, photo_url)            ON public.profiles FROM authenticated;
REVOKE INSERT (name, photo_url, user_id)   ON public.profiles FROM authenticated;

GRANT  UPDATE ON public.profiles TO authenticated;
GRANT  INSERT ON public.profiles TO authenticated;

COMMIT;

-- ── Depois de reverter, conferir que o estado do catálogo é o esperado ───────
--   SELECT relname, relacl FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace AND relname = 'profiles';
--   → esperado conter: authenticated=arwm/postgres  (a=INSERT r=SELECT w=UPDATE)
--
--   SELECT count(*) FROM information_schema.column_privileges
--    WHERE table_name='profiles' AND grantee='authenticated';
--   → esperado 0 (nenhum grant de coluna sobrando)
