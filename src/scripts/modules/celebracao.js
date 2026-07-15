// celebracao.js — Confetti ao bater uma meta (lazy)
// ----------------------------------------------------------------------------
// QUANDO celebrar: `meta.saved` é alterado em 5 pontos diferentes (transação de
// reserva, aporte na tela de metas, rendimento diário, edição de valor, retirada).
// Em vez de instrumentar os 5, detectamos a TRAVESSIA dos 100% num único ponto —
// o render da lista — comparando com o que já foi celebrado (localStorage por
// usuário+perfil). Assim funciona para todos os caminhos, inclusive rendimento.
//
// Regras:
//   • Primeira vez no aparelho → só SEMEIA (não solta confetti para metas antigas).
//   • Meta que sai dos 100% (retirada) é removida da lista → recompletar celebra.
//   • Respeita prefers-reduced-motion (nada de animação).
//   • Sem lib: canvas próprio, ~1,4s, remove-se sozinho.
// ----------------------------------------------------------------------------

const CORES = ['#00ff99', '#ffd166', '#4ca6ff', '#ff6b9d', '#a78bfa'];

/** Regra pura — ids das metas que ACABARAM de completar. Exportada p/ teste. */
export function metasParaCelebrar(metas, jaCelebradas) {
    const done = new Set((Array.isArray(jaCelebradas) ? jaCelebradas : []).map(String));
    const out = [];
    for (const m of (metas || [])) {
        const objetivo = Number(m?.objetivo || 0);
        const saved    = Number(m?.saved || 0);
        if (!(objetivo > 0) || saved < objetivo) continue; // ainda não bateu
        const id = String(m.id);
        if (done.has(id)) continue;                        // já celebrada
        out.push(id);
    }
    return out;
}

/** Ids atualmente completos — usado p/ podar quem saiu dos 100% (retirada). */
export function metasCompletas(metas) {
    return (metas || [])
        .filter(m => Number(m?.objetivo || 0) > 0 && Number(m?.saved || 0) >= Number(m?.objetivo || 0))
        .map(m => String(m.id));
}

/** Confetti — canvas próprio, sem lib, some sozinho. */
export function dispararConfetti({ duracaoMs = 1500, particulas = 90 } = {}) {
    try {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    } catch { /* matchMedia indisponível — segue */ }

    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);

    const g = canvas.getContext('2d');
    if (!g) { canvas.remove(); return; }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.width  = Math.floor(window.innerWidth * dpr);
    const h = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width  = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';

    const ps = [];
    for (let i = 0; i < particulas; i++) {
        ps.push({
            x:   w / 2 + (Math.random() - .5) * w * .35,
            y:   h * .38 + (Math.random() - .5) * 40 * dpr,
            vx:  (Math.random() - .5) * 9 * dpr,
            vy:  (Math.random() * -7 - 3) * dpr,
            grav: .22 * dpr,
            s:   (4 + Math.random() * 5) * dpr,
            rot: Math.random() * Math.PI,
            vr:  (Math.random() - .5) * .3,
            cor: CORES[(Math.random() * CORES.length) | 0],
        });
    }

    const t0 = performance.now();
    let raf = 0;
    const tick = (t) => {
        const dt = t - t0;
        g.clearRect(0, 0, w, h);
        const alpha = Math.max(0, 1 - dt / duracaoMs);
        for (const p of ps) {
            p.vy += p.grav; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
            g.save();
            g.translate(p.x, p.y);
            g.rotate(p.rot);
            g.globalAlpha = alpha;
            g.fillStyle = p.cor;
            g.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6);
            g.restore();
        }
        if (dt < duracaoMs) { raf = requestAnimationFrame(tick); }
        else { cancelAnimationFrame(raf); canvas.remove(); }
    };
    raf = requestAnimationFrame(tick);
}

// ── Cola: estado por usuário+perfil (localStorage; não toca o save-path) ──────
function _chave(ctx) {
    const u = String(ctx?._effectiveUserId ?? 'anon').slice(0, 40);
    const p = ctx?.perfilAtivo;
    const pid = String((p && typeof p === 'object' ? (p.id ?? p.nome) : p) ?? 'x').slice(0, 40);
    return `ge:metasCelebradas:${u}:${pid}`;
}

/**
 * Chamado após render da lista de metas. Celebra o que acabou de bater 100%.
 * Idempotente: só dispara na TRAVESSIA.
 */
export function celebrarMetasConcluidas(ctx) {
    if (!ctx) return;
    const chave = _chave(ctx);

    let raw = null;
    try { raw = localStorage.getItem(chave); } catch { return; /* sem storage → não celebra */ }
    const primeiraVez = raw === null;

    let ja = [];
    try { ja = JSON.parse(raw || '[]'); } catch { ja = []; }
    if (!Array.isArray(ja)) ja = [];

    // Poda: quem não está mais completo (retirada) sai da lista → recompletar celebra.
    const completasAgora = new Set(metasCompletas(ctx.metas));
    const jaLimpo = ja.map(String).filter(id => completasAgora.has(id));

    const novas = metasParaCelebrar(ctx.metas, jaLimpo);

    // Persiste o estado (mesmo quando não celebra — é o que semeia/poda).
    try { localStorage.setItem(chave, JSON.stringify([...new Set([...jaLimpo, ...novas])])); }
    catch { /* modo privado */ }

    if (novas.length === 0) return;
    // Aparelho novo: semeia sem festejar metas que já estavam prontas.
    if (primeiraVez) return;

    dispararConfetti();
    ctx.mostrarNotificacao?.(
        novas.length === 1 ? 'Meta concluída! 🎉' : `${novas.length} metas concluídas! 🎉`,
        'success',
    );
}
