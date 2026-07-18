// phrases.js — biblioteca de respostas do chatbot (a "voz" do Assistente)
// ---------------------------------------------------------------------------
// REGRA DE OURO: todo texto que o usuário lê sai daqui — nunca da IA.
// Ícones são tokens {{fa-nome}} renderizados como <i class="fas fa-nome"> pelo
// ui.js (createElement, whitelist) — sem emojis, sem innerHTML.
// ---------------------------------------------------------------------------

import { formatBRL, mesLabel } from './money.js';
import { TIPO_ICONE } from './parser-local.js';

// A5: pick que evita repetir a última escolha do MESMO array (soa menos robótico).
// WeakMap por referência do array (os pools são constantes de módulo, estáveis).
const _lastPick = new WeakMap();
export function pick(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    let i = Math.floor(Math.random() * arr.length);
    if (_lastPick.get(arr) === i) i = (i + 1) % arr.length;
    _lastPick.set(arr, i);
    return arr[i];
}

// Primeiro nome, capitalizado (para saudação personalizada — A2).
function primeiroNome(nome) {
    const w = String(nome ?? '').trim().split(/\s+/)[0] || '';
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
}

// A3: cumprimento conforme a hora local do aparelho.
function saudacaoHora() {
    const h = new Date().getHours();
    if (h < 12) return 'Bom dia';
    if (h < 18) return 'Boa tarde';
    return 'Boa noite';
}

// A10: ícone contextual por subcategoria (tipo), com fallback pro ícone da categoria.
function iconeDe(t) {
    const tk = TIPO_ICONE[t?.tipo];
    if (tk) return `{{${tk}}}`;
    return CAT_ICONE[t?.categoria] || '{{fa-check}}';
}

// A4: micro-reação por faixa de valor / categoria (dá "vida" à confirmação).
function microReacao(t) {
    const v = Number(t?.valor) || 0;
    if (t?.categoria === 'entrada') {
        if (v >= 3000) return pick([' Entrada gorda! {{fa-fire}}', ' Isso! Mês começando bem. {{fa-fire}}']);
        if (v >= 500)  return pick([' Boa, dinheiro no bolso. {{fa-thumbs-up}}', ' Show, mais grana entrando.']);
        return '';
    }
    if (t?.categoria === 'reserva') return pick([' Você guardando é você vencendo. {{fa-piggy-bank}}', ' Futuro agradece. {{fa-piggy-bank}}']);
    if (t?.categoria === 'saida' || t?.categoria === 'saida_credito') {
        if (v >= 1000) return pick([' Valor alto — anotado com carinho. {{fa-eye}}', ' Gasto grande, tá registrado.']);
        return '';
    }
    return '';
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
    hoje: 'hoje', semana: 'nesta semana', semana_passada: 'na semana passada', mes: 'neste mês',
    mes_passado: 'no mês passado', trimestre: 'no trimestre', ano: 'neste ano', tudo: 'no total',
};

// Rótulo de período — cobre também mês nomeado ("mes:2026-05" → "em maio"). A3.
export function perLabel(p) {
    if (typeof p === 'string' && p.startsWith('mes:')) { const l = mesLabel(p.slice(4)); return l ? `em ${l}` : 'no mês'; }
    return PERIODO_LABEL[p] || 'no período';
}

// A9: mini-barra de proporção com blocos (texto puro — sem HTML, seguro).
export function barra(pct, largura = 10) {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const cheias = Math.round((p / 100) * largura);
    return '█'.repeat(cheias) + '░'.repeat(Math.max(0, largura - cheias));
}

// ── Saudação (A1 persona "Ge" + A2 nome + A3 hora) ───────────────────────────
const SAUDACAO_CORPO = [
    'manda a movimentação que eu anoto. Ex: “gastei 80 no mercado”.',
    'pode falar naturalmente — “paguei 45 de uber”, “recebi 2000 de salário”.',
    'bora organizar tua grana. Me diz um gasto, entrada ou reserva.',
    'diz o que rolou hoje que eu registro na hora.',
    'sou o Ge, teu braço-direito das finanças. Manda o que gastou ou recebeu.',
];
export function saudacao(nome) {
    const quem = primeiroNome(nome) ? `, ${primeiroNome(nome)}` : '';
    return `${saudacaoHora()}${quem}! ${pick(SAUDACAO_CORPO)}`;
}

const AJUDA = [
    'Sou o *Ge*, seu assistente financeiro do GranaEvo. Comigo você pode:\n' +
    '• Lançar gastos: “gastei 120 no mercado”\n' +
    '• Registrar entradas: “recebi 2500 de salário”\n' +
    '• Guardar reserva: “guardei 200 pra viagem”\n' +
    '• Consultar: “quanto gastei com transporte esse mês?”, “meu saldo”, “onde mais gastei?”\n' +
    '• Pedir resumo: “explica meu mês”\n\n' +
    '{{fa-shield-halved}} Teus valores nunca saem do teu aparelho pra IA — e todo lançamento tem *Desfazer*.',
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
const ABERTURAS = ['Anotei', 'Registrado', 'Feito', 'Lançado', 'Pronto', 'Tá salvo', 'Marquei aqui'];
export function confirmacaoLancamento({ transaction, meta }) {
    const t = transaction;
    const ic = iconeDe(t); // A10: ícone da subcategoria
    const extra = t.categoria === 'reserva' && meta ? ` → ${meta}` : '';
    return {
        text: `{{fa-check}} ${pick(ABERTURAS)} · ${formatBRL(t.valor)} · ${ic} ${t.descricao || t.tipo}${extra}${microReacao(t)}`,
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
    const per = perLabel(r.periodo);
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
    const per = perLabel(r.periodo);
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
    const per = perLabel(r.periodo);
    if (r.count === 0 || !r.ranking.length) return `Não achei gastos ${per} pra montar o ranking.`;
    let msg = `{{fa-chart-simple}} *No que você mais gastou ${per}* (total ${formatBRL(r.total)}):\n`;
    msg += r.ranking.map((g, i) => `${i + 1}. ${g.tipo} — ${formatBRL(g.valor)}\n${barra(g.pct)} ${g.pct}%`).join('\n');
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

// ── Relatório (resumo rápido do período — A1/A5/A9/A10) ───────────────────────
// `comp` (opcional) = compararMes() para a linha "vs. mês passado" (só faz
// sentido no período "mes"). A nota final educa: chat = resumo, site = detalhe.
export function renderRelatorio(r, comp) {
    const per = perLabel(r.periodo);
    if (r.count === 0) return `Não tem movimentação ${per} ainda. Bora começar? Manda um gasto ou entrada.`;
    let msg = `{{fa-chart-simple}} *Resumo ${per}*\n` +
        `• Entradas: ${formatBRL(r.entradas)}\n` +
        `• Saídas: ${formatBRL(r.saidas)}\n` +
        `• Reservado: ${formatBRL(r.reservas)}\n` +
        `• Saldo do período: *${formatBRL(r.saldoPeriodo)}*`;
    // A10: comparativo com o mês passado (só no período "mes").
    if (r.periodo === 'mes' && comp && comp.passado > 0) {
        if (comp.dif > 0) msg += `\n{{fa-arrow-trend-up}} ${formatBRL(comp.dif)} a mais que o mês passado${comp.pct !== null ? ` (${comp.pct}%)` : ''}.`;
        else if (comp.dif < 0) msg += `\n{{fa-arrow-trend-down}} ${formatBRL(Math.abs(comp.dif))} a menos que o mês passado. Mandou bem!`;
    }
    // A9: onde mais foi, com mini-barras de proporção.
    if (r.topGastos.length) {
        const maxV = r.topGastos[0].valor || 1;
        msg += '\n\nOnde mais foi:\n' + r.topGastos
            .map((g) => `${g.tipo}: ${formatBRL(g.valor)}\n${barra(Math.round((g.valor / maxV) * 100))}`)
            .join('\n');
    }
    // A5: deixa claro que é o resumo rápido; o detalhe fica no site (CTA anexado pelo engine).
    msg += '\n\n{{fa-circle-info}} Esse é o resumo rápido. Pro detalhado — gráficos e exportar — abre os Relatórios no GranaEvo.';
    return msg;
}

// ── Reservas (E47: lista longa é truncada + CTA anexado pelo engine) ──────────
export function renderReservas(lista) {
    if (!lista.length) return '{{fa-piggy-bank}} Você ainda não tem reservas. Crie no menu “Reservas” e comece a guardar.';
    const CAP = 8;
    const vis = lista.slice(0, CAP);
    let msg = '{{fa-piggy-bank}} *Suas reservas:*\n' + vis.map((m) => {
        const prog = m.pct !== null ? ` (${m.pct}%${m.alvo ? ` de ${formatBRL(m.alvo)}` : ''})` : '';
        return `• ${m.nome}: ${formatBRL(m.saved)}${prog}`;
    }).join('\n');
    if (lista.length > CAP) msg += `\n…e mais ${lista.length - CAP} — ver todas no GranaEvo.`;
    return msg;
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

// ── "Não entendi" com sugestão contextual ──────────────────────────────────────
export function naoEntendiEsperto(local) {
    if (local && local.valor > 0 && !local.categoria) {
        return `Achei o valor ${formatBRL(local.valor)}, mas não entendi o que fazer. Foi um gasto? Ex: “gastei ${local.valor} no mercado”.`;
    }
    if (local && local.categoria && !(local.valor > 0)) {
        return 'Entendi o tipo, mas faltou o valor. Quanto foi?';
    }
    return pick(NAO_ENTENDI) + '\nPode ser: lançar (“gastei 40 no mercado”), consultar (“quanto gastei em transporte”) ou pedir resumo (“meu resumo do mês”).';
}

// ── Confirmação de valor alto (anti-typo) ───────────────────────────────────────
export function confirmarValorAlto(cmd) {
    const desc = cmd.descricao || cmd.tipo || 'esse lançamento';
    return `${formatBRL(cmd.valor)} é um valor alto. Confirma o lançamento de “${desc}”? Responda *sim* ou *não*.`;
}
export function confirmCancelado() {
    return pick(['Beleza, cancelei.', 'Ok, não lancei nada.', 'Tranquilo, deixei pra lá.']);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSIGHTS & PROATIVIDADE (voz do Ge sobre dados 100% locais)
// Retornam string OU null (null = "não há o que dizer" → o engine não mostra).
// ═══════════════════════════════════════════════════════════════════════════════

const _ORD = ['1º', '2º', '3º', '4º', '5º', '6º', '7º', '8º', '9º', '10º'];

// C23: "esse é seu 3º Mercado do mês"
export function insightRepeticao(cpm) {
    if (!cpm || cpm.count < 3) return null; // só a partir do 3º (senão vira ruído)
    const ord = _ORD[cpm.count - 1] || `${cpm.count}º`;
    return `{{fa-circle-info}} Esse foi seu ${ord} *${cpm.tipo}* do mês — ${formatBRL(cpm.total)} no total.`;
}

// C24: alerta suave de orçamento por categoria
export function alertaOrcamentoMsg(al) {
    if (!al || !al.alerta) return null;
    return `{{fa-triangle-exclamation}} Já são ${formatBRL(al.atual)} em *${al.tipo}* este mês — ${al.pct}% acima da sua média (${formatBRL(al.media)}). Fica de olho!`;
}

// A9: reforço positivo quando está gastando menos que o mês passado
export function reforcoComparativo(comp) {
    if (!comp || comp.passado <= 0 || comp.dif >= -30) return null;
    return `{{fa-arrow-trend-down}} No ritmo do mês passado você tá gastando *menos*. Mandando bem!`;
}

// C25: resumo do 1º acesso do dia
export function resumoDiaMsg(rd) {
    if (!rd || !rd.temMovimento) return null;
    const ontem = rd.ontemCount > 0
        ? `Ontem saíram *${formatBRL(rd.ontemTotal)}* em ${rd.ontemCount} ${rd.ontemCount > 1 ? 'lançamentos' : 'lançamento'}.`
        : 'Ontem não teve gasto registrado.';
    return `{{fa-sun}} ${ontem} Saldo do mês até agora: *${formatBRL(rd.saldoMes)}*.`;
}

// C26: sugestão de guardar quando sobra folga
export function sugestaoReserva(valor) {
    const metade = Math.max(1, Math.round(valor / 2));
    return `{{fa-piggy-bank}} Você tá com uma folga boa esse mês (${formatBRL(valor)}). Que tal guardar uma parte? É só dizer “guardar ${metade} na [reserva]”.`;
}

// C27: assinaturas/recorrências detectadas
export function assinaturasMsg(list) {
    if (!list || !list.length) return 'Não achei assinaturas recorrentes claras nos seus lançamentos. {{fa-magnifying-glass}}';
    const total = list.reduce((s, r) => s + r.valor, 0);
    return `{{fa-arrows-rotate}} *Coisas que se repetem todo mês* (~${formatBRL(total)}/mês):\n` +
        list.map((r) => `• ${r.nome}: ${formatBRL(r.valor)} (${r.meses} meses)`).join('\n') +
        '\nAlguma dá pra cancelar?';
}

// C29: curiosidade — dia mais caro
export function curiosidadeMsg(dc) {
    if (!dc || !dc.ok) return null;
    return `{{fa-lightbulb}} Curiosidade: seu dia mais caro costuma ser *${dc.dia}* (média de ${formatBRL(dc.media)} nesse dia).`;
}

// C30: reserva parada
export function metasParadasMsg(list) {
    if (!list || !list.length) return null;
    const m = list[0];
    return `{{fa-bullseye}} Faz *${m.diasParado} dias* sem aporte na reserva “${m.nome}” (parada em ${formatBRL(m.saved)}). Bora voltar a guardar?`;
}

// B22: quanto ainda dá pra gastar
export function orcamentoRestanteMsg(orc) {
    if (!orc || !orc.temHistorico) {
        return 'Ainda não tenho meses suficientes pra estimar quanto dá pra gastar. Continua lançando que logo eu te digo! {{fa-chart-line}}';
    }
    if (orc.restante > 0) {
        return `{{fa-wallet}} Pela sua média (${formatBRL(orc.media)}/mês), ainda dá pra gastar cerca de *${formatBRL(orc.restante)}* este mês — você já gastou ${formatBRL(orc.gastoMes)}.`;
    }
    return `{{fa-triangle-exclamation}} Você já gastou ${formatBRL(orc.gastoMes)} este mês — *${formatBRL(Math.abs(orc.restante))} acima* da sua média (${formatBRL(orc.media)}). Hora de segurar. {{fa-hand}}`;
}

// C31: narrativa "explique meu mês"
export function narrativaMesMsg(nm) {
    if (!nm || nm.rel.count === 0) return 'Ainda não tem movimentação esse mês pra eu explicar. Manda os primeiros lançamentos! {{fa-rocket}}';
    const r = nm.rel, c = nm.comp, top = nm.top;
    const linhas = ['{{fa-book-open}} *Seu mês até agora:*'];
    linhas.push(`Entraram ${formatBRL(r.entradas)} e saíram ${formatBRL(r.saidas)} — saldo do período de *${formatBRL(r.saldoPeriodo)}*.`);
    if (top.ranking && top.ranking.length) {
        const g = top.ranking[0];
        linhas.push(`Onde mais pesou: *${g.tipo}* (${formatBRL(g.valor)}, ${g.pct}% dos gastos).`);
    }
    if (c.passado > 0 && c.dif > 0) linhas.push(`Você está gastando ${formatBRL(c.dif)} a MAIS que o mês passado. {{fa-arrow-trend-up}}`);
    else if (c.passado > 0 && c.dif < 0) linhas.push(`E gastou ${formatBRL(Math.abs(c.dif))} a MENOS que o mês passado — mandou bem! {{fa-arrow-trend-down}}`);
    if (r.reservas > 0) linhas.push(`Ainda guardou ${formatBRL(r.reservas)} em reservas. {{fa-piggy-bank}}`);
    return linhas.join('\n');
}

// A6: comemoração de meta completa
export function metaCompleta(nome, saved) {
    return pick([
        `{{fa-trophy}} *Meta batida!* Você completou “${nome}” (${formatBRL(saved)}). Orgulho! {{fa-fire}}`,
        `{{fa-trophy}} Fechou a meta “${nome}”! ${formatBRL(saved)} guardados. Isso é disciplina! {{fa-star}}`,
    ]);
}

// A7: streak de dias consecutivos
export function streakMsg(n) {
    if (!n || n < 3) return null; // só celebra a partir de 3 dias
    if (n >= 7) return `{{fa-fire}} *${n} dias seguidos* anotando! Você virou fera no controle. {{fa-star}}`;
    return `{{fa-fire}} ${n}º dia seguido lançando — tá criando o hábito!`;
}

// E42: micro-copy educativo de privacidade
export function privacidadeMsg() {
    return '{{fa-shield-halved}} Fica tranquilo: seus valores, saldos e transações *nunca* saem do seu aparelho pra IA. Ela só me ajuda a entender o que você quis dizer — quem faz as contas sou eu, aqui, localmente.';
}

// ── Pagar conta fixa via chat ─────────────────────────────────────────────────
export function contaPaga(res) {
    return {
        text: `{{fa-check}} ${pick(['Conta paga', 'Quitada', 'Feito'])}! · ${formatBRL(res.transaction.valor)} · {{fa-file-invoice-dollar}} ${res.conta} — marquei como paga e lancei a saída. Próximo vencimento atualizado.`,
        chip: { categoria: 'saida', label: `Conta paga · ${formatBRL(res.transaction.valor)} · ${res.conta}`, undoLabel: 'Desfazer' },
    };
}
export function contaJaPaga(nome) {
    return `{{fa-circle-info}} A conta “${nome}” já está marcada como paga neste ciclo.`;
}
export function contaNaoAchada(hint) {
    return hint
        ? `Não achei uma conta em aberto parecida com “${hint}”. Vê o nome exato na tela de Transações → Contas Fixas.`
        : 'Não achei contas fixas em aberto agora.';
}
export function escolherConta(opcoes = []) {
    return `Qual conta você pagou? ${opcoes.slice(0, 6).map((o) => `“${o}”`).join(', ')}. Me diz o nome.`;
}
export function contaHandoff(nome) {
    return `{{fa-credit-card}} “${nome}” é fatura de cartão/parcelada — o pagamento mexe nas parcelas e no limite do cartão, então é mais seguro concluir na tela de Contas.`;
}

// ── Orçamento via chat ────────────────────────────────────────────────────────
export function orcamentoDefinido(res) {
    const antes = res.anterior !== null ? ` (antes era ${formatBRL(res.anterior)})` : '';
    return {
        text: `{{fa-wallet}} Orçamento de *${res.tipo}* definido: ${formatBRL(res.limite)}/mês${antes}. Te aviso quando chegar perto do limite.`,
        chip: { categoria: 'saida', label: `Orçamento · ${res.tipo} · ${formatBRL(res.limite)}`, undoLabel: 'Desfazer' },
    };
}
export function orcamentoSemTipo() {
    return 'Pra qual categoria? Ex: “orçamento de 600 pra Mercado”. Vale: Mercado, Transporte, Lazer, Ifood, Farmácia…';
}

// ── Lembrete via chat (Radar) ─────────────────────────────────────────────────
export function lembreteCriado(texto, dataBR, pushOk) {
    const aviso = pushOk
        ? ''
        : '\n{{fa-triangle-exclamation}} Pra receber o aviso no celular, ativa as notificações nas Configurações do GranaEvo.';
    return `{{fa-bell}} Anotado! Te lembro de *${texto}* em ${dataBR}, de manhã.${aviso}`;
}
export function lembreteSemQuando() {
    return 'Te lembro de quê e quando? Ex: “me lembra de pagar o aluguel dia 5” ou “me avisa amanhã de cancelar o teste grátis”.';
}
export function lembreteDuplicado() {
    return '{{fa-bell}} Esse lembrete já existe pra essa data — pode deixar que eu aviso.';
}
export function lembreteErro() {
    return 'Não consegui agendar o lembrete agora. Tenta de novo em instantes.';
}
export function lembreteDesfeito() {
    return 'Lembrete cancelado.';
}

// ── Offline (outbox) ──────────────────────────────────────────────────────────
export function offlineEnfileirado(cmd) {
    return `{{fa-wifi}} Sem internet agora — mas anotei *${formatBRL(cmd.valor)} · ${cmd.descricao || cmd.tipo}* aqui no aparelho. Assim que a conexão voltar, eu lanço sozinho.`;
}
export function offlineSincronizado(n) {
    return n === 1
        ? '{{fa-cloud-arrow-up}} Conexão de volta! Lancei o registro que estava esperando.'
        : `{{fa-cloud-arrow-up}} Conexão de volta! Lancei os ${n} registros que estavam esperando.`;
}

// ── Selo de entendimento local (telemetria anônima — Configurações) ───────────
export function statsResumo(s) {
    if (!s || !s.total) return 'Ainda não tenho estatísticas de uso por aqui.';
    const pct = s.pctLocal !== null ? `${s.pctLocal}%` : '—';
    return `{{fa-shield-halved}} Das suas ${s.total} mensagens, *${pct}* foram entendidas 100% no aparelho (sem IA).`;
}

// E45: rate-limit com espera explícita (educar, não frustrar)
export function rateEspera(seg) {
    const s = Number.isFinite(seg) && seg > 0 ? seg : 30;
    return `{{fa-hourglass-half}} Opa, muita coisa de uma vez! Aguarda ${s}s e manda de novo — é só proteção, teu histórico tá salvo.`;
}

// E46: rótulo do selo "modo local" (usado pela UI quando a IA está indisponível)
export const LABEL_MODO_LOCAL = 'entendendo localmente';

// ═══════════════════════════════════════════════════════════════════════════════
// BLOCO C — novos insights de proatividade (todos sobre dados 100% locais)
// ═══════════════════════════════════════════════════════════════════════════════

// C21: fatura de cartão vencendo (ou vencida)
export function faturaVencendoMsg(f) {
    if (!f || !f.ok) return null;
    if (f.vencida) return `{{fa-triangle-exclamation}} A fatura do *${f.nome}* (${formatBRL(f.valor)}) já venceu. Bora quitar?`;
    if (f.dias === 0) return `{{fa-calendar-day}} A fatura do *${f.nome}* (${formatBRL(f.valor)}) vence *hoje*.`;
    return `{{fa-calendar-day}} A fatura do *${f.nome}* (${formatBRL(f.valor)}) vence em *${f.dias} ${f.dias > 1 ? 'dias' : 'dia'}*.`;
}

// C22: lembrete de salário provável (só se ainda não caiu este mês)
export function salarioMsg(s) {
    if (!s || !s.ok || s.caiuEsteMes || !s.perto) return null;
    return `{{fa-money-check-dollar}} Seu salário costuma cair por volta do dia *${s.dia}*. Já recebeu? Me fala que eu registro.`;
}

// C23: nudge de fim de mês
export function fimDeMesMsg(fm) {
    if (!fm || !fm.temMovimento || fm.diasRestantes > 3 || fm.diasRestantes < 0) return null;
    if (fm.diasRestantes === 0) return '{{fa-flag-checkered}} Último dia do mês! Quer fechar registrando o que faltou?';
    return `{{fa-flag-checkered}} Faltam *${fm.diasRestantes} ${fm.diasRestantes > 1 ? 'dias' : 'dia'}* pro mês fechar. Algo ainda pra anotar?`;
}

// C24: marcos (reserva acumulada / contagem de lançamentos)
export function marcoReservaMsg(m) {
    if (!m) return null;
    return `{{fa-trophy}} Você passou de *${formatBRL(m.marco)}* guardados no total! Já são ${formatBRL(m.total)}. Que evolução! {{fa-fire}}`;
}
export function marcoContagemMsg(m) {
    if (!m) return null;
    return `{{fa-star}} Esse foi seu *${m.marco}º lançamento*! Consistência é o que constrói patrimônio.`;
}

// C26: conquistas (lê o mapa profile.conquistas — sem rodar o engine de conquistas)
export function conquistasMsg(c) {
    if (!c || !c.total) return 'Você ainda não desbloqueou conquistas. Continua lançando que elas vêm! {{fa-medal}}';
    return `{{fa-medal}} Você já desbloqueou *${c.total} ${c.total > 1 ? 'conquistas' : 'conquista'}*. Vê todas (e seu nível) na tela de Conquistas do GranaEvo.`;
}
export function conquistasHojeMsg(n) {
    if (!n) return null;
    return `{{fa-medal}} Você desbloqueou *${n} ${n > 1 ? 'conquistas' : 'conquista'}* recentemente! Dá um pulo em Conquistas pra ver. {{fa-star}}`;
}

// B13: valor sozinho ambíguo → pergunta (sem IA; chips vêm do engine)
// Pedido de mexer num lançamento que não é o último. Ser honesto sobre o limite
// vale mais que adivinhar: adivinhar aqui grava dado errado no lugar errado.
export function editarAntigoMsg() {
    return '{{fa-pen-to-square}} Por aqui eu só alcanço o *último* lançamento — pra mexer num anterior, abre as Transações que lá dá pra editar e apagar qualquer um.';
}

// Valor solto, sem direção. Oferece as QUATRO direções que o app tem — antes
// eram só gasto/entrada, e quem tinha tirado da reserva ficava sem saída. O
// engine guarda o valor (#pendingValorAmbiguo), então responder por escrito
// ("retirada da caixinha") também funciona, não só os chips.
export function perguntarGastoOuEntrada(valor) {
    return `Peguei *${formatBRL(valor)}* — só me diz o que foi que eu lanço.`;
}

// B15: repetição do último lançamento
export function repetido(res) {
    const base = confirmacaoLancamento(res);
    return { text: '{{fa-rotate-right}} De novo! ' + base.text.replace(/^\{\{fa-check\}\}\s*/, ''), chip: base.chip };
}
export function nadaPraRepetir() {
    return 'Não tenho um lançamento recente pra repetir. Manda o primeiro que eu anoto!';
}

// F49: ajuda contextual — varia conforme o que o usuário já tem/usa.
export function ajudaContexto(ctx = {}) {
    let extra = '';
    if (!ctx.temReserva) extra = '\n\n{{fa-piggy-bank}} Dica: crie uma *reserva* no GranaEvo e eu passo a guardar dinheiro por voz (“guardei 200 na viagem”).';
    else if (!ctx.usouReserva) extra = '\n\n{{fa-piggy-bank}} Você tem reservas! Experimenta “guardei 100 na [nome da reserva]”.';
    else if (!ctx.temCartao) extra = '\n\n{{fa-credit-card}} Tem compras no crédito? Cadastre um cartão no GranaEvo que eu registro as parceladas.';
    return pick(AJUDA) + extra;
}

// ── Segurança / mensagens de sistema ───────────────────────────────────────────
export const SISTEMA = {
    saudacao: (nome) => saudacao(nome),
    ajuda: () => pick(AJUDA),
    naoEntendi: () => pick(NAO_ENTENDI),
    rate: () => pick(RATE),
    rateDia: () => pick(RATE_DIA),
    semValor: () => pick(NAO_ENTENDI),
    erro: () => 'Deu um problema aqui do meu lado. Tenta de novo daqui a pouco.',
    // Nunca revela nada sobre sistema/dados — resposta padrão de recusa amigável.
    recusa: () => pick([
        'Eu sou o Ge, seu assistente de finanças — só cuido de gastos, entradas, reservas e resumos. Como posso ajudar com a sua grana?',
        'Fico só na área de finanças, tá? Posso anotar um gasto, uma entrada ou te mostrar um resumo. Manda aí!',
    ]),
};

// ── Passo 29: micro-lição e proatividade de assinatura ───────────────────────
// Ambas recebem dados JÁ DERIVADOS no cliente (modules/assistant/insights.js).
// Nenhum valor daqui passa perto da IA — o Haiku só interpreta a fala do
// usuário; quem escreve resposta é este arquivo.

/**
 * Micro-lição: a pessoa comparada com ela mesma, nunca com um padrão externo.
 * O tom é de constatação, não de bronca — quem se sente julgado fecha o app.
 */
export function microLicaoMsg(ml) {
    if (!ml) return null;
    return `{{fa-lightbulb}} *${ml.tipo}* levou *${ml.pctAtual}%* do seu gasto neste mês `
         + `(${formatBRL(ml.gastoAtual)}). Nos últimos ${ml.meses} meses fechados, sua média foi `
         + `*${ml.pctMedia}%*. Não é regra nenhuma — é só a sua própria história mostrando a diferença.`;
}

/**
 * Cobrança que se repete e não está cadastrada. Mostra o ANUAL de propósito:
 * R$ 39,90/mês parece pouco; R$ 478,80/ano é a mesma coisa dita de um jeito que
 * faz a pessoa decidir.
 */
export function assinaturaNovaMsg(a) {
    if (!a) return null;
    return `{{fa-repeat}} Achei uma cobrança que se repete e não está nas suas assinaturas: `
         + `*${a.nome}*, ${formatBRL(a.valorMensal)}/mês — ${formatBRL(a.valorAnual)} por ano. `
         + `Quer cadastrar como assinatura pra ela entrar nas suas contas fixas?`;
}
