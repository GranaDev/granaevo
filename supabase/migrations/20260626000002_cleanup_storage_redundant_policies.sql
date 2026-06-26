-- =============================================================================
-- GranaEvo — Limpeza: políticas redundantes de Storage (bucket profile-photos)
-- Rollback: ver 20260626000002_cleanup_storage_redundant_policies.down.sql
--
-- Contexto (FIX-3, /god-eyes): storage.objects tinha dois conjuntos sobrepostos.
--   - storage_delete  == profile_photos_delete  (idênticos)
--   - storage_update  == profile_photos_update  (idênticos)
--   - storage_select  ⊂  profile_photos_select  (subconjunto: só dono, sem o
--                                                 compartilhamento via account_members)
-- Removidos os 3 redundantes. Mantidos: profile_photos_* (authenticated, com sharing
-- casal/família) e storage_insert (service_role — papel distinto, NÃO é duplicata).
--
-- Efeito: nenhuma mudança de acesso efetivo (o conjunto profile_photos_* já cobre).
-- =============================================================================

DROP POLICY IF EXISTS storage_delete ON storage.objects;
DROP POLICY IF EXISTS storage_select ON storage.objects;
DROP POLICY IF EXISTS storage_update ON storage.objects;
