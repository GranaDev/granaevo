// phrases.js — biblioteca de respostas do chatbot (a "voz" do Assistente)
// ---------------------------------------------------------------------------
// REGRA DE OURO: todo texto que o usuário lê sai daqui — nunca da IA.
// Ícones são tokens {{fa-nome}} renderizados como <i class="fas fa-nome"> pelo
// ui.js (createElement, whitelist) — sem emojis, sem innerHTML.
// ---------------------------------------------------------------------------

import { formatBRL } from './money.js';

export function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const CAT_ICONE = {
    entrada: '{{fa-money-bill-wave}}', saida: '{{fa-cart-shopping}}', reserva: '{{fa-piggy-bank}}',
    retirada_reserva: '{{fa-rotate-left}}', saida_credito: '{{fa-credit-card}}', assinatura: '{{fa-arrows-rotate}}',
};
const CAT_LABEL = {
    entrada: 'Entrada', saida: 'Saída', reserva: 'Reserva',
    retirada_reserva: 'Retirada', saida_credito: 'Crédito', assinatura: 'Assinatura',
};

const PERIODO_LABEL = {
    hoje: 'hoje', semana: 'nesta semana', mes: 'neste mês',
    mes_passado: 'no mês passado', ano: 'neste ano', tudo: 'no total',
};

// ── Saudações ────────────────────────────────────────────────────────────────
const SAUDACOES = [
    'Oi! Manda a movimentação que eu anoto. Ex: “gastei 80 no mercado”.',
    'E aí! Pode falar — “paguei 45 de uber”, “recebi 2000 de salário”, o que rolar.',
    'Opa! Bora organizar. Me diz um gasto, entrada ou reserva que eu registro.',
    'Fala! Digita naturalmente que eu entendo. Ex: “guardei 300 na reserva”.',
    'Prontinho pra anotar. Manda aí o que você gastou ou recebeu.',
];

const AJUDA = [
    'Eu sou seu assistente financeiro aqui do GranaEvo. Você pode:\n' +
    '• Lançar gastos: “gastei 120 no mercado”\n' +
    '• Registrar entradas: “recebi 2500 de salário”\n' +
    '• Guardar reserva: “guardei 200 pra viagem”\n' +
    '• Consultar: “quanto gastei com transporte esse mês?”\n' +
    '• Pedir relatório: “me dá um resumo do mês”\n\n' +
    '{{fa-lock}} Sempre que eu anotar algo, aparece um botão de *Desfazer* — teu histórico fica protegido.',
];

const NAO_ENTENDI = [
    'Não peguei o valor. Manda assim: “gastei 40 no mercado”.',
    'Hmm, não entendi direito. Tenta incluir o valor, tipo “paguei 30 de uber”.',
    'Quase! Me diz quanto foi — ex: “recebi 500 de freela”.',
    'Não consegui interpretar. Pode reescrever com o valor? Ex: “assinei Netflix 40”.',
];

const RATE = [
    'Muita coisa de uma vez! Aguarda uns segundos e manda de novo.',
    'Calma que eu anoto tudo — só espera um instantinho e reenvia.',
];

const RATE_DIA = [
    'Você usou bastante o assistente hoje! O limite diário foi atingido — volta amanhã que continuo te ajudando.',
];

// ── Confirmação de lançamento (com chip + Desfazer) ──────────────────────────
export function confirmacaoLancamento({ transaction, meta }) {
    const t = transaction;
    const ic = CAT_ICONE[t.categoria] || '{{fa-check}}';
    const extra = t.categoria === 'reserva' && meta ? ` → ${meta}` : '';
    const aberturas = ['Anotei', 'Registrado', 'Feito', 'Lançado'];
    return {
        text: `{{fa-check}} ${pick(aberturas)} · ${formatBRL(t.valor)} · ${ic} ${t.descricao || t.tipo}${extra}`,
        chip: {
            categoria: t.categoria,
            label: `${CAT_LABEL[t.categoria]} · ${formatBRL(t.valor)} · ${t.descricao || t.tipo}`,
            undoLabel: 'Desfazer',
        },
    };
}

export function desfeito() {
    return pick(['Prontinho, desfiz.', 'Removido — como se nada tivesse acontecido.', 'Desfeito! Teu histórico voltou ao normal.']);
}

// ── Crédito (compra parcelada com picker de cartão + parcelas) ────────────────
export function confirmacaoCredito(res) {
    const parc = res.parcelas > 1
        ? `${res.parcelas}x de ${formatBRL(res.valorParcela)}`
        : 'à vista';
    return {
        text: `{{fa-check}} ${pick(['Anotei', 'Registrado', 'Lançado'])} · ${formatBRL(res.compra.valorTotal)} · {{fa-credit-card}} ${res.cardNome} · ${parc}`,
        chip: { categoria: 'saida_credito', undoLabel: 'Desfazer' },
    };
}
export function creditoQuantoFoi() {
    return pick(['Beleza, compra no crédito! Quanto foi?', 'No crédito. Qual foi o valor da compra?']);
}
export function semCartao() {
    return '{{fa-credit-card}} Você ainda não tem um cartão cadastrado. Crie um no menu **Cartões** do GranaEvo que aí eu registro suas compras no crédito.';
}
export function todosCongelados() {
    return '{{fa-snowflake}} Todos os seus cartões estão congelados. Descongele um no menu **Cartões** pra usar.';
}
export function cartaoCongelado() {
    return '{{fa-snowflake}} Esse cartão está congelado. Descongele no menu **Cartões** pra usá-lo.';
}

// ── Retirada de reserva ────────────────────────────────────────────────────────
export function confirmacaoRetirada(res) {
    return {
        text: `{{fa-check}} ${pick(['Retirei', 'Feito', 'Prontinho'])} · ${formatBRL(res.transaction.valor)} · {{fa-piggy-bank}} de ${res.meta} — voltou pro seu saldo.`,
        chip: { categoria: 'retirada_reserva', undoLabel: 'Desfazer' },
    };
}
export function escolherReservaRetirada(opcoes = []) {
    if (!opcoes.length) return '{{fa-piggy-bank}} Você não tem reservas pra retirar. Crie uma no menu “Reservas”.';
    return `De qual reserva você quer tirar? ${opcoes.map((o) => `“${o}”`).join(', ')}. Me diz o nome.`;
}
export function reservaVazia(meta) {
    return `A reserva “${meta}” está zerada — não tem o que retirar.`;
}
export function retiradaExcede(meta, disponivel) {
    return `Você só tem ${formatBRL(disponivel)} guardado em “${meta}”. Quer tirar até esse valor?`;
}

// ── Escolha de meta (reserva ambígua) ────────────────────────────────────────
export function escolherMeta(opcoes = []) {
    if (!opcoes.length) {
        return '{{fa-piggy-bank}} Você ainda não tem uma reserva/meta criada. Crie uma no menu “Reservas” e depois é só falar comigo.';
    }
    return `Pra qual reserva? ${opcoes.map((o) => `“${o}”`).join(', ')}. Me diz o nome que eu guardo lá.`;
}

// ── Consulta de gastos ────────────────────────────────────────────────────────
export function renderConsulta(r) {
    const per = PERIODO_LABEL[r.periodo] || 'no período';
    if (r.count === 0) {
        const alvo = r.termos.length ? ` com ${r.termos.join(', ')}` : '';
        return `Não achei nenhum gasto${alvo} ${per}.`;
    }
    const alvo = r.termos.length ? ` com *${r.termos.join(', ')}*` : '';
    let msg = `Você gastou *${formatBRL(r.total)}*${alvo} ${per} (${r.count} lançamento${r.count > 1 ? 's' : ''}).`;
    const tipos = Object.entries(r.porTipo).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (tipos.length > 1) {
        msg += '\n' + tipos.map(([tp, v]) => `• ${tp}: ${formatBRL(v)}`).join('\n');
    }
    return msg;
}

// ── Entradas (quanto ganhei/recebi) ───────────────────────────────────────────
export function renderEntradas(r) {
    const per = PERIODO_LABEL[r.periodo] || 'no período';
    if (r.count === 0) {
        const alvo = r.termos.length ? ` de ${r.termos.join(', ')}` : '';
        return `Não achei nenhuma entrada${alvo} ${per}.`;
    }
    const alvo = r.termos.length ? ` de *${r.termos.join(', ')}*` : '';
    let msg = `{{fa-money-bill-wave}} Você recebeu *${formatBRL(r.total)}*${alvo} ${per} (${r.count} entrada${r.count > 1 ? 's' : ''}).`;
    const tipos = Object.entries(r.porTipo).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (tipos.length > 1) msg += '\n' + tipos.map(([tp, v]) => `• ${tp}: ${formatBRL(v)}`).join('\n');
    return msg;
}

// ── Onde mais gastei / gráficos (ranking por categoria) ───────────────────────
export function renderMaiorGasto(r) {
    const per = PERIODO_LABEL[r.periodo] || 'no período';
    if (r.count === 0 || !r.ranking.length) return `Não achei gastos ${per} pra montar o ranking.`;
    let msg = `{{fa-chart-simple}} *No que você mais gastou ${per}* (total ${formatBRL(r.total)}):\n`;
    msg += r.ranking.map((g, i) => `${i + 1}. ${g.tipo} — ${formatBRL(g.valor)} (${g.pct}%)`).join('\n');
    return msg;
}

// ── Últimos lançamentos ────────────────────────────────────────────────────────
const _SINAL = { entrada: '+', retirada_reserva: '+', saida: '-', reserva: '-', saida_credito: '-', assinatura: '-' };
export function renderUltimas(lista) {
    if (!lista.length) return 'Você ainda não tem lançamentos. Manda o primeiro — ex: “gastei 40 no mercado”.';
    return '{{fa-receipt}} *Seus últimos lançamentos:*\n' + lista.map((t) => {
        const s = _SINAL[t.categoria] || '';
        return `• ${t.data} · ${t.descricao || t.tipo}: ${s}${formatBRL(t.valor)}`;
    }).join('\n');
}

// ── Comparação de mês ──────────────────────────────────────────────────────────
export function renderComparar(r) {
    if (r.passado === 0 && r.atual === 0) return 'Sem gastos neste mês nem no passado pra comparar ainda.';
    if (r.passado === 0) return `Você gastou ${formatBRL(r.atual)} este mês. No mês passado não houve gastos registrados.`;
    if (r.dif > 0) return `{{fa-arrow-trend-up}} Este mês: *${formatBRL(r.atual)}* — ${formatBRL(r.dif)} a MAIS que o mês passado (${formatBRL(r.passado)})${r.pct !== null ? `, ${r.pct}% acima` : ''}.`;
    if (r.dif < 0) return `{{fa-arrow-trend-down}} Este mês: *${formatBRL(r.atual)}* — ${formatBRL(Math.abs(r.dif))} a MENOS que o mês passado (${formatBRL(r.passado)}). Mandou bem!`;
    return `Você gastou o mesmo nos dois meses: ${formatBRL(r.atual)}.`;
}

// ── Média mensal ────────────────────────────────────────────────────────────────
export function renderMedia(r) {
    if (!r.meses) return 'Ainda não tenho meses suficientes pra calcular sua média de gastos.';
    return `Sua média de gastos é *${formatBRL(r.media)}/mês* (sobre ${r.meses} ${r.meses > 1 ? 'meses' : 'mês'} com movimentação).`;
}

// ── Fatura do cartão ────────────────────────────────────────────────────────────
export function renderFatura(r) {
    if (r.count === 0) return '{{fa-credit-card}} Você não tem fatura em aberto no momento.';
    let msg = `{{fa-credit-card}} *Fatura(s) em aberto:* ${formatBRL(r.total)}`;
    if (r.itens.length > 1) msg += '\n' + r.itens.map((i) => `• ${i.nome}: ${formatBRL(i.valor)}`).join('\n');
    return msg;
}

// ── Quanto falta pra meta ────────────────────────────────────────────────────────
export function renderFaltaMeta(r) {
    if (!r.ok) {
        if (r.reason === 'sem_meta') return '{{fa-bullseye}} Você não tem metas criadas ainda. Crie no menu “Reservas”.';
        if (r.reason === 'sem_alvo') return `A meta “${r.nome}” não tem valor-alvo definido (você já guardou ${formatBRL(r.saved)}).`;
        if (r.reason === 'ambigua') return `Qual meta? ${r.opcoes.map((o) => `“${o}”`).join(', ')}.`;
        return 'Não achei essa meta.';
    }
    if (r.faltam <= 0) return `{{fa-bullseye}} A meta “${r.nome}” já está completa! (${formatBRL(r.saved)})`;
    return `{{fa-bullseye}} Faltam *${formatBRL(r.faltam)}* pra completar “${r.nome}” — você já tem ${formatBRL(r.saved)} de ${formatBRL(r.alvo)} (${r.pct}%).`;
}

// ── Saldo atual ────────────────────────────────────────────────────────────────
export function renderSaldo(v) {
    if (v > 0) return `{{fa-arrow-trend-up}} Seu saldo atual é *${formatBRL(v)}*.`;
    if (v < 0) return `{{fa-arrow-trend-down}} Seu saldo atual está em *${formatBRL(v)}* — no vermelho. Bora ajustar?`;
    return 'Seu saldo atual está zerado. Manda as movimentações que eu atualizo.';
}

// ── Relatório ─────────────────────────────────────────────────────────────────
export function renderRelatorio(r) {
    const per = PERIODO_LABEL[r.periodo] || 'no período';
    if (r.count === 0) return `Não tem movimentação ${per} ainda. Bora começar? Manda um gasto ou entrada.`;
    let msg = `{{fa-chart-simple}} *Resumo ${per}*\n` +
        `• Entradas: ${formatBRL(r.entradas)}\n` +
        `• Saídas: ${formatBRL(r.saidas)}\n` +
        `• Reservado: ${formatBRL(r.reservas)}\n` +
        `• Saldo do período: ${formatBRL(r.saldoPeriodo)}`;
    if (r.topGastos.length) {
        msg += '\n\nOnde mais foi:\n' + r.topGastos.map((g) => `• ${g.tipo}: ${formatBRL(g.valor)}`).join('\n');
    }
    return msg;
}

// ── Reservas ─────────────────────────────────────────────────────────────────
export function renderReservas(lista) {
    if (!lista.length) return '{{fa-piggy-bank}} Você ainda não tem reservas. Crie no menu “Reservas” e comece a guardar.';
    return '{{fa-piggy-bank}} *Suas reservas:*\n' + lista.map((m) => {
        const prog = m.pct !== null ? ` (${m.pct}%${m.alvo ? ` de ${formatBRL(m.alvo)}` : ''})` : '';
        return `• ${m.nome}: ${formatBRL(m.saved)}${prog}`;
    }).join('\n');
}

// ── Projeção de meta ───────────────────────────────────────────────────────────
export function renderProjecao(p) {
    if (!p.ok) {
        if (p.reason === 'sem_meta') return '{{fa-bullseye}} Você não tem metas com valor-alvo definido. Crie uma no menu “Reservas”.';
        if (p.reason === 'sem_aporte') return 'Me diz quanto pretende guardar por mês, ex: “se eu guardar 300 por mês…”.';
        return 'Essa meta ainda não tem um valor-alvo definido — dá pra ajustar no menu “Reservas”.';
    }
    if (p.faltam <= 0) return `Boa notícia: a meta *${p.nome}* já está completa!`;
    const anos = p.meses >= 12 ? ` (~${(p.meses / 12).toFixed(1)} ano${p.meses >= 24 ? 's' : ''})` : '';
    return `{{fa-bullseye}} Guardando ${formatBRL(p.aporte)}/mês, você completa *${p.nome}* em cerca de *${p.meses} ${p.meses > 1 ? 'meses' : 'mês'}*${anos}. Faltam ${formatBRL(p.faltam)}.`;
}

// ── Handoff (categorias que mexem em meta/cartão — fase 2) ─────────────────────
export function renderHandoff(categoria) {
    if (categoria === 'assinatura')
        return '{{fa-arrows-rotate}} Pra assinatura recorrente, cria no menu **Cartões** (precisa do cartão e do dia).';
    if (categoria === 'retirada_reserva')
        return '{{fa-piggy-bank}} Retirada de reserva é melhor fazer no menu **Reservas**.';
    return 'Isso é melhor confirmar na tela específica.';
}

// ── Segurança / mensagens de sistema ───────────────────────────────────────────
export const SISTEMA = {
    saudacao: () => pick(SAUDACOES),
    ajuda: () => pick(AJUDA),
    naoEntendi: () => pick(NAO_ENTENDI),
    rate: () => pick(RATE),
    rateDia: () => pick(RATE_DIA),
    semValor: () => pick(NAO_ENTENDI),
    erro: () => 'Deu um problema aqui do meu lado. Tenta de novo daqui a pouco.',
    // Nunca revela nada sobre sistema/dados — resposta padrão de recusa amigável.
    recusa: () => 'Sou só seu assistente de finanças. Posso anotar gastos, entradas, reservas e te mostrar resumos. Como posso ajudar?',
};
