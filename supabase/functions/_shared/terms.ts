// =============================================================================
// GranaEvo — Versão corrente dos Termos de Uso / LGPD
//
// COMO FAZER UM BUMP DE VERSÃO:
//   0. ⚠️ PRÉ-REQUISITO (uma vez): garanta que a migration
//      20260714140000_fix_terms_acceptance_versioning.sql já foi aplicada. Ela remove
//      o unique redundante (user_id) que fazia o re-aceite de uma nova versão colidir
//      (23505) e ser engolido como idempotente — sem ela, o bump entra em LOOP de
//      re-aceite. A migration DEVE estar em produção ANTES do deploy das Edge Functions.
//   1. Altere CURRENT_TERMS_VERSION abaixo (ex: '1.1' → '1.2' / '2.0')
//   2. Faça deploy de todas as Edge Functions que importam este arquivo:
//      - check-user-access
//      - accept-terms
//      - verify-guest-invite
//
// O frontend (auth-guard.js) NÃO conhece a versão — ele apenas armazena uma
// flag binária na sessionStorage quando o servidor confirma que os termos
// estão aceitos. Na próxima sessão (ou após logout), a API é consultada novamente.
// O servidor (check-user-access) é sempre a autoridade sobre qual versão vale.
//
// HISTÓRICO:
//   1.0 — versão inicial (aceite dos Termos + Política de Privacidade).
//   1.1 — revisão de Julho/2026: inclusão do assistente de IA (Anthropic) e dos
//         suboperadores Sentry, Resend e Upstash na Política de Privacidade. Força
//         re-aceite de todos os usuários (gap LGPD M2 da auditoria 2026-07-14).
// =============================================================================

export const CURRENT_TERMS_VERSION = '1.1'
