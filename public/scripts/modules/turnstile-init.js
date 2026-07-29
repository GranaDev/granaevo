// ═══════════════════════════════════════════════════════════════
//  turnstile-init.js — substitui o recaptcha-init.js (B-2, 2026-07-27)
//
//  ESTE ARQUIVO DEVE SER CARREGADO ANTES do api.js da Cloudflare,
//  SEM async NEM defer:
//
//    <script src="/scripts/modules/turnstile-init.js"></script>
//    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsOnLoad" async defer></script>
//
//  MOTIVO (o mesmo do reCAPTCHA): login.js é type="module" e módulos são
//  sempre diferidos. O api.js com async pode terminar de carregar ANTES do
//  módulo executar e chamar window.__tsOnLoad quando ele ainda não existe.
//  Este script síncrono garante que o callback esteja lá no momento exato.
//
//  FLUXO:
//    1. turnstile-init.js executa primeiro → __tsOnLoad disponível
//    2. api.js carrega em background (async defer)
//    3. login.js configura o render
//    4. o servidor exige o desafio → o container aparece
//    5a. API já carregada → render imediato
//    5b. API ainda carregando → o render fica pendente e dispara no onload
//
//  POR QUE TURNSTILE E NÃO reCAPTCHA (a troca de 2026-07-27):
//    • Tira o Google do caminho de um produto que se vende por privacidade —
//      a tela de login carregava rastreador de terceiro.
//    • O desafio é quase sempre invisível: menos atrito no caminho crítico.
//    • Some do CSP: script-src, connect-src e frame-src perdem 5 domínios do
//      Google e ganham 1 da Cloudflare, que já é o proxy do site.
//
//  Os nomes globais mudaram de __gr* para __ts* de propósito: se sobrar
//  alguma referência antiga em algum lugar, ela quebra alto em vez de
//  silenciosamente nunca renderizar.
// ═══════════════════════════════════════════════════════════════

window.__tsCaptchaReady  = false;
window.__tsPendingRender = null;

window.__tsOnLoad = function () {
    window.__tsCaptchaReady = true;

    if (typeof window.__tsPendingRender === 'function') {
        var fn = window.__tsPendingRender;
        window.__tsPendingRender = null;
        fn();
    }
};
