// supabase/functions/link-user-subscription/index.ts
/**
 * GranaEvo — link-user-subscription  [DESATIVADA POR SEGURANÇA — 2026-07-16]
 *
 * Responde 410 a tudo. A implementação antiga está no git (commit anterior a
 * este); não vale mantê-la comentada aqui. NÃO REATIVAR sem ler o motivo abaixo.
 *
 * O QUE ELA FAZIA: vinculava ao usuário autenticado uma `stripe_subscriptions`
 * órfã (`user_id IS NULL`) que tivesse o MESMO E-MAIL do JWT. Parecia correta —
 * o e-mail vinha de `auth.getUser(token)`, não do body — mas o problema nunca
 * foi o JWT: era tratar o e-mail como PROVA DE POSSE quando o cadastro não prova
 * posse nenhuma. `/api/create-account` chama
 * `admin.createUser({ email, password, email_confirm: true })`: a conta nasce
 * confirmada, sem link de verificação e sem checagem de pagamento. Ou seja,
 * qualquer pessoa cria conta com o e-mail da vítima e reclama a assinatura dela
 * — e a vítima real fica impedida de se cadastrar (409 email_exists).
 *
 * Pior: ela ainda force-confirmava o e-mail do chamador
 * (`admin.updateUserById(..., { email_confirm: true })`), apagando o único sinal
 * que poderia separar dono de impostor.
 *
 * ⚖️ SEVERIDADE REAL (registrar sem exagerar): esta função exigia
 * `x-proxy-secret` com comparação timing-safe e falha fechada, então NUNCA foi
 * chamável de fora — e nenhuma rota /api/* a invocava. Era código morto atrás de
 * um muro. O vetor explorável de verdade era o MESMO bloco, duplicado inline em
 * `check-user-access` (alcançável via /api/check-user-access, que auth-guard.js
 * chama em todo login), removido no mesmo commit. Esta cai junto por higiene:
 * código morto que faz a coisa errada é uma armadilha esperando alguém religá-la.
 *
 * Vinculação de assinatura órfã (só o legado Cakto precisa — hoje 1 pessoa)
 * passou a ser MANUAL, com o titular identificado fora do app. Se um dia existir
 * compra anônima de verdade, a reclamação tem que exigir PROVA DE POSSE do
 * e-mail (link/código assinado enviado a ele), nunca casar string.
 *
 * Ver: migration 20260716200000 — remove o caminho 'active_email' de
 * get_user_access_data e derruba a policy `stripe_sub_select_by_email`, cuja
 * guarda `email_confirmed_at IS NOT NULL` era inútil enquanto o cadastro força
 * a confirmação.
 */

const CORS = {
  'Access-Control-Allow-Origin':  'https://granaevo.com',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-proxy-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
  'X-Content-Type-Options':       'nosniff',
  'Cache-Control':                'no-store',
  'Vary':                         'Origin',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  console.warn('[link-user-subscription] Endpoint desativado por segurança — 410.');

  return new Response(
    JSON.stringify({
      success: false,
      error:   'endpoint_desativado',
      message: 'Vinculação de assinatura por e-mail foi desativada por segurança.',
    }),
    { status: 410, headers: CORS },
  );
});
