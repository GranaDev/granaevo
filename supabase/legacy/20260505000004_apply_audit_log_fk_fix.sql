-- Aplica a correção da FK de financial_audit_log (migration 00002 não executou).
-- Muda ON DELETE CASCADE → ON DELETE SET NULL no user_id.

DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    SELECT c.conname INTO v_constraint
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
    WHERE t.relname = 'financial_audit_log'
      AND a.attname = 'user_id'
      AND c.contype = 'f'
    LIMIT 1;

    IF v_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE financial_audit_log DROP CONSTRAINT %I', v_constraint);
        RAISE NOTICE 'FK removida: %', v_constraint;
    ELSE
        RAISE NOTICE 'Nenhuma FK user_id encontrada — nada a alterar.';
    END IF;
END $$;

ALTER TABLE financial_audit_log
    ADD CONSTRAINT financial_audit_log_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE SET NULL;
