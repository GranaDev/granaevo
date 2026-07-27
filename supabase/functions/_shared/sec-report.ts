// sec-report.ts — reporta evento de segurança da Edge para o alerta (B-4)
// ---------------------------------------------------------------------------
// POR QUE ISTO EXISTE
//   `api/_alert.js` — thresholds, e-mail via Resend, bloqueio de IP — roda na
//   Vercel. As Edge Functions rodam em Deno e não têm como importá-lo. Sem esta
//   ponte, os eventos `webhook_tamper` e `proxy_bypass` tinham threshold
//   definido e ZERO emissores: o alerta existia no papel e nunca dispararia.
//
// A INVERSÃO QUE TORNA ISSO POSSÍVEL
//   Reportar `proxy_bypass` significa que alguém chamou a edge com o secret
//   ERRADO. A edge conhece o CERTO — então é ela quem consegue se autenticar no
//   caminho de volta. Quem está atacando, não.
//
// REGRAS
//   • Fire-and-forget SEMPRE. Nenhum caminho de segurança pode ficar mais lento
//     ou falhar porque o monitoramento está fora do ar.
//   • Nunca aguarde o retorno. Nunca deixe uma exceção daqui escapar.
// ---------------------------------------------------------------------------

const ALVO = 'https://www.granaevo.com/api/user-data?sec=1'

type Evento = 'webhook_tamper' | 'proxy_bypass' | 'jwt_forgery'

/**
 * Dispara um evento de segurança. Não retorna nada e não lança — de propósito.
 *
 * @param evento  precisa estar na allow-list do lado da Vercel
 * @param origem  qual edge reportou (aparece no e-mail)
 * @param req     usado só para extrair o IP do atacante
 * @param detalhe texto curto de contexto; é truncado do outro lado
 */
export function reportarEventoSeguranca(
  evento: Evento,
  origem: string,
  req: Request,
  detalhe?: string,
): void {
  const secret = Deno.env.get('PROXY_SECRET')
  if (!secret) return

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
         ?? req.headers.get('cf-connecting-ip')
         ?? 'unknown'

  // Sem await: a resposta ao cliente não espera o monitoramento.
  fetch(ALVO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-secret': secret },
    body: JSON.stringify({ eventType: evento, origem, ip, ...(detalhe ? { detalhe } : {}) }),
    signal: AbortSignal.timeout(4_000),
  }).catch(() => { /* monitoramento nunca quebra o fluxo principal */ })
}
