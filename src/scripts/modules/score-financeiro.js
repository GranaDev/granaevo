// score-financeiro.js — Motor do score de saúde financeira (puro) + semáforo no dashboard
// ----------------------------------------------------------------------------
// EXTRAÍDO de db-relatorios.js (_calcScore) em 2026-07-14. Três motivos:
//   1. db-relatorios.js é um chunk lazy de ~32 KB gzip — o dashboard não pode
//      carregá-lo só para mostrar o score.
//   2. Aqui o motor é PURO e testável (o de lá não era alcançável por teste).
//   3. `hoje` virou injetável — o que CONSERTA o histórico de 6 meses do relatório
//      (antes ele passava transações de um mês passado, mas a função filtrava pelo
//      mês ATUAL internamente → todo mês antigo zerava e o gráfico era constante).
//
// Modelo (0–1000), inalterado na extração:
//   C1 Taxa de poupança 200 · C2 Orçamentos 200 · C3 Cartões 150
//   C4 Consistência de reservas 200 · C5 Equilíbrio despesas/renda 250
// ----------------------------------------------------------------------------

/** Nível/letra/cor a partir do score 0–1000. */
export function nivelDe(score) {
    return score >= 850 ? { letra: 'A', nome: 'Excelente', cor: '#4ecdc4' }
         : score >= 700 ? { letra: 'B', nome: 'Muito Bom', cor: '#4ca6ff' }
         : score >= 550 ? { letra: 'C', nome: 'Bom',       cor: '#ffd166' }
         : score >= 400 ? { letra: 'D', nome: 'Regular',   cor: '#ff9f43' }
         :                { letra: 'E', nome: 'Atenção',   cor: '#ff4b4b' };
}

/**
 * Score de saúde financeira do mês de `hoje`.
 * @param {Array}  tx         transações
 * @param {Array}  metas
 * @param {Array}  cartoes
 * @param {Object} orcamentos
 * @param {Date}   hoje       injetável (testes + histórico por mês)
 */
export function calcScore(tx, metas, cartoes, orcamentos, hoje = new Date()) {
    const mesAtual = hoje.getMonth() + 1;
    const anoAtual = hoje.getFullYear();
    const sufixo   = `/${String(mesAtual).padStart(2, '0')}/${anoAtual}`;

    const txMes    = (tx || []).filter(t => typeof t.data === 'string' && t.data.endsWith(sufixo));
    const entradas = txMes.filter(t => t.categoria === 'entrada').reduce((s, t) => s + (parseFloat(t.valor) || 0), 0);
    const saidas   = txMes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((s, t) => s + (parseFloat(t.valor) || 0), 0);
    const reservas = txMes.filter(t => t.categoria === 'reserva').reduce((s, t) => s + (parseFloat(t.valor) || 0), 0);

    // C1: Taxa de poupança (0-200) — 30% de poupança = nota cheia.
    const taxaPoup = entradas > 0 ? ((entradas - saidas) / entradas) * 100 : 0;
    const c1 = Math.round(Math.max(0, Math.min(200, (taxaPoup / 30) * 200)));

    // C2: Orçamentos cumpridos (0-200) — sem orçamento definido, fica no meio (100).
    const orcEntries = Object.entries(orcamentos || {});
    let c2 = 100;
    if (orcEntries.length > 0) {
        let dentro = 0;
        orcEntries.forEach(([tipo, cfg]) => {
            const gasto = txMes
                .filter(t => t.tipo === tipo && (t.categoria === 'saida' || t.categoria === 'saida_credito'))
                .reduce((s, t) => s + (parseFloat(t.valor) || 0), 0);
            if (gasto <= (parseFloat(cfg.limite) || 0)) dentro++;
        });
        c2 = Math.round((dentro / orcEntries.length) * 200);
    }

    // C3: Utilização do cartão (0-150) — acima de ~67% do limite zera.
    let c3 = 150;
    if (cartoes && cartoes.length > 0) {
        const totalLim   = cartoes.reduce((s, c) => s + (parseFloat(c.limite) || 0), 0);
        const totalUsado = cartoes.reduce((s, c) => s + (parseFloat(c.usado) || 0), 0);
        const util = totalLim > 0 ? totalUsado / totalLim : 0;
        c3 = Math.round(Math.max(0, (1 - util * 1.5) * 150));
    }

    // C4: Consistência de reservas — meses consecutivos com aporte (0-200), 40/mês.
    let c4 = 0;
    if (metas && metas.length > 0) {
        const todosMs = new Set();
        metas.forEach(m => {
            if (m.monthly) Object.keys(m.monthly).forEach(k => {
                if (/^\d{4}-\d{2}$/.test(k) && parseFloat(m.monthly[k]) > 0) todosMs.add(k);
            });
        });
        const msOrds = Array.from(todosMs).sort().reverse();
        let streak = 0;
        const refMs = `${anoAtual}-${String(mesAtual).padStart(2, '0')}`;
        for (let i = 0; i < msOrds.length; i++) {
            const m = parseInt(msOrds[i].split('-')[1], 10), a = parseInt(msOrds[i].split('-')[0], 10);
            const refM = parseInt(refMs.split('-')[1], 10), refA = parseInt(refMs.split('-')[0], 10);
            const diffMs = (refA - a) * 12 + (refM - m);
            if (diffMs === streak) streak++; else break;
        }
        c4 = Math.min(200, streak * 40);
    }

    // C5: Equilíbrio despesas/renda (0-250).
    const ratio = entradas > 0 ? saidas / entradas : 1;
    const c5 = Math.round(Math.max(0, Math.min(250, (1 - ratio) * 250)));

    const score = Math.min(1000, c1 + c2 + c3 + c4 + c5);

    return {
        score,
        nivel: nivelDe(score),
        componentes: [
            { nome: 'Taxa de Poupança', pts: c1, max: 200, dica: taxaPoup >= 20 ? 'Parabéns! Acima de 20%.' : `Você poupou ${taxaPoup.toFixed(1)}%. Meta: 20%.` },
            { nome: 'Orçamentos',       pts: c2, max: 200, dica: orcEntries.length === 0 ? 'Defina orçamentos para pontuar aqui.' : `${orcEntries.length} categoria${orcEntries.length > 1 ? 's' : ''} monitorada${orcEntries.length > 1 ? 's' : ''}.` },
            { nome: 'Cartões',          pts: c3, max: 150, dica: cartoes?.length === 0 ? 'Sem cartões cadastrados.' : 'Mantenha utilização abaixo de 50%.' },
            { nome: 'Reservas',         pts: c4, max: 200, dica: c4 >= 200 ? 'Consistência máxima!' : 'Aporte em metas todo mês para aumentar.' },
            { nome: 'Equilíbrio',       pts: c5, max: 250, dica: ratio < 0.7 ? 'Ótimo equilíbrio!' : `${(ratio * 100).toFixed(0)}% da renda vai para despesas.` },
        ],
        entradas, saidas, reservas, taxaPoup,
    };
}

// NOTA (2026-07-14): existiu aqui um card "semáforo 0–100" para o dashboard. Foi
// REMOVIDO a pedido — o score já vive na aba Relatórios (gauge + histórico) e o
// dashboard estava ficando poluído. O motor acima continua sendo o único lugar
// onde o score é calculado (db-relatorios.js o importa), e a extração seguiu
// valendo a pena: tornou o cálculo testável e consertou o histórico de 6 meses
// (o `hoje` injetável). Se um dia o semáforo voltar, o motor já está pronto.
