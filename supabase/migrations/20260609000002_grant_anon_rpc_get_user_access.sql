-- PostgREST só expõe funções via /rest/v1/rpc/ se o role 'anon' tiver EXECUTE.
-- A migration 20260606000001 fez REVOKE FROM PUBLIC (incluindo anon) e só
-- concedeu a 'authenticated'. Isso impediu o PostgREST de incluir a função
-- no schema cache → 403 permanente mesmo com has_execute=true para authenticated.
--
-- A função é segura para anon: o body verifica auth.uid() e retorna
-- {"type":"none"} para qualquer chamada não autenticada.
GRANT EXECUTE ON FUNCTION public.get_user_access_data(uuid) TO anon;

-- Força reload imediato do schema cache do PostgREST.
NOTIFY pgrst, 'reload schema';
