-- SEC-002 — `push_subscriptions.endpoint` aceitava qualquer string
-- ============================================================================
-- Auditoria god-mode de 2026-08-17. Ver security-audit/god-mode-god-eyes-REPORT-2026-08-17.md
--
-- `save-push-subscription` validava o endpoint apenas como "string não-vazia", e
-- `send-radar-push` faz POST para o que estiver gravado. O campo era, na prática,
-- o destino de uma requisição de saída do backend, escolhido pelo usuário
-- (SSRF cego). E validar só na Edge Function não fecharia nada: `authenticated`
-- tinha INSERT/UPDATE DIRETO na tabela via PostgREST, então dava para gravar por
-- fora dela com um PATCH.
--
-- ESTA MIGRATION É A TERCEIRA E A QUARTA CAMADA. As duas primeiras estão no
-- código (commit desta mesma auditoria):
--   1ª  save-push-subscription  → recusa ao gravar
--   2ª  send-radar-push         → recusa de novo ao disparar (última antes do fetch)
--   3ª  REVOKE                  → o cliente perde o caminho paralelo (aqui)
--   4ª  CHECK                   → nem o service_role consegue gravar lixo (aqui)
--
-- ESCOPO VERIFICADO ANTES (regra: correção que quebra funcionalidade = rollback):
--   · O cliente só faz SELECT e DELETE nesta tabela — `security-panel.js:191`
--     (lista dispositivos) e `:216` (revoga um). Ambos preservados.
--   · INSERT/UPDATE só acontecem em `save-push-subscription`, que usa service_role.
--   · Dados atuais: 2 linhas, ambas `https://fcm.googleapis.com/...`. O CHECK
--     valida sem precisar de NOT VALID.
--
-- ⚠️ SINCRONIA: a lista de hosts existe em DOIS lugares — aqui e em
--    `supabase/functions/_shared/push-endpoint.ts`. O SQL não consegue importar o
--    TS. O TS é a autoridade (tem os disfarces: credenciais na URL, sufixo colado);
--    este CHECK é a rede embaixo. Ao mexer num, mexa no outro — o teste
--    `tests/unit/push-endpoint-ssrf.test.js` cobre o lado TS.
-- ============================================================================

BEGIN;

-- ── 3ª camada: o cliente perde o caminho paralelo ────────────────────────────
-- SELECT e DELETE ficam: o painel de segurança lista e revoga dispositivos.
REVOKE INSERT, UPDATE ON public.push_subscriptions FROM authenticated;

-- ── 4ª camada: nem por dentro entra lixo ─────────────────────────────────────
-- `~*` (case-insensitive) porque host de URL não é case-sensitive.
--
-- A âncora final `(/|$)` é o que impede `https://fcm.googleapis.com@evil.test/`:
-- ali, depois do host, vem `@` — não casa. Sem essa âncora o CHECK seria teatro.
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_endpoint_allowlist;

ALTER TABLE public.push_subscriptions
  ADD CONSTRAINT push_endpoint_allowlist CHECK (
    char_length(endpoint) <= 2048
    AND endpoint ~* '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com|push\.apple\.com)(/|$)'
  );

COMMIT;

-- ============================================================================
-- COMO PROVAR QUE FUNCIONOU
--
--   1. Os dados existentes continuam válidos (a migration já falharia se não):
--      SELECT count(*) FROM public.push_subscriptions;   → 2
--
--   2. O CHECK recusa o alvo do SSRF (rodar como service_role — deve dar erro):
--      INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth_key)
--      VALUES ('<uid>', 'https://169.254.169.254/latest/meta-data/', 'x', 'y');
--      → ERROR: new row violates check constraint "push_endpoint_allowlist"
--
--   3. O disfarce com credenciais também é recusado:
--      … VALUES ('<uid>', 'https://fcm.googleapis.com@evil.test/x', 'x', 'y');
--      → ERROR: violates check constraint
--
--   4. O endpoint legítimo entra:
--      … VALUES ('<uid>', 'https://fcm.googleapis.com/fcm/send/abc', 'x', 'y');
--      → INSERT 0 1
--
--   5. O cliente perdeu a escrita (como authenticated, via PostgREST):
--      PATCH /rest/v1/push_subscriptions?id=eq.<meu> {"endpoint":"https://evil.test/"}
--      → 42501 / 403
--      DELETE /rest/v1/push_subscriptions?id=eq.<meu>   → 204  (continua funcionando)
--
--   6. O painel de dispositivos continua listando e revogando (teste manual na UI).
--
-- ROLLBACK: ver 20260817010000_sec002_push_endpoint_allowlist.down.sql
-- ============================================================================
