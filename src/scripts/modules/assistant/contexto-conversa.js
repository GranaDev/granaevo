/**
 * C-1 — o que uma frase deixa para a próxima.
 *
 * Estava espalhado em três lugares do engine: o objeto montado depois de um
 * lançamento, o objeto montado pela continuação ("e mais 30") e o "de novo".
 * Três cópias da mesma regra, e o crédito tinha caído fora das três — quem
 * comprava no cartão e dizia "e mais 300" não era entendido.
 *
 * A regra mora aqui, em função pura, para o teste EXECUTAR ela em vez de
 * procurar o texto dela no fonte.
 */

/**
 * Categorias que o `applyLancamento` NÃO aplica: elas têm fluxo próprio
 * (o crédito precisa saber o cartão). Ele devolve `reason: 'handoff'` para
 * essas — quem chama tem de desviar, não tratar como erro.
 */
export const CATS_HANDOFF = ['saida_credito'];

export function ehHandoff(categoria) {
    return CATS_HANDOFF.includes(categoria);
}

/** Quanto tempo uma frase continua sendo "a frase anterior". */
export const JANELA_CONTEXTO_MS = 10 * 60 * 1000;

/**
 * O retrato que um lançamento concluído deixa para trás.
 * `agora` é injetável só para o teste; em produção é sempre Date.now().
 */
export function guardarContexto(cmd, agora = Date.now()) {
    if (!cmd || !cmd.categoria) return null;
    return {
        intent: 'lancar',
        categoria: cmd.categoria,
        tipo: cmd.tipo ?? null,
        descricao: cmd.descricao ?? null,
        valor: cmd.valor ?? null,
        metaHint: cmd.metaHint ?? null,
        _em: agora,
    };
}

/**
 * O contexto ainda vale?
 *
 * `!(dt < janela)` e não `dt >= janela` de propósito: sem `_em` (contexto de
 * uma versão antiga ainda em memória num aparelho que não recarregou) a conta
 * dá NaN, e NaN precisa REPROVAR.
 */
export function contextoValido(ctx, agora = Date.now()) {
    if (!ctx || !ctx.categoria) return null;
    if (!(agora - ctx._em < JANELA_CONTEXTO_MS)) return null;
    return ctx;
}

/**
 * O que a continuação herda — e, mais importante, o que ela NÃO herda.
 *
 * NÃO herda `descricao`: "e mais 30" depois de "50 de pão" é outro item, não
 * mais pão.
 *
 * NÃO herda `parcelas`: "comprei 900 parcelado em 3x" → "e mais 300" viraria
 * 3× de 100 que o usuário nunca pediu. Parcelamento é termo daquela compra,
 * igual à descrição.
 *
 * NÃO herda o cartão: o picker abre com o valor já preenchido e o usuário
 * confirma de onde sai o dinheiro. Um toque a mais é barato; debitar o cartão
 * errado calado, não.
 *
 * Devolve em snake_case porque é assim que o `toCommand` lê (`meta_hint`).
 * Escrever `metaHint:` aqui compila, não quebra teste nenhum e é
 * silenciosamente ignorado — a continuação de reserva perderia a meta.
 */
export function heranca(ctx) {
    if (!ctx) return null;
    return { categoria: ctx.categoria, tipo: ctx.tipo ?? null, meta_hint: ctx.metaHint ?? null };
}
