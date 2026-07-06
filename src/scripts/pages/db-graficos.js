// db-graficos.js — Seção de Gráficos (lazy-loaded)
// CSS dos gráficos (~28 KB) acoplado a este chunk: o Vite só o baixa quando a
// aba Gráficos abre. Antes era <link> render-blocking no <head> do dashboard,
// embora o Chart.js e a engine de gráficos já fossem carregados sob demanda.
import '../../styles/graficos.css';

let _ctx = null;
let _carregando = false;

// graficos.js (a engine de gráficos, ~92 KB) também é classic script servido de
// public/. Antes carregava EAGER no HTML em toda visita ao dashboard. Agora é
// injetado aqui, sob demanda, junto do Chart.js — só quando a aba Gráficos abre.
// FONTE ÚNICA: public/scripts/modules/graficos.js (não há mais cópia em src/ —
// a duplicata divergia e servia cores de tema escuro no tema claro). Ao editar
// a engine, suba o ?v= abaixo para invalidar o cache do navegador.
const _GRAFICOS_SRC = '/scripts/modules/graficos.js?v=6';

export function init(ctx) {
    _ctx = ctx;
    window._dbGraficos = { inicializarGraficos };
    window.atualizarGraficos = () => atualizarGraficos();
    window.exportarGraficos  = () => exportarGraficos();
    inicializarGraficos();
}

// ========== GRÁFICOS - CARGA SOB DEMANDA ==========
// Carrega Chart.js (~200KB) e graficos.js (~92KB) só quando necessário, na ordem
// correta, e então dispara a inicialização da UI de gráficos (graficos.js expõe
// window.inicializarGraficos como global por ser classic script).
// Como graficos.js agora carrega DEPOIS do DOMContentLoaded, seu auto-init via
// evento não dispara — por isso o chamamos explicitamente aqui.

function _carregarScript(src, integrity) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        if (integrity) {
            s.integrity      = integrity;
            s.crossOrigin    = 'anonymous';
            s.referrerPolicy = 'no-referrer';
        }
        s.onload  = () => resolve();
        s.onerror = () => reject(new Error('Falha ao carregar ' + src));
        document.head.appendChild(s);
    });
}

async function inicializarGraficos() {
    // Já tudo carregado: só re-renderiza a UI (re-entrância é segura — guards internos).
    if (typeof Chart !== 'undefined' && window.GraficosGranaEvo) {
        _ctx._chartJsCarregado = true;
        if (typeof window.inicializarGraficos === 'function') window.inicializarGraficos();
        return;
    }
    if (_carregando) return;
    _carregando = true;

    try {
        // 1) Chart.js primeiro (graficos.js configura Chart.defaults no init).
        if (typeof Chart === 'undefined') {
            await _carregarScript(_ctx._CHARTJS_SRC, _ctx._CHARTJS_INTEGRITY);
        }
        _ctx._chartJsCarregado = true;

        // 2) graficos.js (engine). Sem SRI — mesmo origin, coberto por script-src 'self'.
        if (!window.GraficosGranaEvo) {
            await _carregarScript(_GRAFICOS_SRC);
        }

        // 3) Inicializa filtros/botões/handlers da UI de gráficos.
        if (typeof window.inicializarGraficos === 'function') {
            window.inicializarGraficos();
        }
    } catch (e) {
        _ctx.mostrarNotificacao('Erro ao carregar os gráficos. Verifique a conexão e tente novamente.', 'error');
    } finally {
        _carregando = false;
    }
}

function atualizarGraficos() {
    if (window.GraficosGranaEvo?.gerar) {
        window.GraficosGranaEvo.gerar();
    } else if (typeof gerarGraficos === 'function') {
        // fallback para versões anteriores do graficos.js
        gerarGraficos();
    } else {
        _ctx.mostrarNotificacao('Módulo de gráficos não carregado. Atualize a página e tente novamente.', 'error');
    }
}

function exportarGraficos() {
    _ctx.mostrarNotificacao('Use o botão de exportar dentro de cada gráfico.', 'info');
}

