// mfa-gate.ts — exige sessão elevada (aal2) de quem ativou o 2FA (Passo 31 · B-1c)
// ---------------------------------------------------------------------------
// POR QUE ISTO EXISTE
//   As policies RLS de `20260727020000` cobrem tudo que o cliente alcança por
//   PostgREST. Mas `get-user-data` e `save-user-data` falam com o banco usando
//   service_role, que **bypassa RLS** — e é por ali que passa o blob financeiro
//   inteiro. Sem este gate, uma sessão aal1 de quem ativou o 2FA continuaria
//   lendo e gravando: o 2º fator trancaria a porta da frente e deixaria a dos
//   fundos aberta.
//
// MORA EM _shared PORQUE SÃO DUAS EDGES
//   Duas cópias da mesma regra de segurança divergem — é questão de tempo até
//   alguém corrigir uma e esquecer a outra. Aqui a regra é uma só.
// ---------------------------------------------------------------------------

/**
 * Lê o claim `aal` do payload do JWT.
 *
 * Não verifica assinatura de propósito: quem chama SÓ deve usar esta função
 * depois de `auth.getUser(token)` ter validado o ES256 contra o JWKS. O payload
 * faz parte do conteúdo assinado, então ler dali um token já verificado é
 * legítimo — e evita uma segunda ida à rede só para reler o que já temos.
 *
 * Qualquer problema devolve 'aal1', que é o lado seguro: força a checagem.
 */
export function aalDoToken(token: string): string {
  try {
    const parte = token.split('.')[1]
    if (!parte) return 'aal1'
    const b64 = parte.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))
    // TextDecoder e não atob direto: o payload pode ter caracteres não-ASCII
    // (nome/e-mail acentuado) e atob sozinho os corromperia.
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    return typeof claims?.aal === 'string' ? claims.aal : 'aal1'
  } catch {
    return 'aal1'
  }
}

/**
 * `true` quando a requisição deve ser recusada por falta do 2º fator.
 *
 * @param admin  cliente com service_role (é ele quem pode chamar a RPC)
 * @param token  JWT JÁ VALIDADO por auth.getUser()
 * @param userId id devolvido por auth.getUser() — nunca vindo do corpo da requisição
 *
 * FALHA FECHADO por decisão: se a RPC não responder, recusamos. Não é uma perda
 * de disponibilidade real — a RPC e a consulta de dados vão ao MESMO Postgres, e
 * se ele está fora a requisição falharia de qualquer jeito. Já falhar ABERTO
 * daria a um atacante com a senha um jeito de contornar o 2º fator só derrubando
 * uma chamada.
 */
export async function mfaBloqueia(
  // deno-lint-ignore no-explicit-any
  admin: any,
  token: string,
  userId: string,
  origem: string,
): Promise<boolean> {
  // Sessão já elevada: nada a perguntar ao banco. Este atalho existe para que o
  // custo do gate caia justamente sobre quem usa 2FA, e não sobre todo mundo.
  const aal = aalDoToken(token)
  if (aal === 'aal2') return false

  try {
    const { data, error } = await admin.rpc('mfa_bloqueia', { p_user_id: userId, p_aal: aal })
    if (error) {
      console.error(`[${origem}] gate de 2FA indisponível — recusando:`, error.message)
      return true
    }
    return data === true
  } catch (e) {
    console.error(`[${origem}] gate de 2FA falhou — recusando:`, String(e))
    return true
  }
}
