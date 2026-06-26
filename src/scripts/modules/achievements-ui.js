// achievements-ui.js — Renderização da TELA de conquistas (grid + hero de nível).
// Separado de achievements.js de propósito: este código só é necessário na aba
// Configurações (chunk lazy db-configuracoes). Mantê-lo fora do achievements.js
// — que é importado estaticamente pelo dashboard (chunk principal) — evita
// inflar o bundle crítico. O engine/toast/níveis ficam em achievements.js.

import { ACHIEVEMENTS, RARITY, computeLevel } from './achievements.js?v=1';

// Formatação BRL de fallback (a UI passa a do dashboard quando disponível).
function _brl(v) {
    try { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    catch { return 'R$ ' + Math.round(v); }
}

/**
 * Renderiza a tela de conquistas dentro de `container` (DOM seguro).
 * @param {HTMLElement} container
 * @param {{ state: Object, unlocked: Object, formatBRL?: Function }} opts
 */
export function renderConquistas(container, { state, unlocked, formatBRL } = {}) {
    container.textContent = '';
    unlocked = unlocked || {};
    const fmt = typeof formatBRL === 'function' ? formatBRL : _brl;
    const nivel = computeLevel(unlocked);
    const total = ACHIEVEMENTS.length;
    const feitas = ACHIEVEMENTS.filter(a => unlocked[a.id]).length;

    // ----- Cabeçalho de nível -----
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

    // ----- Grid -----
    const grid = document.createElement('div');
    grid.className = 'ach-grid';

    // Desbloqueadas primeiro, depois as travadas (ocultas no fim).
    const ordenadas = [...ACHIEVEMENTS].sort((a, b) => {
        const ua = unlocked[a.id] ? 0 : 1;
        const ub = unlocked[b.id] ? 0 : 1;
        if (ua !== ub) return ua - ub;
        const ha = a.hidden ? 1 : 0, hb = b.hidden ? 1 : 0;
        return ha - hb;
    });

    for (const a of ordenadas) {
        const feito = !!unlocked[a.id];
        const secretaTravada = a.hidden && !feito;

        const card = document.createElement('div');
        card.className = `ach-card ${RARITY[a.rarity].cls} ${feito ? 'is-unlocked' : 'is-locked'}`;

        const ic = document.createElement('div');
        ic.className = 'ach-card__icon';
        ic.textContent = secretaTravada ? '❔' : a.icon;

        const info = document.createElement('div');
        info.className = 'ach-card__info';

        const tt = document.createElement('div');
        tt.className = 'ach-card__title';
        tt.textContent = secretaTravada ? 'Conquista secreta' : a.titulo;

        const dd = document.createElement('div');
        dd.className = 'ach-card__desc';
        dd.textContent = secretaTravada ? 'Continue usando o app para descobrir.' : a.desc;

        info.append(tt, dd);

        // Barra de progresso (só travadas mensuráveis e não-secretas)
        if (!feito && !secretaTravada && typeof a.progresso === 'function') {
            try {
                const p = a.progresso(state);
                if (p && p.alvo > 0) {
                    const atual = Math.max(0, Math.min(p.atual, p.alvo));
                    const pct = Math.min(100, Math.round((p.atual / p.alvo) * 100));
                    const pbar = document.createElement('div');
                    pbar.className = 'ach-card__bar';
                    const pfill = document.createElement('div');
                    pfill.className = 'ach-card__bar-fill';
                    pfill.style.width = pct + '%';
                    pbar.appendChild(pfill);

                    const plabel = document.createElement('div');
                    plabel.className = 'ach-card__bar-label';
                    const f = p.fmt || ((x) => String(Math.round(x)));
                    plabel.textContent = `${f(atual)} / ${f(p.alvo)}`;

                    info.append(pbar, plabel);
                }
            } catch { /* progresso opcional */ }
        }

        const tag = document.createElement('div');
        tag.className = 'ach-card__tag';
        tag.textContent = feito ? '✓' : RARITY[a.rarity].label;

        card.append(ic, info, tag);
        grid.appendChild(card);
    }

    container.appendChild(grid);
}
