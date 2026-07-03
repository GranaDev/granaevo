// achievements-ui.js — Renderização da TELA de conquistas (hero + stats +
// filtros + grid agrupado por categoria).
// Separado de achievements.js de propósito: este código só é necessário na aba
// Configurações (chunk lazy db-configuracoes). Mantê-lo fora do achievements.js
// — importado estaticamente pelo dashboard (chunk crítico) — evita inflar o
// bundle. O engine/toast/níveis ficam em achievements.js; os textos das
// conquistas em achievements-catalog.js (também lazy).

import { ACHIEVEMENTS, RARITY } from './achievements.js?v=2';
import { getPresent, CATEGORIES, computeLevel } from './achievements-catalog.js?v=1';

// Formatação BRL de fallback (a UI passa a do dashboard quando disponível).
function _brl(v) {
    try { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    catch { return 'R$ ' + Math.round(v); }
}

// Insere um ícone Font Awesome (classe em whitelist) dentro de `el`.
function _faInto(el, name, fallback = 'fa-trophy') {
    const cls = /^fa-[a-z0-9-]+$/.test(name) ? name : fallback;
    const i = document.createElement('i');
    i.className = 'fas ' + cls;
    i.setAttribute('aria-hidden', 'true');
    el.appendChild(i);
}

// ISO → "DD/MM/AAAA" (data de desbloqueio). Robusto a valores inválidos.
function _fmtData(iso) {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return ''; }
}

// Monta a lista combinada (avaliação + apresentação) + estado de cada item.
function _buildItems(unlocked, state) {
    const items = [];
    for (const a of ACHIEVEMENTS) {
        const p = getPresent(a.id);
        if (!p) continue; // sem apresentação → não renderiza (mantém em sincronia)
        const feito = !!unlocked[a.id];
        let pct = 0, prog = null;
        if (!feito && typeof p.progresso === 'function') {
            try {
                const r = p.progresso(state);
                if (r && r.alvo > 0) {
                    prog = r;
                    pct = Math.min(100, Math.round((Math.max(0, r.atual) / r.alvo) * 100));
                }
            } catch { /* progresso é opcional */ }
        }
        let status = feito ? 'unlocked' : (prog ? 'progress' : 'locked');
        items.push({
            id: a.id, rarity: a.rarity, hidden: !!a.hidden,
            titulo: p.titulo, desc: p.desc, icon: p.icon, cat: p.cat,
            feito, prog, pct, status,
            quando: feito ? unlocked[a.id] : null,
            xp: RARITY[a.rarity]?.xp || 0,
        });
    }
    return items;
}

/**
 * Renderiza a tela de conquistas dentro de `container` (DOM seguro).
 * @param {HTMLElement} container
 * @param {{ state: Object, unlocked: Object, formatBRL?: Function }} opts
 */
export function renderConquistas(container, { state, unlocked, formatBRL } = {}) {
    container.textContent = '';
    unlocked = unlocked || {};
    const fmtBRL = typeof formatBRL === 'function' ? formatBRL : _brl;
    const nivel  = computeLevel(unlocked);
    const items  = _buildItems(unlocked, state);
    const total  = items.length;
    const feitas = items.filter(i => i.status === 'unlocked').length;
    const emProg = items.filter(i => i.status === 'progress').length;
    const bloq   = total - feitas;
    const pctGeral = total ? Math.round((feitas / total) * 100) : 0;

    // =================== HERO DE NÍVEL ===================
    const header = document.createElement('div');
    header.className = 'ach-hero';

    const badge = document.createElement('div');
    badge.className = 'ach-hero__badge';
    badge.textContent = String(nivel.nivel);

    const hInfo = document.createElement('div');
    hInfo.className = 'ach-hero__info';

    const hTitulo = document.createElement('div');
    hTitulo.className = 'ach-hero__title';
    hTitulo.textContent = nivel.titulo;

    const hSub = document.createElement('div');
    hSub.className = 'ach-hero__sub';
    hSub.textContent = nivel.proxTitulo
        ? `Nível ${nivel.nivel} · faltam ${nivel.xpFalta} XP para "${nivel.proxTitulo}"`
        : `Nível ${nivel.nivel} · título máximo alcançado 🎉`;

    const bar = document.createElement('div');
    bar.className = 'ach-hero__bar';
    const fill = document.createElement('div');
    fill.className = 'ach-hero__bar-fill';
    fill.style.width = nivel.pct + '%';
    bar.appendChild(fill);

    const hCount = document.createElement('div');
    hCount.className = 'ach-hero__count';
    hCount.textContent = `${feitas}/${total} conquistas · ${nivel.xp} XP`;

    hInfo.append(hTitulo, hSub, bar, hCount);
    header.append(badge, hInfo);
    container.appendChild(header);

    // =================== BARRA DE ESTATÍSTICAS ===================
    const stats = document.createElement('div');
    stats.className = 'ach-stats';
    const stat = (valor, rotulo, cls) => {
        const b = document.createElement('div');
        b.className = 'ach-stat' + (cls ? ' ' + cls : '');
        const v = document.createElement('div'); v.className = 'ach-stat__val'; v.textContent = valor;
        const r = document.createElement('div'); r.className = 'ach-stat__lbl'; r.textContent = rotulo;
        b.append(v, r);
        return b;
    };
    stats.append(
        stat(`${pctGeral}%`, 'completo', 'is-pct'),
        stat(String(feitas), 'desbloqueadas', 'is-done'),
        stat(String(emProg), 'em progresso', 'is-prog'),
        stat(String(bloq), 'bloqueadas', 'is-lock'),
    );
    container.appendChild(stats);

    // =================== CALLOUT "PRÓXIMA CONQUISTA" ===================
    // Entre as travadas mensuráveis (não-secretas), a mais perto de concluir.
    const candidatas = items
        .filter(i => i.status === 'progress' && !i.hidden && i.pct > 0 && i.pct < 100)
        .sort((a, b) => b.pct - a.pct);
    if (candidatas.length) {
        const prox = candidatas[0];
        const call = document.createElement('div');
        call.className = `ach-next ${RARITY[prox.rarity]?.cls || ''}`;
        const ci = document.createElement('div'); ci.className = 'ach-next__icon'; _faInto(ci, prox.icon);
        const cinfo = document.createElement('div'); cinfo.className = 'ach-next__info';
        const ck = document.createElement('div'); ck.className = 'ach-next__kicker'; ck.textContent = 'Quase lá';
        const ct = document.createElement('div'); ct.className = 'ach-next__title'; ct.textContent = prox.titulo;
        const cb = document.createElement('div'); cb.className = 'ach-next__bar';
        const cf = document.createElement('div'); cf.className = 'ach-next__bar-fill'; cf.style.width = prox.pct + '%';
        cb.appendChild(cf);
        cinfo.append(ck, ct, cb);
        const cp = document.createElement('div'); cp.className = 'ach-next__pct'; cp.textContent = prox.pct + '%';
        call.append(ci, cinfo, cp);
        container.appendChild(call);
    }

    // =================== FILTROS (chips) ===================
    const filtros = [
        { key: 'todas',       label: 'Todas',        n: total },
        { key: 'unlocked',    label: 'Desbloqueadas',n: feitas },
        { key: 'progress',    label: 'Em progresso', n: emProg },
        { key: 'locked',      label: 'Bloqueadas',   n: bloq },
    ];
    let filtroAtivo = 'todas';
    const chips = document.createElement('div');
    chips.className = 'ach-filters';
    const chipEls = {};
    for (const f of filtros) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'ach-chip' + (f.key === 'todas' ? ' is-active' : '');
        c.textContent = `${f.label} (${f.n})`;
        c.addEventListener('click', () => {
            if (filtroAtivo === f.key) return;
            filtroAtivo = f.key;
            for (const k in chipEls) chipEls[k].classList.toggle('is-active', k === f.key);
            paintGrid();
        });
        chipEls[f.key] = c;
        chips.appendChild(c);
    }
    container.appendChild(chips);

    // =================== GRID AGRUPADO POR CATEGORIA ===================
    const gridWrap = document.createElement('div');
    gridWrap.className = 'ach-groups';
    container.appendChild(gridWrap);

    const passaFiltro = (i) => {
        if (filtroAtivo === 'todas')    return true;
        if (filtroAtivo === 'locked')   return i.status !== 'unlocked';
        return i.status === filtroAtivo;
    };

    function paintGrid() {
        gridWrap.textContent = '';
        let idxAnim = 0;
        for (const catDef of CATEGORIES) {
            const doCat = items.filter(i => i.cat === catDef.key && passaFiltro(i));
            if (!doCat.length) continue;

            // Desbloqueadas primeiro, depois em progresso, depois travadas.
            const ordem = { unlocked: 0, progress: 1, locked: 2 };
            doCat.sort((a, b) => (ordem[a.status] - ordem[b.status]) || (b.xp - a.xp));

            const sec = document.createElement('div');
            sec.className = 'ach-group';
            const head = document.createElement('div');
            head.className = 'ach-group__head';
            const hi = document.createElement('span'); hi.className = 'ach-group__icon'; _faInto(hi, catDef.icon);
            const hl = document.createElement('span'); hl.className = 'ach-group__label'; hl.textContent = catDef.label;
            const totCat = items.filter(i => i.cat === catDef.key).length;
            const feitasCat = items.filter(i => i.cat === catDef.key && i.feito).length;
            const hc = document.createElement('span'); hc.className = 'ach-group__count'; hc.textContent = `${feitasCat}/${totCat}`;
            head.append(hi, hl, hc);
            sec.appendChild(head);

            const grid = document.createElement('div');
            grid.className = 'ach-grid';
            for (const i of doCat) grid.appendChild(_card(i, fmtBRL, idxAnim++));
            sec.appendChild(grid);
            gridWrap.appendChild(sec);
        }

        if (!gridWrap.children.length) {
            const vazio = document.createElement('div');
            vazio.className = 'ach-empty';
            vazio.textContent = 'Nada por aqui ainda. Continue usando o app para desbloquear!';
            gridWrap.appendChild(vazio);
        }
    }

    paintGrid();
}

// ----- Card individual -----
function _card(i, fmtBRL, idx) {
    const secretaTravada = i.hidden && !i.feito;

    const card = document.createElement('div');
    card.className = `ach-card ${RARITY[i.rarity]?.cls || ''} ${i.feito ? 'is-unlocked' : 'is-locked'}`;
    // Animação de entrada escalonada (CSS lê --d).
    card.style.setProperty('--d', (Math.min(idx, 24) * 28) + 'ms');

    const ic = document.createElement('div');
    ic.className = 'ach-card__icon';
    _faInto(ic, secretaTravada ? 'fa-circle-question' : i.icon);

    const info = document.createElement('div');
    info.className = 'ach-card__info';

    const tt = document.createElement('div');
    tt.className = 'ach-card__title';
    tt.textContent = secretaTravada ? 'Conquista secreta' : i.titulo;

    const dd = document.createElement('div');
    dd.className = 'ach-card__desc';
    dd.textContent = secretaTravada ? 'Continue usando o app para descobrir.' : i.desc;

    info.append(tt, dd);

    // Barra de progresso (travadas mensuráveis e não-secretas)
    if (i.status === 'progress' && !secretaTravada && i.prog) {
        const p = i.prog;
        const atual = Math.max(0, Math.min(p.atual, p.alvo));
        const pbar = document.createElement('div');
        pbar.className = 'ach-card__bar';
        const pfill = document.createElement('div');
        pfill.className = 'ach-card__bar-fill';
        pfill.style.width = i.pct + '%';
        pbar.appendChild(pfill);

        const plabel = document.createElement('div');
        plabel.className = 'ach-card__bar-label';
        const f = p.fmt || ((x) => String(Math.round(x)));
        plabel.textContent = `${f(atual)} / ${f(p.alvo)}`;

        info.append(pbar, plabel);
    }

    // Data de desbloqueio (cards concluídos)
    if (i.feito && i.quando) {
        const dt = _fmtData(i.quando);
        if (dt) {
            const meta = document.createElement('div');
            meta.className = 'ach-card__date';
            meta.textContent = `Desbloqueada em ${dt}`;
            info.append(meta);
        }
    }

    // Lateral: ✓ se feito, senão raridade + XP
    const side = document.createElement('div');
    side.className = 'ach-card__side';
    const tag = document.createElement('div');
    tag.className = 'ach-card__tag';
    tag.textContent = i.feito ? '✓' : (RARITY[i.rarity]?.label || '');
    side.appendChild(tag);
    if (!secretaTravada) {
        const xp = document.createElement('div');
        xp.className = 'ach-card__xp';
        xp.textContent = `+${i.xp} XP`;
        side.appendChild(xp);
    }

    card.append(ic, info, side);
    return card;
}
