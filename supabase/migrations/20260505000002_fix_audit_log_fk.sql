-- Corrige FK de financial_audit_log para auth.users.
-- ON DELETE CASCADE → ON DELETE SET NULL
-- Motivo: trigger bloquear_alteracao_audit_log() proíbe DELETE.
-- SET NULL preserva o log histórico e permite deletar usuários.

DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    -- Descobre o nome da FK usando pg_constraint (sem ambiguidade de coluna)
    SELECT c.conname INTO v_constraint
    FROM pg_constraint c
    JOIN pg_class     t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
    WHERE t.relname  = 'financial_audit_log'
      AND a.attname  = 'user_id'
      AND c.contype  = 'f'  -- foreign key
    LIMIT 1;

    IF v_constraint IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE financial_audit_log DROP CONSTRAINT %I',
            v_constraint
        );
        RAISE NOTICE 'FK % removida.', v_constraint;
    ELSE
        RAISE NOTICE 'FK user_id não encontrada em financial_audit_log.';
    END IF;
END $$;

-- Recria com ON DELETE SET NULL
ALTER TABLE financial_audit_log
    ADD CONSTRAINT financial_audit_log_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE SET NULL;
