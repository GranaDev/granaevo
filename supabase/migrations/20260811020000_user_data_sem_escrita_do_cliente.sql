-- 20260811020000_user_data_sem_escrita_do_cliente.sql
-- GranaEvo — Migration: tira do cliente a escrita direta em user_data
-- Rollback: ver 20260811020000_user_data_sem_escrita_do_cliente.down.sql
--
-- ============================================================================
-- [SEC-009] O caminho que pula TODAS as defesas do blob financeiro
-- ============================================================================
-- `authenticated` tinha INSERT, UPDATE e DELETE em `public.user_data`. O RLS
-- limita a linha ao dono, entao NAO e vazamento entre usuarios — e integridade
-- e disponibilidade do dado mais critico do produto.
--
-- O problema e que a aplicacao NUNCA usa esse caminho. Conferido de dois jeitos
-- independentes em 2026-08-11:
--   1. `grep -rn "from('user_data')" src/ public/ *.html`  → zero ocorrencias
--   2. o cliente so fala com 8 tabelas por PostgREST, e user_data nao esta entre
--      elas (radar_notifications, profiles, stripe_subscriptions,
--      financial_audit_log, push_subscriptions, account_members, user_devices,
--      terms_acceptance)
--
-- Todo save real passa por /api/user-data → edge `save-user-data`, que aplica,
-- NESTA ORDEM, coisas que um PATCH direto no PostgREST pula inteiras:
--
--   • GUARDA ANTI-WIPE  — nasceu de uma PERDA TOTAL DE DADOS real (2026-06-23).
--                         Um DELETE direto e exatamente o incidente de volta,
--                         com a guarda assistindo de fora.
--   • TRAVA DE VERSAO   — `base_versao` → 409. Sem ela, lost update silencioso.
--   • MERGE POR PERFIL  — casal/familia dividem UMA linha; sem o merge, um
--                         escritor apaga o trabalho do outro.
--   • GATE DE 2FA       — `mfaBloqueia`. Uma sessao aal1 escreveria sem passar.
--   • CIFRAGEM AES-GCM  — o blob e cifrado com chave derivada por usuario. Um
--                         write direto grava TEXTO CLARO no lugar do ciphertext.
--
-- Ou seja: um XSS, um token roubado, ou um script do proprio usuario destroem o
-- blob sem encostar em nenhuma das cinco protecoes. O grant e uma arma carregada
-- apontada para o unico incidente que este projeto ja teve de verdade.
--
-- SELECT FICA. Nao e descuido:
--   • o cliente tambem nao usa, mas ler devolve CIPHERTEXT (`{_enc:"v2:..."}`),
--     que sem a DATA_ENCRYPTION_KEY nao diz nada;
--   • o RLS ja limita a linha ao dono (e ao convidado do dono);
--   • revogar SELECT tambem mataria a policy `user_data_select`, que e a unica
--     documentacao viva de quem deveria poder ler a linha.
-- Tirar as tres ESCRITAS elimina 100% do estrago possivel. Revogar o SELECT e
-- higiene opcional, com risco (pequeno) de quebrar um caminho de leitura que a
-- varredura nao viu — nao vale trocar risco real por elegancia.
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE ON public.user_data FROM authenticated;

-- As policies de escrita continuam de pe DE PROPOSITO (nao sao apagadas aqui).
-- Se um dia alguem reconceder o GRANT sem recriar a policy, o RLS nega por
-- padrao — a tabela fica FECHADA, nao aberta. Policy sem grant e inalcancavel;
-- grant sem policy e um buraco. Na duvida, sobra a policy.

-- ============================================================================
-- AUTOVERIFICACAO
-- ============================================================================
DO $$
BEGIN
    IF has_table_privilege('authenticated', 'public.user_data', 'INSERT')
    OR has_table_privilege('authenticated', 'public.user_data', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.user_data', 'DELETE') THEN
        RAISE EXCEPTION 'REVOKE nao pegou: authenticated ainda escreve em user_data';
    END IF;

    -- A leitura tem de sobreviver: se ela cair junto, a policy user_data_select
    -- vira letra morta e um caminho de leitura futuro quebra sem explicacao.
    IF NOT has_table_privilege('authenticated', 'public.user_data', 'SELECT') THEN
        RAISE EXCEPTION 'SELECT foi revogado sem querer — nao era esse o escopo';
    END IF;
END $$;

COMMENT ON TABLE public.user_data IS
    'Blob financeiro cifrado (AES-256-GCM, chave derivada por usuario). ESCRITA '
    'EXCLUSIVA pela Edge Function save-user-data via service_role: e la que vivem '
    'a guarda anti-wipe, a trava de versao, o merge por perfil e o gate de 2FA. '
    'NUNCA reconceder INSERT/UPDATE/DELETE a authenticated — ver migration '
    '20260811020000 (SEC-009).';
