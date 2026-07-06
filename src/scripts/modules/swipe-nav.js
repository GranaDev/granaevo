// ═══════════════════════════════════════════════════════════════════════════
// NAVEGAÇÃO POR SWIPE — carrossel lateral fluido entre abas (mobile)
// ═══════════════════════════════════════════════════════════════════════════
//
// Objetivo: sensação de carrossel real, sem vazio e sem travada.
//
//   • Carrossel de verdade: assim que o arrasto vira horizontal, a aba vizinha
//     é montada na BORDA da tela e arrastada JUNTO com o dedo. O usuário já vê a
//     próxima aba entrando — nada de espaço preto vazio.
//   • Zero travada no commit: o conteúdo da aba vizinha é carregado AINDA durante
//     o arrasto (pré-load). Quando o gesto confirma, é só um "assentar" de
//     transform — nada carrega, nada pisca, sem o flash de título do menu.
//   • Gesto deliberado: trocar exige arrastar ≥ COMMIT_RATIO da largura OU um
//     flick rápido. Arrastos casuais voltam com snap elástico. Rolagem vertical
//     nunca é sequestrada (bloqueio de eixo).
//
// Arquitetura do carrossel (evita o pulo de scroll de páginas longas):
//   • Página ATUAL → continua no fluxo normal (preserva o scroll), movida só por
//     transform translateX.
//   • Página que ENTRA → position:fixed ancorada à viewport, no frame de conteúdo
//     (entre topbar e bottom-nav). Mostra o próprio topo, como um tab novo deve.
//   Ambas movem-se apenas por translate3d → composição na GPU, sem reflow.

const ACTIVATE     = 12;    // px de movimento p/ decidir o eixo do gesto
const DIR_RATIO    = 1.25;  // |dx| precisa exceder |dy| * isto p/ travar horizontal
const COMMIT_RATIO = 0.28;  // fração da largura p/ comitar por distância
const FLICK_V      = 0.45;  // px/ms — velocidade p/ comitar por "flick"
const FLICK_MIN    = 40;    // px mínimos de viagem p/ um flick valer
const COMMIT_MS    = 320;   // duração do "assentar" no commit
const SNAP_MS      = 300;   // duração do retorno elástico (snap-back)
const EASE_OUT     = 'cubic-bezier(0.22, 1, 0.36, 1)';  // glide premium (easeOutQuint)

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
let active = false;        // gesto horizontal em curso
let busy = false;          // animação de commit/snap em curso → ignora novos gestos
let W = 0;                 // largura da viewport no início do gesto

let curPage = null;        // .page.active (fica no fluxo)
let idx = -1;              // índice da aba atual em cfg.order
let frame = null;          // { top, left, width, height } do frame de conteúdo

// aba vizinha montada (a que entra)
let inPage = null;         // elemento da aba que entra
let inTela = null;         // nome da aba que entra
let inDir  = null;         // 'next' | 'prev'
let inEdge = 0;            // posição inicial (off-screen) da aba que entra: +W | -W
let inLoaded = false;      // o conteúdo da vizinha já foi (re)carregado?
let loadTimer = 0;         // timer que adia o loadModule p/ fora do 1º frame do arrasto

const isEnabled = () => localStorage.getItem('ge_swipe_nav') === '1';
const mqMobile  = window.matchMedia('(max-width: 768px)');

// Rubber band clássico (iOS): deslocamento que tende assintoticamente a um teto.
function rubber(d, w) {
    const c = w * 0.55;
    return (1 - 1 / (d / c + 1)) * c;
}

// Algum ancestral (até o #mainContent) é um scroller horizontal de verdade?
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

// Frame de conteúdo (entre topbar e bottom-nav), medido do padding do mainContent
// → fiel a qualquer breakpoint, sem hardcode.
function measureFrame() {
    const cs   = getComputedStyle(mc);
    const padL = parseFloat(cs.paddingLeft)  || 0;
    const padT = parseFloat(cs.paddingTop)   || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    return {
        top:    padT,
        left:   padL,
        width:  mc.clientWidth - padL - padR,
        height: window.innerHeight - padT,
    };
}

// Monta a aba vizinha na direção pedida (off-screen, ancorada à viewport) e já
// dispara o carregamento do conteúdo. Retorna false se não há aba nessa direção.
function mountIncoming(dir) {
    const targetIdx = dir === 'next' ? idx + 1 : idx - 1;
    if (targetIdx < 0 || targetIdx >= cfg.order.length) return false;

    const tela = cfg.order[targetIdx];
    const el = document.getElementById(tela + 'Page');
    if (!el || el === curPage) return false;

    inEdge = dir === 'next' ? W : -W;
    el.classList.add('ge-swipe-incoming');
    el.style.top    = frame.top + 'px';
    el.style.left   = frame.left + 'px';
    el.style.width  = frame.width + 'px';
    el.style.height = frame.height + 'px';
    el.style.transition = 'none';
    el.style.transform  = `translate3d(${inEdge}px,0,0)`;
    el.style.display = 'block';

    inPage = el; inTela = tela; inDir = dir;
    inLoaded = false;

    // A aba já visitada mostra na hora o conteúdo que está no DOM (display:block).
    // O (re)carregar — que pode ser uma renderização SÍNCRONA pesada (lista,
    // cartões) — é ADIADO p/ DEPOIS dos primeiros frames do arrasto. Senão essa
    // renderização trava o dedo logo no começo (a sensação de "duro"/lento). O
    // conteúdo ainda chega muito antes do commit. Fallback no settle cobre flicks
    // ultrarrápidos que confirmam antes do timer disparar.
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
        if (inPage === el && inTela === tela) { cfg.loadModule(tela); inLoaded = true; }
    }, 90);
    return true;
}

// Desmonta a aba vizinha (volta a ficar oculta e no estado normal).
function unmountIncoming() {
    clearTimeout(loadTimer);
    if (!inPage) return;
    inPage.classList.remove('ge-swipe-incoming');
    inPage.style.transition = '';
    inPage.style.transform  = '';
    inPage.style.top = ''; inPage.style.left = '';
    inPage.style.width = ''; inPage.style.height = '';
    inPage.style.display = 'none';
    inPage = null; inTela = null; inDir = null; inLoaded = false;
}

// Posiciona o "trilho" (atual + vizinha) durante o arrasto.
function setTrack(dx) {
    curPage.style.transform = `translate3d(${dx}px,0,0)`;
    if (inPage) inPage.style.transform = `translate3d(${inEdge + dx}px,0,0)`;
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

    curPage = document.querySelector('.page.active');
    if (!curPage) return;

    idx = cfg.order.indexOf(cfg.getCurrent());
    if (idx < 0) { curPage = null; return; }   // aba fora do carrossel (ex.: configurações)

    startX = lastX = t.clientX;
    startY = t.clientY;
    lastT  = performance.now();
    vX = 0;
    axis = null;
    active = false;
}

function beginGesture() {
    active = true;
    W = window.innerWidth;
    frame = measureFrame();
    document.body.classList.add('ge-dragging');
    curPage.classList.add('ge-swipe-current');
    curPage.style.transition = 'none';
}

function onMove(e) {
    if (!curPage || busy) return;

    const t  = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // Decide o eixo do gesto na primeira passada relevante.
    if (axis === null) {
        if (Math.abs(dx) < ACTIVATE && Math.abs(dy) < ACTIVATE) return;
        if (Math.abs(dx) > Math.abs(dy) * DIR_RATIO) { axis = 'h'; beginGesture(); }
        else { axis = 'v'; curPage = null; return; }  // rolagem → solta o gesto
    }
    if (axis !== 'h') return;

    e.preventDefault();  // a partir daqui o gesto é nosso (trava o scroll)

    const now = performance.now();
    const dt  = now - lastT;
    if (dt > 0) vX = (t.clientX - lastX) / dt;
    lastX = t.clientX;
    lastT = now;

    // Direção desejada conforme o sentido do arrasto. Monta/troca a vizinha.
    const wantDir = dx < 0 ? 'next' : 'prev';
    if (inDir !== wantDir) {
        unmountIncoming();
        mountIncoming(wantDir);
    }

    if (inPage) {
        // Carrossel 1:1 (clampa p/ a vizinha não passar do lugar).
        const clamped = inDir === 'next' ? Math.max(dx, -W) : Math.min(dx, W);
        setTrack(clamped);
    } else {
        // Borda (sem aba nessa direção) → resistência elástica só na página atual.
        curPage.style.transform = `translate3d(${Math.sign(dx) * rubber(Math.abs(dx), W)}px,0,0)`;
    }
}

// Anima o trilho até o destino (commit) ou de volta (snap) e finaliza.
function settle(commit) {
    busy = true;
    // Captura local da página atual: `curPage` é de módulo e é zerado ao fim do
    // done(); se um segundo settle/cancel disparar durante a animação, o done()
    // desta chamada ainda precisa de uma referência válida (senão null.removeEL…).
    const el = curPage;
    const goingNext = inDir === 'next';

    // Posições finais: no commit a vizinha vai a 0 e a atual sai por -inEdge;
    // no snap a atual volta a 0 e a vizinha volta à borda.
    const curEnd = commit ? -inEdge : 0;
    const inEnd  = commit ? 0 : inEdge;
    const tela   = inTela;

    let ended = false;
    const done = () => {
        if (ended) return;
        ended = true;
        if (el) el.removeEventListener('transitionend', onSettleEnd);

        if (commit) {
            // A vizinha vira a aba ativa — sem pageEnter (não tem .ge-page-enter,
            // então não pisca). Scroll vai ao topo, como um tab novo.
            clearTimeout(loadTimer);
            window.scrollTo({ top: 0, behavior: 'instant' });

            document.querySelectorAll('.page').forEach(p => {
                p.classList.remove('active', 'ge-page-enter');
                if (p !== inPage) p.style.display = 'none';
            });

            // Limpa a vizinha (sai do fixed, volta ao fluxo) e ativa — SEM
            // ge-page-enter, então não dispara o pageEnter (sem piscada).
            inPage.classList.remove('ge-swipe-incoming');
            inPage.style.transition = '';
            inPage.style.transform  = '';
            inPage.style.top = ''; inPage.style.left = '';
            inPage.style.width = ''; inPage.style.height = '';
            inPage.style.display = 'block';
            inPage.classList.add('active');

            cfg.setNavActive(tela);
            cfg.setCurrent(tela);

            // Fallback: flick confirmou antes do timer de pré-load disparar →
            // carrega agora (página já assentada e estática, sem jank de animação).
            if (!inLoaded) cfg.loadModule(tela);

            inPage = null; inTela = null; inDir = null; inLoaded = false;
        } else {
            unmountIncoming();   // volta tudo; a atual nunca saiu do fluxo
        }

        // Limpa a página atual (que saiu, no commit; ou que voltou, no snap).
        if (el) {
            el.classList.remove('ge-swipe-current');
            el.style.transition = '';
            el.style.transform  = '';
            el.style.display = commit ? 'none' : '';
        }

        document.body.classList.remove('ge-dragging', 'ge-swiping');
        curPage = null; axis = null; active = false;
        busy = false;
    };

    const onSettleEnd = (ev) => {
        if (ev.target === el && ev.propertyName === 'transform') done();
    };

    const dur = (commit && Math.abs(vX) > 0.9) ? 260 : (commit ? COMMIT_MS : SNAP_MS);
    document.body.classList.add('ge-swiping');

    if (el) el.addEventListener('transitionend', onSettleEnd);
    setTimeout(done, dur + 80);   // rede de segurança

    requestAnimationFrame(() => {
        if (el) {
            el.style.transition = `transform ${dur}ms ${EASE_OUT}`;
            el.style.transform  = `translate3d(${curEnd}px,0,0)`;
        }
        if (inPage) {
            inPage.style.transition = `transform ${dur}ms ${EASE_OUT}`;
            inPage.style.transform  = `translate3d(${inEnd}px,0,0)`;
        }
    });
}

// Snap-back simples quando não há vizinha (borda) — só a página atual volta.
function snapBackEdge() {
    busy = true;
    const el = curPage;
    let ended = false;
    const done = () => {
        if (ended) return;
        ended = true;
        el.removeEventListener('transitionend', done);
        el.classList.remove('ge-swipe-current');
        el.style.transition = '';
        el.style.transform  = '';
        document.body.classList.remove('ge-dragging', 'ge-swiping');
        curPage = null; axis = null; active = false; busy = false;
    };
    document.body.classList.add('ge-swiping');
    el.addEventListener('transitionend', done);
    setTimeout(done, SNAP_MS + 60);
    requestAnimationFrame(() => {
        el.style.transition = `transform ${SNAP_MS}ms ${EASE_OUT}`;
        el.style.transform  = 'translate3d(0,0,0)';
    });
}

function onEnd() {
    if (busy) return;   // animação de commit/snap em curso → não reentra num 2º settle
    if (!curPage || axis !== 'h' || !active) {
        // Gesto nunca virou horizontal (tap/scroll) → limpa estado leve.
        if (axis !== 'h') { curPage = null; axis = null; active = false; }
        return;
    }

    const dx = lastX - startX;
    const dist = Math.abs(dx);
    const byDistance = dist >= W * COMMIT_RATIO;
    const byFlick    = Math.abs(vX) >= FLICK_V && dist >= FLICK_MIN;

    if (inPage && (byDistance || byFlick)) {
        if (window.hapticTap) window.hapticTap(8);  // confirmação tátil sutil
        settle(true);                                // commit → desliza p/ a vizinha
    } else if (inPage) {
        settle(false);                               // volta p/ a aba atual
    } else {
        snapBackEdge();                              // borda → só recolhe a atual
    }
}

function onCancel() {
    if (busy) return;   // já assentando → deixa a animação em curso terminar sozinha
    if (!curPage) return;
    if (active && inPage) settle(false);
    else if (active) snapBackEdge();
    else { curPage = null; axis = null; active = false; }
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
