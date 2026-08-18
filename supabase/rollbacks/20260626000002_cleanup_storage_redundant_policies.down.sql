-- =============================================================================
-- GranaEvo — Rollback: 20260626000002_cleanup_storage_redundant_policies.sql
-- ATENÇÃO: reverte a limpeza. Execute apenas em emergência.
-- Recria as 3 políticas redundantes (snapshot pg_policies 2026-06-26).
-- =============================================================================

CREATE POLICY storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING ((bucket_id = 'profile-photos'::text)
         AND ((storage.foldername(name))[1] = (auth.uid())::text));

CREATE POLICY storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING ((bucket_id = 'profile-photos'::text)
         AND ((storage.foldername(name))[1] = (auth.uid())::text));

CREATE POLICY storage_update ON storage.objects
  FOR UPDATE TO authenticated
  USING ((bucket_id = 'profile-photos'::text)
         AND ((storage.foldername(name))[1] = (auth.uid())::text))
  WITH CHECK ((bucket_id = 'profile-photos'::text)
         AND ((storage.foldername(name))[1] = (auth.uid())::text));
