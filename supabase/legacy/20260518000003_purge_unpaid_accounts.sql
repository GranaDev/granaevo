-- =============================================================================
-- GranaEvo — Migration: Exclusão automática de contas criadas sem pagamento
-- Política: contas sem assinatura ativa excluídas após 24h da criação.
-- Cobre: conta criada mas nunca iniciou checkout, ou checkout abandonado
--        (Stripe marca status = 'incomplete_expired' após ~23h).
-- Compatível com LGPD Art. 16 — dados de contas que nunca viraram clientes
--        não precisam ser retidos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. FUNÇÃO: purge_unpaid_accounts
--    Exclui contas em auth.users criadas há mais de 24h que nunca tiveram
--    uma assinatura paga (active, trialing, past_due, canceled, unpaid).
--
--    Critério de elegibilidade:
--      • auth.users.created_at < NOW() - 24h
--      • NÃO existe nenhuma stripe_subscriptions com status pago para o user
--      • Cobre: nunca chegou ao Stripe OU checkout abandonado (incomplete_expired)
--
--    Ordem de exclusão (FK-safe):
--      1. account_members (o convidado pode ter sido de uma conta não paga)
--      2. user_data       (não deveria existir, mas defensivo)
--      3. profiles        (não deveria existir, mas defensivo)
--      4. stripe_subscriptions (incomplete/incomplete_expired se houver)
--      5. auth.users
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_unpaid_accounts()
RETURNS integer
SECURITY DEFINER
SET search_path = extensions, public, auth
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id UUID;
  v_count   integer := 0;
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users u
    WHERE u.created_at < v_cutoff
      -- Nunca teve assinatura paga ou em andamento
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_subscriptions s
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid')
      )
  LOOP
    BEGIN
      -- 1. Vínculos de convidado (improvável, mas defensivo)
      DELETE FROM public.account_members WHERE member_user_id = v_user_id;
      DELETE FROM public.account_members WHERE owner_user_id  = v_user_id;

      -- 2. Dados financeiros (não deveria existir para conta não paga)
      DELETE FROM public.user_data WHERE user_id = v_user_id;

      -- 3. Perfis (não deveria existir para conta não paga)
      DELETE FROM public.profiles WHERE user_id = v_user_id;

      -- 4. Registros Stripe incompletos se houver
      DELETE FROM public.stripe_subscriptions WHERE user_id = v_user_id;

      -- 5. Conta de autenticação
      DELETE FROM auth.users WHERE id = v_user_id;

      v_count := v_count + 1;

      RAISE LOG '[purge_unpaid] Conta não paga excluída — user_id: %', LEFT(v_user_id::text, 8);

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[purge_unpaid] Erro ao excluir user_id %: %', LEFT(v_user_id::text, 8), SQLERRM;
    END;
  END LOOP;

  IF v_count > 0 THEN
    RAISE LOG '[purge_unpaid] Ciclo concluído — % conta(s) não pagas excluídas', v_count;
  END IF;

  RETURN v_count;
END;
$$;

-- Apenas pg_cron (superuser) e service_role podem chamar
REVOKE ALL ON FUNCTION public.purge_unpaid_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_unpaid_accounts() FROM anon;
REVOKE ALL ON FUNCTION public.purge_unpaid_accounts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_unpaid_accounts() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. CRON JOB: executa 2x por dia (02:30 e 14:30 UTC)
--    Garante que contas abandonadas sejam limpas no mesmo dia.
--    Idempotente: se nenhuma conta elegível, retorna 0.
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('granaevo-purge-unpaid-accounts')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'granaevo-purge-unpaid-accounts');

SELECT cron.schedule(
  'granaevo-purge-unpaid-accounts',
  '30 2,14 * * *',
  $$ SELECT public.purge_unpaid_accounts(); $$
);

-- ---------------------------------------------------------------------------
-- 3. COMENTÁRIO DE AUDITORIA
-- ---------------------------------------------------------------------------
COMMENT ON FUNCTION public.purge_unpaid_accounts() IS
  'Exclui contas auth.users criadas há mais de 24h sem assinatura paga. '
  'Cobre abandonos de checkout (Stripe incomplete_expired). '
  'Executado via pg_cron às 02:30 e 14:30 UTC. '
  'Não afeta contas com assinatura cancelada (cobertas por purge_expired_cancelled_accounts).';
