// categorias-edicao.js — a fronteira da reserva, na edição de transação
// ---------------------------------------------------------------------------
// Módulo próprio, e minúsculo, por um motivo: esta regra decide o destino de
// dinheiro, e precisa ser EXECUTADA por teste. Dentro de `db-transacoes.js` ela
// só poderia ser verificada por regex sobre o fonte — e regex sobre fonte já
// deixou passar mutação nesta sessão (o texto continua lá, o comportamento não).
//
// ── POR QUE A FRONTEIRA EXISTE ─────────────────────────────────────────────
// O formulário de edição oferecia as cinco categorias e trocava `t.categoria`
// SEM mexer no saldo da meta: o ajuste no salvar só roda `if (diff !== 0 &&
// t.metaId)`, e uma saída não tem `metaId`.
//
// Medido sobre a fórmula real do saldo (dashboard.js:3257-3260):
//
//   saída R$100  →  retirada de reserva
//     saldo: era −100, vira +100  →  oscila R$200
//     reserva: NÃO é debitada
//   ou seja: R$200 aparecem do nada, e a reserva "pagou" sem saber.
//
//   reserva R$100  →  saída
//     a meta continua com R$100 que ninguém mais lastreia.
//
// Estava em produção, ao alcance de qualquer usuário pelo botão de editar.
//
// Converter de verdade exigiria perguntar QUAL reserva e validar saldo — o fluxo
// do C-10, que nasce na CRIAÇÃO, não aqui. Valor, descrição e tipo continuam
// livres: travar o resto seria punir o usuário por um defeito nosso.
// ---------------------------------------------------------------------------

const ENVOLVE_RESERVA = ['reserva', 'retirada_reserva'];

const COMUNS = Object.freeze([
    { value: 'entrada',       label: 'Entrada' },
    { value: 'saida',         label: 'Saída' },
    { value: 'saida_credito', label: 'Saída no Crédito' },
]);

/**
 * Categorias que a edição pode oferecer, dado o que a transação é hoje.
 * Nunca atravessa a fronteira da reserva, nos dois sentidos.
 *
 * @param {string} categoriaAtual
 * @returns {Array<{value:string,label:string}>}
 */
export function categoriasEditaveis(categoriaAtual) {
    if (ENVOLVE_RESERVA.includes(categoriaAtual)) {
        return [{
            value: categoriaAtual,
            label: categoriaAtual === 'reserva' ? 'Reserva' : 'Retirada de Reserva',
        }];
    }
    return COMUNS.map((c) => ({ ...c }));
}
