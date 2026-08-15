-- ROLLBACK de 20260815200000_drop_rpcs_orfas_de_save.sql
--
-- ⚠️ NÃO recria as funções, DE PROPÓSITO.
--
-- Elas foram desenhadas para uma arquitetura abandonada (cliente escrevendo em
-- `user_data` via PostgREST) que não existe mais: `authenticated` perdeu
-- INSERT/UPDATE/DELETE nessa tabela em 20260811020000. Recriá-las devolveria
-- duas SECURITY DEFINER inertes cuja única propriedade real é serem um caminho
-- de escrita a um GRANT de distância de contornar MFA, merge por perfil,
-- anti-wipe, trava de versão e o teto de tamanho.
--
-- Se algum dia o save por RPC voltar a ser o desenho, escreva funções novas
-- contra as garantias de hoje — não ressuscite estas.
--
-- O corpo original está no histórico: `supabase/schema/public_baseline.sql`
-- antes do commit deste drop, e em `security-audit/god-mode-eyes-REPORT-2026-08-14.md`.

SELECT 'rollback intencionalmente vazio — ver comentário acima' AS nota;
