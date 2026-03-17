/**
 * recaptcha-init.js
 *
 * DEVE ser carregado como <script src="..."> NORMAL (sem type="module",
 * sem async, sem defer) e ANTES do <script src="api.js?onload=__grOnLoad">.
 *
 * Motivo: scripts type="module" são sempre diferidos pelo browser — eles
 * executam DEPOIS que o HTML foi parseado. O api.js com async pode terminar
 * de carregar e tentar chamar window.__grOnLoad antes do módulo login.js
 * ter executado, resultando em "window.__grOnLoad is not a function" e o
 * widget nunca sendo renderizado.
 *
 * Este arquivo é síncrono e executa imediatamente, garantindo que
 * __grOnLoad esteja disponível no momento em que o api.js precisar dele.
 */
window.__grOnLoad = function () {
    window.__grCaptchaReady = true;
    if (typeof window.__grPendingRender === 'function') {
        window.__grPendingRender();
        window.__grPendingRender = null;
    }
};