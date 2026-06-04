-- Remove a FK de financial_audit_log.user_id → auth.users.
--
-- MOTIVO ARQUITETURAL:
-- Um audit log imutável não deve ter FK com CASCADE ou SET NULL.
-- Qualquer operação de cascade (DELETE ou UPDATE) é bloqueada pelo
-- trigger bloquear_alteracao_audit_log() — comportamento correto.
--
-- A abordagem certa: sem FK.
-- Os registros do log mantêm o user_id original mesmo após deleção
-- do usuário — isso é desejável para auditoria forense.
-- Integridade referencial não se aplica a dados imutáveis históricos.

DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    -- Remove qualquer FK de user_id que exista (qualquer nome)
    FOR v_constraint IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class     t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'financial_audit_log'
          AND a.attname = 'user_id'
          AND c.contype = 'f'
    LOOP
        EXECUTE format('ALTER TABLE financial_audit_log DROP CONSTRAINT %I', v_constraint);
        RAISE NOTICE 'FK removida: %', v_constraint;
    END LOOP;
END $$;
