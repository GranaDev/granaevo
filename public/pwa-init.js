window.__pwaInstallPrompt = null;
window.__pwaPromptFired = false;
window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    window.__pwaPromptFired = true;
    document.dispatchEvent(new CustomEvent('ge:pwa-ready'));
});
window.addEventListener('appinstalled', function() {
    window.__pwaInstallPrompt = null;
    document.dispatchEvent(new CustomEvent('ge:pwa-installed'));
});
// Na página do assistente, registra o SW próprio o MAIS CEDO possível (aqui no
// <head>, antes do módulo) para o beforeinstallprompt ficar elegível quanto antes.
// Guardado por pathname para não tocar em outras páginas que também usam este init.
if ('serviceWorker' in navigator && location.pathname.indexOf('/assistente') === 0) {
    navigator.serviceWorker.register('/assistant-sw.js', { scope: '/assistente' }).catch(function () {});
}
