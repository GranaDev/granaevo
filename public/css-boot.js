// Tira o CSS pesado do caminho crítico de renderização — "streaming" estilo GTA:
// pinta o loader (CSS crítico inline) IMEDIATAMENTE e baixa o CSS completo em
// paralelo, aplicando-o assim que chega, sem bloquear o primeiro paint.
//
// Técnica: o <link> nasce com media="print" (baixado SEM bloquear render); quando
// termina de carregar, troca para media="all" e os estilos completos entram.
// Script clássico externo (não-module, sem handler inline) — compatível com a CSP
// do dashboard (script-src 'self').
//
// ROBUSTEZ: o evento "load" de um stylesheet media="print" NEM SEMPRE dispara
// (varia por navegador) — se confiarmos só nele, o CSS pode nunca ser aplicado e
// a página fica SEM estilo. Por isso há rede de segurança: também aplicamos no
// evento "error", no window.load e num timeout. media="all" é idempotente.
(function () {
    function flip(l) { try { l.media = 'all'; } catch (e) {} }

    function flipAll() {
        var links = document.querySelectorAll('link[data-async-style]');
        for (var i = 0; i < links.length; i++) flip(links[i]);
    }

    try {
        var links = document.querySelectorAll('link[data-async-style]');
        for (var i = 0; i < links.length; i++) {
            (function (l) {
                if (l.sheet) { flip(l); return; }            // já baixou antes do script rodar
                l.addEventListener('load',  function () { flip(l); }, { once: true });
                l.addEventListener('error', function () { flip(l); }, { once: true }); // aplica mesmo se falhar
            })(links[i]);
        }

        // Redes de segurança: garantem que o CSS seja aplicado mesmo se "load" não
        // disparar. window.load já espera os stylesheets terminarem; o timeout é
        // um backstop final.
        window.addEventListener('load', flipAll, { once: true });
        setTimeout(flipAll, 2000);
    } catch (e) {
        flipAll(); // em qualquer falha, aplica o CSS para não deixar a página sem estilo
    }
}());
