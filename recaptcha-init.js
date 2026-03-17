// ═══════════════════════════════════════════════════════════════
//  recaptcha-init.js — v6
//
//  ESTE ARQUIVO DEVE SER CARREGADO ANTES DO api.js DO GOOGLE,
//  SEM async NEM defer. Exemplo correto no HTML:
//
//    <script src="recaptcha-init.js?v=6"></script>
//    <script src="https://www.google.com/recaptcha/api.js?render=explicit&onload=__grOnLoad" async defer></script>
//
//  MOTIVO: login.js é type="module" — módulos são sempre diferidos
//  (executam após o parsing do HTML). O api.js com async pode
//  terminar de carregar antes do módulo executar e tentar chamar
//  window.__grOnLoad antes de ele existir. Este script síncrono
//  garante que __grOnLoad esteja disponível no exato momento em
//  que o api.js precisar.
//
//  FLUXO GARANTIDO:
//    1. recaptcha-init.js executa ANTES de tudo → __grOnLoad disponível
//    2. api.js carrega em background (async defer)
//    3. login.js (module) carrega → configura _renderCaptchaWidget
//    4. Usuário erra 3x → showCaptcha() → container fica visível
//    5a. Se API já carregou → __grCaptchaReady=true → render imediato
//    5b. Se API ainda carrega → __grPendingRender fica registrado
//    6. api.js termina → __grOnLoad dispara → executa __grPendingRender
// ═══════════════════════════════════════════════════════════════

window.__grCaptchaReady  = false;
window.__grPendingRender = null;

window.__grOnLoad = function () {
    window.__grCaptchaReady = true;

    // Executa o render pendente se existir (registrado em _renderCaptchaWidget
    // quando a API ainda não tinha carregado no momento da chamada)
    if (typeof window.__grPendingRender === 'function') {
        var fn = window.__grPendingRender;
        window.__grPendingRender = null;
        fn();
    }
};