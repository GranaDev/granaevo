// pwa-init.js — captura ANTECIPADA do beforeinstallprompt + registro cedo do SW.
// Carregado SEM defer no <head> (dashboard.html e assistente.html): em visitas
// repetidas o Chrome dispara o evento cedo; se o listener vier depois
// (defer/módulo), o prompt se perde e o botão de instalar não funciona.
// ATENÇÃO: dashboard.html referencia este arquivo com SRI (integrity=sha384).
// Ao editar, recalcular o hash e atualizar o <script> lá.
window.__pwaInstallPrompt = null;
window.__pwaPromptFired = false;
window.__pwaDiag = { t0: Date.now(), bipAt: 0, installedAt: 0, swErr: '' };
window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    window.__pwaPromptFired = true;
    window.__pwaDiag.bipAt = Date.now();
    document.dispatchEvent(new CustomEvent('ge:pwa-ready'));
});
window.addEventListener('appinstalled', function () {
    window.__pwaInstallPrompt = null;
    window.__pwaDiag.installedAt = Date.now();
    // Memória local (só deste aparelho) de que o ASSISTENTE foi instalado — o
    // dashboard usa pra mostrar "já instalado" nas Configurações. No dashboard
    // este evento é do app principal, por isso o guard de pathname.
    if (location.pathname.indexOf('/assistente') === 0) {
        try { localStorage.setItem('ge_assistant_installed', '1'); } catch (err) { /* */ }
    }
    document.dispatchEvent(new CustomEvent('ge:pwa-installed'));
});
// Na página do assistente, registra o SW próprio o MAIS CEDO possível (aqui no
// <head>, antes do módulo) para o beforeinstallprompt ficar elegível quanto antes.
// Guardado por pathname para não tocar em outras páginas que também usam este init.
if ('serviceWorker' in navigator && location.pathname.indexOf('/assistente') === 0) {
    navigator.serviceWorker.register('/assistant-sw.js', { scope: '/assistente' })
        .catch(function (e) { window.__pwaDiag.swErr = String((e && e.message) || e); });
}
