window.__pwaInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    document.dispatchEvent(new CustomEvent('ge:pwa-ready'));
});
window.addEventListener('appinstalled', function() {
    window.__pwaInstallPrompt = null;
    document.dispatchEvent(new CustomEvent('ge:pwa-installed'));
});
