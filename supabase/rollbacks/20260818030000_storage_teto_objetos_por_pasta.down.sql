-- 20260818030000_storage_teto_objetos_por_pasta.down.sql
-- Reverte 20260818030000_storage_teto_objetos_por_pasta.sql
--
-- ⛔ ESTE ARQUIVO NUNCA DEVE SER APLICADO POR `supabase db push`.
--    Ver supabase/rollbacks/ROLLBACK_CONVENTION.md — é por isso que ele mora
--    aqui e não em supabase/migrations/.
--
-- ── O QUE SE PERDE AO REVERTER ───────────────────────────────────────────────
-- Volta a não existir teto de QUANTIDADE de objetos no bucket profile-photos.
-- O bucket continua impondo 5 MB por arquivo e a allow-list de MIME, e o rate
-- limit de `api/upload-profile-photo.js` continua valendo — mas só para quem
-- passa por lá. Quem falar direto com a Storage API volta a poder subir arquivos
-- sem limite de contagem (SEC-A03).
--
-- ── QUANDO REVERTER FAZ SENTIDO ──────────────────────────────────────────────
-- Se o teto de 50 estiver recusando upload legítimo. Nesse caso, prefira SUBIR
-- o número na função a remover o trigger: `v_teto` é uma constante única dentro
-- de `public.granaevo_teto_objetos_por_pasta()`. Remover o trigger inteiro só
-- se o mecanismo em si estiver quebrado.

DROP TRIGGER IF EXISTS granaevo_teto_objetos ON storage.objects;
DROP FUNCTION IF EXISTS public.granaevo_teto_objetos_por_pasta();
