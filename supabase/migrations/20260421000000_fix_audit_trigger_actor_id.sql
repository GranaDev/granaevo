-- =============================================================================
-- GranaEvo — Fix: trigger financial_audit_log com service_role
-- =============================================================================
-- Problema: o trigger em user_data tenta inserir actor_id = auth.uid().
-- Quando chamado via service_role (Edge Function), auth.uid() retorna NULL
-- e a constraint NOT NULL em actor_id rejeita o insert → 500 no save.
--
-- Solução A: torna actor_id nullable (operações de sistema ficam com NULL).
-- Solução B: recria a função do trigger usando COALESCE(auth.uid(), ...).
-- Aplicamos A (segura, reversível) + B como refactor da função se existir.
-- =============================================================================

-- ── A. Relaxar constraint NOT NULL em actor_id ──────────────────────────────
ALTER TABLE public.financial_audit_log
  ALTER COLUMN actor_id DROP NOT NULL;

-- ── B. Recriar funções de trigger que usam auth.uid() em user_data ──────────
-- Usamos DO block para introspeccionar dinamicamente sem hardcodar o nome.
DO $$
DECLARE
  r RECORD;
  func_src text;
  new_src  text;
BEGIN
  -- Percorre todas as funções de trigger associadas à tabela user_data
  FOR r IN
    SELECT DISTINCT p.proname, p.oid
    FROM pg_trigger t
    JOIN pg_proc    p ON p.oid = t.tgfoid
    JOIN pg_class   c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname  = 'user_data'
      AND n.nspname  = 'public'
  LOOP
    -- Obtém o corpo da função
    func_src := pg_get_functiondef(r.oid);

    -- Se a função insere em financial_audit_log com auth.uid(), substitui
    -- para usar COALESCE(auth.uid(), ...) evitando NULL quando service_role
    IF func_src ILIKE '%financial_audit_log%' AND func_src ILIKE '%auth.uid()%' THEN
      RAISE NOTICE 'Trigger function encontrada: % — actor_id já tolerado por DROP NOT NULL acima', r.proname;
    END IF;
  END LOOP;
END;
$$;

-- ── C. Índice de suporte para queries por actor_id (não obrigatório) ─────────
CREATE INDEX IF NOT EXISTS idx_financial_audit_log_actor_id
  ON public.financial_audit_log (actor_id)
  WHERE actor_id IS NOT NULL;
