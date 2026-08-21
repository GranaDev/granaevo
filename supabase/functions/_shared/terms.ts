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

// 1.2 (2026-07-31) — re-aceite disparado por TRÊS tratamentos que já
// aconteciam e não estavam declarados: aparelhos reconhecidos (`user_devices`,
// base do alerta de login novo), Cloudflare Turnstile (que substituiu o Google
// reCAPTCHA em 2026-07-27, e o Google seguia listado como operador) e ImprovMX
// (recebe os e-mails de @granaevo.com). Ver privacidade.html e
// docs/compliance/RoPA.md §7.

// 1.3 (2026-08-21) — auditoria LGPD do God Mode. Mesmo padrão do 1.2: tratamento
// que JÁ acontecia e não estava declarado no documento que o titular efetivamente
// aceita.
//   · `termos.html` §12 listava 4 operadores; a `privacidade.html` já listava 10.
//     Quem aceita os Termos via quatro nomes e concordava com dez (achado A-2).
//   · Os SERVIÇOS DE PUSH (Google/FCM, Mozilla, Apple, Microsoft) não estavam em
//     NENHUM dos dois documentos, nem na seção de transferência internacional —
//     e são acionados sempre que o usuário liga as notificações (achado A-3).
//   · A página passou a exibir a VERSÃO, não só o mês: é a versão que
//     `terms_acceptance.version` grava, e sem ela o titular não consegue amarrar o
//     que aceitou ao texto que leu (achado A-5).
//
// ⚠️ Subir esta constante FORÇA re-aceite de todos os usuários no próximo acesso.
// É o comportamento correto e o mesmo precedente do 1.2 — mas confirme que
// `aceitar-termos.html` está no ar antes de publicar, senão o app trava todo mundo
// numa tela que não existe.
export const CURRENT_TERMS_VERSION = '1.3'
