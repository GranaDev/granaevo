// db-graficos.js — Seção de Gráficos (lazy-loaded)
let _ctx = null;

export function init(ctx) {
    _ctx = ctx;
    window._dbGraficos = { inicializarGraficos };
    window.atualizarGraficos = () => atualizarGraficos();
    window.exportarGraficos  = () => exportarGraficos();
    inicializarGraficos();
}

// ========== GRÁFICOS - DELEGA PARA graficos.js ==========
// graficos.js é carregado no HTML e inicializa via DOMContentLoaded.
// Aqui apenas garantimos que Chart.js (CDN ~500KB) esteja disponível
// antes de o usuário tentar gerar gráficos.
// _chartJsCarregado, _chartJsCarregando, _CHARTJS_SRC e _CHARTJS_INTEGRITY
// são estado/constantes de dashboard.js, acessíveis via _ctx.

function inicializarGraficos() {
    // Se Chart.js já está disponível (carregado em sessão anterior ou pelo HTML), nada a fazer.
    if (typeof Chart !== 'undefined') {
        _ctx._chartJsCarregado = true;
        return;
    }

    if (_ctx._chartJsCarregado || _ctx._chartJsCarregando) return;

    _ctx._chartJsCarregando = true;

    const chartScript          = document.createElement('script');
    chartScript.src            = _ctx._CHARTJS_SRC;
    chartScript.integrity      = _ctx._CHARTJS_INTEGRITY;
    chartScript.crossOrigin    = 'anonymous';
    chartScript.referrerPolicy = 'no-referrer';

    chartScript.onload = () => {
        _ctx._chartJsCarregado  = true;
        _ctx._chartJsCarregando = false;
    };

    chartScript.onerror = () => {
        _ctx._chartJsCarregando = false;
        _ctx.mostrarNotificacao('Erro ao carregar Chart.js. Verifique a conexão e tente novamente.', 'error');
    };

    document.head.appendChild(chartScript);
}

function atualizarGraficos() {
    if (typeof gerarGraficos === 'function') {
        gerarGraficos();
    } else {
        _ctx.mostrarNotificacao('Módulo de gráficos não carregado.', 'error');
    }
}

function exportarGraficos() {
    _ctx.mostrarNotificacao('Use o botão de exportar dentro de cada gráfico.', 'info');
}

