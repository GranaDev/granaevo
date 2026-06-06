// Aplica tema salvo antes do primeiro render — evita flash de tema errado.
// Script clássico (não-module) executado sincronamente no head.
(function () {
    try {
        var t = localStorage.getItem('ge_theme');
        if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    } catch (e) {}
}());
