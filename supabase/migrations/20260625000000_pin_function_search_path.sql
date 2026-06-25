-- =============================================================================
-- GranaEvo — Fixa search_path mutável em funções (varredura de segurança 2026-06-25)
--
-- Contexto:
--   A varredura completa do banco (Management API) encontrou funções com
--   `search_path` mutável. Para funções SECURITY DEFINER isto é o vetor clássico
--   de escalada de privilégio (um schema controlado pelo atacante pode "sombrear"
--   objetos chamados pela função). Mitigado hoje porque `authenticated`/`anon` NÃO
--   têm CREATE no schema public — mas fixar o search_path é defense-in-depth e
--   zera o aviso do Supabase Security Advisor / linter.
--
-- Efeito: comportamento idêntico; apenas torna determinística a resolução de schema.
-- Idempotente: ALTER FUNCTION ... SET search_path pode rodar múltiplas vezes.
-- =============================================================================

-- ── SECURITY DEFINER (prioridade — eram as únicas definer sem search_path) ────
ALTER FUNCTION public.salvar_dados_usuario(p_data_json jsonb)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.salvar_perfil_usuario(p_profile_id text, p_profile_data jsonb)
  SET search_path = public, pg_temp;

-- ── Funções gatilho / helper (SECURITY INVOKER — risco baixo, padronização) ───
ALTER FUNCTION public.account_members_set_removed_at()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.is_feature_enabled(p_flag_key text, p_user_id uuid, p_plan_name text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_user_id_change()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.profile_backups_set_updated_at()
  SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at()
  SET search_path = public, pg_temp;
