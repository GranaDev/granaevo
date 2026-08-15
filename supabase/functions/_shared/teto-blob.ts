// teto-blob.ts — o tamanho que o blob de uma conta pode alcançar
// ---------------------------------------------------------------------------
// Achado de 2026-08-14: o banco tinha três tetos de save (5 MB por blob, 200
// perfis, 120 escritas/h) morando em RPCs que ninguém chamava — a prova era
// `rate_limit_writes` com zero linhas desde sempre. `save-user-data` gravava
// direto, por fora de todos, e `user_data.data_json` não tem CHECK.
//
// POR QUE ESTA REGRA VIVE NUM ARQUIVO SÓ DELA: ela é pequena e sutil ao mesmo
// tempo. A parte sutil é a VÁLVULA — e uma regra que só existe dentro de um
// `Deno.serve` não pode ser testada por comportamento, só por leitura de
// string. Aqui ela é uma função pura: o teste exercita os três desfechos em vez
// de procurar palavras no fonte.
// ---------------------------------------------------------------------------

// 5 MB. Mesmo número do corpo aceito pelo proxy (MAX_BODY_BYTES em
// api/user-data.js) e 52× o maior blob real em produção (95 kB, medido em
// 2026-08-15). Nenhum usuário legítimo chega perto.
// MANTER EM SINCRONIA com MAX_BODY_BYTES em api/user-data.js.
export const MAX_BLOB_BYTES = 5_242_880

export type DesfechoTeto = 'ok' | 'encolhendo' | 'bloqueado'

/**
 * Decide se um blob pode ser gravado.
 *
 * `'encolhendo'` é o desfecho que impede o teto de virar armadilha: um blob que
 * já passou do limite — por um abuso, por um bug, por um import — tem de poder
 * DIMINUIR. Sem isso, a única saída do usuário (apagar coisas até caber)
 * chegaria ao servidor como mais um save acima do teto e seria recusada junto
 * com o abuso. O usuário ficaria trancado do lado de fora dos próprios dados,
 * sem nenhuma ação capaz de resolver.
 *
 * `tamanhoAnterior === null` significa "não deu para saber" (blob que não
 * decifrou, formato inesperado, registro novo). Aí não há como distinguir
 * encolhimento de crescimento, e a resposta conservadora é bloquear: deixar
 * passar o que não se consegue medir seria o mesmo buraco de antes.
 *
 * @param tamanhoNovo     bytes do JSON que vai para o disco (o RESULTADO, já
 *                        mesclado — nunca o payload de entrada, que não vê o
 *                        caminho por operações)
 * @param tamanhoAnterior bytes do plaintext já gravado, ou null se ilegível
 */
export function decidirTeto(
  tamanhoNovo: number,
  tamanhoAnterior: number | null,
  limite: number = MAX_BLOB_BYTES,
): DesfechoTeto {
  if (tamanhoNovo <= limite) return 'ok'
  if (tamanhoAnterior !== null && tamanhoNovo < tamanhoAnterior) return 'encolhendo'
  return 'bloqueado'
}
