// =============================================================================
// GranaEvo — Versão corrente dos Termos de Uso / LGPD
//
// COMO FAZER UM BUMP DE VERSÃO:
//   1. Altere CURRENT_TERMS_VERSION abaixo (ex: '1.0' → '2.0')
//   2. Faça deploy de todas as Edge Functions que importam este arquivo:
//      - check-user-access
//      - accept-terms
//      - verify-guest-invite
//
// O frontend (auth-guard.js) NÃO conhece a versão — ele apenas armazena uma
// flag binária na sessionStorage quando o servidor confirma que os termos
// estão aceitos. Na próxima sessão (ou após logout), a API é consultada novamente.
// O servidor (check-user-access) é sempre a autoridade sobre qual versão vale.
// =============================================================================

export const CURRENT_TERMS_VERSION = '1.0'
