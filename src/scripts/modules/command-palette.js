// command-palette.js — paleta de comandos (Ctrl/Cmd + K)  [O-1]
// ---------------------------------------------------------------------------
// POR QUE SAIU DO dashboard.js
//   ~150 linhas que só fazem algo quando alguém aperta Ctrl+K — um atalho de
//   usuário avançado que a maioria nunca usa. Viajavam no chunk de boot para
//   todo mundo.
//
//   O `dashboard.js` ficou só com o listener do Ctrl+K (uns 15 linhas) e importa
//   este módulo no PRIMEIRO uso. Quem nunca aperta, nunca baixa.
//
// CONTRATO
//   `init({ mostrarTela })` antes do primeiro `alternar()`. A navegação é a
//   única coisa que a paleta precisa do dashboard — o resto é DOM puro.
//
// ⚠️ O Ctrl+K NÃO é registrado aqui. Ele vive no stub do dashboard.js, que é
//   quem decide carregar este módulo. Registrar de novo aqui faria o atalho
//   disparar duas vezes e a paleta abrir e fechar no mesmo toque.
// ---------------------------------------------------------------------------

let _mostrarTela = () => {};

/** Injeta as dependências do dashboard. Chamar antes do primeiro alternar(). */
export function init(deps) {
    if (typeof deps?.mostrarTela === 'function') _mostrarTela = deps.mostrarTela;
}

const COMANDOS = [
    { icon: 'fa-house',                 label: 'Ir para o Dashboard',   run: () => _mostrarTela('dashboard') },
    { icon: 'fa-right-left',            label: 'Ir para Transações',    run: () => _mostrarTela('transacoes') },
    { icon: 'fa-piggy-bank',            label: 'Ir para Reservas',      run: () => _mostrarTela('reservas') },
    { icon: 'fa-credit-card',           label: 'Ir para Cartões',       run: () => _mostrarTela('cartoes') },
    { icon: 'fa-chart-line',            label: 'Ir para Gráficos',      run: () => _mostrarTela('graficos') },
    { icon: 'fa-file-lines',            label: 'Ir para Relatórios',    run: () => _mostrarTela('relatorios') },
    { icon: 'fa-gear',                  label: 'Ir para Configurações', run: () => _mostrarTela('configuracoes') },
    { icon: 'fa-plus',                  label: 'Nova transação',        run: () => {
        _mostrarTela('transacoes');
        setTimeout(() => {
            const c = document.getElementById('selectCategoria');
            c?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            c?.focus();
        }, 140);
    }},
    { icon: 'fa-bullseye',              label: 'Nova reserva',          run: () => {
        _mostrarTela('reservas');
        setTimeout(() => document.getElementById('btnNovaMeta')?.click(), 180);
    }},
    { icon: 'fa-credit-card',           label: 'Adicionar cartão',      run: () => {
        _mostrarTela('cartoes');
        setTimeout(() => document.querySelector('.cartoes-novo-btn-add')?.click(), 180);
    }},
    { icon: 'fa-file-invoice-dollar',   label: 'Nova conta fixa',       run: () => {
        _mostrarTela('dashboard');
        setTimeout(() => document.getElementById('btnNovaContaFixa')?.click(), 140);
    }},
];

let overlay, input, listEl, itens = [], selIdx = 0, focoAntes = null, construido = false;

function appVisivel() {
    const sel = document.getElementById('selecaoPerfis');
    if (!sel) return true;
    return sel.style.display === 'none' || getComputedStyle(sel).display === 'none';
}

function construir() {
    if (construido) return;
    overlay = document.createElement('div');
    overlay.className = 'ge-cmdk-overlay';
    overlay.id = 'geCmdkOverlay';
    overlay.innerHTML =
        '<div class="ge-cmdk" role="dialog" aria-modal="true" aria-label="Paleta de comandos">' +
            '<div class="ge-cmdk-search">' +
                '<i class="fas fa-magnifying-glass" aria-hidden="true"></i>' +
                '<input type="text" id="geCmdkInput" placeholder="Buscar ações e seções…" aria-label="Buscar comandos" autocomplete="off" spellcheck="false">' +
                '<kbd>ESC</kbd>' +
            '</div>' +
            '<ul class="ge-cmdk-list" id="geCmdkList" role="listbox" aria-label="Comandos"></ul>' +
        '</div>';
    document.body.appendChild(overlay);
    input  = overlay.querySelector('#geCmdkInput');
    listEl = overlay.querySelector('#geCmdkList');

    overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
    input.addEventListener('input', () => render(input.value));
    input.addEventListener('keydown', onKey);
    construido = true;
}

function filtrados(q) {
    const t = q.trim().toLowerCase();
    if (!t) return COMANDOS;
    return COMANDOS.filter(c => c.label.toLowerCase().includes(t));
}

function render(q) {
    itens = filtrados(q);
    selIdx = 0;
    listEl.innerHTML = '';
    if (itens.length === 0) {
        const li = document.createElement('li');
        li.className = 'ge-cmdk-empty';
        li.textContent = 'Nenhum comando encontrado.';
        listEl.appendChild(li);
        return;
    }
    itens.forEach((c, i) => {
        const li = document.createElement('li');
        li.className = 'ge-cmdk-item';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === selIdx ? 'true' : 'false');
        li.dataset.idx = i;
        const ico = document.createElement('span');
        ico.className = 'ge-cmdk-ico';
        ico.innerHTML = `<i class="fas ${c.icon}" aria-hidden="true"></i>`; // ícone estático, sem dado de usuário
        const lbl = document.createElement('span');
        lbl.textContent = c.label;
        li.append(ico, lbl);
        li.addEventListener('click', () => executar(i));
        li.addEventListener('mousemove', () => marcar(i));
        listEl.appendChild(li);
    });
}

function marcar(i) {
    if (i === selIdx) return;
    selIdx = i;
    [...listEl.children].forEach((li, idx) => {
        if (li.setAttribute) li.setAttribute('aria-selected', idx === selIdx ? 'true' : 'false');
    });
}

function executar(i) {
    const cmd = itens[i];
    fechar();
    if (cmd) { try { cmd.run(); } catch (_) {} }
}

function scrollSel() {
    listEl.querySelector(`[data-idx="${selIdx}"]`)?.scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (itens.length) { marcar((selIdx + 1) % itens.length); scrollSel(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (itens.length) { marcar((selIdx - 1 + itens.length) % itens.length); scrollSel(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (itens.length) executar(selIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); fechar(); }
}

function abrir() {
    construir();
    focoAntes = document.activeElement;
    overlay.classList.add('active');
    input.value = '';
    render('');
    requestAnimationFrame(() => { try { input.focus(); } catch (_) {} });
}

function fechar() {
    if (!overlay || !overlay.classList.contains('active')) return;
    overlay.classList.remove('active');
    if (focoAntes && typeof focoAntes.focus === 'function') { try { focoAntes.focus(); } catch (_) {} }
    focoAntes = null;
}

function estaAberto() { return overlay && overlay.classList.contains('active'); }

/** Abre se fechada, fecha se aberta. É o que o stub do dashboard.js chama. */
export function alternar() {
    if (estaAberto()) fechar(); else abrir();
}

/** Exposto para o stub decidir se deve abrir (na seleção de perfil, não abre). */
export { appVisivel };
