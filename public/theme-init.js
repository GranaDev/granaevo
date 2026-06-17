// Aplica tema salvo antes do primeiro render — evita flash de tema errado.
// Script clássico (não-module) executado sincronamente no head.
//
// Quando o tema é CLARO, injeta o CSS do tema claro on-demand (URL vinda do
// data-light-css da própria tag <script>). Assim os ~37 KB do tema claro saem
// do caminho crítico de quem usa o tema escuro (a maioria), sem FOUC para quem
// usa o claro — o <link> é adicionado síncrono no <head> antes do <body>.
(function () {
    try {
        var t = localStorage.getItem('ge_theme');
        if (t !== 'light') return;
        document.documentElement.setAttribute('data-theme', 'light');

        var href = document.currentScript && document.currentScript.dataset.lightCss;
        if (!href) return; // página sem tema claro dedicado
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        document.head.appendChild(l);
    } catch (e) {}
}());
