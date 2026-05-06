-- Atualiza cleanup_abandoned_accounts() para ser compatível com
-- o trigger de imutabilidade do financial_audit_log.
-- Com a FK em SET NULL (migration 00002), o DELETE em auth.users
-- agora anonymiza o log em vez de tentar deletá-lo.

CREATE OR REPLACE FUNCTION cleanup_abandoned_accounts()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER := 0;
    v_id          UUID;
BEGIN
    -- Itera nos candidatos para logar cada deleção (sem FOR loop no DELETE
    -- pois queremos contar corretamente)
    FOR v_id IN
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
                AND s.is_active      = true
                AND s.payment_status = 'approved'
          )
          AND NOT EXISTS (
              SELECT 1 FROM user_data ud
              WHERE ud.user_id = u.id
          )
        -- Exclui contas de serviço / administradores do sistema
        -- (emails do próprio domínio não são limpas automaticamente)
        AND u.email NOT LIKE '%@granaevo.com'
    LOOP
        -- Limpa dados dependentes que NÃO têm CASCADE (ou têm trigger bloqueando)
        DELETE FROM terms_acceptance  WHERE user_id = v_id;
        DELETE FROM user_data         WHERE user_id = v_id;
        DELETE FROM account_members
            WHERE member_user_id = v_id
               OR owner_user_id  = v_id;
        -- stripe_subscriptions: ON DELETE CASCADE cobre; mas fazemos explícito
        -- para cobrir registros sem user_id (compras órfãs pelo email)
        DELETE FROM stripe_subscriptions
            WHERE user_id = v_id;

        -- financial_audit_log: com FK SET NULL, o DELETE em auth.users
        -- vai apenas NULLificar o user_id — sem violar o trigger de imutabilidade.

        -- Deleta o usuário (dispara SET NULL no financial_audit_log)
        DELETE FROM auth.users WHERE id = v_id;

        deleted_count := deleted_count + 1;
    END LOOP;

    -- Limpa stripe_subscriptions sem usuário, inativas, antigas
    DELETE FROM stripe_subscriptions
    WHERE user_id IS NULL
      AND status NOT IN ('active', 'trialing')
      AND created_at < NOW() - INTERVAL '3 days';

    -- Limpa eventos Stripe com mais de 90 dias (idempotência já expirada)
    DELETE FROM stripe_events
    WHERE processed_at < NOW() - INTERVAL '90 days';

    RAISE NOTICE '[cleanup] % usuário(s) abandonado(s) removido(s).', deleted_count;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Remove e recria o cron job com a função atualizada
SELECT cron.unschedule('cleanup-abandoned-accounts')
FROM cron.job
WHERE jobname = 'cleanup-abandoned-accounts';

SELECT cron.schedule(
    'cleanup-abandoned-accounts',
    '0 3 * * *',
    $$SELECT cleanup_abandoned_accounts()$$
);
