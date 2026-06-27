// ═══════════════════════════════════════════════════════════════════════════
// NAVEGAÇÃO POR SWIPE — gesto lateral fluido entre abas (mobile)
// ═══════════════════════════════════════════════════════════════════════════
//
// Filosofia: o gesto tem que ser DELIBERADO (não dispara num roçar de dedo) e a
// transição tem que ser FLUIDA (a página segue o dedo, com peso e elasticidade —
// nada de corte seco). Por isso:
//
//   1. Bloqueio de eixo: só assume o gesto se o movimento for claramente
//      horizontal (|dx| > |dy| * RATIO). Rolagem vertical nunca é sequestrada.
//   2. Limiar de commit: trocar de aba exige arrastar ≥ COMMIT_RATIO da largura
//      OU dar um "flick" rápido (velocidade ≥ FLICK_V). Arrastos curtos/casuais
//      voltam sozinhos (snap-back elástico) — resolve o "passei o dedo e trocou".
//   3. Borda elástica: nas pontas (1ª/última aba) o arrasto resiste em rubber
//      band e nunca comita — feedback tátil de "não tem mais aba aqui".
//   4. O commit em si (carrossel das duas páginas) é tocado pelo dashboard via
//      o callback swipeTo — transform puro na GPU, otimizado p/ aparelho fraco.
//
// Tudo gera só translate3d → composição na GPU, sem reflow durante o arrasto.

const ACTIVATE   = 12;     // px de movimento p/ decidir o eixo do gesto
const DIR_RATIO  = 1.25;   // |dx| precisa exceder |dy| * isto p/ travar horizontal
const COMMIT_RATIO = 0.30; // fração da largura p/ comitar por distância
const FLICK_V    = 0.5;    // px/ms — velocidade p/ comitar por "flick"
const FLICK_MIN  = 45;     // px mínimos de viagem p/ um flick valer
const SNAP_MS    = 300;    // duração do retorno elástico (snap-back)
const DRAG_FADE  = 0.18;   // quanto a página que sai esmaece no auge do arrasto

// Elementos/contextos onde o swipe NÃO deve nascer (precisam do gesto horizontal
// pra si, ou seriam atrapalhados por ele).
const BLOCK_SEL = [
    'input', 'textarea', 'select', '[contenteditable]', 'canvas',
    '[data-no-swipe]', '.no-swipe', '[role="slider"]', '.range-input',
].join(',');

let cfg = null;            // { order, getCurrent, swipeTo }
let mc  = null;            // #mainContent

// estado vivo do gesto
let startX = 0, startY = 0, lastX = 0, lastT = 0, vX = 0;
let axis = null;           // null → indeciso | 'h' | 'v'
let page = null;           // .page.active sendo arrastada
let idx = -1, hasPrev = false, hasNext = false;
let busy = false;          // commit em andamento → ignora novos gestos

const isEnabled = () => localStorage.getItem('ge_swipe_nav') === '1';

const mqMobile = window.matchMedia('(max-width: 768px)');

// Rubber band clássico (iOS): deslocamento que tende assintoticamente a um teto.
function rubber(d, w) {
    const c = w * 0.55;
    return (1 - 1 / (d / c + 1)) * c;
}

// Algum ancestral (até o #mainContent) é um scroller horizontal de verdade?
// Se for, é dele o gesto — não sequestramos.
function inHorizontalScroller(el) {
    while (el && el !== mc && el !== document.body) {
        if (el.scrollWidth > el.clientWidth + 4) {
            const ox = getComputedStyle(el).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
        }
        el = el.parentElement;
    }
    return false;
}

// Há um modal/painel/menu aberto sobrepondo a navegação?
function overlayAberto() {
    if (document.body.classList.contains('sidebar-open')) return true;
    const modal = document.getElementById('modalContainer');
    if (modal && modal.childElementCount > 0) return true;
    const sheet = document.getElementById('bottomSheetOverlay');
    if (sheet && sheet.classList.contains('active')) return true;
    const notif = document.getElementById('notificacoesPanel');
    if (notif && !notif.classList.contains('js-hidden') &&
        getComputedStyle(notif).display !== 'none') return true;
    return false;
}

function onStart(e) {
    if (busy || axis !== null) return;
    if (!isEnabled() || !mqMobile.matches) return;
    if (e.touches.length !== 1) return;

    const t = e.touches[0];
    const tgt = e.target;
    if (tgt && tgt.closest && tgt.closest(BLOCK_SEL)) return;
    if (inHorizontalScroller(tgt)) return;
    if (overlayAberto()) return;

    page = document.querySelector('.page.active');
    if (!page) return;

    idx = cfg.order.indexOf(cfg.getCurrent());
    hasPrev = idx > 0;
    hasNext = idx >= 0 && idx < cfg.order.length - 1;

    startX = lastX = t.clientX;
    startY = t.clientY;
    lastT  = performance.now();
    vX = 0;
    axis = null;
}

function beginDrag() {
    document.body.classList.add('ge-dragging');
    page.classList.add('ge-swipe-drag');
    page.style.transition = 'none';
}

function onMove(e) {
    if (!page || busy) return;

    const t  = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // Decide o eixo do gesto na primeira passada relevante.
    if (axis === null) {
        if (Math.abs(dx) < ACTIVATE && Math.abs(dy) < ACTIVATE) return;
        if (Math.abs(dx) > Math.abs(dy) * DIR_RATIO) {
            axis = 'h';
            beginDrag();
        } else {
            axis = 'v';          // é rolagem → solta o gesto, deixa o nativo rolar
            page = null;
            return;
        }
    }
    if (axis !== 'h') return;

    e.preventDefault();          // a partir daqui o gesto é nosso (trava scroll)

    const now = performance.now();
    const dt  = now - lastT;
    if (dt > 0) vX = (t.clientX - lastX) / dt;
    lastX = t.clientX;
    lastT = now;

    // Resistência elástica nas bordas (sem aba naquela direção).
    const goingNext = dx < 0;
    const blocked = (goingNext && !hasNext) || (!goingNext && !hasPrev);
    let x = dx;
    if (blocked) x = Math.sign(dx) * rubber(Math.abs(dx), window.innerWidth);

    const prog = Math.min(1, Math.abs(x) / window.innerWidth);
    page.style.transform = `translate3d(${x}px,0,0)`;
    page.style.opacity   = String(1 - prog * DRAG_FADE);
}

function snapBack() {
    const el = page;
    page = null; axis = null;
    document.body.classList.remove('ge-dragging');
    if (!el) return;

    el.style.transition = `transform ${SNAP_MS}ms cubic-bezier(0.22,1,0.36,1), opacity ${SNAP_MS}ms ease`;
    el.style.transform  = 'translate3d(0,0,0)';
    el.style.opacity    = '';

    let cleared = false;
    const clear = () => {
        if (cleared) return;
        cleared = true;
        el.removeEventListener('transitionend', clear);
        el.style.transition = '';
        el.style.transform  = '';
        el.classList.remove('ge-swipe-drag');
    };
    el.addEventListener('transitionend', clear);
    setTimeout(clear, SNAP_MS + 60);
}

function onEnd() {
    if (!page) { axis = null; return; }
    if (axis !== 'h') { page = null; axis = null; document.body.classList.remove('ge-dragging'); return; }

    const w  = window.innerWidth;
    const dx = lastX - startX;
    const goingNext = dx < 0;
    const blocked = (goingNext && !hasNext) || (!goingNext && !hasPrev);
    const dist = Math.abs(dx);

    const byDistance = dist >= w * COMMIT_RATIO;
    const byFlick    = Math.abs(vX) >= FLICK_V && dist >= FLICK_MIN;
    const commit = !blocked && (byDistance || byFlick);

    if (!commit) { snapBack(); return; }

    const target = cfg.order[goingNext ? idx + 1 : idx - 1];
    const sy = window.scrollY;
    const el = page;

    busy = true;
    page = null; axis = null;
    document.body.classList.remove('ge-dragging');
    el.classList.remove('ge-swipe-drag');
    el.style.opacity = '';

    if (window.hapticTap) window.hapticTap(8); // confirmação tátil sutil

    // O dashboard assume o carrossel a partir do deslocamento atual (continuidade).
    cfg.swipeTo(target, {
        dir: goingNext ? -1 : 1,
        dx,
        sy,
        vX,
        done: () => { busy = false; },
    });
}

function onCancel() {
    if (axis === 'h') snapBack();
    else { page = null; axis = null; document.body.classList.remove('ge-dragging'); }
}

export function initSwipeNav(config) {
    if (!config || typeof config.swipeTo !== 'function') return;
    mc = document.getElementById('mainContent');
    if (!mc) return;
    if (initSwipeNav._bound) return;   // idempotente
    initSwipeNav._bound = true;
    cfg = config;

    // touchstart/end passivos (não bloqueiam scroll); touchmove ativo p/ poder
    // chamar preventDefault assim que o gesto vira horizontal.
    mc.addEventListener('touchstart',  onStart,  { passive: true });
    mc.addEventListener('touchmove',   onMove,   { passive: false });
    mc.addEventListener('touchend',    onEnd,    { passive: true });
    mc.addEventListener('touchcancel', onCancel, { passive: true });
}
