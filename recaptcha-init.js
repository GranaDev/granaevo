/**
 * recaptcha-init.js — v7
 * Script síncrono, sem module, sem async/defer.
 * Apenas expõe __grOnLoad para o api.js chamar quando pronto.
 */
window.__grOnLoad = function () {
    window.__grCaptchaReady = true;
    // Com auto-render, o widget já foi criado pelo Google.
    // Nada a fazer aqui exceto sinalizar que a API está pronta.
};