// phrases.js — biblioteca de respostas do chatbot (a "voz" do Assistente)
// ---------------------------------------------------------------------------
// REGRA DE OURO: todo texto que o usuário lê sai daqui — nunca da IA.
// Pools variados + pick() aleatório dão a sensação de um assistente real.
// Funções de render recebem dados já calculados (nunca chamam a IA).
// ---------------------------------------------------------------------------

import { formatBRL } from './money.js';

export function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const CAT_ICONE = {
    entrada: '💰', saida: '🛒', reserva: '🐷', retirada_reserva: '↩️',
    saida_credito: '💳', assinatura: '🔁',
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
    'Oi! 👋 Manda a movimentação que eu anoto. Ex: “gastei 80 no mercado”.',
    'E aí! Pode falar — “paguei 45 de uber”, “recebi 2000 de salário”, o que rolar.',
    'Opa! Bora organizar. Me diz um gasto, entrada ou reserva que eu registro.',
    'Fala! Digita naturalmente que eu entendo. Ex: “guardei 300 na reserva”.',
    'Prontinho pra anotar. 💸 Manda aí o que você gastou ou recebeu.',
];

const AJUDA = [
    'Eu sou seu assistente financeiro aqui do GranaEvo. Você pode:\n' +
    '• Lançar gastos: “gastei 120 no mercado”\n' +
    '• Registrar entradas: “recebi 2500 de salário”\n' +
    '• Guardar reserva: “guardei 200 pra viagem”\n' +
    '• Consultar: “quanto gastei com transporte esse mês?”\n' +
    '• Pedir relatório: “me dá um resumo do mês”\n\n' +
    'Sempre que eu anotar algo, aparece um botão de *Desfazer* — teu histórico fica protegido. 🔒',
];

const NAO_ENTENDI = [
    'Não peguei o valor. Manda assim: “gastei 40 no mercado”. 🙂',
    'Hmm, não entendi direito. Tenta incluir o valor, tipo “paguei 30 de uber”.',
    'Quase! Me diz quanto foi — ex: “recebi 500 de freela”.',
    'Não consegui interpretar. Pode reescrever com o valor? Ex: “assinei Netflix 40”.',
];

const RATE = [
    'Ufa, muita coisa de uma vez! 😅 Aguarda uns segundos e manda de novo.',
    'Calma que eu anoto tudo — só espera um instantinho e reenvia.',
];

const RATE_DIA = [
    'Você usou bastante o assistente hoje! O limite diário foi atingido — volta amanhã que continuo te ajudando. 👍',
];

// ── Confirmação de lançamento (com chip + Desfazer) ──────────────────────────
export function confirmacaoLancamento({ transaction, meta }) {
    const t = transaction;
    const ic = CAT_ICONE[t.categoria] || '✅';
    const extra = t.categoria === 'reserva' && meta ? ` → ${meta}` : '';
    const aberturas = ['✓ Anotei', '✓ Registrado', '✓ Feito', '✓ Lançado'];
    return {
        text: `${pick(aberturas)} · ${formatBRL(t.valor)} · ${ic} ${t.descricao || t.tipo}${extra}`,
        chip: {
            categoria: t.categoria,
            label: `${CAT_LABEL[t.categoria]} · ${formatBRL(t.valor)} · ${t.descricao || t.tipo}`,
            undoLabel: 'Desfazer',
        },
    };
}

export function desfeito() {
    return pick(['Prontinho, desfiz. 👌', 'Removido — como se nada tivesse acontecido.', 'Desfeito! Teu histórico voltou ao normal.']);
}

// ── Crédito (compra parcelada com picker de cartão + parcelas) ────────────────
export function confirmacaoCredito(res) {
    const parc = res.parcelas > 1
        ? `${res.parcelas}x de ${formatBRL(res.valorParcela)}`
        : 'à vista';
    return {
        text: `${pick(['✓ Anotei', '✓ Registrado', '✓ Lançado'])} · ${formatBRL(res.compra.valorTotal)} · 💳 ${res.cardNome} · ${parc}`,
        chip: { categoria: 'saida_credito', undoLabel: 'Desfazer' },
    };
}
export function creditoQuantoFoi() {
    return pick(['Beleza, compra no crédito! Quanto foi? 💳', 'No crédito 👍 Qual foi o valor da compra?']);
}
export function semCartao() {
    return 'Você ainda não tem um cartão cadastrado. Crie um no menu **Cartões** do GranaEvo que aí eu registro suas compras no crédito. 💳';
}
export function todosCongelados() {
    return 'Todos os seus cartões estão congelados. Descongele um no menu **Cartões** pra usar. ❄️';
}
export function cartaoCongelado() {
    return 'Esse cartão está congelado. Descongele no menu **Cartões** pra usá-lo. ❄️';
}

// ── Escolha de meta (reserva ambígua) ────────────────────────────────────────
export function escolherMeta(opcoes = []) {
    if (!opcoes.length) {
        return 'Você ainda não tem uma reserva/meta criada. Crie uma no menu “Reservas” e depois é só falar comigo. 🐷';
    }
    return `Pra qual reserva? ${opcoes.map((o) => `“${o}”`).join(', ')}. Me diz o nome que eu guardo lá.`;
}

// ── Consulta de gastos ────────────────────────────────────────────────────────
export function renderConsulta(r) {
    const per = PERIODO_LABEL[r.periodo] || 'no período';
    if (r.count === 0) {
        const alvo = r.termos.length ? ` com ${r.termos.join(', ')}` : '';
        return `Não achei nenhum gasto${alvo} ${per}. 🎉`;
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
        return `Não achei nenhuma entrada${alvo} ${per}. 🙂`;
    }
    const alvo = r.termos.length ? ` de *${r.termos.join(', ')}*` : '';
    let msg = `Você recebeu *${formatBRL(r.total)}*${alvo} ${per} (${r.count} entrada${r.count > 1 ? 's' : ''}). 💰`;
    const tipos = Object.entries(r.porTipo).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (tipos.length > 1) msg += '\n' + tipos.map(([tp, v]) => `• ${tp}: ${formatBRL(v)}`).join('\n');
    return msg;
}

// ── Saldo atual ────────────────────────────────────────────────────────────────
export function renderSaldo(v) {
    if (v > 0) return `Seu saldo atual é *${formatBRL(v)}*. 🟢`;
    if (v < 0) return `Seu saldo atual está em *${formatBRL(v)}* — no vermelho. 🔴 Bora ajustar?`;
    return 'Seu saldo atual está zerado. Manda as movimentações que eu atualizo. 🙂';
}

// ── Relatório ─────────────────────────────────────────────────────────────────
export function renderRelatorio(r) {
    const per = PERIODO_LABEL[r.periodo] || 'no período';
    if (r.count === 0) return `Não tem movimentação ${per} ainda. Bora começar? Manda um gasto ou entrada. 🙂`;
    let msg = `📊 *Resumo ${per}*\n` +
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
    if (!lista.length) return 'Você ainda não tem reservas. Crie no menu “Reservas” e comece a guardar. 🐷';
    return '🐷 *Suas reservas:*\n' + lista.map((m) => {
        const prog = m.pct !== null ? ` (${m.pct}%${m.alvo ? ` de ${formatBRL(m.alvo)}` : ''})` : '';
        return `• ${m.nome}: ${formatBRL(m.saved)}${prog}`;
    }).join('\n');
}

// ── Projeção de meta ───────────────────────────────────────────────────────────
export function renderProjecao(p) {
    if (!p.ok) {
        if (p.reason === 'sem_meta') return 'Você não tem metas com valor-alvo definido. Crie uma no menu “Reservas”. 🎯';
        if (p.reason === 'sem_aporte') return 'Me diz quanto pretende guardar por mês, ex: “se eu guardar 300 por mês…”. 💡';
        return 'Essa meta ainda não tem um valor-alvo definido — dá pra ajustar no menu “Reservas”.';
    }
    if (p.faltam <= 0) return `Boa notícia: a meta *${p.nome}* já está completa! 🎉`;
    const anos = p.meses >= 12 ? ` (~${(p.meses / 12).toFixed(1)} ano${p.meses >= 24 ? 's' : ''})` : '';
    return `Guardando ${formatBRL(p.aporte)}/mês, você completa *${p.nome}* em cerca de *${p.meses} ${p.meses > 1 ? 'meses' : 'mês'}*${anos}. Faltam ${formatBRL(p.faltam)}. 🎯`;
}

// ── Handoff (categorias que mexem em meta/cartão — fase 2) ─────────────────────
export function renderHandoff(categoria) {
    if (categoria === 'assinatura')
        return 'Pra assinatura recorrente, cria no menu **Cartões** (precisa do cartão e do dia). 🔁';
    if (categoria === 'retirada_reserva')
        return 'Retirada de reserva é melhor fazer no menu **Reservas**. 🐷';
    return 'Isso é melhor confirmar na tela específica. 🙂';
}

// ── Segurança / mensagens de sistema ───────────────────────────────────────────
export const SISTEMA = {
    saudacao: () => pick(SAUDACOES),
    ajuda: () => pick(AJUDA),
    naoEntendi: () => pick(NAO_ENTENDI),
    rate: () => pick(RATE),
    rateDia: () => pick(RATE_DIA),
    semValor: () => pick(NAO_ENTENDI),
    erro: () => 'Deu um problema aqui do meu lado 😕 Tenta de novo daqui a pouco.',
    // Nunca revela nada sobre sistema/dados — resposta padrão de recusa amigável.
    recusa: () => 'Sou só seu assistente de finanças 🙂 Posso anotar gastos, entradas, reservas e te mostrar resumos. Como posso ajudar?',
};
