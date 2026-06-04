-- Migration: 20260505000001_cleanup_cron.sql
-- Cria função pg_cron para limpar contas abandonadas diariamente às 3h UTC.
-- "Abandonada" = criada há > 3 dias, sem assinatura ativa, sem dados de usuário.

-- Cria a função de limpeza
CREATE OR REPLACE FUNCTION cleanup_abandoned_accounts()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Deleta usuários que:
    -- 1. Criados há mais de 3 dias
    -- 2. Sem stripe_subscription ativa (active/trialing)
    -- 3. Sem subscription Cakto ativa
    -- 4. Nunca acessaram o dashboard (sem user_data)
    WITH abandoned AS (
        SELECT u.id
        FROM auth.users u
        WHERE u.created_at < NOW() - INTERVAL '3 days'
        AND NOT EXISTS (
            SELECT 1 FROM stripe_subscriptions ss
            WHERE ss.user_id = u.id
            AND ss.status IN ('active', 'trialing')
        )
        AND NOT EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = u.id
            AND s.is_active = true
            AND s.payment_status = 'approved'
        )
        AND NOT EXISTS (
            SELECT 1 FROM user_data ud
            WHERE ud.user_id = u.id
        )
    ),
    deleted AS (
        DELETE FROM auth.users
        WHERE id IN (SELECT id FROM abandoned)
        RETURNING id
    )
    SELECT COUNT(*)::INTEGER INTO deleted_count FROM deleted;

    -- Limpa stripe_subscriptions órfãs (sem user, sem pagamento, > 3 dias)
    DELETE FROM stripe_subscriptions
    WHERE user_id IS NULL
    AND status NOT IN ('active', 'trialing')
    AND created_at < NOW() - INTERVAL '3 days';

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Agenda limpeza diária às 3h UTC (remove job anterior se existir)
SELECT cron.unschedule('cleanup-abandoned-accounts') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'cleanup-abandoned-accounts'
);

SELECT cron.schedule(
    'cleanup-abandoned-accounts',
    '0 3 * * *',
    $$SELECT cleanup_abandoned_accounts()$$
);
