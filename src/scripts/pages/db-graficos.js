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
const _GRAFICOS_SRC = '/scripts/modules/graficos.js?v=7';

export function init(ctx) {
    _ctx = ctx;
    window._dbGraficos = { inicializarGraficos };
    window.atualizarGraficos = () => atualizarGraficos();
    window.exportarGraficos  = () => exportarGraficos();
    inicializarGraficos();
}

// ── A PONTE DAS RESERVAS ────────────────────────────────────────────────────
// A engine de gráficos é um script CLÁSSICO (public/), então não importa módulo
// ES. Mas a conta das reservas da conta não pode ser reescrita lá: a reserva
// compartilhada tem uma cópia no slot de CADA membro, e somar `window.metas`
// contaria o mesmo cofre uma vez por perfil.
//
// Então a regra continua num lugar só (modules/relatorio-reservas.js, puro e
// testado, o mesmo que a aba Relatórios usa) e aqui só a penduramos numa função
// global. FUNÇÃO, não valor: a engine repinta várias vezes, e um retrato
// congelado no boot mostraria o saldo de antes do último aporte.
let _consolidar = null;
async function _ligarPonteDeReservas() {
    try {
        if (!_consolidar) {
            ({ consolidarReservas: _consolidar } = await import('../modules/relatorio-reservas.js?v=1'));
        }
        window.__reservasDaConta = () => _consolidar(_ctx?.allProfilesData);
    } catch (e) {
        // Sem a ponte a seção some, e o resto dos gráficos continua de pé.
        // Melhor um card a menos do que a aba inteira em branco.
        _ctx?._log?.warn?.('[graficos] ponte de reservas indisponível:', e?.message ?? e);
    }
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
    // A ponte tem de existir ANTES da engine pintar: ela lê `__reservasDaConta`
    // no meio do render, de forma síncrona. Ligada aqui, e não no init, porque
    // este caminho é o único por onde TODA repintura passa.
    await _ligarPonteDeReservas();

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
        // Repintura pedida pelo usuário: a ponte pode não estar de pé se a
        // primeira carga falhou. `then` sem await — a engine lê a função no
        // render, e um card a menos nunca vale travar o botão.
        _ligarPonteDeReservas().finally(() => window.GraficosGranaEvo.gerar());
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

