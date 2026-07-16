// ----------------------------------------------------------------------------
// sugestao-corte.js — "onde cortar dói menos" (item 17)
//
// Não é um juiz de moral financeira. A pergunta que ele responde é estreita e
// honesta: entre o que você gasta, **onde um corte pequeno rende mais sem mudar
// sua vida**? A resposta quase nunca é "o gasto maior" — é o gasto REPETIDO e
// pequeno, que passa despercebido justamente por ser pequeno. R$32 de delivery
// 18 vezes no mês são R$576 que ninguém sente saindo, e cortar 1 em cada 3 nem
// dói. É o oposto de cortar uma compra grande, que é uma decisão consciente e
// única — e que este módulo deliberadamente NÃO sugere.
//
// ── TRÊS TRAVAS CONTRA CONSELHO BURRO ───────────────────────────────────────
//  1. ESSENCIAL NUNCA ENTRA. Mercado, Farmácia, Saúde, Transporte, Educação,
//     Pet, Conta fixa e Academia jamais são sugeridos. "Economize no remédio"
//     ou "corte a academia" é conselho que destrói valor — e a economia de curto
//     prazo cobra caro depois. Fora do escopo, por decisão de produto.
//  2. EVIDÊNCIA MÍNIMA (3 ocorrências). Com 1 ou 2 compras não existe hábito,
//     existe evento. Sugerir "corte 30% da sua Viagem" a partir de uma passagem
//     comprada é ruído. Mesma régua que recorrencias.js adotou depois do falso
//     positivo do pedágio em produção.
//  3. PISO DE RELEVÂNCIA. Abaixo de ~R$30/mês a "economia" é estatisticamente
//     ruído e cobrar isso do usuário é implicância, não ajuda.
//
// LIMITE DECLARADO: o app vê rótulo, valor e data — não vê contexto. Não sabe
// que aquele "Presente" era o aniversário do filho. Por isso a saída é uma
// SUGESTÃO com número explícito, para o usuário julgar; nunca uma ordem, nunca
// uma acusação, e nunca "você gastou demais".
//
// O motor (`sugerirCortes`) é puro: sem DOM, sem rede, `hoje` injetável. O
// `renderCortesEm` no fim do arquivo é a única parte que toca o DOM — mesma
// divisão de previsao-mes.js, e mesma casa: o popup "Onde foi meu dinheiro?".
// Não vira card no dashboard de propósito (a home já tem 4 e o usuário reclamou
// de poluição em 2026-07-14).
// ----------------------------------------------------------------------------

// Nunca sugeridos para corte. Inclui Academia (saúde) e Conta fixa/Cartão, que
// não são "escolha do mês": conta fixa é compromisso e 'Cartão' é transferência
// para a fatura, não uma categoria de consumo.
export const TIPOS_PROTEGIDOS = new Set([
    'Mercado', 'Farmácia', 'Saúde', 'Transporte', 'Educação', 'Pet',
    'Conta fixa', 'Conta Fixa', 'Cartão', 'Pagamento Cartão', 'Academia',
]);

// Consumo discricionário: dá para aparar sem perder o essencial. 'Outros' fica
// de fora de propósito — é o balde do desconhecido, e não se aconselha sobre o
// que não se sabe o que é.
export const TIPOS_APARAVEIS = new Set([
    'Lazer', 'Ifood', 'Roupas', 'Beleza', 'Presente', 'Eletrônico',
    'Shopee', 'Mercado Livre', 'Amazon', 'Assinaturas', 'Viagem',
]);

// "DD/MM/YYYY" ou "YYYY-MM-DD" → Date (ou null). Mesmo parser dos módulos irmãos.
function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (/^\d{4}-\d{2}-\d{2}/.test(data)) {
        [y, m, d] = data.slice(0, 10).split('-').map(Number);
    } else if (/^\d{2}\/\d{2}\/\d{4}/.test(data)) {
        [d, m, y] = data.slice(0, 10).split('/').map(Number);
    } else {
        return null;
    }
    const dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Fração do gasto que dá para aparar sem doer, pela FREQUÊNCIA do hábito.
 *
 * Quanto mais repetido o gasto, mais ele é piloto automático — e mais fácil é
 * tirar uma fatia sem sentir. Gasto raro é decisão consciente: aparar "20% de
 * uma compra" não significa nada no mundo real (não se compra 4/5 de um tênis).
 *
 * @param {number} porMes ocorrências por mês
 * @returns {number} fração de 0 a 1 (0 = não sugerir)
 */
export function fracaoCorte(porMes) {
    if (porMes >= 8) return 1 / 3;   // hábito diário/quase — 1 em cada 3
    if (porMes >= 4) return 1 / 4;   // semanal — 1 em cada 4
    if (porMes >= 2) return 1 / 5;   // quinzenal — 1 em cada 5
    return 0;                        // esporádico: não há hábito para aparar
}

/**
 * Onde o usuário pode cortar com menos dor, do maior retorno para o menor.
 *
 * @param {Array}  transacoes
 * @param {Date}   hoje
 * @param {Object} opts { janelaMeses=3, minOcorrencias=3, minMensal=30, limite=5 }
 * @returns {Array<{tipo,gastoMensal,ocorrencias,porMes,ticketMedio,fracao,
 *                  cortesPorMes,economiaMensal,economiaAnual}>}
 */
export function sugerirCortes(transacoes, hoje = new Date(), opts = {}) {
    const janelaMeses    = opts.janelaMeses    ?? 3;
    const minOcorrencias = opts.minOcorrencias ?? 3;
    const minMensal      = opts.minMensal      ?? 30;
    const limite         = opts.limite         ?? 5;

    if (!Array.isArray(transacoes)) return [];

    const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - (janelaMeses - 1), 1);
    const grupos = new Map();   // tipo → { total, n, primeira }

    for (const t of transacoes) {
        // Gasto de verdade: 'saida' e 'saida_credito' — mesma soma que o relatório
        // "Onde foi meu dinheiro" usa, para os dois números nunca se contradizerem.
        if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') continue;

        // Lançamentos GERADOS pelo app (conta fixa, fatura, parcela) não são
        // escolha do mês — são replay de uma decisão antiga. Exclusão por
        // MARCADOR DE ORIGEM, nunca pelo rótulo `tipo`: comparar rótulo já foi
        // causa-raiz de bug aqui (previsao-mes e recorrencias, ambos em prod).
        if (t.contaFixaId != null || t.faturaId != null || t.compraId != null) continue;

        const tipo = typeof t.tipo === 'string' ? t.tipo.trim() : '';
        if (!tipo || TIPOS_PROTEGIDOS.has(tipo)) continue;
        if (!TIPOS_APARAVEIS.has(tipo)) continue;

        const dt = _txDate(t.data);
        if (!dt || dt < inicio || dt > hoje) continue;

        const v = parseFloat(t.valor);
        if (!isFinite(v) || v <= 0) continue;

        let g = grupos.get(tipo);
        if (!g) { g = { total: 0, n: 0, primeira: dt }; grupos.set(tipo, g); }
        g.total += v;
        g.n     += 1;
        if (dt < g.primeira) g.primeira = dt;
    }

    const out = [];
    for (const [tipo, g] of grupos) {
        if (g.n < minOcorrencias) continue;

        // Denominador adaptativo: quem começou a usar o app há 40 dias não tem 3
        // meses de histórico, e dividir por 3 diluiria o gasto até sumir. Mesma
        // correção que a previsão de fim de mês precisou levar.
        //
        // Conta em meses de CALENDÁRIO (do 1º gasto até hoje, inclusive), não em
        // dias/30,44: quem gastou R$576 em julho gastou R$576 no mês, e não
        // R$566 porque julho tem 31 dias — diluir pelo tamanho do mês é
        // arbitrário e faz o número contradizer o extrato que o usuário vê.
        // Mês sem gasto no meio conta como mês (foi zero mesmo), o que mantém a
        // média fiel à janela. Mesma fórmula de ritmo-metas.js.
        const mesesAtivos = Math.min(
            janelaMeses,
            Math.max(1, (hoje.getFullYear() - g.primeira.getFullYear()) * 12
                      + (hoje.getMonth() - g.primeira.getMonth()) + 1),
        );

        const gastoMensal = g.total / mesesAtivos;
        if (gastoMensal < minMensal) continue;

        const porMes = g.n / mesesAtivos;
        const fracao = fracaoCorte(porMes);
        if (fracao === 0) continue;

        const economiaMensal = gastoMensal * fracao;
        out.push({
            tipo,
            gastoMensal,
            ocorrencias:  g.n,
            porMes,
            ticketMedio:  g.total / g.n,
            fracao,
            cortesPorMes: Math.max(1, Math.round(porMes * fracao)),
            economiaMensal,
            economiaAnual: economiaMensal * 12,
        });
    }

    out.sort((a, b) => b.economiaMensal - a.economiaMensal);
    return out.slice(0, limite);
}

/** Soma da economia anual de todas as sugestões — o número que convence. */
export function economiaTotalAnual(sugestoes) {
    if (!Array.isArray(sugestoes)) return 0;
    return sugestoes.reduce((s, x) => s + (x.economiaAnual || 0), 0);
}

// Rótulo do que se deixa de fazer. Genérico ("compras") quando o tipo não tem
// unidade natural — melhor do que forçar "1 em cada 3 Beleza".
const _UNIDADE = {
    Ifood:  ['pedido', 'pedidos'],
    Lazer:  ['saída', 'saídas'],
    Roupas: ['peça', 'peças'],
    Viagem: ['viagem', 'viagens'],
};
const _unidade = (tipo, n) => (_UNIDADE[tipo] || ['compra', 'compras'])[n === 1 ? 0 : 1];

/**
 * Renderiza o bloco de cortes dentro de `container` (popup "Onde foi meu
 * dinheiro?"). Silencioso quando não há sugestão: sem dado, melhor não falar.
 */
export function renderCortesEm(container, ctx) {
    if (!container || !ctx) return;
    container.textContent = '';

    const sugestoes = sugerirCortes(ctx.transacoes || [], new Date(), { limite: 3 });
    if (sugestoes.length === 0) return;

    const card = document.createElement('div');
    card.className = 'corte-card';

    // ── Cabeçalho: a promessa em um número
    const head = document.createElement('div');
    head.className = 'corte-head';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'corte-icon';
    const ic = document.createElement('i');
    ic.className = 'fas fa-scissors';
    ic.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(ic);

    const headTxt = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'corte-label';
    label.textContent = 'Onde dá para cortar sem doer';
    const valor = document.createElement('div');
    valor.className = 'corte-valor';
    valor.textContent = `até ${ctx.formatBRL(economiaTotalAnual(sugestoes))}/ano`;
    headTxt.appendChild(label);
    headTxt.appendChild(valor);

    head.appendChild(iconWrap);
    head.appendChild(headTxt);
    card.appendChild(head);

    // ── Uma linha por sugestão
    const lista = document.createElement('div');
    lista.className = 'corte-lista';

    for (const s of sugestoes) {
        const row = document.createElement('div');
        row.className = 'corte-row';

        const topo = document.createElement('div');
        topo.className = 'corte-row-topo';
        const nome = document.createElement('span');
        nome.className = 'corte-row-tipo';
        nome.textContent = s.tipo;                    // textContent — nunca innerHTML
        const gasto = document.createElement('span');
        gasto.className = 'corte-row-gasto';
        gasto.textContent = `${ctx.formatBRL(s.gastoMensal)}/mês · ${s.ocorrencias} ${_unidade(s.tipo, s.ocorrencias)}`;
        topo.appendChild(nome);
        topo.appendChild(gasto);

        const baixo = document.createElement('div');
        baixo.className = 'corte-row-baixo';
        const acao = document.createElement('span');
        acao.className = 'corte-row-acao';
        const aCada = Math.round(1 / s.fracao);
        acao.textContent = `deixe de fazer ${s.cortesPorMes} por mês (1 a cada ${aCada})`;
        const eco = document.createElement('span');
        eco.className = 'corte-row-eco';
        eco.textContent = `+${ctx.formatBRL(s.economiaMensal)}/mês`;
        baixo.appendChild(acao);
        baixo.appendChild(eco);

        row.appendChild(topo);
        row.appendChild(baixo);
        lista.appendChild(row);
    }
    card.appendChild(lista);

    // ── Rodapé: o app não conhece o contexto de cada compra. Dizer isso é o que
    //    separa uma sugestão honesta de um app que se acha dono da sua vida.
    const nota = document.createElement('div');
    nota.className = 'corte-nota';
    nota.textContent = 'Sugestões pelo seu próprio padrão — só você sabe o que valeu a pena.';
    card.appendChild(nota);

    container.appendChild(card);
}
