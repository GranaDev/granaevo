-- 20260727050000_storage_policies_as_code.sql
-- GranaEvo — Migration: registra como CÓDIGO as policies de storage.objects (M-3)
-- Rollback: ver 20260727050000_storage_policies_as_code.down.sql
--
-- O PROBLEMA (drift)
--   Estas 5 policies existem no banco e são LOAD-BEARING: são elas que impedem um
--   usuário de ler a foto de perfil de outro. Mas não existiam em migration
--   nenhuma — apareciam só DENTRO DE UM COMENTÁRIO em
--   `20260626000002_cleanup_storage_redundant_policies.sql`, e
--   `supabase/schema/public_baseline.sql` não cobre o schema `storage`.
--   Ou seja: se sumissem, não havia fonte para restaurá-las. Já existe registro
--   no projeto de policy load-bearing desaparecendo após operação no Management
--   API — este arquivo é o seguro contra isso.
--
-- POR QUE APLICAR E NÃO SÓ DOCUMENTAR
--   Uma migration de "documentação" que nunca rodou não vale nada: ninguém sabe
--   se ela reproduz o estado real. Esta foi aplicada e o resultado conferido por
--   fingerprint (md5 do conjunto de policies) ANTES e DEPOIS — as definições
--   abaixo são transcrição exata do que o banco reportava.
--
-- REGRA DE ACESSO EM UMA FRASE
--   Cada usuário manda na pasta `<seu-uuid>/`; convidado ATIVO (account_members)
--   pode LER e ESCREVER na pasta do dono do plano, mas só o próprio dono da pasta
--   pode ALTERAR ou APAGAR o que está nela.

-- ── SELECT: própria pasta, ou a do dono de quem sou convidado ativo ──────────
DROP POLICY IF EXISTS profile_photos_select ON storage.objects;
CREATE POLICY profile_photos_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'profile-photos'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR EXISTS (
                SELECT 1 FROM public.account_members am
                WHERE am.member_user_id = auth.uid()
                  AND am.is_active = true
                  AND am.owner_user_id::text = (storage.foldername(objects.name))[1]
            )
        )
    );

-- ── INSERT: mesma regra do SELECT (convidado sobe foto na conta do dono) ─────
DROP POLICY IF EXISTS profile_photos_insert ON storage.objects;
CREATE POLICY profile_photos_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'profile-photos'
        AND (
            (storage.foldername(name))[1] = auth.uid()::text
            OR EXISTS (
                SELECT 1 FROM public.account_members am
                WHERE am.member_user_id = auth.uid()
                  AND am.is_active = true
                  AND am.owner_user_id::text = (storage.foldername(objects.name))[1]
            )
        )
    );

-- ── UPDATE: SÓ a própria pasta. Convidado não sobrescreve foto alheia. ───────
DROP POLICY IF EXISTS profile_photos_update ON storage.objects;
CREATE POLICY profile_photos_update ON storage.objects
    FOR UPDATE TO authenticated
    USING      (bucket_id = 'profile-photos' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'profile-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── DELETE: SÓ a própria pasta. ─────────────────────────────────────────────
DROP POLICY IF EXISTS profile_photos_delete ON storage.objects;
CREATE POLICY profile_photos_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'profile-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── service_role: a Edge upload-profile-photo grava por aqui ─────────────────
DROP POLICY IF EXISTS storage_insert ON storage.objects;
CREATE POLICY storage_insert ON storage.objects
    FOR INSERT TO service_role
    WITH CHECK (bucket_id = 'profile-photos');
