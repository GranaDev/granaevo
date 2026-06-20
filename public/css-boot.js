// Tira o CSS pesado do caminho crítico de renderização — "streaming" estilo GTA:
// pinta o loader (CSS crítico inline) IMEDIATAMENTE e baixa o CSS completo em
// paralelo, aplicando-o assim que chega, sem bloquear o primeiro paint.
//
// Técnica: o <link> nasce com media="print" (baixado SEM bloquear render); quando
// termina de carregar, troca para media="all" e os estilos completos entram.
// Script clássico externo (não-module, sem handler inline) — compatível com a CSP
// do dashboard (script-src 'self').
(function () {
    try {
        var links = document.querySelectorAll('link[data-async-style]');
        for (var i = 0; i < links.length; i++) {
            (function (l) {
                // Já baixou antes do script rodar? Aplica de imediato.
                if (l.sheet) { l.media = 'all'; return; }
                l.addEventListener('load', function () { l.media = 'all'; }, { once: true });
            })(links[i]);
        }
    } catch (e) {}
}());
