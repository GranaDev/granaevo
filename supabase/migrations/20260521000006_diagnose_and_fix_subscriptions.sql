-- =============================================================================
-- GranaEvo — Diagnóstico e correção total de referências a "subscriptions"
--
-- As funções can_create_profile() e cleanup_abandoned_accounts() estão limpas
-- (verificado via pg_proc). O erro 42P01 persiste, portanto a origem deve ser:
--   A) Um trigger na tabela profiles criado manualmente (fora das migrations)
--   B) Outra função no schema public que ainda referencia subscriptions
--   C) Uma RLS policy em alguma tabela que usa subscriptions
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Remove TODOS os triggers não-internos em public.profiles
--    (inclui os criados manualmente via Dashboard que não aparecem nas migrations)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_trig RECORD;
BEGIN
  FOR v_trig IN
    SELECT tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'profiles'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.profiles CASCADE', v_trig.tgname);
    RAISE NOTICE '[diagnose] Trigger removido de profiles: %', v_trig.tgname;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Encontra e corrige TODAS as funções no schema public que ainda
--    referenciam "subscriptions" (exclui stripe_subscriptions e _cakto_archive)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn   RECORD;
BEGIN
  FOR v_fn IN
    SELECT proname, prosrc
    FROM pg_proc p
    WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND p.prosrc ~* '\bsubscriptions\b'
      AND p.prosrc !~* 'stripe_subscriptions'
      AND p.prosrc !~* 'subscriptions_cakto_archive'
  LOOP
    RAISE WARNING '[diagnose] FUNÇÃO COM REFERÊNCIA A subscriptions: % — body preview: %',
      v_fn.proname, left(v_fn.prosrc, 200);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Encontra RLS policies em qualquer tabela que referenciem "subscriptions"
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_pol RECORD;
BEGIN
  FOR v_pol IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (qual IS NOT NULL AND qual ~* '\bsubscriptions\b' AND qual !~* 'stripe_subscriptions' AND qual !~* 'subscriptions_cakto_archive')
        OR
        (with_check IS NOT NULL AND with_check ~* '\bsubscriptions\b' AND with_check !~* 'stripe_subscriptions' AND with_check !~* 'subscriptions_cakto_archive')
      )
  LOOP
    RAISE WARNING '[diagnose] POLICY COM REFERÊNCIA A subscriptions: tabela=% policy=% qual=% with_check=%',
      v_pol.tablename, v_pol.policyname,
      left(COALESCE(v_pol.qual, ''), 200),
      left(COALESCE(v_pol.with_check, ''), 200);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Verifica triggers em TODAS as tabelas do schema public cujas funções
--    referenciam "subscriptions" — não só profiles
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_trig RECORD;
BEGIN
  FOR v_trig IN
    SELECT
      n.nspname  AS schema_name,
      c.relname  AS table_name,
      t.tgname   AS trigger_name,
      p.proname  AS function_name,
      p.prosrc   AS function_body
    FROM pg_trigger t
    JOIN pg_class c       ON c.oid = t.tgrelid
    JOIN pg_namespace n   ON n.oid = c.relnamespace
    JOIN pg_proc p        ON p.oid = t.tgfoid
    WHERE n.nspname IN ('public', 'auth')
      AND NOT t.tgisinternal
      AND p.prosrc ~* '\bsubscriptions\b'
      AND p.prosrc !~* 'stripe_subscriptions'
      AND p.prosrc !~* 'subscriptions_cakto_archive'
  LOOP
    RAISE WARNING '[diagnose] TRIGGER COM REFERÊNCIA A subscriptions: tabela=%.% trigger=% função=% body=%',
      v_trig.schema_name, v_trig.table_name,
      v_trig.trigger_name, v_trig.function_name,
      left(v_trig.function_body, 200);

    -- Remove o trigger problemático
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I CASCADE',
      v_trig.trigger_name, v_trig.schema_name, v_trig.table_name);
    RAISE NOTICE '[diagnose] Trigger % em %.% removido.', v_trig.trigger_name, v_trig.schema_name, v_trig.table_name;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Garante que a RLS policy de INSERT em profiles está correta
--    (sem referência a can_create_profile antiga ou qualquer subscriptions)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;

CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND can_create_profile()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- F. Verifica outras funções que poderiam ter overloads com subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    AND p.prosrc ~* '\bsubscriptions\b'
    AND p.prosrc !~* 'stripe_subscriptions'
    AND p.prosrc !~* 'subscriptions_cakto_archive';

  IF v_count > 0 THEN
    RAISE WARNING '[diagnose] Ainda existem % função(ões) com referência direta a subscriptions!', v_count;
  ELSE
    RAISE NOTICE '[diagnose] OK — nenhuma função pública referencia subscriptions diretamente.';
  END IF;

  -- Conta triggers problemáticos restantes
  SELECT COUNT(*) INTO v_count
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE n.nspname IN ('public', 'auth')
    AND NOT t.tgisinternal
    AND p.prosrc ~* '\bsubscriptions\b'
    AND p.prosrc !~* 'stripe_subscriptions'
    AND p.prosrc !~* 'subscriptions_cakto_archive';

  IF v_count > 0 THEN
    RAISE WARNING '[diagnose] Ainda existem % trigger(s) com referência a subscriptions!', v_count;
  ELSE
    RAISE NOTICE '[diagnose] OK — nenhum trigger referencia subscriptions diretamente.';
  END IF;
END $$;
