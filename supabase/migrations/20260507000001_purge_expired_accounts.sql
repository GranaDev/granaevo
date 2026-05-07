-- =============================================================================
-- GranaEvo — Migration: Exclusão automática de dados de contas canceladas
-- Política: dados preservados por 90 dias após o fim do acesso pago.
-- Após 90 dias sem reativação, TODOS os dados são removidos permanentemente.
-- Compatível com LGPD (Art. 16 — dados mantidos pelo prazo necessário).
--
-- Aplique via: supabase db push
--   OU execute no SQL Editor do Supabase Dashboard
--
-- Pré-requisito: pg_cron habilitado (migration 20260425000000 já o fez).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. FUNÇÃO: purge_expired_cancelled_accounts
--    Exclui permanentemente todos os dados de usuários cujo acesso pago
--    encerrou há mais de 90 dias e que não reassinaram.
--
--    Ordem de exclusão (respeita FK constraints):
--      1. user_data           — dados financeiros criptografados (JSON)
--      2. profiles            — perfis e fotos de perfil
--      3. stripe_subscriptions — registros de assinatura (o CASCADE cobre,
--                                mas excluímos explicitamente por segurança)
--      4. auth.users          — conta de autenticação
--                              (ON DELETE CASCADE cobre stripe_subscriptions
--                               com user_id, por precaução já excluímos antes)
--
--    Retorna o número de contas excluídas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_expired_cancelled_accounts()
RETURNS integer
SECURITY DEFINER
SET search_path = extensions, public, auth
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id   UUID;
  v_count     integer := 0;
  v_cutoff    TIMESTAMPTZ := NOW() - INTERVAL '90 days';
BEGIN
  -- Identifica usuários elegíveis para exclusão:
  --   • status = 'canceled' (assinatura definitivamente encerrada pelo Stripe)
  --   • O fim do período pago (current_period_end) ultrapassou 90 dias
  --   • Sem nova assinatura ativa no mesmo user_id
  FOR v_user_id IN
    SELECT DISTINCT s.user_id
    FROM   public.stripe_subscriptions s
    WHERE  s.status  = 'canceled'
      AND  s.user_id IS NOT NULL
      AND  COALESCE(s.current_period_end, s.canceled_at, s.created_at) < v_cutoff
      -- Garante que não existe assinatura ativa para o mesmo usuário
      AND  NOT EXISTS (
             SELECT 1
             FROM   public.stripe_subscriptions s2
             WHERE  s2.user_id = s.user_id
               AND  s2.status IN ('active', 'trialing', 'past_due')
           )
  LOOP
    BEGIN
      -- 1. Dados financeiros (JSON criptografado — maior volume de dados pessoais)
      DELETE FROM public.user_data
      WHERE  user_id = v_user_id;

      -- 2. Perfis (inclui referência à foto em storage)
      DELETE FROM public.profiles
      WHERE  user_id = v_user_id;

      -- 3. Registros de assinatura Stripe
      DELETE FROM public.stripe_subscriptions
      WHERE  user_id = v_user_id;

      -- 4. Conta de autenticação (cascata para qualquer FK restante)
      DELETE FROM auth.users
      WHERE  id = v_user_id;

      v_count := v_count + 1;

      RAISE LOG '[purge_expired] Conta excluída — user_id: %', LEFT(v_user_id::text, 8);

    EXCEPTION WHEN OTHERS THEN
      -- Não aborta o loop inteiro se uma exclusão falhar
      RAISE WARNING '[purge_expired] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_expired] Ciclo concluído — % conta(s) excluída(s)', v_count;
  END IF;

  RETURN v_count;
END;
$$;

-- Apenas o scheduler (pg_cron = superuser) e service_role podem chamar
REVOKE ALL ON FUNCTION public.purge_expired_cancelled_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_cancelled_accounts() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_cancelled_accounts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_cancelled_accounts() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. CRON JOB: executa diariamente às 03:00 UTC
--    Horário de baixo tráfego — minimiza impacto em I/O.
--    O job é idempotente: se nenhuma conta estiver elegível, retorna 0.
-- ---------------------------------------------------------------------------

-- Remove job anterior caso exista (evita duplicata)
SELECT cron.unschedule('purge-expired-cancelled-accounts')
WHERE  EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-cancelled-accounts'
);

SELECT cron.schedule(
  'purge-expired-cancelled-accounts',    -- nome único do job
  '0 3 * * *',                           -- todo dia às 03:00 UTC
  $$ SELECT public.purge_expired_cancelled_accounts(); $$
);

-- ---------------------------------------------------------------------------
-- 3. COMENTÁRIOS DE AUDITORIA (documentação inline no schema)
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.purge_expired_cancelled_accounts() IS
  'Exclui permanentemente dados de usuários com assinatura cancelada há mais de '
  '90 dias. Executado automaticamente via pg_cron às 03:00 UTC. '
  'Conforme LGPD Art. 16 — retenção pelo prazo estritamente necessário. '
  'Não excluirá contas com assinatura ativa (reativação dentro dos 90 dias).';
