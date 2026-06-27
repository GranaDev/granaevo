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
//   4. O commit em si (carrossel das duas páginas) é tocado por commitSlide aqui
//      mesmo (transform puro na GPU, otimizado p/ aparelho fraco). O dashboard só
//      fornece os primitivos (carregar módulo, destacar nav, setar aba ativa).
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

let cfg = null;            // { order, getCurrent, setCurrent, navigate, loadModule, setNavActive }
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

    // Carrossel a partir do deslocamento atual (continuidade com o arrasto).
    commitSlide(el, target, {
        dir: goingNext ? -1 : 1,
        dx,
        sy,
        vX,
        done: () => { busy = false; },
    });
}

// ───────────────────────────────────────────────────────────────────────────
// TRANSIÇÃO LATERAL (commit) — o "carrossel" das duas páginas
// ───────────────────────────────────────────────────────────────────────────
// A aba que sai desliza pro lado e a que entra vem da borda oposta, ambas
// movidas SÓ por transform (composição na GPU, zero reflow). O conteúdo do alvo
// é carregado ANTES do slide, então já desliza preenchido (ou com skeleton no
// 1º acesso). Vive aqui (módulo lazy, mobile-only) p/ não pesar o dashboard.js.
//
//   dir: -1 → próxima aba (dedo p/ esquerda, trilho vai p/ -vw)
//        +1 → aba anterior (dedo p/ direita, trilho vai p/ +vw)
//   dx : deslocamento horizontal no fim do arrasto (continuidade)
//   sy : scrollY no commit (compensa a página que sai p/ ela não pular)
function commitSlide(fromPage, target, opts) {
    const { dir, dx, sy, vX, done } = opts;
    const finish = () => { try { done && done(); } catch (_) { /* noop */ } };
    const toPage = document.getElementById(target + 'Page');

    // Fallbacks: alvo inexistente ou movimento reduzido → troca seca canônica.
    if (!fromPage || !toPage || fromPage === toPage) {
        if (fromPage) { fromPage.style.transform = ''; fromPage.style.opacity = ''; }
        cfg.navigate(target);
        finish();
        return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        fromPage.style.transform = '';
        fromPage.style.opacity   = '';
        cfg.navigate(target);
        finish();
        return;
    }

    const w    = window.innerWidth;
    const next = dir < 0;
    const trackEnd = next ? -w : w;          // posição final do "trilho"
    const toStart  = next ? dx + w : dx - w; // onde a aba que entra começa

    // Mede o frame de conteúdo (independe de padding/breakpoint) p/ sobrepor as
    // duas páginas exatamente onde o fluxo normal as colocaria.
    const cs   = getComputedStyle(mc);
    const padL = parseFloat(cs.paddingLeft)  || 0;
    const padT = parseFloat(cs.paddingTop)   || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const cw   = mc.clientWidth - padL - padR;
    const fromH = fromPage.offsetHeight;

    document.body.classList.add('ge-swiping');
    mc.style.minHeight = fromH + 'px';   // evita colapso enquanto as páginas são absolutas

    cfg.loadModule(target);              // conteúdo do alvo carrega/atualiza ANTES do slide

    const pages = [fromPage, toPage];
    pages.forEach(p => {
        p.classList.add('ge-swipe-page');
        p.style.left  = padL + 'px';
        p.style.top   = padT + 'px';
        p.style.width = cw + 'px';
        p.style.transition = 'none';
    });
    toPage.style.display = 'block';

    // Alinha: zera o scroll (a aba que entra começa no topo) e compensa
    // verticalmente a aba que sai p/ ela não "pular" pro topo ao sair.
    window.scrollTo({ top: 0, behavior: 'instant' });
    fromPage.style.transform = `translate3d(${dx}px, ${-sy}px, 0)`;
    toPage.style.transform   = `translate3d(${toStart}px, 0, 0)`;
    fromPage.style.opacity   = '';

    void toPage.offsetWidth; // força reflow → estado inicial firme antes da transição

    const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';        // easeOutExpo — glide premium
    const dur  = Math.abs(vX) > 0.9 ? 260 : 340;          // flick forte → mais rápido

    let ended = false;
    const finalize = () => {
        if (ended) return;
        ended = true;
        toPage.removeEventListener('transitionend', onSlideEnd);

        // Estado canônico (sem reload — módulo já carregado acima).
        document.querySelectorAll('.page').forEach(p => {
            p.classList.remove('active');
            p.style.display = 'none';
        });
        toPage.style.display = 'block';
        toPage.classList.add('active');   // ge-swiping ainda ativo → pageEnter suprimido
        cfg.setNavActive(target);
        cfg.setCurrent(target);

        pages.forEach(p => {
            p.classList.remove('ge-swipe-page');
            p.style.transition = '';
            p.style.transform  = '';
            p.style.left = ''; p.style.top = ''; p.style.width = ''; p.style.opacity = '';
        });
        mc.style.minHeight = '';
        document.body.classList.remove('ge-swiping');
        finish();
    };
    const onSlideEnd = (ev) => {
        if (ev.target === toPage && ev.propertyName === 'transform') finalize();
    };
    toPage.addEventListener('transitionend', onSlideEnd);
    setTimeout(finalize, dur + 80);   // rede de segurança se o transitionend não disparar

    requestAnimationFrame(() => {
        fromPage.style.transition = `transform ${dur}ms ${ease}`;
        toPage.style.transition   = `transform ${dur}ms ${ease}`;
        fromPage.style.transform  = `translate3d(${trackEnd}px, ${-sy}px, 0)`;
        toPage.style.transform    = `translate3d(0px, 0px, 0)`;
    });
}

function onCancel() {
    if (axis === 'h') snapBack();
    else { page = null; axis = null; document.body.classList.remove('ge-dragging'); }
}

export function initSwipeNav(config) {
    if (!config || typeof config.navigate !== 'function' ||
        typeof config.loadModule !== 'function' || typeof config.setNavActive !== 'function' ||
        typeof config.setCurrent !== 'function') return;
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
