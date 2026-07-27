-- 20260727030000_mfa_gate_edges.sql
-- GranaEvo — Migration: gate de 2FA para as Edge Functions de dados (Passo 31 · B-1c)
-- Rollback: ver 20260727030000_mfa_gate_edges.down.sql
--
-- O BURACO QUE ISTO FECHA
--   A migration 20260727020000 exige aal2 via RLS, o que cobre tudo que o cliente
--   alcança por PostgREST. Mas `get-user-data` e `save-user-data` falam com o banco
--   usando service_role, que **bypassa RLS por definição** — e é justamente por ali
--   que passa o blob financeiro inteiro. Sem este gate, uma sessão aal1 de quem
--   ativou o 2FA continuaria lendo e gravando os dados: o segundo fator protegeria
--   a porta da frente enquanto a porta dos fundos seguia aberta.
--
-- POR QUE UMA FUNÇÃO SEPARADA DE `mfa_pendente()`
--   `mfa_pendente()` deriva tudo de `auth.uid()`, que é NULL numa conexão
--   service_role. Ela é perfeita para RLS e inútil aqui. Esta recebe o user_id e
--   o aal explicitamente, porque quem chama já provou a identidade de outro jeito:
--   a Edge Function validou o JWT via `auth.getUser(token)` (assinatura ES256
--   conferida contra o JWKS) ANTES de chegar aqui, e o `aal` sai do payload desse
--   mesmo token verificado.
--
-- POR QUE ACEITAR user_id COMO ARGUMENTO NÃO É ESCALADA
--   A auditoria trata "DEFINER que aceita user_id" como padrão de risco, e com
--   razão — mas o risco é a função ser ALCANÇÁVEL por quem não deveria. Aqui:
--     • EXECUTE só para service_role (revogado de PUBLIC/anon/authenticated)
--     • retorna um único boolean; não devolve dado nenhum
--     • é read-only (STABLE, sem escrita)
--   Mesmo que alguém a chamasse com o user_id de outro, aprenderia apenas se
--   aquela conta tem 2FA — e não teria como chamá-la sem a service_role.

CREATE OR REPLACE FUNCTION public.mfa_bloqueia(p_user_id uuid, p_aal text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
           SELECT 1 FROM auth.mfa_factors f
           WHERE f.user_id = p_user_id
             AND f.status  = 'verified'
         )
     AND COALESCE(p_aal, 'aal1') <> 'aal2';
$$;

COMMENT ON FUNCTION public.mfa_bloqueia(uuid, text) IS
    'true quando o usuario TEM 2FA verificado e a sessao NAO esta elevada (aal <> aal2). Para as Edge Functions de dados, que usam service_role e bypassam RLS. EXECUTE apenas service_role. Ver migration 20260727030000.';

REVOKE ALL     ON FUNCTION public.mfa_bloqueia(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mfa_bloqueia(uuid, text) TO service_role;

-- SOBRE ÍNDICE: não criamos nenhum aqui, por dois motivos. O GoTrue já mantém
-- `mfa_factors_user_id_idx` em (user_id), que é exatamente o acesso desta função.
-- E, mesmo que faltasse, `auth.mfa_factors` pertence a `supabase_auth_admin`:
-- um CREATE INDEX ali falha com "must be owner of table mfa_factors" e derruba a
-- migration inteira. Objeto do schema `auth` não é nosso para alterar.

NOTIFY pgrst, 'reload schema';
