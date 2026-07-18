// ----------------------------------------------------------------------------
// painel-alertas.js — render do painel de vencimentos (LAZY, Passo 10)
//
// POR QUE FOI EXTRAÍDO: eram ~168 linhas carregadas em TODO boot para uma tela
// que só existe quando o usuário clica no sino. `dashboard.js` estava em
// 41,1/42 KB gzip — cada feature nova exigia conferir se ainda cabia. Isto é
// código frio: sai do caminho crítico e carrega sob demanda.
//
// POR QUE FOI SEGURO (a nota antiga dizia o contrário):
// O receio registrado era que "os botões chamam de volta abrirPopupPagarContaFixa",
// o que faria a extração puxar uma cadeia que termina em dinheiro. Ao ler o
// código, não é o caso: este render NÃO chama nada de pagamento. Ele só marca os
// cards com `data-acao` / `data-id`, e quem despacha para pagar/editar é o
// listener DELEGADO que vive no dashboard (`abrirPainelNotificacoes`). Ou seja,
// é um render de folha — o dinheiro continua do outro lado da fronteira.
//
// CONTRATO COM O CONSUMIDOR (não mudar sem mudar lá):
//   - todo card clicável carrega `data-id` e `data-acao` ('pagar' | 'editar')
//   - o botão de conta vencida usa `data-acao="pagar-btn"`
// O listener do dashboard depende EXATAMENTE desses nomes.
//
// Sem estado próprio e sem import de dashboard: recebe os alertas já calculados
// (`verificarVencimentos()` continua lá, porque 6 outros pontos a usam) e os
// formatadores por injeção.
// ----------------------------------------------------------------------------

/**
 * Monta o painel de alertas de vencimento.
 *
 * @param {object} alertas  saída de verificarVencimentos()
 * @param {{ formatBRL: Function, formatarDataBR: Function }} deps
 * @returns {HTMLElement|null} null quando não há nada a mostrar
 */
export function renderPainelAlertas(alertas, { formatBRL, formatarDataBR } = {}) {
    if (!alertas || alertas.total === 0) return null;
    if (typeof formatBRL !== 'function' || typeof formatarDataBR !== 'function') return null;

    const wrap = document.createElement('div');
    wrap.className = 'alertas-vencimento';

    // ── helper: extrai id seguro
    function _idSeguro(conta) {
        const raw = conta.id;
        const n   = parseInt(raw, 10);
        const id  = Number.isInteger(n) && String(n) === String(raw) ? n : raw;
        return (id === null || id === undefined || id === '') ? null : id;
    }

    // ── helper: calcula dias (positivo = futuro, negativo = passado)
    function _diffDias(vencimentoISO) {
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        const d    = new Date(vencimentoISO + 'T00:00:00');
        return Math.round((d - hoje) / 86400000);
    }

    // ── helper: cria um card de conta
    function _criarCard(conta, tipo) {
        const id = _idSeguro(conta);
        if (!id) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(conta.vencimento)) return null;
        if (isNaN(new Date(conta.vencimento + 'T00:00:00').getTime())) return null;

        const diff = _diffDias(conta.vencimento);

        const paleta = {
            vencida:  { bg: 'rgba(255,75,75,0.1)',   borda: '#ff4b4b', tag: '#ff4b4b',  acao: 'pagar'  },
            hoje:     { bg: 'rgba(255,140,50,0.1)',  borda: '#ff8c32', tag: '#ff8c32',  acao: 'editar' },
            em3Dias:  { bg: 'rgba(255,209,102,0.1)', borda: '#ffd166', tag: '#ffd166',  acao: 'editar' },
            proximo:  { bg: 'rgba(76,166,255,0.1)',  borda: '#4ca6ff', tag: '#4ca6ff',  acao: 'editar' },
        };
        const p = paleta[tipo] || paleta.proximo;

        const card = document.createElement('div');
        card.className   = 'alerta-card';
        card.dataset.id  = String(id);
        card.dataset.acao = p.acao;
        card.style.cssText = `
            background: ${p.bg};
            border-left: 3px solid ${p.borda};
            border-radius: 12px;
            padding: 14px 16px;
            margin-bottom: 10px;
            cursor: pointer;
            transition: opacity .15s;
        `;

        // ── Linha 1: nome + badge
        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:10px;';

        const nome = document.createElement('div');
        nome.style.cssText = 'font-weight:700; color:var(--text-primary); font-size:0.95rem; flex:1;';
        nome.textContent   = conta.descricao;

        const badge = document.createElement('span');
        badge.style.cssText = `
            background: ${p.borda}22;
            color: ${p.tag};
            border: 1px solid ${p.borda}55;
            font-size: 0.72rem;
            font-weight: 700;
            padding: 3px 9px;
            border-radius: 20px;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 4px;
        `;

        const bIcon = document.createElement('i');
        if      (tipo === 'vencida') { bIcon.className = 'fas fa-triangle-exclamation'; badge.appendChild(bIcon); badge.appendChild(document.createTextNode(`Vencida há ${Math.abs(diff)} dia(s)`)); }
        else if (tipo === 'hoje')    { bIcon.className = 'fas fa-bell';                  badge.appendChild(bIcon); badge.appendChild(document.createTextNode('Vence Hoje')); }
        else if (tipo === 'em3Dias') { bIcon.className = 'fas fa-clock';                 badge.appendChild(bIcon); badge.appendChild(document.createTextNode('Em 3 dias')); }
        else                         { bIcon.className = 'fas fa-calendar';              badge.appendChild(bIcon); badge.appendChild(document.createTextNode(`Em ${diff} dia(s)`)); }

        row1.appendChild(nome);
        row1.appendChild(badge);

        // ── Linha 2: valor + data vencimento + botão pagar (se vencida)
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:8px;';

        const metaInfo = document.createElement('div');
        metaInfo.style.cssText = 'display:flex; flex-direction:column; gap:3px;';

        const valorEl = document.createElement('div');
        valorEl.style.cssText = 'font-size:0.9rem; color:var(--text-primary); font-weight:600;';
        const valorIcon = document.createElement('i');
        valorIcon.className = 'fas fa-tag';
        valorIcon.style.cssText = `color:${p.borda}; margin-right:5px; font-size:0.8rem;`;
        valorEl.appendChild(valorIcon);
        valorEl.appendChild(document.createTextNode(formatBRL(conta.valor)));

        const vencEl = document.createElement('div');
        vencEl.style.cssText = 'font-size:0.8rem; color:var(--text-muted); display:flex; align-items:center; gap:4px;';
        const vencIcon = document.createElement('i');
        vencIcon.className = 'fas fa-calendar-day';
        vencEl.appendChild(vencIcon);
        vencEl.appendChild(document.createTextNode(` ${formatarDataBR(conta.vencimento)}`));

        metaInfo.appendChild(valorEl);
        metaInfo.appendChild(vencEl);
        row2.appendChild(metaInfo);

        if (tipo === 'vencida') {
            const btn = document.createElement('button');
            btn.className   = 'alerta-btn';
            btn.dataset.id  = String(id);
            btn.dataset.acao = 'pagar-btn';
            const btnIcon = document.createElement('i');
            btnIcon.className = 'fas fa-check-circle';
            btnIcon.style.marginRight = '5px';
            btn.appendChild(btnIcon);
            btn.appendChild(document.createTextNode('Pagar'));
            row2.appendChild(btn);
        }

        card.appendChild(row1);
        card.appendChild(row2);
        return card;
    }

    // ── Renderizar seções por prioridade
    const grupos = [
        { lista: alertas.vencidas || [],  tipo: 'vencida',  iconCls: 'fas fa-circle-exclamation', titulo: 'Contas Vencidas',    cor: '#ff4b4b' },
        { lista: alertas.hoje    || [],   tipo: 'hoje',     iconCls: 'fas fa-bell',                titulo: 'Vencem Hoje',        cor: '#ff8c32' },
        { lista: alertas.em3Dias || [],   tipo: 'em3Dias',  iconCls: 'fas fa-clock',               titulo: 'Vencem em 3 Dias',   cor: '#ffd166' },
        { lista: alertas.proximos || [],  tipo: 'proximo',  iconCls: 'fas fa-calendar-check',      titulo: 'Próximos 7 Dias',    cor: '#4ca6ff' },
    ];

    grupos.forEach(g => {
        if (g.lista.length === 0) return;

        const sec = document.createElement('div');
        sec.style.cssText = 'margin-bottom:18px;';

        const secHeader = document.createElement('div');
        secHeader.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.08);';

        const secIcon = document.createElement('i');
        secIcon.className = g.iconCls;
        secIcon.style.cssText = `color:${g.cor}; font-size:0.9rem;`;

        const secTitle = document.createElement('span');
        secTitle.style.cssText = `font-weight:700; font-size:0.85rem; color:${g.cor}; text-transform:uppercase; letter-spacing:0.5px;`;
        secTitle.textContent   = `${g.titulo} (${g.lista.length})`;

        secHeader.appendChild(secIcon);
        secHeader.appendChild(secTitle);
        sec.appendChild(secHeader);

        g.lista.forEach(conta => {
            const card = _criarCard(conta, g.tipo);
            if (card) sec.appendChild(card);
        });

        wrap.appendChild(sec);
    });

    return wrap;
}
