-- =============================================================================
-- 1. Remove triggers/funções em auth.users que referenciam public.subscriptions
--    (tabela agora renomeada para subscriptions_cakto_archive).
--    Estes triggers causavam "Database error creating new user" na GoTrue API.
-- =============================================================================
DO $$
DECLARE
  v_trig RECORD;
  v_func RECORD;
BEGIN
  -- Remove todos os triggers em auth.users que chamam funções que referenciam subscriptions
  FOR v_trig IN
    SELECT tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users CASCADE', v_trig.tgname);
    RAISE NOTICE 'Trigger removido de auth.users: %', v_trig.tgname;
  END LOOP;
END $$;

-- =============================================================================
-- 2. Restaura contas auth deletadas pelo bug de purge
--    Insere diretamente em auth.users + auth.identities
--    Senha temporária: GranaEvo@2026
-- =============================================================================
DO $$
DECLARE
  v_email       TEXT;
  v_user_id     UUID;
  v_identity_id UUID;
  v_temp_pass   TEXT;
  v_now         TIMESTAMPTZ := NOW();
  v_emails TEXT[] := ARRAY[
    'suportegranaevo@gmail.com',
    'kemellycarolayne@gmail.com',
    'samuelcontamestre@gmail.com',
    'snakitohachi47@gmail.com',
    'claricealexandre.alves@gmail.com'
  ];
BEGIN
  -- Gera hash da senha temporária
  v_temp_pass := extensions.crypt('GranaEvo@2026', extensions.gen_salt('bf'));

  FOREACH v_email IN ARRAY v_emails LOOP
    IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(v_email)) THEN
      RAISE NOTICE '[restore] Já existe: %', v_email;
      CONTINUE;
    END IF;

    v_user_id     := gen_random_uuid();
    v_identity_id := gen_random_uuid();

    INSERT INTO auth.users (
      instance_id, id, aud, role,
      email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin, created_at, updated_at,
      confirmation_token, recovery_token,
      email_change_token_new, email_change,
      phone, phone_change, phone_change_token,
      email_change_token_current, email_change_confirm_status,
      reauthentication_token, is_sso_user, is_anonymous
    ) VALUES (
      '00000000-0000-0000-0000-000000000000'::uuid,
      v_user_id, 'authenticated', 'authenticated',
      lower(v_email), v_temp_pass, v_now,
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"restored_by":"migration","reason":"purge_bug_fix"}'::jsonb,
      false, v_now, v_now,
      '', '', '', '',
      NULL, '', '', '', 0, '',
      false, false
    );

    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data,
      provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
      v_identity_id, v_user_id,
      lower(v_email),
      jsonb_build_object('sub', v_user_id::text, 'email', lower(v_email), 'email_verified', true),
      'email', NULL, v_now, v_now
    );

    UPDATE public.stripe_subscriptions
    SET user_id = v_user_id, updated_at = v_now
    WHERE lower(user_email) = lower(v_email)
      AND user_id IS NULL;

    RAISE NOTICE '[restore] Conta recriada: % → %', v_email, v_user_id;
  END LOOP;

  RAISE NOTICE '[restore] Concluído.';
END $$;
