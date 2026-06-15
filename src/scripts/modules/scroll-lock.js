/**
 * scroll-lock.js — Trava a rolagem da página enquanto qualquer pop-up,
 * comprovante, modal, bottom sheet ou painel estiver aberto.
 *
 * Abordagem centralizada: em vez de alterar cada ponto de
 * abertura/fechamento espalhado pelo app, este módulo observa o DOM
 * (MutationObserver) e, sempre que algum overlay conhecido fica visível,
 * trava o <body>. Quando o último overlay fecha, destrava e restaura a
 * posição de rolagem exata em que o usuário estava.
 *
 * Técnica de trava: position:fixed no <body>. Diferente de apenas
 * `overflow:hidden`, ela também impede o "momentum scroll" do iOS Safari
 * por trás do pop-up — comportamento esperado em PWA mobile.
 *
 * Para cobrir um novo tipo de overlay, basta adicionar o seletor que
 * representa o seu estado ABERTO em OVERLAY_SELECTORS.
 */

// Cada seletor representa um overlay no seu estado ABERTO/VISÍVEL.
const OVERLAY_SELECTORS = [
    '#modalOverlay.active',              // pop-ups e comprovantes (criarPopup)
    '#bottomSheetOverlay.active',        // bottom sheet (mobile)
    '#notificacoesPanel:not(.js-hidden)',// painel de notificações
    '.modal-overlay.active',             // qualquer outro modal-overlay genérico
    '.obw-overlay',                      // boas-vindas (onboarding)
    '.tut-card',                         // tutorial guiado
    '#pwaInstructionsModal',             // instruções de instalação PWA
    '#planModalOverlay',                 // modal de plano / comprovante (atualizarplano)
];

let _locked   = false;
let _scrollY  = 0;
let _rafToken = 0;

/** Verdadeiro se o elemento está realmente renderizado (cobre display:none). */
function _visivel(el) {
    return !!(el && el.getClientRects().length);
}

/** Existe algum overlay aberto no momento? */
function _algumOverlayAberto() {
    for (const sel of OVERLAY_SELECTORS) {
        if (_visivel(document.querySelector(sel))) return true;
    }
    return false;
}

function _travar() {
    if (_locked) return;
    _locked  = true;
    _scrollY = window.scrollY || window.pageYOffset || 0;

    const body = document.body;
    body.style.top      = `-${_scrollY}px`;
    body.style.position = 'fixed';
    body.style.left     = '0';
    body.style.right    = '0';
    body.style.width    = '100%';
    body.classList.add('scroll-locked');
}

function _destravar() {
    if (!_locked) return;
    _locked = false;

    const body = document.body;
    body.style.position = '';
    body.style.top      = '';
    body.style.left     = '';
    body.style.right    = '';
    body.style.width    = '';
    body.classList.remove('scroll-locked');

    // Restaura a posição exata em que o usuário estava antes da trava.
    window.scrollTo(0, _scrollY);
}

/** Recalcula o estado da trava (coalescido em 1x por frame). */
function _reavaliar() {
    if (_rafToken) return;
    _rafToken = requestAnimationFrame(() => {
        _rafToken = 0;
        if (_algumOverlayAberto()) _travar();
        else                       _destravar();
    });
}

function init() {
    if (window.__scrollLockAtivo) return; // idempotente por página
    window.__scrollLockAtivo = true;

    const observer = new MutationObserver(_reavaliar);
    observer.observe(document.body, {
        subtree: true,
        childList: true,          // overlays adicionados/removidos do DOM
        attributes: true,
        attributeFilter: ['class', 'style'], // .active / .js-hidden / display
    });

    // Avalia o estado inicial (caso algo já esteja aberto no load).
    _reavaliar();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

export { init };
