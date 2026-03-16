/**
 * recaptcha-bridge.js
 *
 * DEVE ser carregado como script SÍNCRONO (sem async, sem defer, sem type="module")
 * ANTES do script do reCAPTCHA api.js no HTML.
 *
 * Motivo: login.js usa type="module", que é SEMPRE deferido pelo browser.
 * O reCAPTCHA usa async e pode chamar window._grOnLoad ANTES do módulo
 * ser avaliado. Este arquivo garante que _grOnLoad exista no momento certo.
 *
 * Flags expostas globalmente (lidas por login.js):
 *   window.__grCaptchaReady    {boolean}   true quando grecaptcha está pronto
 *   window.__grPendingRender   {Function|null}  callback registrado pelo login.js
 */
(function () {
    // Garante que as flags existam mesmo antes de login.js carregar
    window.__grCaptchaReady  = false;
    window.__grPendingRender = null;

    window._grOnLoad = function () {
        window.__grCaptchaReady = true;

        // Se login.js já registrou um callback pendente, executa agora
        if (typeof window.__grPendingRender === 'function') {
            var fn = window.__grPendingRender;
            window.__grPendingRender = null;
            fn();
        }
    };
}());