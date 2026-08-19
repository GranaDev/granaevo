-- 20260818030000_storage_teto_objetos_por_pasta.sql
-- GranaEvo — Migration: teto de objetos por pasta no bucket profile-photos (SEC-A03)
-- Rollback: ver supabase/rollbacks/20260818030000_storage_teto_objetos_por_pasta.down.sql
--
-- ── O PROBLEMA (auditoria 2026-08-18) ────────────────────────────────────────
-- A policy `profile_photos_insert` dá INSERT DIRETO em `storage.objects` ao role
-- `authenticated`. Nenhum código do cliente usa `storage.from(...)` — todo upload
-- passa por `api/upload-profile-photo.js`, que tem rate limit por IP e por
-- usuário. Ou seja: aquele rate limit é o controle PRETENDIDO, e é OPCIONAL.
-- Quem falar direto com a Storage API, com o próprio JWT e a chave publicável do
-- bundle, não encosta nele.
--
-- O bucket já impõe 5 MB por arquivo e allow-list de MIME (image/jpeg, png, webp,
-- gif) — ambos no servidor, ambos bons. O que NÃO existia era teto de QUANTIDADE.
-- 5 MB × ilimitado = exaustão de custo de Storage e de bandwidth.
--
-- ── POR QUE UM TRIGGER E NÃO UMA POLICY ──────────────────────────────────────
-- Uma policy RLS enxerga só as linhas visíveis ao chamador. Contar sob RLS daria
-- número menor que o real em parte dos casos, e um teto que conta menos do que
-- existe é um teto que se contorna. O trigger roda depois da policy, vê a tabela
-- inteira e conta a verdade.
--
-- ── ESCALADA DE PRIVILÉGIO: revisada (exigência do CLAUDE.md) ────────────────
-- `SECURITY DEFINER` aqui existe SÓ para a contagem ser completa. A função:
--   · não recebe entrada do usuário além de NEW (que o Postgres já validou);
--   · não escreve em lugar nenhum;
--   · não devolve dado — só `NEW` inalterado ou uma exceção;
--   · tem `search_path` fixado, então não há sequestro de resolução de nome.
-- Não há caminho de escalada.
--
-- ── O NÚMERO: 50 ─────────────────────────────────────────────────────────────
-- Medido em produção em 2026-08-18: máximo de 8 objetos por pasta, média 2,8,
-- em 16 pastas. 50 é 6× o pior caso real. Alto o bastante para que nenhum uso
-- legítimo esbarre (trocar de foto é raro, e overwrite nem passa por aqui),
-- baixo o bastante para que o abuso pare em 250 MB por conta em vez de ilimitado.
--
-- ── O QUE ESTE TETO NÃO FAZ (de propósito) ───────────────────────────────────
-- Só vale para INSERT. Substituir a foto é UPDATE/upsert e continua livre — senão
-- quem chegasse ao teto ficaria impedido de TROCAR a própria foto, que é a mesma
-- armadilha da "válvula de encolhimento" do teto de save (_shared/teto-blob.ts):
-- um teto que barra a saída não é teto, é tijolo.
--
-- ── CUSTO ────────────────────────────────────────────────────────────────────
-- Um COUNT por INSERT, restrito ao bucket. Com 45 objetos hoje é irrelevante.
-- Se o bucket passar de ~50 mil objetos, trocar `storage.foldername(name)` por
-- uma comparação de intervalo em `name` (que usa o índice único de
-- (bucket_id, name)) — não antes, para não trocar clareza por nada.

-- ── POR QUE A FUNÇÃO MORA EM `public` E NÃO EM `storage` ────────────────────
-- O schema `storage` pertence a `supabase_admin`, e `postgres` NÃO tem CREATE
-- nele (medido em 2026-08-18: has_schema_privilege('postgres','storage','CREATE')
-- = false). A primeira versão desta migration criava a função em `storage` e o
-- ensaio devolveu `42501: permission denied for schema storage` — antes de
-- persistir qualquer coisa, que é exatamente para isso que o ensaio existe.
--
-- O que `postgres` TEM (também medido): CREATE em `public`, TRIGGER em
-- `storage.objects`, SELECT em `storage.objects`, USAGE em `storage` e EXECUTE
-- em `storage.foldername`. Ou seja: a função em `public` e o trigger apontando
-- para a tabela de `storage` é a única combinação possível — e é suficiente.
CREATE OR REPLACE FUNCTION public.granaevo_teto_objetos_por_pasta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
    v_pasta text;
    v_qtd   integer;
    v_teto  constant integer := 50;
BEGIN
    v_pasta := (storage.foldername(NEW.name))[1];

    -- Sem pasta identificável não há a quem atribuir a cota. Deixar passar seria
    -- criar exatamente o caminho de fuga que este teto fecha.
    IF v_pasta IS NULL OR v_pasta = '' THEN
        RAISE EXCEPTION 'STORAGE_LIMIT: caminho sem pasta de usuario';
    END IF;

    SELECT count(*) INTO v_qtd
    FROM storage.objects
    WHERE bucket_id = NEW.bucket_id
      AND (storage.foldername(name))[1] = v_pasta;

    IF v_qtd >= v_teto THEN
        RAISE EXCEPTION 'STORAGE_LIMIT: limite de % arquivos por perfil atingido', v_teto;
    END IF;

    RETURN NEW;
END;
$$;

-- Função de trigger nasce com EXECUTE para PUBLIC. Aqui isso é inofensivo
-- (chamada fora de trigger dá erro de contexto), mas o REVOKE mantém o
-- inventário honesto: `authenticated` não aparece como podendo executar uma
-- função SECURITY DEFINER. Ver a varredura de proacl em security-audit/.
REVOKE EXECUTE ON FUNCTION public.granaevo_teto_objetos_por_pasta() FROM PUBLIC;

DROP TRIGGER IF EXISTS granaevo_teto_objetos ON storage.objects;
CREATE TRIGGER granaevo_teto_objetos
    BEFORE INSERT ON storage.objects
    FOR EACH ROW
    WHEN (NEW.bucket_id = 'profile-photos')
    EXECUTE FUNCTION public.granaevo_teto_objetos_por_pasta();
