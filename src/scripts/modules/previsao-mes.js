// previsao-mes.js — "Previsão de fim de mês" (lazy)
// ----------------------------------------------------------------------------
// Projeta o saldo do usuário para o último dia do mês corrente:
//
//   previsão = saldo hoje
//            + entradas recorrentes ainda não recebidas (detectadas por padrão)
//            − contas fixas/faturas NÃO pagas que vencem até o fim do mês
//            − (média diária de gasto variável × dias restantes)
//
// 100% client-side, matemática pura — nenhum dado sai do navegador.
// Render: card no dashboard (#previsaoSlot) + popup de detalhamento.
// Todo dado dinâmico entra via textContent (imune a XSS).
// ----------------------------------------------------------------------------

let _ctx = null;
let _debounceTimer = null;

// ── Datas ─────────────────────────────────────────────────────────────────────
// t.data chega como "DD/MM/YYYY" (padrão do app) ou "YYYY-MM-DD" (legado/import).
function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (data.includes('/')) {
        const p = data.split('/');
        if (p.length !== 3) return null;
        d = +p[0]; m = +p[1]; y = +p[2];
    } else if (data.includes('-')) {
        const p = data.split('-');
        if (p.length < 3) return null;
        y = +p[0]; m = +p[1]; d = parseInt(p[2], 10);
    } else return null;
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d);
}

function _valSeguro(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Descrição normalizada p/ agrupar recorrências (mesma técnica do detector).
function _normDesc(desc) {
    return String(desc || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\d+/g, '')
        .replace(/[^a-z ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

/**
 * Entradas recorrentes previstas para o restante do mês: descrições que
 * apareceram como 'entrada' em ≥2 dos últimos 3 meses, com dia médio ainda
 * por vir neste mês e que ainda não ocorreram neste mês.
 */
function _entradasPrevistas(transacoes, hoje) {
    const grupos = new Map(); // norm → { meses:Set<YYYY-MM>, dias:[], valores:[], mesAtualJaOcorreu }
    const mesAtualKey = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const inicioJanela = new Date(hoje.getFullYear(), hoje.getMonth() - 3, 1);

    for (const t of transacoes) {
        if (t.categoria !== 'entrada') continue;
        const dt = _txDate(t.data);
        if (!dt || dt < inicioJanela) continue;
        const key = _normDesc(t.descricao);
        if (key.length < 3) continue;
        if (!grupos.has(key)) grupos.set(key, { meses: new Set(), dias: [], valores: [], mesAtual: false });
        const g = grupos.get(key);
        const mesKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        if (mesKey === mesAtualKey) { g.mesAtual = true; continue; }
        g.meses.add(mesKey);
        g.dias.push(dt.getDate());
        g.valores.push(_valSeguro(t.valor));
    }

    let total = 0, itens = 0;
    for (const g of grupos.values()) {
        if (g.mesAtual || g.meses.size < 2 || g.valores.length === 0) continue;
        const diaMedio = Math.round(g.dias.reduce((s, d) => s + d, 0) / g.dias.length);
        if (diaMedio <= hoje.getDate()) continue; // dia já passou e não caiu — não conta
        // usa o MENOR valor recente como estimativa conservadora
        total += Math.min(...g.valores);
        itens++;
    }
    return { total, itens };
}

/** Núcleo do cálculo — exportado p/ reuso e teste. */
export function calcularPrevisao(ctx) {
    const hoje      = new Date();
    const ano       = hoje.getFullYear();
    const mes       = hoje.getMonth();
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    const diasRestantes = Math.max(0, ultimoDia - hoje.getDate());

    // ── Saldo acumulado (mesmas regras do dashboard) ─────────────────────
    let saldo = 0;
    for (const t of (ctx.transacoes || [])) {
        const v = _valSeguro(t.valor);
        if      (t.categoria === 'entrada')          saldo += v;
        else if (t.categoria === 'saida')            saldo -= v;
        else if (t.categoria === 'reserva')          saldo -= v;
        else if (t.categoria === 'retirada_reserva') saldo += v;
    }

    // ── Contas fixas/faturas não pagas vencendo até o fim do mês ────────
    let contasAPagar = 0, qtdContas = 0;
    for (const c of (ctx.contasFixas || [])) {
        if (c.pago === true) continue;
        if (typeof c.vencimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.vencimento)) continue;
        const [vy, vm] = c.vencimento.split('-').map(Number);
        // vencidas de meses anteriores também pesam no caixa deste mês
        if (vy > ano || (vy === ano && vm > mes + 1)) continue;
        contasAPagar += _valSeguro(c.valor);
        qtdContas++;
    }

    // ── Gasto variável médio/dia (28 dias, excluindo contas e faturas) ───
    const inicio28 = new Date(ano, mes, hoje.getDate() - 28);
    let gastoVariavel = 0;
    for (const t of (ctx.transacoes || [])) {
        if (t.categoria !== 'saida') continue;
        if (t.tipo === 'Conta fixa' || t.tipo === 'Cartão') continue; // já contados acima
        const dt = _txDate(t.data);
        if (!dt || dt < inicio28 || dt > hoje) continue;
        gastoVariavel += _valSeguro(t.valor);
    }
    const mediaDiaria = gastoVariavel / 28;

    // ── Entradas recorrentes previstas ───────────────────────────────────
    const previstas = _entradasPrevistas(ctx.transacoes || [], hoje);

    const projecao = saldo + previstas.total - contasAPagar - (mediaDiaria * diasRestantes);

    return {
        projecao,
        saldo,
        contasAPagar, qtdContas,
        mediaDiaria, diasRestantes,
        entradasPrevistas: previstas.total,
        qtdEntradasPrevistas: previstas.itens,
        mesLabel: hoje.toLocaleDateString('pt-BR', { month: 'long' }),
    };
}

// ── Render do card ────────────────────────────────────────────────────────────
function _render() {
    if (!_ctx) return;
    const slot = document.getElementById('previsaoSlot');
    if (!slot) return;

    // Sem transações ainda → não polui o dashboard de quem está começando
    if (!Array.isArray(_ctx.transacoes) || _ctx.transacoes.length < 3) {
        slot.innerHTML = '';
        return;
    }

    const r = calcularPrevisao(_ctx);

    slot.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'previsao-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'Ver detalhes da previsão de fim de mês');

    const iconWrap = document.createElement('div');
    iconWrap.className = 'previsao-icon' + (r.projecao >= 0 ? ' previsao-icon--ok' : ' previsao-icon--neg');
    const ic = document.createElement('i');
    ic.className = 'fas fa-calendar-week';
    ic.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(ic);

    const body = document.createElement('div');
    body.className = 'previsao-body';

    const label = document.createElement('div');
    label.className = 'previsao-label';
    label.textContent = `Previsão de fim de ${r.mesLabel}`;

    const valor = document.createElement('div');
    valor.className = 'previsao-valor ' + (r.projecao >= 0 ? 'previsao-valor--ok' : 'previsao-valor--neg');
    valor.textContent = _ctx.formatBRL(r.projecao);

    const sub = document.createElement('div');
    sub.className = 'previsao-sub';
    const partes = [];
    if (r.contasAPagar > 0)  partes.push(`${_ctx.formatBRL(r.contasAPagar)} em contas a pagar`);
    if (r.mediaDiaria > 0)   partes.push(`~${_ctx.formatBRL(r.mediaDiaria)}/dia de gasto variável`);
    sub.textContent = partes.length ? partes.join(' · ') : 'Baseado no seu ritmo de gastos atual';

    body.appendChild(label);
    body.appendChild(valor);
    body.appendChild(sub);

    const seta = document.createElement('i');
    seta.className = 'fas fa-chevron-right previsao-seta';
    seta.setAttribute('aria-hidden', 'true');

    card.appendChild(iconWrap);
    card.appendChild(body);
    card.appendChild(seta);

    const abrir = () => _abrirDetalhe(r);
    card.addEventListener('click', abrir);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });

    slot.appendChild(card);
}

function _abrirDetalhe(r) {
    _ctx.criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Previsão de fim de mês';
        popup.appendChild(titulo);

        const grande = document.createElement('div');
        grande.className = 'previsao-pop-valor ' + (r.projecao >= 0 ? 'previsao-valor--ok' : 'previsao-valor--neg');
        grande.textContent = _ctx.formatBRL(r.projecao);
        popup.appendChild(grande);

        const linhas = [
            ['Saldo hoje',                                        r.saldo,                              null],
            [`Entradas previstas (${r.qtdEntradasPrevistas} recorrentes)`, r.entradasPrevistas,        '+'],
            [`Contas e faturas a pagar (${r.qtdContas})`,          -r.contasAPagar,                     '-'],
            [`Gasto variável estimado (${r.diasRestantes} dias × ${_ctx.formatBRL(r.mediaDiaria)})`, -(r.mediaDiaria * r.diasRestantes), '-'],
        ];

        const lista = document.createElement('div');
        lista.className = 'previsao-pop-lista';
        for (const [nome, val] of linhas) {
            if (Math.abs(val) < 0.005 && nome !== 'Saldo hoje') continue;
            const row = document.createElement('div');
            row.className = 'previsao-pop-row';
            const n = document.createElement('span');
            n.textContent = nome;
            const v = document.createElement('span');
            v.className = val >= 0 ? 'previsao-valor--ok' : 'previsao-valor--neg';
            v.textContent = _ctx.formatBRL(val);
            row.appendChild(n);
            row.appendChild(v);
            lista.appendChild(row);
        }
        popup.appendChild(lista);

        const nota = document.createElement('p');
        nota.className = 'previsao-pop-nota';
        nota.textContent = 'Estimativa baseada nos últimos 28 dias de gastos e nas suas entradas recorrentes. Registrar tudo direitinho deixa a previsão mais precisa.';
        popup.appendChild(nota);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-primary';
        btn.textContent = 'Entendi';
        btn.addEventListener('click', () => _ctx.fecharPopup());
        popup.appendChild(btn);
    });
}

/** Boot: chamado pelo dashboard via import() após o carregamento inicial. */
export function initPrevisao(ctx) {
    _ctx = ctx;
    _render();
    // Recalcula após cada save (dados mudaram) — debounced p/ saves em rajada
    document.addEventListener('ge:save-done', () => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(_render, 1_200);
    });
}

export function atualizarPrevisao() { _render(); }
