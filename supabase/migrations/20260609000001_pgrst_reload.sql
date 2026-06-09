-- Re-asserta permissão EXECUTE e notifica PostgREST para recarregar o schema cache.
-- Contexto: get_user_access_data retorna 403 porque o cache do PostgREST ainda
-- reflete o estado ANTES do GRANT adicionado em 20260606000001.
-- NOTIFY pgrst força recarga imediata sem reiniciar o servidor.
GRANT EXECUTE ON FUNCTION get_user_access_data(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
