// db-relatorios.js — Seção de Relatórios (lazy-loaded)
// CSS do RESULTADO (injetado em #relatorioResultado) viaja neste chunk lazy —
// sai do caminho crítico de boot do dashboard. Base PRIMEIRO, depois overrides.
import '../../styles/dashboard/_db-reports-lazy.css';
// CSS desktop-only (min-width:769px) viaja neste chunk lazy — mobile não baixa
// essas regras (saíram do dashboard.css eager).
import '../../styles/dashboard/_db-reports-desktop-lazy.css';
import { dataManager } from '../modules/data-manager.js?v=8';
// Motor do score extraído (puro/testável) — ver ../modules/score-financeiro.js
import { calcScore as _calcScoreCore } from '../modules/score-financeiro.js?v=1';
let _ctx = null;

// ── Lista de transações do relatório: exibição em duas etapas (Passo 7) ──────
// Quantas linhas entram no primeiro render. 150 cobre o mês típico inteiro (ou
// seja: a maioria dos usuários nunca vê o botão), e segura o caso de "todo o
// período", onde despejar milhares de nós de uma vez trava a tela.
const REL_TX_VISIVEIS = 150;

// As que ficaram de fora do primeiro render, aguardando o "Ver todas".
// Zerada a cada relatório gerado — nunca pode vazar de um período para outro.
let _relTxPendentes = [];

/** Uma linha da lista de transações do relatório (mesmo markup dos dois caminhos). */
function _relTxItemHtml(t) {
    if (!t || typeof t !== 'object') return '';
    let dotClass, sinal;
    if (t.categoria === 'entrada') { dotClass = 'entrada'; sinal = '+'; }
    else { dotClass = t.categoria === 'saida' ? 'saida' : 'reserva'; sinal = '-'; }
    return `
                <div class="rel-tx-item">
                    <div class="rel-tx-dot rel-tx-dot--${dotClass}"></div>
                    <div class="rel-tx-info">
                        <span class="rel-tx-tipo">${sanitizeHTML(String(t.tipo || '').slice(0, 100))}</span>
                        <span class="rel-tx-desc">${sanitizeHTML(String(t.descricao || '').slice(0, 200))}</span>
                        <span class="rel-tx-date">${sanitizeHTML(String(t.data || ''))} · ${sanitizeHTML(String(t.hora || ''))}</span>
                    </div>
                    <div class="rel-tx-value rel-tx-value--${dotClass}">${sinal}${formatBRL(sanitizeNumber(t.valor))}</div>
                </div>`;
}

/**
 * Renderiza as transações que ficaram de fora e remove o botão.
 * Idempotente e seguro chamar sem nada pendente — é por isso que a exportação
 * pode chamar sempre, sem perguntar.
 * @returns {boolean} true se expandiu algo (a exportação usa para saber se
 *          precisa esperar o DOM assentar antes de clonar).
 */
function _relExpandirTx() {
    const btn = document.getElementById('relTxVerMais');
    if (!btn || _relTxPendentes.length === 0) { if (btn) btn.remove(); return false; }

    let html = '';
    for (const t of _relTxPendentes) html += _relTxItemHtml(t);
    _relTxPendentes = [];

    // Mesmo saneador do render principal — o caminho de expansão não pode ser
    // uma porta dos fundos que escapa do DOMParser/whitelist.
    const temp = document.createElement('div');
    temp.innerHTML = _sanitizarHTMLRelatorio(html);

    // Insere os .rel-tx-item como IRMÃOS dos que já estão lá. Inserir o próprio
    // `temp` criaria um <div> intermediário e quebraria o CSS da lista.
    const pai = btn.parentNode;
    while (temp.firstChild) pai.insertBefore(temp.firstChild, btn);
    btn.remove();
    return true;
}

// Proxies locais para funções utilitárias de dashboard.js (disponíveis via _ctx após init).
// Usados como atalhos para evitar prefixar _ctx. em centenas de chamadas no arquivo.
const formatBRL      = (...a) => _ctx.formatBRL(...a);
const sanitizeHTML   = (...a) => _ctx.sanitizeHTML(...a);
const getMesNome     = (...a) => _ctx.getMesNome(...a);
const formatarDataBR = (...a) => _ctx.formatarDataBR(...a);
const sanitizeNumber = (...a) => _ctx.sanitizeNumber(...a);
const sanitizeDate        = (...a) => _ctx.sanitizeDate(...a);
const dataParaISO         = (...a) => _ctx.dataParaISO(...a);
const _sanitizeText       = (...a) => _ctx._sanitizeText(...a);
const safeCategorias      = (...a) => _ctx.safeCategorias(...a);
const sanitizarHTMLPopup  = (...a) => _ctx.sanitizarHTMLPopup(...a);

export function init(ctx) {
    _ctx = ctx;
    window._dbRelatorios = { popularFiltrosRelatorio };
    window.gerarRelatorio       = (...a) => gerarRelatorio(...a);
    window.abrirSelecaoPerfisCasal = () => abrirSelecaoPerfisCasal();
    window.confirmarSelecaoPerfisCasal = () => confirmarSelecaoPerfisCasal();
    window.gerarRelatorioCompartilhadoPersonalizado = () => gerarRelatorioCompartilhadoPersonalizado();
    window.processarAnaliseOndeForDinheiro = () => processarAnaliseOndeForDinheiro();
    window.abrirWidgetOndeForDinheiro = () => abrirWidgetOndeForDinheiro();
    window.abrirDetalhesPerfilRelatorio  = (id) => abrirDetalhesPerfilRelatorio(id);
    window.abrirDetalhesCartaoRelatorio  = (id) => abrirDetalhesCartaoRelatorio(id);
    setupBotoesRelatorio();
    popularFiltrosRelatorio();
}

// ── Período do relatório: recorte mês/ano OU "todo o período" ───────────────
// Centralizado porque a validação aparecia em CINCO funções e o prefixo em três.
// Com "todos" espalhado à mão, bastava esquecer um ponto para o relatório fazer
// `return` silencioso — o usuário clicaria em Gerar e nada aconteceria, sem erro.

/** Aceita o recorte mês/ano OU o período completo ('todos'). */
function _periodoValido(mes, ano) {
    if (mes === 'todos') return true;
    return /^\d{2}$/.test(mes) && +mes >= 1 && +mes <= 12
        && /^\d{4}$/.test(ano) && +ano >= 2000 && +ano <= 2100;
}

/**
 * Prefixo ISO usado nos filtros (`dataISO.startsWith(...)`).
 * Para "todo o período" devolve STRING VAZIA — e `startsWith('')` é sempre true,
 * então todas as transações entram sem precisar de um segundo caminho de código.
 */
function _prefixoPeriodo(mes, ano) {
    return mes === 'todos' ? '' : `${ano}-${mes}`;
}

// ========== RELATÓRIOS ==========
async function popularFiltrosRelatorio() {
    const mesSelect    = document.getElementById('mesRelatorio');
    const anoSelect    = document.getElementById('anoRelatorio');
    const perfilSelect = document.getElementById('selectPerfilRelatorio');

    if (!mesSelect || !anoSelect || !perfilSelect) {
        _ctx._log.error('RELATORIO_DOM_001', 'Elementos de filtro não encontrados');
        return;
    }

    function _criarPlaceholder(texto) {
        const opt = document.createElement('option');
        opt.value       = '';
        opt.textContent = texto;
        return opt;
    }

    while (mesSelect.firstChild)    mesSelect.removeChild(mesSelect.firstChild);
    while (anoSelect.firstChild)    anoSelect.removeChild(anoSelect.firstChild);
    while (perfilSelect.firstChild) perfilSelect.removeChild(perfilSelect.firstChild);

    mesSelect.appendChild(_criarPlaceholder('Selecione o mês'));

    // "Todo o período" — o relatório só oferecia mês a mês, então não havia como
    // ver o ano inteiro nem a vida toda da conta. Vale `todos`: os filtros usam
    // `periodoSelecionado` como PREFIXO (startsWith), e prefixo vazio casa com
    // tudo — por isso a opção sai quase de graça, sem um segundo caminho de
    // filtragem para manter em sincronia.
    // O ano fica irrelevante aqui e é desabilitado pelo listener abaixo.
    const optTodos = document.createElement('option');
    optTodos.value       = 'todos';
    optTodos.textContent = 'Todo o período';
    mesSelect.appendChild(optTodos);

    anoSelect.appendChild(_criarPlaceholder('Selecione o ano'));
    perfilSelect.appendChild(_criarPlaceholder('Selecione o perfil'));

    // Com "Todo o período" o ano não faz sentido: desabilita para não sugerir
    // uma combinação que o relatório ignora.
    mesSelect.addEventListener('change', () => {
        const todos = mesSelect.value === 'todos';
        anoSelect.disabled = todos;
        anoSelect.style.opacity = todos ? '0.5' : '';
    });

    if (!Array.isArray(_ctx.usuarioLogado?.perfis)) return;

    _ctx.usuarioLogado.perfis.forEach(perfil => {
        const option = document.createElement('option');
        option.value       = _ctx.sanitizeHTML(String(perfil.id));
        option.textContent = String(perfil.nome || '').slice(0, 100);
        if (_ctx.perfilAtivo && String(perfil.id) === String(_ctx.perfilAtivo.id)) {
            option.selected = true;
        }
        perfilSelect.appendChild(option);
    });

    const mesesNomes = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março',    '04': 'Abril',
        '05': 'Maio',    '06': 'Junho',     '07': 'Julho',    '08': 'Agosto',
        '09': 'Setembro','10': 'Outubro',   '11': 'Novembro', '12': 'Dezembro'
    };

    // Renderiza as caixas de mês/ano a partir de um Set de períodos "YYYY-MM".
    // Sempre inclui o mês/ano atuais e pré-seleciona-os — assim o usuário pode
    // apenas abrir e clicar em "Gerar Relatório" (igual aos Gráficos).
    const _renderPeriodos = (periodosDisponiveis) => {
        const _hojeFiltro  = new Date();
        const _anoAtualStr = String(_hojeFiltro.getFullYear());
        const _mesAtualStr = String(_hojeFiltro.getMonth() + 1).padStart(2, '0');
        periodosDisponiveis.add(`${_anoAtualStr}-${_mesAtualStr}`);

        // Limpa opções anteriores preservando o placeholder (índice 0)
        while (mesSelect.options.length > 1) mesSelect.remove(1);
        while (anoSelect.options.length > 1) anoSelect.remove(1);

        const meses = new Set();
        const anos  = new Set();
        periodosDisponiveis.forEach(periodo => {
            const partes = String(periodo).split('-');
            if (partes.length === 2) {
                meses.add(partes[1]);
                anos.add(partes[0]);
            }
        });

        Array.from(meses).sort().forEach(mes => {
            if (!mesesNomes[mes]) return;
            const option       = document.createElement('option');
            option.value       = mes;
            option.textContent = mesesNomes[mes];
            mesSelect.appendChild(option);
        });

        Array.from(anos).sort().reverse().forEach(ano => {
            const anoNum = parseInt(ano, 10);
            if (anoNum < 2000 || anoNum > 2100) return;
            const option       = document.createElement('option');
            option.value       = ano;
            option.textContent = ano;
            anoSelect.appendChild(option);
        });

        if ([...mesSelect.options].some(o => o.value === _mesAtualStr)) {
            mesSelect.value = _mesAtualStr;
        }
        if ([...anoSelect.options].some(o => o.value === _anoAtualStr)) {
            anoSelect.value = _anoAtualStr;
        }
    };

    // Extrai os períodos "YYYY-MM" de uma lista de transações, validando cada uma
    // com o mesmo validator do save (impede dados envenenados de afetar o filtro).
    const _coletarPeriodos = (transacoes, set) => {
        if (!Array.isArray(transacoes)) return;
        transacoes.forEach(t => {
            if (!t || typeof t !== 'object') return;
            if (!_ctx._validators.transacao(t)) return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (dataISO) set.add(dataISO.slice(0, 7));
        });
    };

    if (_ctx.tipoRelatorioAtivo === 'individual') {
        // Individual: transações do perfil ativo já estão em memória.
        const periodosDisponiveis = new Set();
        _coletarPeriodos(_ctx.transacoes, periodosDisponiveis);
        _renderPeriodos(periodosDisponiveis);
    } else {
        // Casal/Família: os períodos vêm de TODOS os perfis. A fonte real é o
        // blob userData (/api/user-data) — o mesmo que o relatório consome. O
        // antigo localStorage `granaevo_perfil_${id}` não existe mais, então lê-lo
        // devolvia sempre vazio e só o mês atual aparecia. Renderiza já com o mês
        // atual e re-renderiza quando o histórico de todos os perfis chegar.
        _renderPeriodos(new Set());
    }

    setupBotoesRelatorio();
    // ✅ CORRIGIDO: log operacional sem dados sensíveis
    _ctx._log.info('[popularFiltrosRelatorio] Filtros populados. Tipo ativo:', _ctx.tipoRelatorioAtivo);

    // Carrega o histórico de todos os perfis em background (casal/família) e
    // re-renderiza as caixas de mês/ano com os meses realmente disponíveis.
    if (_ctx.tipoRelatorioAtivo !== 'individual' && _ctx.tipoRelatorioAtivo !== 'patrimonio') {
        try {
            const userData = await dataManager.loadUserData();
            const periodosDisponiveis = new Set();
            if (Array.isArray(userData?.profiles)) {
                userData.profiles.forEach(perfil => {
                    _coletarPeriodos(perfil?.transacoes, periodosDisponiveis);
                });
            }
            // Só re-renderiza se o usuário ainda estiver num modo multi-perfil
            // (evita sobrescrever se ele trocou para individual/patrimônio enquanto carregava).
            if (_ctx.tipoRelatorioAtivo !== 'individual' && _ctx.tipoRelatorioAtivo !== 'patrimonio') {
                _renderPeriodos(periodosDisponiveis);
            }
        } catch (e) {
            _ctx._log.warn('RELATORIO_LS_001', 'Erro ao carregar períodos históricos dos perfis');
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// SISTEMA DE EXPORTAÇÃO — PDF (HTML) · Excel (SpreadsheetML) · Apresentação
// ══════════════════════════════════════════════════════════════════════════

function _escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
const _escapeExport = _escapeXml;

function _getPeriodInfo() {
    const mesEl  = document.getElementById('mesRelatorio');
    const anoEl  = document.getElementById('anoRelatorio');
    const mesNum = (mesEl?.value || '').padStart(2, '0');
    const anoNum = anoEl?.value || String(new Date().getFullYear());
    const mesNome = mesEl?.options[mesEl.selectedIndex]?.text || '';
    // Em "todo o período" o ano não participa do recorte — devolvê-lo faria os
    // títulos e nomes de arquivo dizerem "Todo o período 2026", que é contraditório.
    if (mesNum === 'todos') return { mesNum, anoNum: '', mesNome };
    return { mesNum, anoNum, mesNome };
}

function _getTxsDoPeriodo() {
    const { mesNum, anoNum } = _getPeriodInfo();
    if (!mesNum || mesNum === '00' || (mesNum !== 'todos' && !anoNum)) return _ctx.transacoes;
    // Usa o MESMO helper do relatório na tela. Montar o prefixo à mão aqui daria
    // "2026-todos", que não casa com data nenhuma — e o CSV/Excel sairiam VAZIOS
    // justamente na opção "todo o período".
    const prefix = _prefixoPeriodo(mesNum, anoNum);
    if (!prefix) return _ctx.transacoes;
    return _ctx.transacoes.filter(t => {
        const iso = _ctx.dataParaISO(t.data || '');
        return iso ? iso.startsWith(prefix) : false;
    });
}

function _fmtBRL(v) {
    const n = parseFloat(v) || 0;
    return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _exportarRelatorio() {
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado || resultado.classList.contains('js-hidden') || resultado.innerHTML.trim() === '') {
        _ctx.mostrarNotificacao('Gere o relatório antes de exportar.', 'warning');
        return;
    }

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '420px';

        const h3 = document.createElement('h3');
        h3.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px;';
        h3.innerHTML = '<i class="fas fa-share-alt" style="color:var(--primary)" aria-hidden="true"></i>';
        h3.appendChild(document.createTextNode(' Exportar Relatório'));

        const sub = document.createElement('p');
        sub.style.cssText = 'color:var(--text-muted);font-size:0.82rem;margin-bottom:20px;';
        sub.textContent = 'Escolha o formato de exportação:';

        const opts = [
            { icon:'fa-file-pdf',       color:'#ef4444', label:'PDF',                badge:'Recomendado',
              desc:'Abre o relatório completo com gráficos em nova aba. Salve como PDF com Ctrl+P.',
              fn: () => { _ctx.fecharPopup(); setTimeout(_exportPDF, 120); } },
            { icon:'fa-file-csv',       color:'#0891b2', label:'CSV',
              desc:'Exporta todas as transações do período em CSV (UTF-8). Compatível com Excel e Google Sheets.',
              fn: () => { _ctx.fecharPopup(); setTimeout(_exportCSV, 120); } },
            { icon:'fa-file-excel',     color:'#16a34a', label:'Excel (.xls)',
              desc:'Planilha com 4 abas: Resumo, Transações, Metas e Contas Fixas.',
              fn: () => { _ctx.fecharPopup(); setTimeout(_exportExcel, 120); } },
            { icon:'fa-file-powerpoint',color:'#ea580c', label:'Apresentação (.html)',
              desc:'Slides financeiros interativos. Abra no browser (F11 = tela cheia) ou importe no PowerPoint.',
              fn: () => { _ctx.fecharPopup(); setTimeout(_exportApresentacao, 120); } },
        ];

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-bottom:14px;';

        opts.forEach(opt => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.style.cssText = 'display:flex;align-items:center;gap:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;cursor:pointer;text-align:left;transition:background 0.18s,border-color 0.18s;width:100%;';

            const iconDiv = document.createElement('div');
            iconDiv.style.cssText = 'width:44px;height:44px;border-radius:12px;background:' + opt.color + '20;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.2rem;color:' + opt.color + ';';
            iconDiv.innerHTML = '<i class="fas ' + opt.icon + '" aria-hidden="true"></i>';

            const textDiv = document.createElement('div');
            textDiv.style.cssText = 'flex:1;min-width:0;';

            const labelRow = document.createElement('div');
            labelRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:3px;';
            const labelEl = document.createElement('span');
            labelEl.style.cssText = 'font-weight:700;font-size:0.94rem;color:#fff;';
            labelEl.textContent = opt.label;
            labelRow.appendChild(labelEl);
            if (opt.badge) {
                const badgeEl = document.createElement('span');
                badgeEl.style.cssText = 'font-size:0.65rem;font-weight:700;background:rgba(16,185,129,0.18);color:#10b981;padding:2px 7px;border-radius:20px;';
                badgeEl.textContent = opt.badge;
                labelRow.appendChild(badgeEl);
            }
            const descEl = document.createElement('div');
            descEl.style.cssText = 'font-size:0.77rem;color:rgba(255,255,255,0.45);line-height:1.35;';
            descEl.textContent = opt.desc;
            textDiv.appendChild(labelRow);
            textDiv.appendChild(descEl);

            const arrow = document.createElement('div');
            arrow.style.cssText = 'color:rgba(255,255,255,0.25);flex-shrink:0;';
            arrow.innerHTML = '<i class="fas fa-chevron-right" aria-hidden="true"></i>';

            btn.appendChild(iconDiv); btn.appendChild(textDiv); btn.appendChild(arrow);
            btn.addEventListener('mouseenter', () => { btn.style.background='rgba(255,255,255,0.08)'; btn.style.borderColor=opt.color+'50'; });
            btn.addEventListener('mouseleave', () => { btn.style.background='rgba(255,255,255,0.04)'; btn.style.borderColor='rgba(255,255,255,0.08)'; });
            btn.addEventListener('click', opt.fn);
            list.appendChild(btn);
        });

        const btnCancel = document.createElement('button');
        btnCancel.className = 'btn-cancelar'; btnCancel.type = 'button';
        btnCancel.style.width = '100%'; btnCancel.textContent = 'Cancelar';
        btnCancel.addEventListener('click', () => _ctx.fecharPopup());

        box.appendChild(h3); box.appendChild(sub); box.appendChild(list); box.appendChild(btnCancel);
    });
}

// ── CSV: transações do período (UTF-8 BOM) ───────────────────────────────
function _exportCSV() {
    const txs = _getTxsDoPeriodo();
    const { mesNome, anoNum, mesNum } = _getPeriodInfo();
    const perfilNome = _ctx.perfilAtivo?.nome || 'relatorio';

    // Cabeçalho
    const cols = ['Data','Hora','Categoria','Tipo','Descrição','Valor (R$)'];

    function _csvCell(val) {
        // RFC 4180: envolve em aspas se contém vírgula, aspas ou quebra de linha
        const s = String(val ?? '').replace(/"/g, '""');
        return /[",\n\r]/.test(s) ? `"${s}"` : s;
    }

    const linhas = [cols.map(_csvCell).join(',')];
    txs.forEach(t => {
        linhas.push([
            _csvCell(t.data  || ''),
            _csvCell(t.hora  || ''),
            _csvCell(t.categoria || ''),
            _csvCell(t.tipo  || ''),
            _csvCell(t.descricao || ''),
            _csvCell(typeof t.valor === 'number' ? t.valor.toFixed(2).replace('.', ',') : (t.valor || '0,00')),
        ].join(','));
    });

    const csv     = '﻿' + linhas.join('\r\n'); // BOM UTF-8 para Excel abrir corretamente
    const arquivo = `GranaEvo_${anoNum}-${mesNum}_${perfilNome}_transacoes.csv`;
    _downloadBlob(csv, arquivo, 'text/csv;charset=utf-8');
}

// ── PDF: HTML standalone com gráficos embutidos ──────────────────────────
function _exportPDF() {
    // Passo 7: a tela mostra só as primeiras transações. Este export CLONA o DOM
    // → sem expandir, geraria um PDF que OMITE transações em silêncio, que é bem
    // pior do que um relatório lento. Idempotente: sem pendências, não faz nada.
    _relExpandirTx();

    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;
    const { mesNome, anoNum, mesNum } = _getPeriodInfo();
    const perfilNome = _escapeXml(_ctx.perfilAtivo?.nome || '');
    const tipoLabel  = { individual:'Individual', casal:'Casal', familia:'Família', patrimonio:'Visão Geral' };
    const tipo = tipoLabel[_ctx.tipoRelatorioAtivo] || '';
    const geradoEm = new Date().toLocaleDateString('pt-BR') + ' às ' + new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

    const canvasMap = new Map();
    resultado.querySelectorAll('canvas').forEach(canvas => {
        try { canvasMap.set(canvas, canvas.toDataURL('image/png')); } catch { }
    });

    const clone = resultado.cloneNode(true);
    const origCanvases = [...resultado.querySelectorAll('canvas')];
    [...clone.querySelectorAll('canvas')].forEach((c, idx) => {
        const url = canvasMap.get(origCanvases[idx]);
        if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.style.cssText = 'max-width:100%;height:auto;border-radius:8px;';
            c.parentNode.replaceChild(img, c);
        }
    });
    clone.querySelectorAll('button,.btn-primary,.btn-cancelar,.rel-header-actions').forEach(el => el.remove());

    const html = '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n<meta charset="UTF-8">\n<title>GranaEvo — ' + _escapeXml(tipo) + ' ' + _escapeXml(mesNome) + ' ' + _escapeXml(anoNum) + '</title>\n' +
`<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#1a1a2e;font-size:15px;line-height:1.6}
.ge-doc{max-width:960px;margin:0 auto;padding:32px 28px}
.ge-hdr{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;padding-bottom:16px;border-bottom:3px solid #10b981;flex-wrap:wrap;gap:12px}
.ge-logo{font-size:1.7rem;font-weight:900;color:#10b981;letter-spacing:-0.03em}.ge-logo span{color:#1a1a2e}
.ge-meta{text-align:right;font-size:0.82rem;color:#6b7280;line-height:1.5}
.ge-meta strong{color:#374151;font-size:0.9rem;display:block;margin-bottom:2px}
.ge-btn{display:inline-flex;align-items:center;gap:8px;background:#10b981;color:#fff;border:none;padding:10px 22px;border-radius:10px;font-size:0.9rem;font-weight:700;cursor:pointer;margin-bottom:24px;font-family:inherit}
.ge-btn:hover{background:#059669}
.relatorio-resumo,.relatorio-cards-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
.relatorio-card{padding:16px;border-radius:12px;border:1px solid #e5e7eb;background:#f9fafb}
.relatorio-card-label{font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#9ca3af;margin-bottom:6px}
.relatorio-card-value{font-size:1.35rem;font-weight:800;color:#374151}
.relatorio-section,.relatorio-bloco{margin-bottom:28px;page-break-inside:avoid}
.relatorio-section-title,.relatorio-titulo,.section-title,.grafico-titulo{font-size:1rem;font-weight:700;color:#374151;padding-bottom:8px;border-bottom:2px solid #e5e7eb;margin-bottom:14px;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;font-size:0.83rem;margin-bottom:4px}
th{background:#f9fafb;color:#374151;font-weight:700;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;padding:9px 12px;text-align:left;border-bottom:2px solid #e5e7eb}
td{padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#374151}
tr:last-child td{border-bottom:none}
tr:nth-child(even) td{background:#fafafa}
.val-entrada,.text-success,.cor-entrada{color:#16a34a;font-weight:600}
.val-saida,.text-danger,.cor-saida{color:#dc2626;font-weight:600}
.val-reserva,.cor-reserva{color:#d97706;font-weight:600}
.cat-badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.7rem;font-weight:700}
.cat-entrada{background:#dcfce7;color:#16a34a}
.cat-saida{background:#fee2e2;color:#dc2626}
.cat-reserva{background:#fef9c3;color:#d97706}
.grafico-container,.chart-wrapper,.grafico-wrapper{max-width:100%;overflow:hidden;text-align:center}
img{max-width:100%;height:auto;border-radius:8px}
.prog-bar-wrap{background:#e5e7eb;border-radius:99px;height:8px;margin:4px 0}
.prog-bar{background:#10b981;height:8px;border-radius:99px}
@media print{@page{margin:14mm 12mm}.ge-btn{display:none!important}body{font-size:13px}.relatorio-section,.relatorio-bloco{page-break-inside:avoid}}
</style>
</head>
<body>
<div class="ge-doc">
  <div class="ge-hdr">
    <div><div class="ge-logo">Grana<span>Evo</span></div><div style="font-size:0.82rem;color:#6b7280;margin-top:4px;">Relatório Financeiro</div></div>
    <div class="ge-meta"><strong>` + _escapeXml(tipo) + ' · ' + _escapeXml(mesNome) + ' ' + _escapeXml(anoNum) + `</strong>` +
    (perfilNome ? 'Perfil: ' + perfilNome + '<br>' : '') +
    'Gerado em: ' + _escapeXml(geradoEm) + `</div>
  </div>
  <button class="ge-btn" onclick="window.print()">&#128438; Salvar como PDF (Ctrl+P)</button>
  ` + clone.innerHTML + `
</div>
</body>
</html>`;

    _downloadBlob(html, 'GranaEvo_' + anoNum + '-' + mesNum + '_' + (perfilNome || 'relatorio') + '.html', 'text/html;charset=utf-8');
    _ctx.mostrarNotificacao('📄 Relatório HTML baixado! Abra o arquivo e pressione Ctrl+P → Salvar como PDF.', 'success');
}

// ── Excel: SpreadsheetML XML (.xls) ─────────────────────────────────────
function _exportExcel() {
    const { mesNome, anoNum, mesNum } = _getPeriodInfo();
    const perfilNome = _ctx.perfilAtivo?.nome || 'Perfil';
    const txs = _getTxsDoPeriodo();

    const entradas = txs.filter(t => t.categoria === 'entrada').reduce((s, t) => s + Number(t.valor || 0), 0);
    const saidas   = txs.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((s, t) => s + Number(t.valor || 0), 0);
    const reservas = txs.filter(t => t.categoria === 'reserva').reduce((s, t) => s + Number(t.valor || 0), 0);
    const saldo    = entradas - saidas;

    const catMap = {};
    txs.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').forEach(t => {
        catMap[t.tipo || 'Outros'] = (catMap[t.tipo || 'Outros'] || 0) + Number(t.valor || 0);
    });
    const categorias = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

    const c = (type, val, style) => {
        const s = style ? ' ss:StyleID="' + style + '"' : '';
        return '<Cell' + s + '><Data ss:Type="' + type + '">' + _escapeXml(String(val)) + '</Data></Cell>';
    };
    const hdr = v => c('String', v, 'sHdr');
    const num = (v, s) => c('Number', (parseFloat(v) || 0).toFixed(2), s || '');
    const emptyR = (n) => '<Row><Cell ss:MergeAcross="' + (n-1) + '"><Data ss:Type="String"></Data></Cell></Row>';
    const titleR = (t, n) => '<Row ss:Height="24"><Cell ss:MergeAcross="' + (n-1) + '" ss:StyleID="sTitle"><Data ss:Type="String">' + _escapeXml(t) + '</Data></Cell></Row>';

    const _CAT_LBL = { entrada:'Entrada', saida:'Saída', saida_credito:'Crédito', reserva:'Reserva', retirada_reserva:'Retirada' };

    const sheetResumo = `<Worksheet ss:Name="Resumo"><Table ss:DefaultColumnWidth="160">
${titleR('GranaEvo — ' + mesNome + ' ' + anoNum + ' · ' + perfilNome, 3)}
${emptyR(3)}
<Row ss:Height="20">${hdr('INDICADOR')}${hdr('VALOR')}${hdr('DETALHE')}</Row>
<Row>${c('String','Entradas')}${num(entradas,'sPos')}${c('String','Receitas do período')}</Row>
<Row>${c('String','Saídas')}${num(saidas,'sNeg')}${c('String','Gastos do período')}</Row>
<Row>${c('String','Saldo')}${num(saldo, saldo>=0?'sPos':'sNeg')}${c('String','Entradas − Saídas')}</Row>
<Row>${c('String','Reservas')}${num(reservas,'sWarn')}${c('String','Aportes em metas')}</Row>
${emptyR(3)}
${titleR('Gastos por Categoria', 3)}
${emptyR(3)}
<Row ss:Height="20">${hdr('CATEGORIA')}${hdr('VALOR')}${hdr('% DO TOTAL')}</Row>
${categorias.map(([cat, val]) => '<Row>' + c('String',cat) + num(val,'sNeg') + c('Number', saidas>0?((val/saidas)*100).toFixed(1):'0') + '</Row>').join('')}
</Table></Worksheet>`;

    const sheetTx = `<Worksheet ss:Name="Transações"><Table ss:DefaultColumnWidth="130">
${titleR('Transações — ' + mesNome + ' ' + anoNum, 5)}
${emptyR(5)}
<Row ss:Height="20">${hdr('DATA')}${hdr('DESCRIÇÃO')}${hdr('CATEGORIA')}${hdr('TIPO')}${hdr('VALOR (R$)')}</Row>
${txs.slice().reverse().map(t => {
    const isPos = t.categoria === 'entrada' || t.categoria === 'retirada_reserva';
    return '<Row>' + c('String',t.data||'') + c('String',t.descricao||'') + c('String',_CAT_LBL[t.categoria]||t.categoria) + c('String',t.tipo||'') + num(t.valor, isPos?'sPos':'sNeg') + '</Row>';
}).join('')}
</Table></Worksheet>`;

    const sheetMetas = `<Worksheet ss:Name="Reservas e Metas"><Table ss:DefaultColumnWidth="140">
${titleR('Reservas e Metas', 5)}
${emptyR(5)}
<Row ss:Height="20">${hdr('NOME')}${hdr('OBJETIVO (R$)')}${hdr('SALVO (R$)')}${hdr('PROGRESSO %')}${hdr('PRAZO')}</Row>
${(_ctx.metas||[]).map(m => {
    const pct = m.objetivo>0 ? Math.min(100,((m.saved||0)/m.objetivo)*100).toFixed(1) : '0';
    return '<Row>' + c('String',m.descricao||'') + num(m.objetivo) + num(m.saved||0,'sPos') + c('Number',pct) + c('String',m.prazo||'Sem prazo') + '</Row>';
}).join('')}
</Table></Worksheet>`;

    const sheetContas = `<Worksheet ss:Name="Contas Fixas"><Table ss:DefaultColumnWidth="150">
${titleR('Contas Fixas', 4)}
${emptyR(4)}
<Row ss:Height="20">${hdr('DESCRIÇÃO')}${hdr('VALOR (R$)')}${hdr('VENCIMENTO')}${hdr('STATUS')}</Row>
${(_ctx.contasFixas||[]).filter(c2=>c2.tipoContaFixa!=='fatura_cartao').map(cf => {
    const venc = cf.vencimento ? cf.vencimento.split('-').reverse().join('/') : '';
    return '<Row>' + c('String',cf.descricao||'') + num(cf.valor,'sNeg') + c('String',venc) + c('String',cf.pago?'Pago':'Pendente') + '</Row>';
}).join('')}
</Table></Worksheet>`;

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
`<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
<Style ss:ID="sHdr"><Font ss:Bold="1" ss:Color="#FFFFFF" ss:Size="9"/><Interior ss:Color="#10b981" ss:Pattern="Solid"/></Style>
<Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="13" ss:Color="#10b981"/></Style>
<Style ss:ID="sPos"><Font ss:Color="#16a34a" ss:Bold="1"/><NumberFormat ss:Format='"R$ "#,##0.00'/></Style>
<Style ss:ID="sNeg"><Font ss:Color="#dc2626" ss:Bold="1"/><NumberFormat ss:Format='"R$ "#,##0.00'/></Style>
<Style ss:ID="sWarn"><Font ss:Color="#d97706" ss:Bold="1"/><NumberFormat ss:Format='"R$ "#,##0.00'/></Style>
</Styles>
` + sheetResumo + sheetTx + sheetMetas + sheetContas + '</Workbook>';

    const nomArq = 'GranaEvo_' + anoNum + '-' + mesNum + '_' + perfilNome.replace(/\s+/g,'_') + '.xls';
    _downloadBlob('﻿' + xml, nomArq, 'application/vnd.ms-excel;charset=utf-8');
    _ctx.mostrarNotificacao('📊 Planilha Excel gerada! Abra o arquivo .xls no Excel ou Google Sheets.', 'success');
}

// ── Apresentação HTML interativa com slides financeiros ───────────────────
function _exportApresentacao() {
    // Mesmo motivo do _exportPDF: clona o DOM, então expande antes.
    _relExpandirTx();

    const { mesNome, anoNum, mesNum } = _getPeriodInfo();
    const perfilNome = _ctx.perfilAtivo?.nome || '';
    const txs = _getTxsDoPeriodo();

    const entradas = txs.filter(t => t.categoria==='entrada').reduce((s,t)=>s+Number(t.valor||0),0);
    const saidas   = txs.filter(t => t.categoria==='saida'||t.categoria==='saida_credito').reduce((s,t)=>s+Number(t.valor||0),0);
    const reservas = txs.filter(t => t.categoria==='reserva').reduce((s,t)=>s+Number(t.valor||0),0);
    const saldo    = entradas - saidas;

    const catMap = {};
    txs.filter(t=>t.categoria==='saida'||t.categoria==='saida_credito').forEach(t=>{catMap[t.tipo||'Outros']=(catMap[t.tipo||'Outros']||0)+Number(t.valor||0);});
    const top5 = Object.entries(catMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const maxV = top5[0]?.[1]||1;
    const metas = (_ctx.metas||[]).slice(0,5);
    const contas = (_ctx.contasFixas||[]).filter(c=>c.tipoContaFixa!=='fatura_cartao').slice(0,6);

    const N = 5;
    const slideHTML = (id, content) => '<section class="slide" id="s'+id+'" aria-label="Slide '+id+'">'+content+'</section>';
    const slideTitles = ['Capa','Visão Geral','Gastos','Reservas','Contas Fixas'];

    const slides = [
        slideHTML(1,
            '<div class="cov"><div class="cov-logo">GranaEvo</div><div class="cov-title">Relatório Financeiro</div>' +
            '<div class="cov-period">'+_escapeXml(mesNome)+' '+_escapeXml(anoNum)+'</div>' +
            (perfilNome?'<div class="cov-tag">'+_escapeXml(perfilNome)+'</div>':'')+
            '<div class="cov-date">Gerado em '+new Date().toLocaleDateString('pt-BR')+'</div></div>'),

        slideHTML(2,
            '<div class="shdr"><span class="snum">02 / '+N+'</span><span class="slbl">Visão Geral</span></div>'+
            '<h2 class="stit">Resumo Financeiro</h2>'+
            '<div class="sgrid">'+
            '<div class="scard green"><div class="sic">↑</div><div class="slabel">ENTRADAS</div><div class="sval">'+_escapeXml(_fmtBRL(entradas))+'</div></div>'+
            '<div class="scard red"><div class="sic">↓</div><div class="slabel">SAÍDAS</div><div class="sval">'+_escapeXml(_fmtBRL(saidas))+'</div></div>'+
            '<div class="scard '+(saldo>=0?'blue':'red')+'"><div class="sic">≡</div><div class="slabel">SALDO</div><div class="sval">'+_escapeXml(_fmtBRL(saldo))+'</div></div>'+
            '<div class="scard yellow"><div class="sic">🏦</div><div class="slabel">RESERVAS</div><div class="sval">'+_escapeXml(_fmtBRL(reservas))+'</div></div>'+
            '</div>'),

        slideHTML(3,
            '<div class="shdr"><span class="snum">03 / '+N+'</span><span class="slbl">Análise</span></div>'+
            '<h2 class="stit">Top 5 Categorias de Gasto</h2>'+
            '<div class="cats">'+(top5.length===0?'<p class="empty-msg">Nenhum gasto no período</p>':top5.map(([cat,val],i)=>{
                const pct=Math.round((val/maxV)*100);
                const ptotal=saidas>0?((val/saidas)*100).toFixed(1):'0';
                return '<div class="crow"><span class="cnum">'+String(i+1).padStart(2,'0')+'</span>'+
                '<div class="cinfo"><span class="cname">'+_escapeXml(cat)+'</span>'+
                '<div class="cbar-w"><div class="cbar" data-w="'+pct+'"></div></div></div>'+
                '<div class="cvals"><span class="cval">'+_escapeXml(_fmtBRL(val))+'</span><span class="cpct">'+ptotal+'%</span></div></div>';
            }).join(''))+'</div>'),

        slideHTML(4,
            '<div class="shdr"><span class="snum">04 / '+N+'</span><span class="slbl">Reservas</span></div>'+
            '<h2 class="stit">Progresso das Metas</h2>'+
            '<div class="metas">'+(metas.length===0?'<p class="empty-msg">Nenhuma reserva criada</p>':metas.map(m=>{
                const pct=m.objetivo>0?Math.min(100,((m.saved||0)/m.objetivo)*100):0;
                return '<div class="mrow">'+
                '<div class="minfo"><span class="mname">'+_escapeXml(m.descricao||'')+'</span>'+
                '<div class="mbar-w"><div class="mbar" data-w="'+pct.toFixed(1)+'"></div></div></div>'+
                '<div class="mvals"><span class="mval">'+_escapeXml(_fmtBRL(m.saved||0))+'</span><span class="mpct">'+pct.toFixed(0)+'%</span></div></div>';
            }).join(''))+'</div>'),

        slideHTML(5,
            '<div class="shdr"><span class="snum">05 / '+N+'</span><span class="slbl">Obrigações</span></div>'+
            '<h2 class="stit">Contas Fixas</h2>'+
            '<div class="conts">'+(contas.length===0?'<p class="empty-msg">Nenhuma conta fixa</p>':contas.map(cf=>{
                const venc=cf.vencimento?cf.vencimento.split('-').reverse().join('/'):'';
                return '<div class="cont-row">'+
                '<span class="cont-name">'+_escapeXml(cf.descricao||'')+'</span>'+
                '<span class="cont-venc">'+_escapeXml(venc)+'</span>'+
                '<span class="cont-val '+(cf.pago?'pago':'pend')+'">'+_escapeXml(_fmtBRL(cf.valor))+'</span>'+
                '<span class="cont-st '+(cf.pago?'pago':'pend')+'">'+(cf.pago?'✓ Pago':'● Pendente')+'</span></div>';
            }).join(''))+'</div>')
    ];

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GranaEvo — Apresentação ${_escapeXml(mesNome)} ${_escapeXml(anoNum)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#09000f;color:#fff;overflow:hidden;height:100vh}
.pres{width:100vw;height:100vh;position:relative}
.slide{width:100%;height:100%;position:absolute;top:0;left:0;display:none;flex-direction:column;padding:52px 72px;background:linear-gradient(135deg,#0a0d16 0%,#0d1420 100%)}
.slide.active{display:flex}
.cov{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;gap:14px}
.cov-logo{font-size:3rem;font-weight:900;color:#10b981;letter-spacing:-0.04em}
.cov-title{font-size:1.8rem;font-weight:700;margin-top:6px}
.cov-period{font-size:1.1rem;color:rgba(255,255,255,0.55)}
.cov-tag{background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);color:#10b981;padding:5px 18px;border-radius:99px;font-size:0.88rem;font-weight:600;margin-top:10px}
.cov-date{font-size:0.75rem;color:rgba(255,255,255,0.28);margin-top:20px}
.shdr{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.snum{font-size:0.72rem;font-weight:700;color:rgba(16,185,129,0.65);letter-spacing:0.08em}
.slbl{font-size:0.72rem;color:rgba(255,255,255,0.32);letter-spacing:0.1em;text-transform:uppercase}
.stit{font-size:1.75rem;font-weight:800;margin-bottom:28px;letter-spacing:-0.02em}
.sgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.scard{padding:26px 18px;border-radius:18px;border:1px solid rgba(255,255,255,0.07);text-align:center}
.scard.green{background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.22)}
.scard.red{background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.22)}
.scard.blue{background:rgba(59,130,246,0.1);border-color:rgba(59,130,246,0.22)}
.scard.yellow{background:rgba(217,119,6,0.1);border-color:rgba(217,119,6,0.22)}
.sic{font-size:1.3rem;margin-bottom:8px}
.slabel{font-size:0.64rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(255,255,255,0.4);margin-bottom:7px}
.sval{font-size:1.2rem;font-weight:800}
.cats{display:flex;flex-direction:column;gap:16px}
.crow{display:grid;grid-template-columns:36px 1fr 160px;align-items:center;gap:14px}
.cnum{font-size:1.05rem;font-weight:800;color:rgba(16,185,129,0.55)}
.cname{font-size:0.9rem;font-weight:600;display:block;margin-bottom:6px}
.cbar-w{background:rgba(255,255,255,0.08);border-radius:99px;height:6px}
.cbar{background:linear-gradient(90deg,#10b981,#34d399);height:6px;border-radius:99px;width:0;transition:width 0.5s ease}
.cvals{text-align:right}
.cval{display:block;font-weight:700;font-size:0.95rem}
.cpct{font-size:0.72rem;color:rgba(255,255,255,0.38)}
.metas{display:flex;flex-direction:column;gap:18px}
.mrow{display:grid;grid-template-columns:1fr 160px;gap:14px;align-items:center}
.mname{font-size:0.9rem;font-weight:600;display:block;margin-bottom:7px}
.mbar-w{background:rgba(255,255,255,0.08);border-radius:99px;height:7px}
.mbar{background:linear-gradient(90deg,#f59e0b,#fcd34d);height:7px;border-radius:99px;width:0;transition:width 0.5s ease}
.mvals{text-align:right}
.mval{display:block;font-weight:700;font-size:0.95rem}
.mpct{font-size:0.75rem;color:rgba(255,255,255,0.38)}
.conts{display:flex;flex-direction:column;gap:10px}
.cont-row{display:grid;grid-template-columns:1fr 100px 130px 110px;align-items:center;gap:14px;background:rgba(255,255,255,0.04);border-radius:11px;padding:12px 16px;border:1px solid rgba(255,255,255,0.06)}
.cont-name{font-weight:600;font-size:0.88rem}
.cont-venc{font-size:0.8rem;color:rgba(255,255,255,0.4)}
.cont-val,.cont-st{font-size:0.85rem;font-weight:700;text-align:right}
.cont-val.pago,.cont-st.pago{color:#10b981}
.cont-val.pend,.cont-st.pend{color:#f87171}
.empty-msg{opacity:0.4;text-align:center;margin-top:60px;font-size:1rem}
.nav{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;background:rgba(0,0,0,0.65);backdrop-filter:blur(14px);padding:9px 18px;border-radius:99px;border:1px solid rgba(255,255,255,0.08);z-index:100}
.nbtn{background:none;border:none;color:rgba(255,255,255,0.65);cursor:pointer;font-size:1rem;padding:3px 6px;transition:color 0.2s}
.nbtn:hover{color:#10b981}
.ndot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.18);cursor:pointer;transition:background 0.2s}
.ndot.a{background:#10b981}
.ninfo{font-size:0.8rem;color:rgba(255,255,255,0.35);min-width:52px;text-align:center}
.hint{position:fixed;top:16px;right:18px;font-size:0.7rem;color:rgba(255,255,255,0.2)}
@media print{@page{size:1280px 720px;margin:0}body{overflow:visible;height:auto}.pres{width:1280px;height:auto}.slide{position:relative;display:flex!important;page-break-after:always;height:720px}.nav,.hint{display:none}}
</style>
</head>
<body>
<div class="pres">
${slides.join('\n')}
</div>
<nav class="nav">
<button class="nbtn" onclick="go(-1)" aria-label="Anterior">&#8592;</button>
<div id="dots" style="display:flex;gap:6px;align-items:center"></div>
<span class="ninfo" id="ni">1 / ${N}</span>
<button class="nbtn" onclick="go(1)" aria-label="Próximo">&#8594;</button>
</nav>
<div class="hint">F11 = tela cheia &nbsp;&nbsp; ←→ = navegar &nbsp;&nbsp; Ctrl+P = imprimir slides</div>
<script>
var cur=0;
var sls=document.querySelectorAll('.slide');
var dotsEl=document.getElementById('dots');
var ni=document.getElementById('ni');
sls.forEach(function(_,i){var d=document.createElement('div');d.className='ndot'+(i===0?' a':'');d.onclick=function(){goTo(i);};dotsEl.appendChild(d);});
function animate(n){sls[n].querySelectorAll('.cbar,.mbar').forEach(function(b){var w=b.getAttribute('data-w');b.style.width='0';setTimeout(function(){b.style.width=(w||'0')+'%';},80);});}
function goTo(n){sls[cur].classList.remove('active');dotsEl.children[cur].classList.remove('a');cur=Math.max(0,Math.min(n,sls.length-1));sls[cur].classList.add('active');dotsEl.children[cur].classList.add('a');ni.textContent=(cur+1)+' / '+sls.length;animate(cur);}
function go(d){goTo(cur+d);}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowDown')go(1);if(e.key==='ArrowLeft'||e.key==='ArrowUp')go(-1);});
goTo(0);
</script>
</body>
</html>`;

    const fn = 'GranaEvo_Apresentacao_' + anoNum + '-' + mesNum + '_' + (perfilNome||'perfil').replace(/\s+/g,'_') + '.html';
    _downloadBlob(html, fn, 'text/html;charset=utf-8');
    _ctx.mostrarNotificacao('📊 Apresentação gerada! Abra o HTML no browser e pressione F11 para tela cheia.', 'success');
}

// ── Utilitário: baixa um Blob como arquivo ────────────────────────────────
function _downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function setupBotoesRelatorio() {
    // Conecta o botão de exportar (sem inline onclick)
    const btnExportar = document.getElementById('btnExportarRelatorio');
    if (btnExportar) {
        const newBtnExp = btnExportar.cloneNode(true);
        btnExportar.parentNode.replaceChild(newBtnExp, btnExportar);
        newBtnExp.addEventListener('click', () => _exportarRelatorio());
    }

    const btnIndividual = document.querySelector('.tipo-relatorio-btns [data-tipo="individual"]');
    const btnCasal = document.querySelector('.tipo-relatorio-btns [data-tipo="casal"]');
    const btnFamilia = document.querySelector('.tipo-relatorio-btns [data-tipo="familia"]');
    const perfilSelector = document.getElementById('perfilSelectorDiv');
    
    if (!btnIndividual || !btnCasal || !btnFamilia || !perfilSelector) {
        console.error('Botões de relatório não encontrados!');
        return;
    }
    
    const newBtnIndividual = btnIndividual.cloneNode(true);
    const newBtnCasal = btnCasal.cloneNode(true);
    const newBtnFamilia = btnFamilia.cloneNode(true);
    // Declarado no escopo da função (não dentro do if abaixo): o handler do botão
    // "Família" o referencia, e um `const` block-scoped causaria ReferenceError.
    let newBtnPatrimonio = null;
    
    btnIndividual.parentNode.replaceChild(newBtnIndividual, btnIndividual);
    btnCasal.parentNode.replaceChild(newBtnCasal, btnCasal);
    btnFamilia.parentNode.replaceChild(newBtnFamilia, btnFamilia);
    
    newBtnIndividual.addEventListener('click', function () {
        _ctx.tipoRelatorioAtivo = 'individual';
        newBtnIndividual.classList.add('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.remove('active');
        perfilSelector.classList.add('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.classList.add('js-hidden');
        _ctx.popularFiltrosRelatorio();
    });
    
    newBtnCasal.addEventListener('click', function () {
        if (!Array.isArray(_ctx.usuarioLogado?.perfis) || _ctx.usuarioLogado.perfis.length < 2) {
            _ctx.mostrarNotificacao('Você precisa ter pelo menos 2 perfis cadastrados para gerar relatório de casal!', 'warning');
            return;
        }
        _ctx.tipoRelatorioAtivo = 'casal';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.add('active');
        newBtnFamilia.classList.remove('active');
        perfilSelector.classList.remove('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.classList.add('js-hidden');
        _ctx.popularFiltrosRelatorio();
    });

    newBtnFamilia.addEventListener('click', function () {
        if (!Array.isArray(_ctx.usuarioLogado?.perfis) || _ctx.usuarioLogado.perfis.length < 2) {
            _ctx.mostrarNotificacao('Você precisa ter pelo menos 2 perfis para gerar relatório da família!', 'warning');
            return;
        }
        _ctx.tipoRelatorioAtivo = 'familia';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.remove('active');
        newBtnPatrimonio?.classList.remove('active');
        newBtnFamilia.classList.add('active');
        perfilSelector.classList.remove('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.classList.add('js-hidden');
        _ctx.popularFiltrosRelatorio();
    });

    // ── Histórico Patrimonial ────────────────────────────────────────────
    const btnPatrimonio = document.querySelector('.tipo-relatorio-btns [data-tipo="patrimonio"]');
    if (btnPatrimonio) {
        newBtnPatrimonio = btnPatrimonio.cloneNode(true);
        btnPatrimonio.parentNode.replaceChild(newBtnPatrimonio, btnPatrimonio);

        newBtnPatrimonio.addEventListener('click', function () {
            _ctx.tipoRelatorioAtivo = 'patrimonio';
            newBtnIndividual.classList.remove('active');
            newBtnCasal.classList.remove('active');
            newBtnFamilia.classList.remove('active');
            newBtnPatrimonio.classList.add('active');
            perfilSelector.classList.remove('show');
            const periodRow = document.querySelector('.rel-period-row');
            if (periodRow) periodRow.style.display = 'none';
            // Auto-gera sem precisar clicar em "Gerar Relatório"
            const resultado = document.getElementById('relatorioResultado');
            if (resultado) {
                resultado.classList.remove('js-hidden');
                _gerarPatrimonioCompleto(resultado);
            }
        });
    }

    // Restaura seletores ao trocar para outro tipo
    [newBtnIndividual, newBtnCasal, newBtnFamilia].forEach(btn => {
        btn.addEventListener('click', () => {
            const periodRow = document.querySelector('.rel-period-row');
            if (periodRow) periodRow.style.display = '';
        }, true);
    });
}

// _gerandoRelatorio é estado de dashboard.js, acessível via _ctx.

async function gerarRelatorio() {
    // Patrimônio + Score juntos — não precisam de mês/ano
    if (_ctx.tipoRelatorioAtivo === 'patrimonio') {
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) { resultado.classList.remove('js-hidden'); _gerarPatrimonioCompleto(resultado); }
        return;
    }

    if (_ctx._gerandoRelatorio) return; // CORREÇÃO: Debounce de segurança

    const mesEl = document.getElementById('mesRelatorio');
    const anoEl = document.getElementById('anoRelatorio');

    if (!mesEl || !anoEl) return;
    
    const mes = mesEl.value;
    const ano = anoEl.value;
    
    // "Todo o período" ignora mês E ano de propósito — não há recorte a validar.
    const todoPeriodo = (mes === 'todos');

    // CORREÇÃO: Validar formato de mês e ano antes de processar
    if (!todoPeriodo) {
        if (!mes || !ano) {
            return _ctx.mostrarNotificacao('Por favor, selecione o mês e o ano.', 'error');
        }
        if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) {
            return _ctx.mostrarNotificacao('Mês inválido.', 'error');
        }
        if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) {
            return _ctx.mostrarNotificacao('Ano inválido.', 'error');
        }
    }
    
    _ctx._gerandoRelatorio = true;
    try {
        if (_ctx.tipoRelatorioAtivo === 'individual') {
            const perfilEl = document.getElementById('selectPerfilRelatorio');
            if (!perfilEl) return;
            const perfilId = perfilEl.value;
            if (!perfilId) return _ctx.mostrarNotificacao('Por favor, selecione um perfil.', 'error');
            // CORREÇÃO: Validar que perfilId realmente existe nos perfis do usuário
            const perfilExiste = _ctx.usuarioLogado?.perfis?.some(p => String(p.id) === String(perfilId));
            if (!perfilExiste) return _ctx.mostrarNotificacao('Perfil inválido.', 'error');
            await gerarRelatorioIndividual(mes, ano, perfilId);
        } else if (_ctx.tipoRelatorioAtivo === 'casal') {
            if (_ctx.usuarioLogado.plano === 'Família' && _ctx.usuarioLogado.perfis.length > 2) {
                abrirSelecaoPerfisCasal(mes, ano);
            } else {
                await gerarRelatorioCompartilhado(mes, ano, 2);
            }
        } else {
            const numPerfis = Math.min(_ctx.usuarioLogado?.perfis?.length || 0, 20); // CORREÇÃO: Limite máximo
            await gerarRelatorioCompartilhado(mes, ano, numPerfis);
        }
    } finally {
        _ctx._gerandoRelatorio = false;
    }
}

    // ========== SELEÇÃO DE PERFIS PARA RELATÓRIO CASAL (PLANO FAMÍLIA) ==========
window.abrirSelecaoPerfisCasal = function abrirSelecaoPerfisCasal(mes, ano) {
    if (!_periodoValido(mes, ano)) return;   // aceita também "todo o período"

    if (!Array.isArray(_ctx.usuarioLogado?.perfis)) return;

    let htmlPerfis = '';

    _ctx.usuarioLogado.perfis.forEach(perfil => {
        const idSeguro   = _ctx.sanitizeHTML(String(perfil.id));
        const nomeSeguro = _ctx.sanitizeHTML(String(perfil.nome || '').slice(0, 100));

        // ✅ CORREÇÃO: onmouseover/onmouseout removidos pelo sanitizarHTMLPopup
        //    Substituídos por classes CSS ou event delegation após criação do popup
        htmlPerfis += `
            <div style="margin-bottom:12px;">
                <label class="perfil-label-casal" style="display:flex; align-items:center; gap:10px; padding:12px; background:rgba(255,255,255,0.05); border-radius:10px; cursor:pointer; transition:background 0.3s;">
                    <input type="checkbox" class="perfil-checkbox-casal" value="${idSeguro}"
                           style="width:20px; height:20px; cursor:pointer; accent-color:var(--primary);">
                    <span style="font-weight:600; color: var(--text-primary);">${nomeSeguro}</span>
                </label>
            </div>
        `;
    });

    _ctx.criarPopup(`
        <h3>👥 Selecione 2 Perfis para Relatório Casal</h3>
        <p style="color: var(--text-secondary); margin-bottom:20px; font-size:0.9rem;">
            Escolha exatamente 2 perfis para gerar o relatório conjunto
        </p>
        <div style="max-height:300px; overflow-y:auto; margin-bottom:20px;">
            ${htmlPerfis}
        </div>
        <div id="avisoSelecao" style="display:none; background:rgba(255,75,75,0.1); padding:12px; border-radius:8px; margin-bottom:16px; border-left:3px solid #ff4b4b;">
            <span style="color:#ff4b4b; font-weight:600;">⚠️ Selecione exatamente 2 perfis</span>
        </div>
        <button class="btn-primary" id="btnConfirmarCasal" data-mes="${sanitizeHTML(mes)}" data-ano="${sanitizeHTML(ano)}" style="width:100%; margin-bottom:10px;">
            Gerar Relatório
        </button>
        <button class="btn-cancelar" id="btnCancelarCasal" style="width:100%;">
            Cancelar
        </button>
    `);

    // ✅ CORREÇÃO: addEventListener no botão Cancelar em vez de onclick inline
    //    onclick="fecharPopup()" é removido pelo sanitizarHTMLPopup — botão ficava morto
    const btnCancelar = document.getElementById('btnCancelarCasal');
    if (btnCancelar) {
        btnCancelar.addEventListener('click', _ctx.fecharPopup);
    }

    const btnConfirmar = document.getElementById('btnConfirmarCasal');
    if (btnConfirmar) {
        btnConfirmar.addEventListener('click', function () {
            const m = this.getAttribute('data-mes');
            const a = this.getAttribute('data-ano');
            window.confirmarSelecaoPerfisCasal(m, a);
        });
    }

    // ✅ CORREÇÃO: hover nos labels via JavaScript em vez de onmouseover/onmouseout inline
    document.querySelectorAll('.perfil-label-casal').forEach(label => {
        label.addEventListener('mouseover', () => { label.style.background = 'rgba(67,160,71,0.1)'; });
        label.addEventListener('mouseout',  () => { label.style.background = 'rgba(255,255,255,0.05)'; });
    });
};

window.confirmarSelecaoPerfisCasal = function confirmarSelecaoPerfisCasal(mes, ano) {
    if (!_periodoValido(mes, ano)) return;   // aceita também "todo o período"

    const checkboxes = document.querySelectorAll('.perfil-checkbox-casal:checked');
    const avisoEl = document.getElementById('avisoSelecao');

    if (checkboxes.length !== 2) {
        if (avisoEl) {
            avisoEl.style.display = 'block';
            setTimeout(() => { avisoEl.style.display = 'none'; }, 3000);
        }
        return;
    }

    const perfisIds = Array.from(checkboxes).map(cb => cb.value);

    const idsValidos = perfisIds.every(id =>
        _ctx.usuarioLogado?.perfis?.some(p => String(p.id) === String(id))
    );
    if (!idsValidos) {
        console.error('IDs de perfis inválidos detectados');
        return;
    }

    _ctx.fecharPopup();
    window.gerarRelatorioCompartilhadoPersonalizado(mes, ano, perfisIds);
};

// ========== GERAR RELATÓRIO CASAL PERSONALIZADO ==========
window.gerarRelatorioCompartilhadoPersonalizado = async function gerarRelatorioCompartilhadoPersonalizado(mes, ano, perfisIds) {
    if (!_periodoValido(mes, ano)) return;   // aceita também "todo o período"
    if (!Array.isArray(perfisIds) || perfisIds.length !== 2) return;

    const periodoSelecionado = _prefixoPeriodo(mes, ano);

    const perfisAtivos = _ctx.usuarioLogado.perfis.filter(p =>
        perfisIds.includes(String(p.id))
    );

    if (perfisAtivos.length !== 2) {
        _ctx.mostrarNotificacao('É necessário selecionar exatamente 2 perfis.', 'error');
        return;
    }

    let mesAnterior, anoAnterior;
    if (mes === '01') {
        mesAnterior = '12';
        anoAnterior = String(Number(ano) - 1);
    } else {
        mesAnterior = String(Number(mes) - 1).padStart(2, '0');
        anoAnterior = ano;
    }
    const periodoAnterior = `${anoAnterior}-${mesAnterior}`;

    const userData = await dataManager.loadUserData();

    if (!_ctx.validarUserData(userData)) {
        console.error('Dados do usuário inválidos ou corrompidos');
        return;
    }

    const dadosPorPerfil = perfisAtivos.map(perfil => {
        const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfil.id));
        const transacoesPerfil = Array.isArray(dadosPerfil?.transacoes) ? dadosPerfil.transacoes : [];
        const metasPerfil = Array.isArray(dadosPerfil?.metas) ? dadosPerfil.metas : [];
        const cartoesPerfil = Array.isArray(dadosPerfil?.cartoesCredito) ? dadosPerfil.cartoesCredito : [];

        const transacoesPeriodo = transacoesPerfil.filter(t => {
            if (!t || typeof t !== 'object') return false;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO) return false;
            return dataISO.startsWith(periodoSelecionado);
        });

        let saldoInicial = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO || dataISO >= periodoSelecionado) return;
            const valor = _ctx.sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') saldoInicial += valor;
            else if (t.categoria === 'saida') saldoInicial -= valor;
            else if (t.categoria === 'reserva') saldoInicial -= valor;
            else if (t.categoria === 'retirada_reserva') saldoInicial += valor;
        });

        let entradas = 0, saidas = 0, totalGuardado = 0, totalRetirado = 0;
        const categorias = safeCategorias();

        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
            const valor = _ctx.sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') {
                entradas += valor;
            } else if (t.categoria === 'saida') {
                saidas += valor;
                if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                    const tipoKey = t.tipo.trim();
                    categorias[tipoKey] = (categorias[tipoKey] || 0) + valor;
                }
            } else if (t.categoria === 'reserva') {
                totalGuardado += valor;
                saidas += valor;
            } else if (t.categoria === 'retirada_reserva') {
                totalRetirado += valor;
                saidas -= valor;
            }
        });

        const saldoDoMes = entradas - saidas;
        const saldoFinal = saldoInicial + saldoDoMes;

        let entradasAnt = 0, saidasAnt = 0, guardadoAnt = 0, retiradoAnt = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoAnterior)) return;
            const valor = _ctx.sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') entradasAnt += valor;
            else if (t.categoria === 'saida') saidasAnt += valor;
            else if (t.categoria === 'reserva') { guardadoAnt += valor; saidasAnt += valor; }
            else if (t.categoria === 'retirada_reserva') { retiradoAnt += valor; saidasAnt -= valor; }
        });

        const reservasLiquido = totalGuardado - totalRetirado;
        const reservasLiquidoAnt = guardadoAnt - retiradoAnt;
        const taxaEconomia = entradas > 0 ? ((reservasLiquido / entradas) * 100) : 0;
        const taxaEconomiaAnt = entradasAnt > 0 ? ((reservasLiquidoAnt / entradasAnt) * 100) : 0;

        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            if (!c || typeof c !== 'object') return;
            totalLimiteCartoes += _ctx.sanitizeNumber(c.limite);
            totalUsadoCartoes += _ctx.sanitizeNumber(c.usado);
        });

        return {
            perfil,
            entradas, saidas, reservas: reservasLiquido,
            totalGuardado, totalRetirado,
            saldoInicial, saldoDoMes, saldo: saldoFinal,
            categorias, transacoes: transacoesPeriodo,
            metas: metasPerfil, cartoes: cartoesPerfil,
            totalLimiteCartoes, totalUsadoCartoes,
            mesAnterior: { entradas: entradasAnt, saidas: saidasAnt, reservas: reservasLiquidoAnt, saldo: entradasAnt - saidasAnt },
            taxaEconomia, taxaEconomiaAnterior: taxaEconomiaAnt,
            evolucaoEconomia: taxaEconomia - taxaEconomiaAnt
        };
    });

    const temDados = dadosPorPerfil.some(d => d.transacoes.length > 0);
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;

    if (!temDados) {
        // ✅ _sanitizarHTMLRelatorio (DOMParser) — consistente com todo o módulo
        resultado.innerHTML = _sanitizarHTMLRelatorio(`
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas para os perfis selecionados em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</p>
                <p style="margin-top:12px; color: var(--text-muted);">
                    Perfis: ${perfisAtivos.map(p => sanitizeHTML(String(p.nome || ''))).join(', ')}
                </p>
            </div>
        `);
        resultado.classList.remove('js-hidden');
        return;
    }

    renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior);
};

// ✅ HELPER: aplica sanitizarHTMLPopup antes de qualquer atribuição de innerHTML/insertAdjacentHTML
//    Centraliza a sanitização para todos os relatórios — evita esquecimento futuro
function _sanitizarHTMLRelatorio(html) {
    if (typeof html !== 'string' || !html.trim()) return '';
    // Reutiliza o sanitizador DOMParser já existente no módulo
    // Aplica: whitelist CSS, remoção de tags perigosas, remoção de on*, bloqueio de javascript:
    return sanitizarHTMLPopup(html);
}

async function gerarRelatorioIndividual(mes, ano, perfilId) {
    if (!_periodoValido(mes, ano)) return;   // aceita também "todo o período"
    if (!perfilId) return;

    const userData = await dataManager.loadUserData();

    if (!_ctx.validarUserData(userData)) {
        console.error('❌ Dados do usuário inválidos');
        return;
    }

    const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfilId));

    if (!dadosPerfil) {
        console.error('❌ Perfil não encontrado no DataManager');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) {
            resultado.innerHTML = '';
            const div = document.createElement('div');
            div.className = 'relatorio-vazio';
            const h3 = document.createElement('h3');
            h3.textContent = '⚠️ Erro ao Carregar Dados';
            const p = document.createElement('p');
            p.textContent = 'Não foi possível encontrar os dados do perfil selecionado.';
            div.appendChild(h3);
            div.appendChild(p);
            resultado.appendChild(div);
            resultado.classList.remove('js-hidden');
        }
        return;
    }

    const transacoesPerfil    = Array.isArray(dadosPerfil.transacoes)     ? dadosPerfil.transacoes     : [];
    const metasPerfil         = Array.isArray(dadosPerfil.metas)          ? dadosPerfil.metas          : [];
    const cartoesPerfil       = Array.isArray(dadosPerfil.cartoesCredito) ? dadosPerfil.cartoesCredito : [];
    const contasFixasPerfil   = Array.isArray(dadosPerfil.contasFixas)    ? dadosPerfil.contasFixas    : [];

    const periodoSelecionado  = _prefixoPeriodo(mes, ano);
    const hojeISO             = new Date().toISOString().slice(0, 10);

    const transacoesPeriodo = transacoesPerfil.filter(t => {
        if (!t || typeof t !== 'object') return false;
        const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
        if (!dataISO) return false;
        if (t.categoria === 'retirada_reserva') return false;
        return dataISO.startsWith(periodoSelecionado);
    });

    let saldoInicial = 0;
    transacoesPerfil.forEach(t => {
        if (!t || typeof t !== 'object') return;
        const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
        if (!dataISO || dataISO >= periodoSelecionado) return;
        const valor = _ctx.sanitizeNumber(t.valor);
        if (t.categoria === 'entrada')            saldoInicial += valor;
        else if (t.categoria === 'saida')         saldoInicial -= valor;
        else if (t.categoria === 'reserva')       saldoInicial -= valor;
        else if (t.categoria === 'retirada_reserva') saldoInicial += valor;
    });

    let totalEntradas = 0, totalSaidas = 0, totalGuardado = 0, totalRetirado = 0;
    const categorias = safeCategorias();

    transacoesPerfil.forEach(t => {
        if (!t || typeof t !== 'object') return;
        const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
        if (!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
        const valor = _ctx.sanitizeNumber(t.valor);
        if (t.categoria === 'entrada') {
            totalEntradas += valor;
        } else if (t.categoria === 'saida') {
            totalSaidas += valor;
            if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                const tipoKey = t.tipo.trim();
                categorias[tipoKey] = (categorias[tipoKey] || 0) + valor;
            }
        } else if (t.categoria === 'reserva') {
            totalGuardado += valor;
        } else if (t.categoria === 'retirada_reserva') {
            totalRetirado += valor;
        }
    });

    const valorReservadoLiquido = totalGuardado - totalRetirado;
    const saldoDoMes            = totalEntradas - totalSaidas;
    const saldoFinal            = saldoInicial + saldoDoMes - valorReservadoLiquido;

    const [anoAtual, mesAtual]      = hojeISO.split('-').slice(0, 2);
    const periodoAtualCompleto      = `${anoAtual}-${mesAtual}`;

    const contasFixasMes = contasFixasPerfil.filter(c => {
        if (!c || typeof c !== 'object') return false;
        if (!c.vencimento) return false;
        if (c.vencimento.startsWith(periodoSelecionado)) return true;
        const pagamentoNoMes = transacoesPerfil.find(t => {
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            return dataISO &&
                dataISO.startsWith(periodoSelecionado) &&
                String(t.contaFixaId) === String(c.id) &&
                t.tipo === 'Conta Fixa';
        });
        if (pagamentoNoMes) return true;
        if (periodoSelecionado === periodoAtualCompleto &&
            c.vencimento < periodoSelecionado && !c.pago) return true;
        return false;
    });

    const taxaEconomia       = totalEntradas > 0 ?
        ((valorReservadoLiquido / totalEntradas) * 100).toFixed(1) : 0;
    const diasNoMes          = new Date(Number(ano), Number(mes), 0).getDate();
    const mediaGastoDiario   = diasNoMes > 0 ? totalSaidas / diasNoMes : 0;

    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;

    const perfilNome = _ctx.sanitizeHTML(
        String(_ctx.usuarioLogado.perfis.find(p => String(p.id) === String(perfilId))?.nome || 'Perfil').slice(0, 100)
    );

    if (transacoesPeriodo.length === 0 && contasFixasMes.length === 0) {
        resultado.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'relatorio-vazio';
        const h3 = document.createElement('h3');
        h3.textContent = '📊 Nenhum relatório disponível';
        const p = document.createElement('p');
        p.textContent = `Não há transações ou contas registradas para ${perfilNome} em ${getMesNome(mes)} de ${ano}`;
        div.appendChild(h3);
        div.appendChild(p);
        resultado.appendChild(div);
        resultado.classList.remove('js-hidden');
        return;
    }

    let html = `
    <div class="rel-report-header">
        <div class="rel-report-title">Relatório de ${perfilNome}</div>
        <span class="rel-report-badge"><i class="fas fa-calendar-alt"></i> ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</span>
    </div>
    <div class="rel-kpi-grid">
        <div class="rel-kpi-card rel-kpi-card--entradas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-up rel-kpi-icon"></i><span class="rel-kpi-label">Entradas</span></div>
            <div class="rel-kpi-value">${formatBRL(totalEntradas)}</div>
            <div class="rel-kpi-sub">Total do período</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saidas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-down rel-kpi-icon"></i><span class="rel-kpi-label">Saídas</span></div>
            <div class="rel-kpi-value">${formatBRL(totalSaidas)}</div>
            <div class="rel-kpi-sub">Total do período</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--guardado">
            <div class="rel-kpi-top"><i class="fas fa-piggy-bank rel-kpi-icon"></i><span class="rel-kpi-label">Guardado Líquido</span></div>
            <div class="rel-kpi-value">${formatBRL(valorReservadoLiquido)}</div>
            <div class="rel-kpi-sub">Guardou: ${formatBRL(totalGuardado)} · Retirou: ${formatBRL(totalRetirado)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saldo">
            <div class="rel-kpi-top"><i class="fas fa-wallet rel-kpi-icon"></i><span class="rel-kpi-label">Saldo Total</span></div>
            <div class="rel-kpi-value">${formatBRL(saldoFinal)}</div>
            <div class="rel-kpi-sub">Inicial: ${formatBRL(saldoInicial)} · Mês: ${formatBRL(saldoDoMes)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--economia">
            <div class="rel-kpi-top"><i class="fas fa-gem rel-kpi-icon"></i><span class="rel-kpi-label">Taxa de Economia</span></div>
            <div class="rel-kpi-value">${sanitizeHTML(String(taxaEconomia))}%</div>
            <div class="rel-kpi-sub">Do que ganhou foi guardado</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--media">
            <div class="rel-kpi-top"><i class="fas fa-calendar-day rel-kpi-icon"></i><span class="rel-kpi-label">Gasto Médio/Dia</span></div>
            <div class="rel-kpi-value">${formatBRL(mediaGastoDiario)}</div>
            <div class="rel-kpi-sub">Média diária de gastos</div>
        </div>
    </div>
    `;

    // ── Visão Geral (donut + top gastos) ─────────────────────────────────────
    {
        const totalVG   = totalEntradas + totalSaidas + Math.max(0, valorReservadoLiquido);
        const pEnt      = totalVG > 0 ? (totalEntradas / totalVG * 100) : 0;
        const pSai      = totalVG > 0 ? (totalSaidas   / totalVG * 100) : 0;
        const pRes      = totalVG > 0 ? (Math.max(0, valorReservadoLiquido) / totalVG * 100) : 0;
        const seg1      = pEnt.toFixed(2);
        const seg2      = (pEnt + pSai).toFixed(2);
        const seg3      = (pEnt + pSai + pRes).toFixed(2);
        const donutGrad = `conic-gradient(var(--success) 0% ${seg1}%, var(--danger) ${seg1}% ${seg2}%, var(--warning) ${seg2}% ${seg3}%, rgba(255,255,255,0.05) ${seg3}% 100%)`;

        html += `
        <div class="rel-section rel-section--visao-geral">
            <div class="rel-section-header"><i class="fas fa-chart-pie"></i><span>Visão Geral</span></div>
            <div class="rel-vg-wrap">
                <div class="rel-vg-donut-wrap">
                    <div class="rel-vg-donut" style="background: ${donutGrad}"></div>
                    <div class="rel-vg-inner">
                        <span class="rel-vg-center-val">${formatBRL(saldoFinal)}</span>
                        <span class="rel-vg-center-label">Saldo total</span>
                    </div>
                </div>
                <div class="rel-vg-legend">
                    <div class="rel-vg-leg-item">
                        <span class="rel-vg-leg-dot" style="background: var(--success)"></span>
                        <div class="rel-vg-leg-info">
                            <span class="rel-vg-leg-label">Entradas</span>
                            <span class="rel-vg-leg-val" style="color: var(--success)">${formatBRL(totalEntradas)}</span>
                        </div>
                        <span class="rel-vg-leg-pct">${pEnt.toFixed(1)}%</span>
                    </div>
                    <div class="rel-vg-leg-item">
                        <span class="rel-vg-leg-dot" style="background: var(--danger)"></span>
                        <div class="rel-vg-leg-info">
                            <span class="rel-vg-leg-label">Saídas</span>
                            <span class="rel-vg-leg-val" style="color: var(--danger)">${formatBRL(totalSaidas)}</span>
                        </div>
                        <span class="rel-vg-leg-pct">${pSai.toFixed(1)}%</span>
                    </div>
                    <div class="rel-vg-leg-item">
                        <span class="rel-vg-leg-dot" style="background: var(--warning)"></span>
                        <div class="rel-vg-leg-info">
                            <span class="rel-vg-leg-label">Reservas</span>
                            <span class="rel-vg-leg-val" style="color: var(--warning)">${formatBRL(valorReservadoLiquido)}</span>
                        </div>
                        <span class="rel-vg-leg-pct">${pRes.toFixed(1)}%</span>
                    </div>
                    <div class="rel-vg-leg-item">
                        <span class="rel-vg-leg-dot" style="background: var(--accent)"></span>
                        <div class="rel-vg-leg-info">
                            <span class="rel-vg-leg-label">Saldo</span>
                            <span class="rel-vg-leg-val" style="color: var(--accent)">${formatBRL(saldoFinal)}</span>
                        </div>
                        <span class="rel-vg-leg-pct">-</span>
                    </div>
                </div>
            </div>`;

        if (Object.keys(categorias).length > 0) {
            const categoriasOrdenadas  = Object.entries(categorias).sort((a, b) => b[1] - a[1]).slice(0, 5);
            const totalGastoCategorias = Object.values(categorias).reduce((a, b) => a + b, 0);
            const coresCategorias      = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];
            html += `<div class="rel-vg-cats-header"><i class="fas fa-chart-bar"></i><span>Top 5 Gastos</span></div><div class="rel-cat-list">`;
            categoriasOrdenadas.forEach(([cat, valor], i) => {
                const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
                html += `
                    <div class="rel-cat-item">
                        <div class="rel-cat-info">
                            <div class="rel-cat-dot" style="background:${coresCategorias[i]};"></div>
                            <span class="rel-cat-name">${sanitizeHTML(cat)}</span>
                        </div>
                        <div class="rel-cat-bar-wrap">
                            <div class="rel-cat-bar-track"><div class="rel-cat-bar-fill" style="width:${sanitizeHTML(String(percentual))}%; background:${coresCategorias[i]};"></div></div>
                            <span class="rel-cat-value">${formatBRL(valor)}</span>
                        </div>
                    </div>`;
            });
            html += `</div>`;
        }
        html += `</div>`;
    }

    // ── Insights do Período ──────────────────────────────────────────────────
    {
        const topCatEntry = Object.entries(categorias).sort((a, b) => b[1] - a[1])[0];
        const topCatNome  = topCatEntry ? sanitizeHTML(String(topCatEntry[0]).slice(0, 60)) : null;
        const topCatVal   = topCatEntry ? topCatEntry[1] : 0;
        const taxa        = Number(taxaEconomia);

        // 1. Performance
        const insightPerf = taxa >= 30
            ? `Incrível! Você guardou ${sanitizeHTML(String(taxaEconomia))}% da sua renda — no caminho da liberdade financeira.`
            : taxa > 0
                ? `Você economizou ${sanitizeHTML(String(taxaEconomia))}% do que ganhou neste período.`
                : totalEntradas > 0
                    ? 'Nenhum valor foi guardado neste período. Comece a reservar hoje!'
                    : 'Adicione entradas para calcular sua taxa de economia.';

        // 2. Maior gasto
        const insightGasto = topCatNome
            ? `${topCatNome} com ${formatBRL(topCatVal)}`
            : 'Nenhum gasto registrado no período.';

        // 3. Pressão das contas fixas
        const totalContasMes = contasFixasMes.reduce((s, c) => s + sanitizeNumber(c.valor), 0);
        const percContas = totalEntradas > 0 ? ((totalContasMes / totalEntradas) * 100).toFixed(0) : 0;
        const insightContas = contasFixasMes.length === 0
            ? 'Nenhuma conta fixa cadastrada. Adicione no Dashboard!'
            : totalEntradas > 0
                ? Number(percContas) > 60
                    ? `Atenção: contas fixas (${formatBRL(totalContasMes)}) consomem ${percContas}% da renda. Revise seus compromissos.`
                    : `Suas ${contasFixasMes.length} conta${contasFixasMes.length > 1 ? 's' : ''} fixa${contasFixasMes.length > 1 ? 's' : ''} somam ${formatBRL(totalContasMes)} (${percContas}% da renda).`
                : `Você tem ${contasFixasMes.length} conta${contasFixasMes.length > 1 ? 's' : ''} fixa${contasFixasMes.length > 1 ? 's' : ''} totalizando ${formatBRL(totalContasMes)}.`;

        // 4. Saúde financeira (relação gastos/renda)
        const percGastos = totalEntradas > 0 ? ((totalSaidas / totalEntradas) * 100).toFixed(0) : 0;
        const insightSaude = totalEntradas === 0
            ? 'Registre suas entradas para analisar sua saúde financeira.'
            : Number(percGastos) > 90
                ? `Seus gastos (${percGastos}% da renda) estão críticos. Reduza despesas imediatamente.`
                : Number(percGastos) > 70
                    ? `Gastos em ${percGastos}% da renda. Tente manter abaixo de 70% para ter folga financeira.`
                    : Number(percGastos) > 0
                        ? `Gastos controlados em ${percGastos}% da renda. Bom equilíbrio!`
                        : 'Registre seus gastos para análise completa.';

        // 5. Oportunidade / dica de ação
        const insightOp = totalSaidas === 0 && totalEntradas > 0
            ? 'Registre seus gastos para obter insights personalizados.'
            : taxa >= 20
                ? 'Ótima taxa de economia! Continue assim para atingir suas metas mais rápido.'
                : taxa > 0
                    ? 'Tente guardar pelo menos 20% do seu ganho mensal (regra 50/30/20).'
                    : 'Adicione reservas para melhorar sua saúde financeira.';

        html += `
        <div class="rel-section rel-section--insights">
            <div class="rel-section-header"><i class="fas fa-lightbulb"></i><span>Insights do Período</span></div>
            <div class="rel-insight-list">
                <div class="rel-insight-item">
                    <div class="rel-insight-icon-wrap rel-insight-icon--perf"><i class="fas fa-chart-line"></i></div>
                    <div class="rel-insight-body">
                        <div class="rel-insight-title">Performance</div>
                        <div class="rel-insight-text">${insightPerf}</div>
                    </div>
                </div>
                <div class="rel-insight-item">
                    <div class="rel-insight-icon-wrap rel-insight-icon--gasto"><i class="fas fa-arrow-down"></i></div>
                    <div class="rel-insight-body">
                        <div class="rel-insight-title">Maior gasto</div>
                        <div class="rel-insight-text">${insightGasto}</div>
                    </div>
                </div>
                <div class="rel-insight-item">
                    <div class="rel-insight-icon-wrap rel-insight-icon--contas"><i class="fas fa-file-invoice-dollar"></i></div>
                    <div class="rel-insight-body">
                        <div class="rel-insight-title">Contas fixas</div>
                        <div class="rel-insight-text">${insightContas}</div>
                    </div>
                </div>
                <div class="rel-insight-item">
                    <div class="rel-insight-icon-wrap rel-insight-icon--saude"><i class="fas fa-heartbeat"></i></div>
                    <div class="rel-insight-body">
                        <div class="rel-insight-title">Saúde financeira</div>
                        <div class="rel-insight-text">${insightSaude}</div>
                    </div>
                </div>
                <div class="rel-insight-item">
                    <div class="rel-insight-icon-wrap rel-insight-icon--op"><i class="fas fa-lightbulb"></i></div>
                    <div class="rel-insight-body">
                        <div class="rel-insight-title">Oportunidade</div>
                        <div class="rel-insight-text">${insightOp}</div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    if (cartoesPerfil.length > 0) {
        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            if (!c || typeof c !== 'object') return;
            totalLimiteCartoes += _ctx.sanitizeNumber(c.limite);
            totalUsadoCartoes  += _ctx.sanitizeNumber(c.usado);
        });
        const disponivelCartoes = totalLimiteCartoes - totalUsadoCartoes;
        const percUsado         = totalLimiteCartoes > 0 ?
            ((totalUsadoCartoes / totalLimiteCartoes) * 100).toFixed(1) : 0;

        const corUtilizado = Number(percUsado) > 80 ? 'var(--danger)' : 'var(--success)';
        html += `
            <div class="rel-section rel-section--cartoes">
                <div class="rel-section-header"><i class="fas fa-credit-card"></i><span>Cartões de Crédito</span></div>
                <div class="rel-cards-summary">
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Limite Total</span>
                        <span class="rel-card-stat-value">${formatBRL(totalLimiteCartoes)}</span>
                    </div>
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Usado</span>
                        <span class="rel-card-stat-value" style="color:var(--danger);">${formatBRL(totalUsadoCartoes)}</span>
                    </div>
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Disponível</span>
                        <span class="rel-card-stat-value" style="color:var(--success);">${formatBRL(disponivelCartoes)}</span>
                    </div>
                    <div class="rel-card-stat">
                        <span class="rel-card-stat-label">Utilizado</span>
                        <span class="rel-card-stat-value" style="color:${corUtilizado};">${sanitizeHTML(String(percUsado))}%</span>
                    </div>
                </div>
                <div id="listaCartoesRelatorio"></div>
            </div>`;

        resultado.innerHTML = _sanitizarHTMLRelatorio(html);
        _ctx._aplicarEstilosCSOM(resultado);
        resultado.classList.remove('js-hidden');

        const listaCartoes = document.getElementById('listaCartoesRelatorio');
        if (listaCartoes) {
            cartoesPerfil.forEach(c => {
                if (!c || typeof c !== 'object') return;
                const usado       = _ctx.sanitizeNumber(c.usado);
                const limite      = _ctx.sanitizeNumber(c.limite);
                const percCartao  = limite > 0 ? ((usado / limite) * 100).toFixed(1) : 0;
                const percNum     = Number(percCartao);
                const corBarra    = percNum > 80 ? '#ff4b4b' : percNum > 50 ? '#ffd166' : '#00ff99';
                const nomeBanco   = String(c.nomeBanco || '');

                // ── Outer card ──
                const div = document.createElement('div');
                div.className = 'rel-card-visual';
                div.style.background = _ctx.BANCO_COR[nomeBanco] || 'linear-gradient(135deg,#1a1d2e 0%,#2a2d3e 100%)';

                // ── Top row ──
                const topDiv = document.createElement('div');
                topDiv.className = 'rel-card-visual-top';

                // Icon (logo or abbreviation)
                const iconDiv = document.createElement('div');
                iconDiv.className = 'rel-card-visual-icon';
                const iconPath = _ctx.BANCO_ICON[nomeBanco];
                if (iconPath) {
                    const img = document.createElement('img');
                    img.className = 'rel-card-visual-img';
                    img.src   = iconPath;
                    img.alt   = '';  // decorativo
                    img.setAttribute('aria-hidden', 'true');
                    iconDiv.appendChild(img);
                } else {
                    const abrev = document.createElement('span');
                    abrev.className = 'rel-card-visual-icon-text';
                    abrev.textContent = _ctx.BANCO_ABREV[nomeBanco] || nomeBanco.substring(0, 2).toUpperCase();
                    iconDiv.appendChild(abrev);
                }

                // Info (name + limit)
                const infoDiv = document.createElement('div');
                infoDiv.className = 'rel-card-visual-info';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'rel-card-visual-name';
                nameSpan.textContent = nomeBanco;
                const subSpan = document.createElement('span');
                subSpan.className = 'rel-card-visual-sub';
                subSpan.textContent = `Limite: ${formatBRL(limite)}`;
                infoDiv.appendChild(nameSpan);
                infoDiv.appendChild(subSpan);

                // Right (used + perc)
                const rightDiv = document.createElement('div');
                rightDiv.className = 'rel-card-visual-right';
                const usadoSpan = document.createElement('span');
                usadoSpan.className = 'rel-card-visual-used';
                usadoSpan.textContent = _ctx.formatBRL(usado);
                const percSpan = document.createElement('span');
                percSpan.className = 'rel-card-visual-perc';
                percSpan.style.color = corBarra;
                percSpan.textContent = `${percCartao}% usado`;
                rightDiv.appendChild(usadoSpan);
                rightDiv.appendChild(percSpan);

                topDiv.appendChild(iconDiv);
                topDiv.appendChild(infoDiv);
                topDiv.appendChild(rightDiv);

                // ── Progress bar ──
                const barWrap = document.createElement('div');
                barWrap.className = 'rel-card-visual-bar-wrap';
                const barFill = document.createElement('div');
                barFill.className = 'rel-card-visual-bar-fill';
                barFill.style.width      = `${Math.min(100, percNum)}%`;
                barFill.style.background = corBarra;
                barWrap.appendChild(barFill);

                // ── Hint ──
                const dicaDiv = document.createElement('div');
                dicaDiv.className = 'rel-card-visual-hint';
                const dicaIc = document.createElement('i');
                dicaIc.className = 'fas fa-chevron-right';
                dicaIc.setAttribute('aria-hidden', 'true');
                dicaDiv.appendChild(document.createTextNode('Toque para ver detalhes'));
                dicaDiv.appendChild(dicaIc);

                div.appendChild(topDiv);
                div.appendChild(barWrap);
                div.appendChild(dicaDiv);

                div.addEventListener('click', () => { abrirDetalhesCartaoRelatorio(c.id, mes, ano, perfilId); });
                listaCartoes.appendChild(div);
            });
        }

        html = '';
    }

    if (metasPerfil.length > 0) {
        html += `
            <div class="rel-section rel-section--metas">
                <div class="rel-section-header"><i class="fas fa-bullseye"></i><span>Progresso das Metas</span></div>
                <div class="rel-meta-selector-wrap">
                    <select id="selectMetaRelatorio" class="form-input">
                        <option value="">Selecione uma meta...</option>
        `;
        metasPerfil.forEach(m => {
            if (!m || typeof m !== 'object') return;
            html += `<option value="${sanitizeHTML(String(m.id))}">${sanitizeHTML(String(m.descricao || '').slice(0, 100))}</option>`;
        });
        html += `</select></div><div id="detalhesMetaRelatorio" style="display:none;"></div></div>`;
    }

    const contasComStatus = contasFixasMes.map(c => {
        if (!c || typeof c !== 'object') return null;
        let status = 'Pendente', corStatus = '#ffd166', corFundo = 'rgba(255,209,102,0.1)';
        const pagamentoNoMes = transacoesPerfil.find(t => {
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            return dataISO && dataISO.startsWith(periodoSelecionado) &&
                String(t.contaFixaId) === String(c.id) && t.tipo === 'Conta Fixa';
        });
        if (pagamentoNoMes || c.pago) {
            status = 'Paga'; corStatus = '#00ff99'; corFundo = 'rgba(0,255,153,0.1)';
        } else if (c.vencimento < hojeISO) {
            status = 'Vencido'; corStatus = '#ff4b4b'; corFundo = 'rgba(255,75,75,0.1)';
        }
        return { ...c, status, corStatus, corFundo };
    }).filter(Boolean);

    const contasPagas     = contasComStatus.filter(c => c.status === 'Paga').length;
    const contasPendentes = contasComStatus.filter(c => c.status === 'Pendente').length;
    const contasVencidas  = contasComStatus.filter(c => c.status === 'Vencida').length;
    const totalContasValor = contasComStatus.reduce((sum, c) => sum + _ctx.sanitizeNumber(c.valor), 0);

    html += `
        <div class="rel-section rel-section--contas">
            <div class="rel-section-header"><i class="fas fa-file-invoice-dollar"></i><span>Contas Fixas do Mês</span></div>
            <div class="rel-bills-chips">
                <div class="rel-bill-chip rel-bill-chip--success">
                    <span class="rel-bill-chip-count">${contasPagas}</span>
                    <span class="rel-bill-chip-label">Pagas</span>
                </div>
                <div class="rel-bill-chip rel-bill-chip--warning">
                    <span class="rel-bill-chip-count">${contasPendentes}</span>
                    <span class="rel-bill-chip-label">Pendentes</span>
                </div>
                <div class="rel-bill-chip rel-bill-chip--danger">
                    <span class="rel-bill-chip-count">${contasVencidas}</span>
                    <span class="rel-bill-chip-label">Vencidas</span>
                </div>
                <div class="rel-bill-chip">
                    <span class="rel-bill-chip-count" style="font-size:0.72rem;">${formatBRL(totalContasValor)}</span>
                    <span class="rel-bill-chip-label">Total</span>
                </div>
            </div>
            <div class="rel-bills-list">
    `;

    if (contasComStatus.length > 0) {
        const pagas     = contasComStatus.filter(c => c.status === 'Paga');
        const pendentes = contasComStatus.filter(c => c.status === 'Pendente');
        const vencidas  = contasComStatus.filter(c => c.status === 'Vencida');

        const _statusClass = (s) => s === 'Paga' ? 'paga' : s === 'Vencida' ? 'vencida' : 'pendente';
        const renderConta = (c) => `
            <div class="rel-bill-item rel-bill-item--${_statusClass(c.status)}">
                <div class="rel-bill-dot"></div>
                <div class="rel-bill-info">
                    <span class="rel-bill-name">${sanitizeHTML(String(c.descricao || '').slice(0, 100))}</span>
                    <span class="rel-bill-date">Vence: ${sanitizeHTML(formatarDataBR(c.vencimento))}</span>
                </div>
                <div class="rel-bill-amount">${formatBRL(sanitizeNumber(c.valor))}</div>
                <div class="rel-bill-badge">${sanitizeHTML(c.status)}</div>
            </div>`;

        const todasContas = [...pagas, ...pendentes, ...vencidas];
        html += todasContas.length > 0
            ? todasContas.map(renderConta).join('')
            : `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.85rem;">Nenhuma conta fixa registrada</div>`;
    } else {
        html += `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.85rem;">
                ${periodoSelecionado === periodoAtualCompleto ?
                    'Nenhuma conta fixa cadastrada. Adicione no Dashboard!' :
                    'Sem contas fixas neste período.'}
            </div>`;
    }
    html += `</div></div>`;

    if (transacoesPeriodo.length > 0) {
        html += `<div class="rel-section rel-section--transacoes"><div class="rel-section-header"><i class="fas fa-list"></i><span>Todas as Transações (${transacoesPeriodo.length})</span></div><div class="rel-tx-list">`;

        transacoesPeriodo.sort((a, b) => {
            const dataHoraA = `${sanitizeDate(dataParaISO(a.data)) || ''} ${String(a.hora || '')}`;
            const dataHoraB = `${sanitizeDate(dataParaISO(b.data)) || ''} ${String(b.hora || '')}`;
            return dataHoraB.localeCompare(dataHoraA);
        });

        // Passo 7 — não despeja o período inteiro de uma vez. Um ano de dados
        // vira milhares de nós numa string só: o relatório demora a aparecer e o
        // DOM fica pesado para sempre. Mostra as mais recentes e guarda o resto.
        //
        // O corte é SÓ DE EXIBIÇÃO. Relatório financeiro que omite transação em
        // silêncio é pior que relatório lento — por isso: o botão diz quantas
        // faltam, e a exportação (PDF/apresentação, que CLONAM o DOM) expande
        // tudo antes de clonar. CSV/Excel nunca dependeram disso: leem
        // `_getTxsDoPeriodo()`, os dados crus.
        const _visiveis = transacoesPeriodo.slice(0, REL_TX_VISIVEIS);
        const _restantes = transacoesPeriodo.slice(REL_TX_VISIVEIS);

        _visiveis.forEach(t => { html += _relTxItemHtml(t); });

        if (_restantes.length > 0) {
            _relTxPendentes = _restantes;      // consumido por _relExpandirTx()
            html += `
                <button type="button" id="relTxVerMais" class="btn-primary" style="width:100%; margin-top:10px;">
                    Ver todas — mais ${_restantes.length} transaç${_restantes.length === 1 ? 'ão' : 'ões'}
                </button>`;
        } else {
            _relTxPendentes = [];
        }
        html += `</div></div>`;
    }

    // ✅ CORREÇÃO PRINCIPAL: aplica _sanitizarHTMLRelatorio (DOMParser + whitelist CSS)
    //    antes de qualquer atribuição innerHTML ou insertAdjacentHTML.
    //    Isso garante que mesmo dados de usuário que passaram por sanitizeHTML (escape de entidades)
    //    também sejam verificados pelo whitelist CSS, remoção de on*, remoção de tags perigosas
    //    e bloqueio de esquemas javascript:/vbscript:/data: em atributos.
    //    Crítico para planos Família/Casal onde dados do dono são exibidos para membros convidados.
    if (html) {
        resultado.insertAdjacentHTML('beforeend', _sanitizarHTMLRelatorio(html));
        _ctx._aplicarEstilosCSOM(resultado);
    }
    resultado.classList.remove('js-hidden');

    if (metasPerfil.length > 0) {
        const selectMeta = document.getElementById('selectMetaRelatorio');
        if (selectMeta) {
            selectMeta.addEventListener('change', function () {
                const metaId    = this.value;
                const detalhesEl = document.getElementById('detalhesMetaRelatorio');
                if (!detalhesEl) return;
                if (!metaId) { detalhesEl.style.display = 'none'; return; }

                const meta = metasPerfil.find(m => String(m.id) === String(metaId));
                if (!meta) return;

                const saved      = _ctx.sanitizeNumber(meta.saved);
                const objetivo   = _ctx.sanitizeNumber(meta.objetivo);
                const falta      = Math.max(0, objetivo - saved);
                const perc       = objetivo > 0 ? Math.min(100, ((saved / objetivo) * 100).toFixed(1)) : 0;

                const depositosMes = transacoesPerfil.filter(t => {
                    const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
                    return dataISO && dataISO.startsWith(periodoSelecionado) &&
                        t.categoria === 'reserva' && String(t.metaId) === String(metaId);
                });
                const totalDepositadoMes = depositosMes.reduce((sum, t) => sum + _ctx.sanitizeNumber(t.valor), 0);

                const retiradasMes = transacoesPerfil.filter(t => {
                    const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
                    return dataISO && dataISO.startsWith(periodoSelecionado) &&
                        t.categoria === 'retirada_reserva' && String(t.metaId) === String(metaId);
                });
                const totalRetiradoMes = retiradasMes.reduce((sum, t) => sum + _ctx.sanitizeNumber(t.valor), 0);

                let corProgresso = '#ff4b4b';
                if (perc >= 75) corProgresso = '#00ff99';
                else if (perc >= 40) corProgresso = '#ffd166';

                // ── Projeção de conclusão ──
                const todosDepositosMeta = transacoesPerfil.filter(t =>
                    t.categoria === 'reserva' && String(t.metaId) === String(metaId)
                );
                const depositosPorMes = {};
                todosDepositosMeta.forEach(t => {
                    const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
                    if (!dataISO) return;
                    const mesKey = dataISO.slice(0, 7);
                    depositosPorMes[mesKey] = (depositosPorMes[mesKey] || 0) + _ctx.sanitizeNumber(t.valor);
                });
                const valoresPorMes     = Object.values(depositosPorMes);
                const mediaDepositoMes  = valoresPorMes.length > 0
                    ? valoresPorMes.reduce((a, b) => a + b, 0) / valoresPorMes.length
                    : 0;

                let projecaoHtml = '';
                if (falta <= 0) {
                    projecaoHtml = `<div class="rel-meta-projection rel-meta-projection--done">
                        <i class="fas fa-trophy"></i>
                        <span>Meta concluída! Parabéns!</span>
                    </div>`;
                } else if (mediaDepositoMes > 0) {
                    const mesesParaConcluir = Math.ceil(falta / mediaDepositoMes);
                    const anos             = Math.floor(mesesParaConcluir / 12);
                    const mesesRest        = mesesParaConcluir % 12;
                    const tempoTexto = anos > 0 && mesesRest > 0
                        ? `${anos} ano${anos > 1 ? 's' : ''} e ${mesesRest} mês${mesesRest > 1 ? 'es' : ''}`
                        : anos > 0
                            ? `${anos} ano${anos > 1 ? 's' : ''}`
                            : `${mesesParaConcluir} mês${mesesParaConcluir > 1 ? 'es' : ''}`;
                    projecaoHtml = `<div class="rel-meta-projection">
                        <div class="rel-meta-proj-header"><i class="fas fa-clock"></i><span>Projeção de conclusão</span></div>
                        <div class="rel-meta-proj-time">${sanitizeHTML(tempoTexto)}</div>
                        <div class="rel-meta-proj-sub">Com ${formatBRL(mediaDepositoMes)}/mês (média de ${sanitizeHTML(String(valoresPorMes.length))} mês${valoresPorMes.length > 1 ? 'es' : ''} com depósito)</div>
                    </div>`;
                } else {
                    projecaoHtml = `<div class="rel-meta-projection rel-meta-projection--empty">
                        <i class="fas fa-info-circle"></i>
                        <div class="rel-meta-proj-sub">Faça depósitos para ver a projeção de conclusão</div>
                    </div>`;
                }

                const detalhesHtml = `
                    <div class="rel-meta-detail">
                        <div class="rel-meta-detail-name">${sanitizeHTML(String(meta.descricao || '').slice(0, 100))}</div>
                        <div class="rel-meta-bar-wrap">
                            <div class="rel-meta-bar-track"><div class="rel-meta-bar-fill" style="width:${sanitizeHTML(String(perc))}%; background:${corProgresso};"></div></div>
                            <span class="rel-meta-bar-label" style="color:${corProgresso};">${sanitizeHTML(String(perc))}%</span>
                        </div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Objetivo</span><span class="rel-meta-info-value">${formatBRL(objetivo)}</span></div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Guardado</span><span class="rel-meta-info-value" style="color:var(--success);">${formatBRL(saved)}</span></div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Falta</span><span class="rel-meta-info-value" style="color:var(--danger);">${formatBRL(falta)}</span></div>
                        <div class="rel-meta-info-row"><span class="rel-meta-info-label">Depositado neste mês</span><span class="rel-meta-info-value" style="color:var(--warning);">${formatBRL(totalDepositadoMes)} <small style="font-weight:400; color:var(--text-muted);">(${depositosMes.length}x)</small></span></div>
                        ${totalRetiradoMes > 0 ? `<div class="rel-meta-info-row"><span class="rel-meta-info-label">Retirado neste mês</span><span class="rel-meta-info-value" style="color:#ff9500;">${formatBRL(totalRetiradoMes)} <small style="font-weight:400; color:var(--text-muted);">(${retiradasMes.length}x)</small></span></div>` : ''}
                        ${projecaoHtml}
                    </div>`;

                // ✅ CORREÇÃO: detalhesEl.innerHTML também passa pelo sanitizador DOMParser
                detalhesEl.innerHTML = _sanitizarHTMLRelatorio(detalhesHtml);
                detalhesEl.style.display = 'block';
            });
        }
    }
}

async function gerarRelatorioCompartilhado(mes, ano, numPerfis) {
    // CORREÇÃO: Validar inputs
    if (!_periodoValido(mes, ano)) return;   // aceita também "todo o período"
    
    // CORREÇÃO: Limitar numPerfis a um máximo razoável
    const numPerfisSeguro = Math.min(Math.max(parseInt(numPerfis, 10) || 0, 0), 20);
    
    const periodoSelecionado = _prefixoPeriodo(mes, ano);
    const perfisAtivos = (_ctx.usuarioLogado?.perfis || []).slice(0, numPerfisSeguro);
    
    if (perfisAtivos.length < 2) {
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) {
            // ✅ CORREÇÃO VULN #3: _sanitizarHTMLRelatorio adicionado — segunda camada DOMParser.
            //    Antes: innerHTML direto, sem DOMParser, sem whitelist CSS.
            //    Agora: consistente com todos os outros caminhos do relatório.
            //    Mesmo sendo HTML estático, a cobertura uniforme elimina o risco
            //    de regressão caso futuramente dados do usuário sejam adicionados aqui.
            resultado.innerHTML = _sanitizarHTMLRelatorio(`
                <div class="relatorio-vazio">
                    <h3>⚠️ Perfis Insuficientes</h3>
                    <p>Você precisa ter pelo menos 2 perfis cadastrados para gerar este tipo de relatório.</p>
                </div>
            `);
            resultado.classList.remove('js-hidden');
        }
        return;
    }

    let mesAnterior, anoAnterior;
    if (mes === '01') {
        mesAnterior = '12';
        anoAnterior = String(Number(ano) - 1);
    } else {
        mesAnterior = String(Number(mes) - 1).padStart(2, '0');
        anoAnterior = ano;
    }
    const periodoAnterior = `${anoAnterior}-${mesAnterior}`;
    
    const userData = await dataManager.loadUserData();
    
    // CORREÇÃO: Validar estrutura
    if (!_ctx.validarUserData(userData)) {
        console.error('Dados do usuário inválidos ou corrompidos');
        return;
    }
    
    const dadosPorPerfil = perfisAtivos.map(perfil => {
        // CORREÇÃO: === estrito
        const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfil.id));
        const transacoesPerfil = Array.isArray(dadosPerfil?.transacoes) ? dadosPerfil.transacoes : [];
        const metasPerfil = Array.isArray(dadosPerfil?.metas) ? dadosPerfil.metas : [];
        const cartoesPerfil = Array.isArray(dadosPerfil?.cartoesCredito) ? dadosPerfil.cartoesCredito : [];
        
        const transacoesPeriodo = transacoesPerfil.filter(t => {
            if (!t || typeof t !== 'object') return false;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO) return false;
            return dataISO.startsWith(periodoSelecionado);
        });
        
        let saldoInicial = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO || dataISO >= periodoSelecionado) return;
            const valor = _ctx.sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') saldoInicial += valor;
            else if (t.categoria === 'saida') saldoInicial -= valor;
            else if (t.categoria === 'reserva') saldoInicial -= valor;
            else if (t.categoria === 'retirada_reserva') saldoInicial += valor;
        });
        
        let entradas = 0, saidas = 0, totalGuardado = 0, totalRetirado = 0;
        // CORREÇÃO: safeCategorias()
        const categorias = safeCategorias();
        
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
            const valor = _ctx.sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') {
                entradas += valor;
            } else if (t.categoria === 'saida') {
                saidas += valor;
                if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                    const tipoKey = t.tipo.trim();
                    categorias[tipoKey] = (categorias[tipoKey] || 0) + valor;
                }
            } else if (t.categoria === 'reserva') {
                totalGuardado += valor;
                saidas += valor;
            } else if (t.categoria === 'retirada_reserva') {
                totalRetirado += valor;
                saidas -= valor;
            }
        });
        
        const saldoDoMes = entradas - saidas;
        const saldoFinal = saldoInicial + saldoDoMes;
        
        let entradasAnt = 0, saidasAnt = 0, guardadoAnt = 0, retiradoAnt = 0;
        transacoesPerfil.forEach(t => {
            if (!t || typeof t !== 'object') return;
            const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
            if (!dataISO || !dataISO.startsWith(periodoAnterior)) return;
            const valor = _ctx.sanitizeNumber(t.valor);
            if (t.categoria === 'entrada') entradasAnt += valor;
            else if (t.categoria === 'saida') saidasAnt += valor;
            else if (t.categoria === 'reserva') { guardadoAnt += valor; saidasAnt += valor; }
            else if (t.categoria === 'retirada_reserva') { retiradoAnt += valor; saidasAnt -= valor; }
        });
        
        const reservasLiquido = totalGuardado - totalRetirado;
        const reservasLiquidoAnt = guardadoAnt - retiradoAnt;
        const taxaEconomia = entradas > 0 ? ((reservasLiquido / entradas) * 100) : 0;
        const taxaEconomiaAnt = entradasAnt > 0 ? ((reservasLiquidoAnt / entradasAnt) * 100) : 0;
        
        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            if (!c || typeof c !== 'object') return;
            totalLimiteCartoes += _ctx.sanitizeNumber(c.limite);
            totalUsadoCartoes += _ctx.sanitizeNumber(c.usado);
        });
        
        return {
            perfil, entradas, saidas, reservas: reservasLiquido,
            totalGuardado, totalRetirado, saldoInicial, saldoDoMes, saldo: saldoFinal,
            categorias, transacoes: transacoesPeriodo, metas: metasPerfil,
            cartoes: cartoesPerfil, totalLimiteCartoes, totalUsadoCartoes,
            mesAnterior: { entradas: entradasAnt, saidas: saidasAnt, reservas: reservasLiquidoAnt, saldo: entradasAnt - saidasAnt },
            taxaEconomia, taxaEconomiaAnterior: taxaEconomiaAnt,
            evolucaoEconomia: taxaEconomia - taxaEconomiaAnt
        };
    });
    
    const temDados = dadosPorPerfil.some(d => d.transacoes.length > 0);
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;
    
    if (!temDados) {
        const tipoTexto = _ctx.tipoRelatorioAtivo === 'casal' ? 'do Casal' : 'da Família';
        // ✅ CORREÇÃO VULN #3: _sanitizarHTMLRelatorio adicionado.
        //    tipoTexto é valor interno (ternário), mas os nomes de perfil (p.nome)
        //    são dados do usuário — passam por sanitizeHTML() E agora também
        //    pelo DOMParser, garantindo defesa em profundidade real.
        //    Padrão agora é 100% consistente com o caminho renderizarRelatorioCompartilhado.
        resultado.innerHTML = _sanitizarHTMLRelatorio(`
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas ${sanitizeHTML(tipoTexto)} em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</p>
                <p style="margin-top:12px; color:var(--text-muted);">
                    Perfis verificados: ${perfisAtivos.map(p => sanitizeHTML(String(p.nome || ''))).join(', ')}
                </p>
            </div>
        `);
        resultado.classList.remove('js-hidden');
        return;
    }

    renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior);
}

function renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior) {
    const resultado = document.getElementById('relatorioResultado');
    if (!resultado) return;

    if (!Array.isArray(dadosPorPerfil) || dadosPorPerfil.length === 0) return;

    const tipoTexto = _ctx.tipoRelatorioAtivo === 'casal' ? 'do Casal' : 'da Família';
    const icone     = _ctx.tipoRelatorioAtivo === 'casal' ? '💑' : '👨‍👩‍👧‍👦';

    let totalGeralEntradas          = 0;
    let totalGeralSaidas            = 0;
    let totalGeralReservasLiquido   = 0;
    let totalGeralGuardado          = 0;
    let totalGeralRetirado          = 0;
    const categoriasGerais          = safeCategorias();

    dadosPorPerfil.forEach(d => {
        if (!d || typeof d !== 'object') return;
        totalGeralEntradas        += _ctx.sanitizeNumber(d.entradas);
        totalGeralSaidas          += _ctx.sanitizeNumber(d.saidas);
        totalGeralReservasLiquido += _ctx.sanitizeNumber(d.reservas);
        totalGeralGuardado        += _ctx.sanitizeNumber(d.totalGuardado);
        totalGeralRetirado        += _ctx.sanitizeNumber(d.totalRetirado);

        if (d.categorias && typeof d.categorias === 'object') {
            Object.keys(d.categorias).forEach(cat => {
                if (cat && typeof cat === 'string' && cat.length < 100) {
                    categoriasGerais[cat] = (categoriasGerais[cat] || 0) + _ctx.sanitizeNumber(d.categorias[cat]);
                }
            });
        }
    });

    const saldoGeral        = totalGeralEntradas - totalGeralSaidas;
    const taxaEconomiaGeral = totalGeralEntradas > 0
        ? ((totalGeralReservasLiquido / totalGeralEntradas) * 100).toFixed(1)
        : 0;
    const saldoInicialGeral = dadosPorPerfil.reduce((sum, d) => sum + _ctx.sanitizeNumber(d?.saldoInicial), 0);
    const saldoGeralDoMes   = dadosPorPerfil.reduce((sum, d) => sum + _ctx.sanitizeNumber(d?.saldoDoMes), 0);

    // ✅ CORREÇÃO PRINCIPAL: todo o bloco de HTML estático ainda usa template string,
    //    mas passa obrigatoriamente por _sanitizarHTMLRelatorio (DOMParser + whitelist CSS)
    //    antes de qualquer atribuição a innerHTML.
    //    Dados de usuário (nomes, categorias) continuam sanitizados via sanitizeHTML()
    //    E recebem uma segunda camada pelo DOMParser — defesa em profundidade real.
    let html = `
    <div class="rel-report-header">
        <div class="rel-report-title">${icone} Relatório ${sanitizeHTML(tipoTexto)}</div>
        <span class="rel-report-badge"><i class="fas fa-calendar-alt"></i> ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</span>
    </div>
    <div class="rel-kpi-grid">
        <div class="rel-kpi-card rel-kpi-card--entradas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-up rel-kpi-icon"></i><span class="rel-kpi-label">Entradas Totais</span></div>
            <div class="rel-kpi-value">${formatBRL(totalGeralEntradas)}</div>
            <div class="rel-kpi-sub">Soma de todos os perfis</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saidas">
            <div class="rel-kpi-top"><i class="fas fa-arrow-down rel-kpi-icon"></i><span class="rel-kpi-label">Saídas Totais</span></div>
            <div class="rel-kpi-value">${formatBRL(totalGeralSaidas)}</div>
            <div class="rel-kpi-sub">Soma de todos os perfis</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--guardado">
            <div class="rel-kpi-top"><i class="fas fa-piggy-bank rel-kpi-icon"></i><span class="rel-kpi-label">Guardado Líquido</span></div>
            <div class="rel-kpi-value">${formatBRL(totalGeralReservasLiquido)}</div>
            <div class="rel-kpi-sub">Guardou: ${formatBRL(totalGeralGuardado)} · Retirou: ${formatBRL(totalGeralRetirado)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--saldo">
            <div class="rel-kpi-top"><i class="fas fa-wallet rel-kpi-icon"></i><span class="rel-kpi-label">Saldo Total</span></div>
            <div class="rel-kpi-value">${formatBRL(saldoGeral)}</div>
            <div class="rel-kpi-sub">Inicial: ${formatBRL(saldoInicialGeral)} · Mês: ${formatBRL(saldoGeralDoMes)}</div>
        </div>
        <div class="rel-kpi-card rel-kpi-card--economia">
            <div class="rel-kpi-top"><i class="fas fa-gem rel-kpi-icon"></i><span class="rel-kpi-label">Taxa de Economia</span></div>
            <div class="rel-kpi-value">${sanitizeHTML(String(taxaEconomiaGeral))}%</div>
            <div class="rel-kpi-sub">Média ${sanitizeHTML(tipoTexto.toLowerCase())}</div>
        </div>
    </div>

    <div class="rel-section">
        <div class="rel-section-header"><i class="fas fa-trophy"></i><span>Rankings e Comparativos</span></div>
        <div class="rel-ranking-tabs">
            <button class="rel-ranking-tab ranking-btn active" data-ranking="gastos">Quem Gastou Mais</button>
            <button class="rel-ranking-tab ranking-btn" data-ranking="guardou">Quem Guardou Mais</button>
            <button class="rel-ranking-tab ranking-btn" data-ranking="economia">Melhor Economia</button>
            <button class="rel-ranking-tab ranking-btn" data-ranking="evolucao">Maior Evolução</button>
        </div>
        <div id="rankingContainer"></div>
    </div>

    <div class="rel-section">
        <div class="rel-section-header"><i class="fas fa-users"></i><span>Análise Individual Completa</span></div>
        <div class="rel-profiles-grid">
    `;

    dadosPorPerfil.forEach(d => {
        if (!d || typeof d !== 'object') return;

        const diasNoMes        = new Date(Number(ano), Number(mes), 0).getDate();
        const mediaGastoDiario = diasNoMes > 0 ? _ctx.sanitizeNumber(d.saidas) / diasNoMes : 0;
        const percUsadoCartoes = d.totalLimiteCartoes > 0
            ? ((d.totalUsadoCartoes / d.totalLimiteCartoes) * 100).toFixed(1)
            : 0;

        const variacaoEntradas  = d.mesAnterior?.entradas > 0
            ? (((d.entradas  - d.mesAnterior.entradas)  / d.mesAnterior.entradas)  * 100).toFixed(1) : 0;
        const variacaoSaidas    = d.mesAnterior?.saidas > 0
            ? (((d.saidas    - d.mesAnterior.saidas)    / d.mesAnterior.saidas)    * 100).toFixed(1) : 0;
        const variacaoReservas  = d.mesAnterior?.reservas !== 0
            ? (((d.reservas  - d.mesAnterior.reservas)  / Math.abs(d.mesAnterior.reservas || 1)) * 100).toFixed(1) : 0;

        const nomePerfilSeguro = _ctx.sanitizeHTML(String(d.perfil?.nome || '').slice(0, 100));
        const perfilIdSeguro   = _ctx.sanitizeHTML(String(d.perfil?.id   || ''));

        const varEntStr = d.mesAnterior?.entradas > 0 ?
            `<span class="rel-variacao rel-variacao--${variacaoEntradas >= 0 ? 'up' : 'down'}">${variacaoEntradas >= 0 ? '↑' : '↓'}${Math.abs(variacaoEntradas)}%</span>` : '';
        const varSaiStr = d.mesAnterior?.saidas > 0 ?
            `<span class="rel-variacao rel-variacao--${variacaoSaidas <= 0 ? 'up' : 'down'}">${variacaoSaidas >= 0 ? '↑' : '↓'}${Math.abs(variacaoSaidas)}%</span>` : '';
        const varResStr = d.mesAnterior?.reservas !== 0 ?
            `<span class="rel-variacao rel-variacao--${variacaoReservas >= 0 ? 'up' : 'down'}">${variacaoReservas >= 0 ? '↑' : '↓'}${Math.abs(variacaoReservas)}%</span>` : '';

        html += `
            <div class="rel-profile-card">
                <div class="rel-profile-name">${nomePerfilSeguro}</div>
                <div class="rel-profile-grid">
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-arrow-up"></i> Entradas</span>
                        <span class="rel-profile-row-value entrada">${formatBRL(d.entradas)} ${varEntStr}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-arrow-down"></i> Saídas</span>
                        <span class="rel-profile-row-value saida">${formatBRL(d.saidas)} ${varSaiStr}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-piggy-bank"></i> Guardado</span>
                        <span class="rel-profile-row-value reserva">${formatBRL(d.reservas)} ${varResStr}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-wallet"></i> Saldo</span>
                        <span class="rel-profile-row-value" style="color:var(--accent);">${formatBRL(d.saldo)}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-gem"></i> Economia</span>
                        <span class="rel-profile-row-value" style="color:var(--success);">${sanitizeHTML(String(d.taxaEconomia.toFixed(1)))}%</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-calendar-day"></i> Média/Dia</span>
                        <span class="rel-profile-row-value">${formatBRL(mediaGastoDiario)}</span>
                    </div>
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-list"></i> Transações</span>
                        <span class="rel-profile-row-value">${d.transacoes.length}</span>
                    </div>
                    ${d.cartoes?.length > 0 ? `
                    <div class="rel-profile-row">
                        <span class="rel-profile-row-label"><i class="fas fa-credit-card"></i> Cartões</span>
                        <span class="rel-profile-row-value" style="color:${percUsadoCartoes > 80 ? 'var(--danger)' : 'var(--success)'};">${sanitizeHTML(String(percUsadoCartoes))}% usado</span>
                    </div>` : ''}
                </div>
                <div id="btnDetalhes_${perfilIdSeguro}" style="margin-top:12px;"></div>
            </div>`;
    });

    html += `</div></div>`;

    if (Object.keys(categoriasGerais).length > 0) {
        const categoriasTop         = Object.entries(categoriasGerais).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totalGastoCategorias  = Object.values(categoriasGerais).reduce((a, b) => a + b, 0);
        const coresCategorias       = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];

        html += `<div class="rel-section"><div class="rel-section-header"><i class="fas fa-chart-bar"></i><span>Top 5 Categorias (Geral)</span></div><div class="rel-cat-list">`;

        categoriasTop.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            html += `
                <div class="rel-cat-item">
                    <div class="rel-cat-info">
                        <div class="rel-cat-dot" style="background:${coresCategorias[i]};"></div>
                        <span class="rel-cat-name">${sanitizeHTML(cat)}</span>
                    </div>
                    <div class="rel-cat-bar-wrap">
                        <div class="rel-cat-bar-track"><div class="rel-cat-bar-fill" style="width:${sanitizeHTML(String(percentual))}%; background:${coresCategorias[i]};"></div></div>
                        <span class="rel-cat-value">${formatBRL(valor)}</span>
                    </div>
                </div>`;
        });

        html += `</div></div>`;
    }

    // ✅ CORREÇÃO: _sanitizarHTMLRelatorio aplicado antes de resultado.innerHTML
    //    Antes: resultado.innerHTML = html  ← sem DOMParser, innerHTML direto
    //    Agora: passa pelo DOMParser com whitelist CSS, remoção de on*, tags perigosas
    //           e bloqueio de esquemas javascript:/vbscript:/data: em atributos
    resultado.innerHTML = _sanitizarHTMLRelatorio(html);
    resultado.classList.remove('js-hidden');

    // "Ver todas" (Passo 7). O listener vai AQUI porque o innerHTML acima
    // recria o botão a cada relatório — um listener preso no HTML morreria junto.
    document.getElementById('relTxVerMais')?.addEventListener('click', () => _relExpandirTx());

    dadosPorPerfil.forEach(d => {
        if (!d?.perfil?.id) return;
        const btnContainer = document.getElementById(
            `btnDetalhes_${sanitizeHTML(String(d.perfil.id))}`
        );
        if (btnContainer) {
            const btn         = document.createElement('button');
            btn.className     = 'btn-primary';
            btn.style.cssText = 'width:100%; padding:10px;';
            btn.textContent   = '🔍 Ver Detalhes Completos';
            btn.addEventListener('click', () => {
                abrirDetalhesPerfilRelatorio(d.perfil.id, mes, ano);
            });
            btnContainer.appendChild(btn);
        }
    });

    configurarRankings(dadosPorPerfil, mes, ano);
    mostrarRanking('gastos', dadosPorPerfil);
}

// ========== WIDGET "ONDE FOI MEU DINHEIRO?" ==========
function processarAnaliseOndeForDinheiro() {
    const mes       = document.getElementById('mesAnalise').value;
    const ano       = document.getElementById('anoAnalise').value;
    const container = document.getElementById('resultadoAnalise');

    const analise = gerarAnaliseOndeForDinheiro(mes, ano);

    if (!analise.temDados) {
        container.innerHTML = '';
        const wrapperVazio = document.createElement('div');
        wrapperVazio.style.cssText = 'text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px;';

        const iconDiv = document.createElement('div');
        iconDiv.style.cssText = 'font-size:2.5rem; margin-bottom:12px; opacity:0.4; color:var(--text-secondary);';
        const iconDivI = document.createElement('i');
        iconDivI.className = 'fas fa-magnifying-glass';
        iconDiv.appendChild(iconDivI);

        const tituloDiv = document.createElement('div');
        tituloDiv.style.cssText = 'font-size:1.1rem; font-weight:600; color:var(--text-primary); margin-bottom:8px;';
        tituloDiv.textContent = 'Sem Dados Disponíveis';

        const msgDiv = document.createElement('div');
        msgDiv.style.cssText = 'font-size:0.9rem; color:var(--text-secondary);';
        msgDiv.textContent = analise.mensagem;

        wrapperVazio.appendChild(iconDiv);
        wrapperVazio.appendChild(tituloDiv);
        wrapperVazio.appendChild(msgDiv);
        container.appendChild(wrapperVazio);
        return;
    }

    // ✅ CORREÇÃO: constrói narrativa via DOM usando narrativaPartes (estruturado)
    //    em vez de interpolar analise.narrativa (que é undefined após refatoração)
    //    Elimina o risco de dados de usuário em innerHTML mesmo com sanitizeHTML
    const narrativaContainer = document.createElement('div');
    narrativaContainer.style.cssText = 'font-size:1.1rem; line-height:1.8; color:var(--text-primary);';

    (analise.narrativaPartes || []).forEach(parte => {
        if (parte.tipo === 'texto') {
            narrativaContainer.appendChild(document.createTextNode(parte.texto));
        } else if (parte.tipo === 'destaque') {
            narrativaContainer.appendChild(document.createTextNode(parte.prefixo || ''));
            const strong = document.createElement('strong');
            strong.textContent = parte.destaque || ''; // ✅ textContent — nunca innerHTML
            narrativaContainer.appendChild(strong);
            narrativaContainer.appendChild(document.createTextNode(parte.sufixo || ''));
        }
    });

    // Limpa container
    container.innerHTML = '';

    // ── Card de resumo (glassmorphism)
    const cardResumo = document.createElement('div');
    cardResumo.style.cssText = 'background:linear-gradient(135deg,rgba(67,160,71,0.15),rgba(108,99,255,0.15)); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(67,160,71,0.25); padding:18px; border-radius:16px; margin-bottom:16px;';

    // Narrativa
    narrativaContainer.style.cssText = 'font-size:0.95rem; line-height:1.7; color:var(--text-primary); margin-bottom:14px;';
    cardResumo.appendChild(narrativaContainer);

    // Stats rápidos: total + transações
    const rowStats = document.createElement('div');
    rowStats.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:10px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.08);';

    function criarStatMini(lbl, val, cor) {
        const c = document.createElement('div');
        c.style.cssText = 'background:rgba(255,255,255,0.04); border-radius:10px; padding:10px 12px; text-align:center;';
        const vEl = document.createElement('div');
        vEl.style.cssText = `font-size:1.2rem; font-weight:700; color:${cor}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
        vEl.textContent = val;
        const lEl = document.createElement('div');
        lEl.style.cssText = 'font-size:0.72rem; color:var(--text-muted); margin-top:3px; text-transform:uppercase; letter-spacing:0.04em;';
        lEl.textContent = lbl;
        c.appendChild(vEl); c.appendChild(lEl);
        return c;
    }
    rowStats.appendChild(criarStatMini('Total gasto', _ctx.formatBRL(analise.totalGastos), '#ff4b4b'));
    rowStats.appendChild(criarStatMini('Transações', String(analise.totalTransacoes), '#4ecdc4'));
    cardResumo.appendChild(rowStats);
    container.appendChild(cardResumo);

    // ── Distribuição por categoria
    const cardCats = document.createElement('div');
    cardCats.style.cssText = 'background:rgba(255,255,255,0.03); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:16px; margin-bottom:14px;';

    const catTitulo = document.createElement('div');
    catTitulo.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:14px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted);';
    const catIcon = document.createElement('i'); catIcon.className = 'fas fa-chart-pie'; catIcon.style.color = 'var(--primary)';
    catTitulo.appendChild(catIcon); catTitulo.appendChild(document.createTextNode(' Distribuição por Categoria'));
    cardCats.appendChild(catTitulo);

    const cores = ['#ff4b4b','#ffd166','#4ecdc4','#45b7d1','#f9ca24','#6c5ce7','#a29bfe','#fd79a8'];

    analise.categorias.forEach(([categoria, valor], i) => {
        const percentual = parseFloat(((valor / analise.totalGastos) * 100).toFixed(1));
        const cor        = cores[i % cores.length];

        const itemCat = document.createElement('div');
        itemCat.style.cssText = 'margin-bottom:10px;';

        const rowCat = document.createElement('div');
        rowCat.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;';

        const leftCat = document.createElement('div');
        leftCat.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0;';
        const dot = document.createElement('span');
        dot.style.cssText = `width:10px; height:10px; border-radius:3px; background:${cor}; flex-shrink:0;`;
        const nomeCat = document.createElement('span');
        nomeCat.style.cssText = 'font-size:0.85rem; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        nomeCat.textContent = _ctx._sanitizeText(categoria); // ✅ textContent
        leftCat.appendChild(dot); leftCat.appendChild(nomeCat);

        const rightCat = document.createElement('div');
        rightCat.style.cssText = 'display:flex; align-items:center; gap:8px; flex-shrink:0;';
        const valEl = document.createElement('span');
        valEl.style.cssText = 'font-size:0.85rem; font-weight:700; color:var(--text-primary);';
        valEl.textContent = _ctx.formatBRL(valor);
        const pctEl = document.createElement('span');
        // Cores são todas do array interno (6 chars hex) — seguro interpolar
        const [rr,gg,bb] = (cor.slice(1).match(/../g) || ['ff','ff','ff']).map(x => parseInt(x, 16));
        pctEl.style.cssText = `font-size:0.75rem; padding:2px 6px; border-radius:10px; background:rgba(${rr},${gg},${bb},0.18); color:${cor}; font-weight:600; min-width:36px; text-align:center;`;
        pctEl.textContent = `${percentual}%`;
        rightCat.appendChild(valEl); rightCat.appendChild(pctEl);

        rowCat.appendChild(leftCat); rowCat.appendChild(rightCat);

        const barra = document.createElement('div');
        barra.style.cssText = 'width:100%; height:5px; background:rgba(255,255,255,0.08); border-radius:10px; overflow:hidden;';
        const fill = document.createElement('div');
        fill.style.cssText = `width:0%; height:100%; background:${cor}; border-radius:10px; transition:width 0.6s ease ${i * 80}ms;`;
        barra.appendChild(fill);

        // Animação com timeout para efeito de entrada
        setTimeout(() => { fill.style.width = `${percentual}%`; }, 50);

        itemCat.appendChild(rowCat); itemCat.appendChild(barra);
        cardCats.appendChild(itemCat);
    });

    container.appendChild(cardCats);

    // ── Insight card (glassmorphism roxo)
    const insightDiv = document.createElement('div');
    insightDiv.style.cssText = 'background:rgba(108,99,255,0.1); backdrop-filter:blur(8px); border:1px solid rgba(108,99,255,0.2); padding:16px; border-radius:16px;';

    const insightTit = document.createElement('div');
    insightTit.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#a78bfa;';
    const insightI = document.createElement('i'); insightI.className = 'fas fa-lightbulb'; insightI.style.color = '#6c63ff';
    insightTit.appendChild(insightI); insightTit.appendChild(document.createTextNode(' Insight Inteligente'));
    insightDiv.appendChild(insightTit);

    const ticketMedio = analise.totalGastos / analise.totalTransacoes;

    function addInsightP(txt) {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:0.84rem; color:var(--text-secondary); line-height:1.6; margin-bottom:6px;';
        p.textContent = txt;
        insightDiv.appendChild(p);
    }

    if (analise.top3[0]) {
        const percTop = Math.round((analise.top3[0][1] / analise.totalGastos) * 100);
        if (percTop > 50) {
            addInsightP(`⚠️ Atenção: ${percTop}% dos gastos foram em "${_sanitizeText(analise.top3[0][0])}" — mais da metade do orçamento! Analise oportunidades de redução nessa categoria.`);
        }
    }
    addInsightP(`💳 Ticket médio: ${formatBRL(ticketMedio)} por transação. ${ticketMedio > 200 ? 'Valores altos — certifique-se de que cada gasto está alinhado com suas prioridades.' : 'Valores moderados — bom sinal de controle diário.'}`);

    if (analise.top3.length >= 2) {
        const ec = analise.top3.reduce((s, [, v]) => s + v * 0.1, 0);
        addInsightP(`💡 Economizando 10% nas ${analise.top3.length} maiores categorias você teria ${formatBRL(ec)} a mais por mês.`);
    }

    container.appendChild(insightDiv);

    // ── Projeção de fim de mês ──────────────────────────────────────────────
    if (analise.projecao !== null && analise.diaHoje < analise.diasMes) {
        const cardProj = document.createElement('div');
        cardProj.style.cssText = 'background:rgba(76,166,255,0.08); border:1px solid rgba(76,166,255,0.2); border-radius:16px; padding:16px; margin-top:12px;';
        const projTit = document.createElement('div');
        projTit.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#4ca6ff;';
        const projI = document.createElement('i'); projI.className = 'fas fa-chart-line';
        projTit.appendChild(projI); projTit.appendChild(document.createTextNode(' Projeção de Fim de Mês'));
        const projRow = document.createElement('div');
        projRow.style.cssText = 'display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;';
        function _miniStat(lbl, val, cor) {
            const c = document.createElement('div');
            c.style.cssText = 'background:rgba(255,255,255,0.04); border-radius:10px; padding:10px 8px; text-align:center;';
            const v = document.createElement('div'); v.style.cssText = `font-size:1rem; font-weight:700; color:${cor}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;
            v.textContent = val;
            const l = document.createElement('div'); l.style.cssText = 'font-size:0.68rem; color:var(--text-muted); margin-top:3px; text-transform:uppercase; letter-spacing:0.04em;';
            l.textContent = lbl;
            c.appendChild(v); c.appendChild(l); return c;
        }
        const diasRestantes = analise.diasMes - analise.diaHoje;
        const mediaDiaria   = analise.totalGastos / analise.diaHoje;
        projRow.appendChild(_miniStat('Gasto até hoje', formatBRL(analise.totalGastos), '#ff4b4b'));
        projRow.appendChild(_miniStat('Projeção total', formatBRL(analise.projecao), '#ffd166'));
        projRow.appendChild(_miniStat(`${diasRestantes} dias restantes`, formatBRL(mediaDiaria) + '/dia', '#4ecdc4'));
        cardProj.appendChild(projTit); cardProj.appendChild(projRow);
        container.appendChild(cardProj);
    }

    // ── Taxa de poupança ──────────────────────────────────────────────────
    if (analise.taxaPoupanca !== null && analise.totalEntradas > 0) {
        const tp   = Math.max(-999, analise.taxaPoupanca);
        const corT = tp >= 20 ? '#4ecdc4' : tp >= 0 ? '#ffd166' : '#ff4b4b';
        const lblT = tp >= 20 ? '✅ Meta de 20% atingida!' : tp >= 0 ? `⚠️ Meta: 20% — você poupou ${tp.toFixed(1)}%` : '❌ Gastos superaram as entradas';
        const cardTp = document.createElement('div');
        cardTp.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:16px; margin-top:12px; display:flex; align-items:center; gap:14px;';
        const ringWrap = document.createElement('div');
        ringWrap.style.cssText = `position:relative; width:60px; height:60px; flex-shrink:0;`;
        const pctClamped = Math.max(0, Math.min(100, tp));
        const circ = 2 * Math.PI * 26;
        const dashFill = (pctClamped / 100) * circ;
        ringWrap.innerHTML = `<svg width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/><circle cx="30" cy="30" r="26" fill="none" stroke="${corT}" stroke-width="6" stroke-dasharray="${dashFill.toFixed(1)} ${circ.toFixed(1)}" stroke-dashoffset="${(circ/4).toFixed(1)}" stroke-linecap="round"/></svg><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:800;color:${corT}">${tp >= 0 ? tp.toFixed(0) : '–'}%</div>`;
        const tpBody = document.createElement('div');
        const tpTitle = document.createElement('div');
        tpTitle.style.cssText = 'font-size:0.9rem; font-weight:700; color:var(--text-primary); margin-bottom:4px;';
        tpTitle.textContent = 'Taxa de Poupança';
        const tpSub = document.createElement('div');
        tpSub.style.cssText = `font-size:0.82rem; color:${corT};`;
        tpSub.textContent = lblT;
        const tpDetail = document.createElement('div');
        tpDetail.style.cssText = 'font-size:0.76rem; color:var(--text-muted); margin-top:4px;';
        tpDetail.textContent = `Entradas: ${formatBRL(analise.totalEntradas)} · Saídas: ${formatBRL(analise.totalGastos)}`;
        tpBody.appendChild(tpTitle); tpBody.appendChild(tpSub); tpBody.appendChild(tpDetail);
        cardTp.appendChild(ringWrap); cardTp.appendChild(tpBody);
        container.appendChild(cardTp);
    }

    // ── Comparação vs mês anterior ────────────────────────────────────────
    if (analise.comparacao && analise.comparacao.some(c => c.anterior > 0)) {
        const cardComp = document.createElement('div');
        cardComp.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:16px; margin-top:12px;';
        const compTit = document.createElement('div');
        compTit.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted);';
        const compI = document.createElement('i'); compI.className = 'fas fa-arrows-left-right'; compI.style.color = 'var(--primary)';
        compTit.appendChild(compI); compTit.appendChild(document.createTextNode(' vs Mês Anterior'));
        cardComp.appendChild(compTit);
        const compGrid = document.createElement('div');
        compGrid.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
        let shown = 0;
        analise.comparacao.forEach(c => {
            if (c.anterior === 0 || c.delta === null || shown >= 5) return;
            shown++;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:rgba(255,255,255,0.03); border-radius:8px;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'font-size:0.83rem; color:var(--text-primary); font-weight:500;';
            lbl.textContent = _ctx._sanitizeText(c.tipo);
            const right = document.createElement('div');
            right.style.cssText = 'display:flex; align-items:center; gap:8px;';
            const val = document.createElement('span');
            val.style.cssText = 'font-size:0.8rem; color:var(--text-secondary);';
            val.textContent = formatBRL(c.atual);
            const badge = document.createElement('span');
            const sinal = c.delta > 0 ? '+' : '';
            const corD  = c.delta > 15 ? '#ff4b4b' : c.delta < -15 ? '#4ecdc4' : '#ffd166';
            badge.style.cssText = `font-size:0.72rem; font-weight:700; color:${corD}; background:rgba(255,255,255,0.06); padding:2px 7px; border-radius:10px;`;
            badge.textContent = `${sinal}${c.delta.toFixed(0)}%`;
            right.appendChild(val); right.appendChild(badge);
            row.appendChild(lbl); row.appendChild(right);
            compGrid.appendChild(row);
        });
        cardComp.appendChild(compGrid);
        container.appendChild(cardComp);
    }

    // ── Anomalias ────────────────────────────────────────────────────────
    if (analise.anomalias && analise.anomalias.length > 0) {
        const cardAnom = document.createElement('div');
        cardAnom.style.cssText = 'background:rgba(255,75,75,0.07); border:1px solid rgba(255,75,75,0.2); border-radius:16px; padding:16px; margin-top:12px;';
        const anomTit = document.createElement('div');
        anomTit.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#ff4b4b;';
        const anomI = document.createElement('i'); anomI.className = 'fas fa-triangle-exclamation';
        anomTit.appendChild(anomI); anomTit.appendChild(document.createTextNode(' Gastos Anômalos (vs 3 meses)'));
        cardAnom.appendChild(anomTit);
        analise.anomalias.slice(0, 3).forEach(a => {
            const p = document.createElement('p');
            p.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); margin-bottom:6px; line-height:1.5;';
            p.textContent = `⚠️ ${_ctx._sanitizeText(a.tipo)}: ${formatBRL(a.atual)} este mês — ${a.delta.toFixed(0)}% acima da sua média (${formatBRL(a.media)}/mês).`;
            cardAnom.appendChild(p);
        });
        container.appendChild(cardAnom);
    }
}

// ========== GERAR ANÁLISE "ONDE FOI MEU DINHEIRO?" ==========
function gerarAnaliseOndeForDinheiro(mes, ano) {
    if (!mes || !ano) {
        return { temDados: false, mensagem: 'Selecione mês e ano para analisar.' };
    }

    const periodoSelecionado = _prefixoPeriodo(mes, ano);

    const _txPeriodo = (m, a, cat) => _ctx.transacoes.filter(t => {
        if (!t || typeof t !== 'object') return false;
        const iso = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
        if (!iso) return false;
        if (cat && t.categoria !== cat) return false;
        return iso.startsWith(`${a}-${m}`);
    });

    const txSaida    = _txPeriodo(mes, ano, 'saida');
    const txEntrada  = _txPeriodo(mes, ano, 'entrada');

    if (txSaida.length === 0 && txEntrada.length === 0) {
        return { temDados: false, mensagem: `Não há movimentações registradas em ${getMesNome(mes)} de ${ano}.` };
    }

    // Mês anterior
    const mesN   = parseInt(mes, 10);
    const anoN   = parseInt(ano, 10);
    const mesAnt = mesN === 1 ? 12 : mesN - 1;
    const anoAnt = mesN === 1 ? anoN - 1 : anoN;
    const mesAntStr = String(mesAnt).padStart(2, '0');
    const anoAntStr = String(anoAnt);
    const txSaidaAnt = _txPeriodo(mesAntStr, anoAntStr, 'saida');

    // Categorias do período
    const categorias = safeCategorias();
    txSaida.forEach(t => {
        if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
            const k = t.tipo.trim();
            categorias[k] = (categorias[k] || 0) + _ctx.sanitizeNumber(t.valor);
        }
    });

    // Categorias mês anterior
    const catAnt = safeCategorias();
    txSaidaAnt.forEach(t => {
        if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
            const k = t.tipo.trim();
            catAnt[k] = (catAnt[k] || 0) + _ctx.sanitizeNumber(t.valor);
        }
    });

    // Média de 3 meses anteriores por categoria (para anomalias)
    const cat3m = safeCategorias();
    for (let i = 1; i <= 3; i++) {
        let m3 = mesN - i; let a3 = anoN;
        if (m3 <= 0) { m3 += 12; a3--; }
        const m3s = String(m3).padStart(2, '0');
        _txPeriodo(m3s, String(a3), 'saida').forEach(t => {
            if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
                const k = t.tipo.trim();
                cat3m[k] = (cat3m[k] || 0) + _ctx.sanitizeNumber(t.valor) / 3;
            }
        });
    }

    const totalGastos    = Object.values(categorias).reduce((s, v) => s + v, 0);
    const totalEntradas  = txEntrada.reduce((s, t) => s + _ctx.sanitizeNumber(t.valor), 0);
    const totalGastosAnt = Object.values(catAnt).reduce((s, v) => s + v, 0);
    const taxaPoupanca   = totalEntradas > 0 ? ((totalEntradas - totalGastos) / totalEntradas) * 100 : null;

    // Dias do mês e projeção
    const hoje    = new Date();
    const diaHoje = (parseInt(ano, 10) === hoje.getFullYear() && parseInt(mes, 10) === hoje.getMonth() + 1)
                    ? hoje.getDate() : null;
    const diasMes = new Date(parseInt(ano, 10), parseInt(mes, 10), 0).getDate();
    const projecao = diaHoje && diaHoje > 0
                     ? (totalGastos / diaHoje) * diasMes : null;

    // Comparação vs mês anterior (delta por categoria)
    const comparacao = [];
    Object.entries(categorias).forEach(([k, v]) => {
        const prev  = catAnt[k] || 0;
        const delta = prev > 0 ? ((v - prev) / prev) * 100 : null;
        comparacao.push({ tipo: k, atual: v, anterior: prev, delta });
    });
    comparacao.sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));

    // Anomalias (>60% acima da média dos 3 meses anteriores)
    const anomalias = [];
    Object.entries(categorias).forEach(([k, v]) => {
        const media = cat3m[k] || 0;
        if (media > 10 && v > media * 1.6) {
            anomalias.push({ tipo: k, atual: v, media, delta: ((v - media) / media) * 100 });
        }
    });
    anomalias.sort((a, b) => b.delta - a.delta);

    const categoriasOrdenadas = Object.entries(categorias).sort((a, b) => b[1] - a[1]);
    const top3 = categoriasOrdenadas.slice(0, 3);

    const narrativaPartes = [];
    narrativaPartes.push({ tipo: 'texto', texto: `Em ${getMesNome(mes)} de ${ano}, você realizou ${txSaida.length} transação(ões) de saída. ` });
    if (top3[0]) {
        const percTop = ((top3[0][1] / totalGastos) * 100).toFixed(0);
        narrativaPartes.push({ tipo: 'destaque', prefixo: 'Seu maior gasto foi em ', destaque: top3[0][0], sufixo: `, representando ${percTop}% do total. ` });
    }
    if (top3[1]) narrativaPartes.push({ tipo: 'destaque', prefixo: 'Em segundo lugar, gastos com ', destaque: top3[1][0], sufixo: '. ' });
    if (top3[2]) narrativaPartes.push({ tipo: 'destaque', prefixo: 'E em terceiro, ', destaque: top3[2][0], sufixo: '.' });

    return {
        temDados: true,
        totalGastos, totalEntradas, totalGastosAnt, taxaPoupanca,
        totalTransacoes: txSaida.length,
        categorias: categoriasOrdenadas, top3,
        comparacao, anomalias, projecao, diaHoje, diasMes,
        narrativaPartes,
    };
}

// ========== ABRIR WIDGET "ONDE FOI MEU DINHEIRO?" ==========
function abrirWidgetOndeForDinheiro() {
    if (!_ctx.perfilAtivo) {
        _ctx.mostrarNotificacao('Selecione um perfil primeiro.', 'error');
        return;
    }

    const hoje     = new Date();
    const anoAtual = hoje.getFullYear();
    const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');

    const mesesNomes = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março',    '04': 'Abril',
        '05': 'Maio',    '06': 'Junho',     '07': 'Julho',    '08': 'Agosto',
        '09': 'Setembro','10': 'Outubro',   '11': 'Novembro', '12': 'Dezembro'
    };

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:480px; width:96%;';

        // ── Wrapper scroll
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:82vh; overflow-y:auto; overflow-x:hidden; scrollbar-width:none; padding-right:0;';
        wrapper.style.msOverflowStyle = 'none';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:4px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.1rem;';
        const tituloIcon = document.createElement('i');
        tituloIcon.className = 'fas fa-magnifying-glass-dollar';
        tituloIcon.style.color = 'var(--primary)';
        const tituloText = document.createElement('span');
        tituloText.textContent = 'Onde Foi Meu Dinheiro?';
        titulo.appendChild(tituloIcon);
        titulo.appendChild(tituloText);

        // ── Subtítulo
        const subtitulo = document.createElement('p');
        subtitulo.style.cssText = 'color:var(--text-muted); margin-bottom:14px; font-size:0.8rem; text-align:center;';
        subtitulo.textContent = 'Analise seus gastos por período';

        // ── Row de filtros
        const rowFiltros = document.createElement('div');
        rowFiltros.style.cssText = 'display:flex; gap:12px; margin-bottom:14px; flex-wrap:wrap;';

        // ── Coluna Mês
        const colMes = document.createElement('div');
        colMes.style.cssText = 'flex:1; min-width:130px;';

        const labelMes = document.createElement('label');
        labelMes.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:0.85rem; font-weight:600; color:var(--text-secondary);';
        const labelMesIcon = document.createElement('i');
        labelMesIcon.className = 'fas fa-calendar';
        const labelMesText = document.createElement('span');
        labelMesText.textContent = 'Mês';
        labelMes.appendChild(labelMesIcon);
        labelMes.appendChild(labelMesText);

        const selectMes = document.createElement('select');
        selectMes.id        = 'mesAnalise';
        selectMes.className = 'form-input';

        Object.entries(mesesNomes).forEach(([val, nome]) => {
            const opt       = document.createElement('option');
            opt.value       = val;           // ✅ .value — não interpolado
            opt.textContent = nome;          // ✅ textContent — não innerHTML
            if (val === mesAtual) opt.selected = true;
            selectMes.appendChild(opt);
        });

        colMes.appendChild(labelMes);
        colMes.appendChild(selectMes);

        // ── Coluna Ano
        const colAno = document.createElement('div');
        colAno.style.cssText = 'flex:1; min-width:100px;';

        const labelAno = document.createElement('label');
        labelAno.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:6px; font-size:0.85rem; font-weight:600; color:var(--text-secondary);';
        const labelAnoIcon = document.createElement('i');
        labelAnoIcon.className = 'fas fa-calendar-days';
        const labelAnoText = document.createElement('span');
        labelAnoText.textContent = 'Ano';
        labelAno.appendChild(labelAnoIcon);
        labelAno.appendChild(labelAnoText);

        const selectAno = document.createElement('select');
        selectAno.id        = 'anoAnalise';
        selectAno.className = 'form-input';

        for (let a = anoAtual; a >= anoAtual - 4; a--) {
            const opt       = document.createElement('option');
            opt.value       = String(a);
            opt.textContent = String(a);
            if (a === anoAtual) opt.selected = true;
            selectAno.appendChild(opt);
        }

        colAno.appendChild(labelAno);
        colAno.appendChild(selectAno);

        rowFiltros.appendChild(colMes);
        rowFiltros.appendChild(colAno);

        // ── Botão analisar
        const btnAnalisar = document.createElement('button');
        btnAnalisar.id        = 'btnAnalisarGastos';
        btnAnalisar.className = 'btn-primary';
        btnAnalisar.style.cssText = 'width:100%; margin-bottom:20px; display:flex; align-items:center; justify-content:center; gap:8px;';
        const btnAnalisarIcon = document.createElement('i');
        btnAnalisarIcon.className = 'fas fa-magnifying-glass';
        const btnAnalisarText = document.createElement('span');
        btnAnalisarText.textContent = 'Analisar Gastos';
        btnAnalisar.appendChild(btnAnalisarIcon);
        btnAnalisar.appendChild(btnAnalisarText);
        btnAnalisar.addEventListener('click', processarAnaliseOndeForDinheiro);

        // ── Container resultado
        const resultadoDiv = document.createElement('div');
        resultadoDiv.id = 'resultadoAnalise';

        wrapper.appendChild(titulo);
        wrapper.appendChild(subtitulo);

        // ── Previsão de fim de mês ──────────────────────────────────────────
        // Vive AQUI (e não no dashboard) desde 2026-07-14: a home estava ficando
        // poluída, e este é o contexto certo — quem quer saber para onde o dinheiro
        // FOI também quer saber onde ele VAI PARAR no fim do mês. Lazy e
        // best-effort: se falhar, a análise continua funcionando.
        const previsaoBox = document.createElement('div');
        wrapper.appendChild(previsaoBox);
        import('../modules/previsao-mes.js?v=2')
            .then(m => m.renderPrevisaoEm(previsaoBox, _ctx))
            .catch(() => { /* previsão é complemento — nunca quebra a análise */ });

        wrapper.appendChild(rowFiltros);
        wrapper.appendChild(btnAnalisar);
        wrapper.appendChild(resultadoDiv);

        // ── Sugestão de corte (item 17) ─────────────────────────────────────
        // Depois do resultado, de propósito: primeiro o usuário vê PARA ONDE o
        // dinheiro foi, aí a pergunta natural é onde dá para aparar. Nunca toca
        // em essencial (remédio/mercado/transporte) — só em consumo repetido.
        // Lazy e best-effort, igual à previsão: se falhar, a análise continua.
        const cortesBox = document.createElement('div');
        wrapper.appendChild(cortesBox);
        import('../modules/sugestao-corte.js?v=1')
            .then(m => m.renderCortesEm(cortesBox, _ctx))
            .catch(() => { /* complemento — nunca quebra a análise */ });

        // ── Botão fechar (fora do wrapper scroll)
        const btnFechar = document.createElement('button');
        btnFechar.id        = 'fecharWidgetAnalise';
        btnFechar.className = 'btn-cancelar';
        btnFechar.style.cssText = 'width:100%; margin-top:14px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', _ctx.fecharPopup);

        popup.appendChild(wrapper);
        popup.appendChild(btnFechar);
    });

    // Executa análise com o período padrão imediatamente
    processarAnaliseOndeForDinheiro();
}

window.processarAnaliseOndeForDinheiro = processarAnaliseOndeForDinheiro;
window.abrirWidgetOndeForDinheiro = abrirWidgetOndeForDinheiro;


// Função para configurar eventos dos rankings
function configurarRankings(dadosPorPerfil, mes, ano) {
    const btnsRanking = document.querySelectorAll('.ranking-btn');
    
    btnsRanking.forEach(btn => {
        btn.addEventListener('click', function() {
            btnsRanking.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            const tipoRanking = this.getAttribute('data-ranking');
            mostrarRanking(tipoRanking, dadosPorPerfil);
        });
    });
}

// Função para mostrar diferentes tipos de ranking
function mostrarRanking(tipo, dadosPorPerfil) {
    const container = document.getElementById('rankingContainer');
    if (!container) return;

    // ✅ Limpa via DOM — sem innerHTML vazio como surface
    container.innerHTML = '';

    const emojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

    function _criarItemRanking({
        corFundo,
        corBorda,
        posicaoTxt,
        nomeTxt,
        detalhesTxt,
        valorTxt,
        corValor = null,
        fontSizeValor = null,
    }) {
        const item = document.createElement('div');
        item.className        = 'ranking-item';
        item.style.background = corFundo; // ✅ cor interna — não vem do usuário
        item.style.borderLeft = `3px solid ${corBorda}`; // ✅ idem

        const posicao           = document.createElement('div');
        posicao.className       = 'ranking-posicao';
        posicao.textContent     = posicaoTxt; // ✅ emoji ou número — valor interno

        const info              = document.createElement('div');
        info.className          = 'ranking-info';

        const nomeEl            = document.createElement('div');
        nomeEl.className        = 'ranking-nome';
        nomeEl.textContent      = _ctx._sanitizeText(String(nomeTxt || '')); // ✅ textContent — dado do usuário

        const detalhesEl        = document.createElement('div');
        detalhesEl.className    = 'ranking-detalhes';
        detalhesEl.textContent  = String(detalhesTxt || ''); // ✅ textContent — formatBRL retorna string numérica

        info.appendChild(nomeEl);
        info.appendChild(detalhesEl);

        const valorEl           = document.createElement('div');
        valorEl.className       = 'ranking-valor';
        valorEl.textContent     = String(valorTxt || ''); // ✅ textContent — formatBRL ou percentual numérico
        if (corValor)     valorEl.style.color    = corValor;    // ✅ cor interna
        if (fontSizeValor) valorEl.style.fontSize = fontSizeValor; // ✅ valor interno

        item.appendChild(posicao);
        item.appendChild(info);
        item.appendChild(valorEl);

        return item;
    }

    function _criarTitulo(texto) {
        const h4 = document.createElement('h4');
        h4.style.cssText = 'margin-bottom:16px; color: var(--text-primary);';
        h4.textContent   = texto; // ✅ texto estático — sem dado do usuário
        return h4;
    }

    function _criarSubtitulo(texto) {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:0.9rem; color: var(--text-secondary); margin-bottom:16px;';
        p.textContent   = texto; // ✅ texto estático
        return p;
    }

    switch (tipo) {

        // ── GASTOS ────────────────────────────────────────────────────────────
        case 'gastos': {
            const rankingGastos = dadosPorPerfil
                .map(d => ({ nome: d.perfil.nome, valor: d.saidas }))
                .sort((a, b) => b.valor - a.valor);

            const totalGastos = rankingGastos.reduce((sum, r) => sum + r.valor, 0);

            container.appendChild(_criarTitulo('💸 Ranking: Quem Gastou Mais'));

            rankingGastos.forEach((r, i) => {
                const percentual = totalGastos > 0
                    ? ((r.valor / totalGastos) * 100).toFixed(1)
                    : '0.0';

                container.appendChild(_criarItemRanking({
                    corFundo:    'rgba(255,75,75,0.1)',
                    corBorda:    '#ff4b4b',
                    posicaoTxt:  emojis[i] || String(i + 1),
                    nomeTxt:     r.nome,
                    detalhesTxt: `${percentual}% do total de gastos`,
                    valorTxt:    _ctx.formatBRL(r.valor),
                }));
            });
            break;
        }

        // ── GUARDOU ───────────────────────────────────────────────────────────
        case 'guardou': {
            const rankingGuardou = dadosPorPerfil
                .map(d => ({ nome: d.perfil.nome, valor: d.reservas }))
                .sort((a, b) => b.valor - a.valor);

            const totalGuardado = rankingGuardou.reduce((sum, r) => sum + r.valor, 0);

            container.appendChild(_criarTitulo('💰 Ranking: Quem Guardou Mais'));

            rankingGuardou.forEach((r, i) => {
                const percentual = totalGuardado > 0
                    ? ((r.valor / totalGuardado) * 100).toFixed(1)
                    : '0.0';

                container.appendChild(_criarItemRanking({
                    corFundo:    'rgba(0,255,153,0.1)',
                    corBorda:    '#00ff99',
                    posicaoTxt:  emojis[i] || String(i + 1),
                    nomeTxt:     r.nome,
                    detalhesTxt: `${percentual}% do total guardado`,
                    valorTxt:    _ctx.formatBRL(r.valor),
                    corValor:    '#00ff99',
                }));
            });
            break;
        }

        // ── ECONOMIA ──────────────────────────────────────────────────────────
        case 'economia': {
            const rankingEconomia = dadosPorPerfil
                .map(d => ({
                    nome:      d.perfil.nome,
                    taxa:      d.taxaEconomia,
                    guardado:  d.reservas,
                    entradas:  d.entradas,
                }))
                .sort((a, b) => b.taxa - a.taxa);

            container.appendChild(_criarTitulo('📊 Ranking: Melhor Taxa de Economia'));
            container.appendChild(_criarSubtitulo('Quanto % do que ganhou foi guardado'));

            rankingEconomia.forEach((r, i) => {
                container.appendChild(_criarItemRanking({
                    corFundo:      'rgba(255,209,102,0.1)',
                    corBorda:      '#ffd166',
                    posicaoTxt:    emojis[i] || String(i + 1),
                    nomeTxt:       r.nome,
                    // ✅ formatBRL retorna string numérica formatada — textContent seguro
                    detalhesTxt:   `Guardou ${formatBRL(r.guardado)} de ${formatBRL(r.entradas)}`,
                    valorTxt:      `${r.taxa.toFixed(1)}%`,
                    corValor:      '#ffd166',
                    fontSizeValor: '1.5rem',
                }));
            });
            break;
        }

        // ── EVOLUÇÃO ──────────────────────────────────────────────────────────
        case 'evolucao': {
            const rankingEvolucao = dadosPorPerfil
                .map(d => ({
                    nome:         d.perfil.nome,
                    evolucao:     d.evolucaoEconomia,
                    taxaAtual:    d.taxaEconomia,
                    taxaAnterior: d.taxaEconomiaAnterior,
                }))
                .sort((a, b) => b.evolucao - a.evolucao);

            container.appendChild(_criarTitulo('📈 Ranking: Maior Evolução na Economia'));
            container.appendChild(_criarSubtitulo('Comparação com o mês anterior'));

            rankingEvolucao.forEach((r, i) => {
                // ✅ corEvolucao e simbolo determinados por lógica interna — não vêm do usuário
                const corEvolucao = r.evolucao >= 0 ? '#00ff99' : '#ff4b4b';
                const simbolo     = r.evolucao >= 0 ? '↑' : '↓';

                container.appendChild(_criarItemRanking({
                    corFundo:    'rgba(108,99,255,0.1)',
                    corBorda:    corEvolucao,
                    posicaoTxt:  emojis[i] || String(i + 1),
                    nomeTxt:     r.nome,
                    detalhesTxt: `${r.taxaAnterior.toFixed(1)}% → ${r.taxaAtual.toFixed(1)}%`,
                    valorTxt:    `${simbolo} ${Math.abs(r.evolucao).toFixed(1)}%`,
                    corValor:    corEvolucao,
                }));
            });
            break;
        }

        // ── TIPO DESCONHECIDO ─────────────────────────────────────────────────
        default:
            _ctx._log.warn('[mostrarRanking] Tipo de ranking desconhecido:', tipo);
            break;
    }
}

// Função para abrir detalhes completos de um perfil específico
function abrirDetalhesPerfilRelatorio(perfilId, mes, ano) {
    // ✅ HTML estático sem onclick inline — sanitizarHTMLPopup remove atributos on*,
    //    por isso o botão ficava morto. Substituído por addEventListener após criação.
    _ctx.criarPopup(`
        <h3>🔍 Detalhes Completos</h3>
        <div class="small">Carregando dados detalhados do período...</div>
        <button class="btn-primary" id="btnFecharDetalhesRelatorio">Fechar</button>
    `);

    // ✅ addEventListener — funciona independente do sanitizador
    const btnFechar = document.getElementById('btnFecharDetalhesRelatorio');
    if (btnFechar) {
        btnFechar.addEventListener('click', _ctx.fecharPopup);
    }

    setTimeout(() => {
        gerarRelatorioIndividual(mes, ano, perfilId);
        _ctx.fecharPopup();
    }, 500);
}

// Expor globalmente
window.abrirDetalhesPerfilRelatorio = abrirDetalhesPerfilRelatorio;

// ========== DETALHES DO CARTÃO NO RELATÓRIO ==========

async function abrirDetalhesCartaoRelatorio(cartaoId, mes, ano, perfilId) {
    const userData = await dataManager.loadUserData();
    const dadosPerfil = userData.profiles.find(p => String(p.id) === String(perfilId));

    const cartoesPerfil     = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
    const contasFixasPerfil = dadosPerfil ? dadosPerfil.contasFixas    || [] : [];

    const cartao = cartoesPerfil.find(c => String(c.id) === String(cartaoId));
    if (!cartao) { _ctx.mostrarNotificacao('Cartão não encontrado.', 'error'); return; }

    const hojeISO         = new Date().toISOString().slice(0, 10);
    const periodoMesAtual = `${ano}-${mes}`;

    // ── Todas as faturas deste cartão
    const todasFaturas = contasFixasPerfil.filter(c =>
        String(c.cartaoId) === String(cartaoId) && c.vencimento
    );

    // ── Faturas pendentes (não pagas, vencimento >= hoje)
    const faturasPendentes = todasFaturas
        .filter(f => !f.pago)
        .sort((a, b) => a.vencimento.localeCompare(b.vencimento));

    // ── Faturas vencidas (não pagas, vencimento < hoje)
    const faturasVencidas = faturasPendentes.filter(f => f.vencimento < hojeISO);

    // ── Compras do mês selecionado no relatório
    const faturasMes = todasFaturas.filter(f => f.vencimento && f.vencimento.startsWith(periodoMesAtual));
    let comprasMes = [];
    faturasMes.forEach(f => {
        if (Array.isArray(f.compras)) f.compras.forEach(c => comprasMes.push({ ...c, faturaId: f.id, vencFatura: f.vencimento }));
    });

    // ── Métricas do cartão
    const usado      = Number(cartao.usado || 0);
    const limite     = Number(cartao.limite || 0);
    const disponivel = Math.max(0, limite - usado);
    const percUsado  = limite > 0 ? Math.min(100, (usado / limite) * 100) : 0;
    const percStr    = percUsado.toFixed(1);
    const corPerc    = percUsado > 80 ? '#ff4b4b' : percUsado > 50 ? '#ffd166' : '#00ff99';

    // ── Total em aberto nas faturas pendentes
    const totalPendente = faturasPendentes.reduce((s, f) => s + Number(f.valor || 0), 0);

    // ── Projeção de quitação: data da última fatura com parcelas restantes
    let dataQuitacao = null;
    faturasPendentes.forEach(f => {
        if (!f.vencimento) return;
        if (!dataQuitacao || f.vencimento > dataQuitacao) dataQuitacao = f.vencimento;
    });

    // ── Parcelas pendentes no mês atual (contas a pagar neste mês)
    const parcelasPendentesMes = comprasMes.filter(c => c.pago !== true).length;

    const dica = obterDicaAleatoria();

    // ── Monta HTML de compras do mês
    let htmlComprasMes = '';
    if (comprasMes.length === 0) {
        htmlComprasMes = `
            <div style="text-align:center; padding:30px; background:rgba(255,255,255,0.03); border-radius:12px;">
                <i class="fas fa-shopping-cart" style="font-size:2.5rem; opacity:0.4; color:var(--text-muted); display:block; margin-bottom:12px;"></i>
                <div style="font-size:1rem; font-weight:600; color:var(--text-primary); margin-bottom:6px;">Nenhuma compra registrada</div>
                <div style="font-size:0.85rem; color:var(--text-secondary);">
                    Nenhuma compra neste cartão em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
                </div>
            </div>`;
    } else {
        comprasMes.forEach(compra => {
            const pago     = compra.pago === true;
            const cor      = pago ? '#00ff99' : '#ffd166';
            const falta    = pago ? '—' : _ctx.formatBRL(compra.valorParcela);
            const nParc    = compra.numeroParcela ?? compra.parcelaAtual;
            const parcTxt  = pago ? 'Pago' : `Parcela ${sanitizeHTML(String(nParc))}/${sanitizeHTML(String(compra.totalParcelas))}`;
            htmlComprasMes += `
                <div style="background:rgba(255,255,255,0.03); padding:14px; border-radius:10px; margin-bottom:10px; border-left:3px solid ${cor};">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
                        <div style="flex:1;">
                            <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem;">${sanitizeHTML(compra.tipo)}</div>
                            <div style="color:var(--text-secondary); font-size:0.82rem; margin-top:3px;">${sanitizeHTML(compra.descricao)}</div>
                            <div style="color:var(--text-muted); font-size:0.78rem; margin-top:3px; display:flex; align-items:center; gap:4px;">
                                <i class="fas fa-calendar-day" style="font-size:0.72rem;"></i>
                                ${sanitizeHTML(formatarDataBR(compra.dataCompra))}
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-weight:700; color:var(--text-primary); font-size:1.05rem;">${formatBRL(compra.valorParcela)}</div>
                            <div style="font-size:0.78rem; color:${cor}; font-weight:600; margin-top:3px;">${parcTxt}</div>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.07);">
                        <div><div style="font-size:0.72rem; color:var(--text-muted);">Total da compra</div><div style="font-size:0.85rem; font-weight:600; color:var(--text-secondary);">${formatBRL(compra.valorTotal)}</div></div>
                        <div><div style="font-size:0.72rem; color:var(--text-muted);">Falta pagar</div><div style="font-size:0.85rem; font-weight:600; color:${pago ? '#00ff99' : '#ff4b4b'};">${falta}</div></div>
                    </div>
                </div>`;
        });
    }

    // ── Monta HTML de faturas pendentes
    let htmlFaturasPendentes = '';
    if (faturasPendentes.length === 0) {
        htmlFaturasPendentes = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.9rem;">
            <i class="fas fa-circle-check" style="color:#00ff99; margin-right:6px;"></i>Nenhuma fatura pendente — cartão em dia!
        </div>`;
    } else {
        faturasPendentes.slice(0, 6).forEach(f => {
            const vencido = f.vencimento < hojeISO;
            const cor = vencido ? '#ff4b4b' : '#ffd166';
            const icone = vencido ? 'fa-triangle-exclamation' : 'fa-clock';
            htmlFaturasPendentes += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:8px; border-left:2px solid ${cor};">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <i class="fas ${icone}" style="color:${cor}; font-size:0.8rem;"></i>
                        <div>
                            <div style="font-size:0.82rem; color:var(--text-primary); font-weight:600;">${sanitizeHTML(formatarDataBR(f.vencimento))}</div>
                            <div style="font-size:0.72rem; color:var(--text-muted);">${vencido ? 'Vencida' : 'Pendente'}</div>
                        </div>
                    </div>
                    <div style="font-weight:700; color:${cor}; font-size:0.9rem;">${formatBRL(f.valor)}</div>
                </div>`;
        });
        if (faturasPendentes.length > 6) {
            htmlFaturasPendentes += `<div style="text-align:center; color:var(--text-muted); font-size:0.8rem; padding:6px;">
                + ${faturasPendentes.length - 6} fatura(s) não exibida(s)
            </div>`;
        }
    }

    _ctx.criarPopup(`
        <div style="max-height:82vh; overflow-y:auto; overflow-x:hidden; scrollbar-width:none; -ms-overflow-style:none; padding-right:0;">
            <button id="btnFecharCartaoRelatorio" style="position:sticky; top:0; float:right; margin-bottom:8px; background:#ff4b4b; border:none; color:#fff; width:32px; height:32px; border-radius:8px; cursor:pointer; font-size:1.1rem; font-weight:700; z-index:10; box-shadow:0 2px 8px rgba(255,75,75,0.4); display:flex; align-items:center; justify-content:center;">
                <i class="fas fa-xmark"></i>
            </button>

            <!-- Cabeçalho -->
            <div style="background:linear-gradient(135deg, var(--primary), var(--secondary)); padding:20px; border-radius:14px; margin-bottom:18px; text-align:center; box-shadow:0 4px 20px rgba(108,99,255,0.3);">
                <i class="fas fa-credit-card" style="font-size:1.8rem; color:white; margin-bottom:8px; display:block; opacity:0.9;"></i>
                <div style="font-size:1.4rem; font-weight:700; color:white;">${sanitizeHTML(cartao.nomeBanco)}</div>
                <div style="font-size:0.85rem; color:rgba(255,255,255,0.75); margin-top:6px;">
                    <i class="fas fa-calendar-alt" style="margin-right:5px;"></i>${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}
                </div>
            </div>

            <!-- Limite e uso -->
            <div style="display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:18px;">
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-wallet" style="margin-right:4px;"></i>Limite</div>
                    <div style="font-size:1.15rem; font-weight:700; color:var(--text-primary);">${formatBRL(limite)}</div>
                </div>
                <div style="background:rgba(255,75,75,0.08); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-arrow-trend-up" style="margin-right:4px;"></i>Usado</div>
                    <div style="font-size:1.15rem; font-weight:700; color:#ff4b4b;">${formatBRL(usado)}</div>
                </div>
                <div style="background:rgba(0,255,153,0.08); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-circle-check" style="margin-right:4px;"></i>Disponível</div>
                    <div style="font-size:1.15rem; font-weight:700; color:#00ff99;">${formatBRL(disponivel)}</div>
                </div>
                <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:12px; text-align:center; backdrop-filter:blur(8px);">
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-bottom:4px;"><i class="fas fa-chart-pie" style="margin-right:4px;"></i>Utilizado</div>
                    <div style="font-size:1.15rem; font-weight:700; color:${corPerc};">${sanitizeHTML(percStr)}%</div>
                </div>
            </div>

            <!-- Barra de uso -->
            <div style="margin-bottom:18px;">
                <div style="width:100%; height:10px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden;">
                    <div style="width:${sanitizeHTML(percStr)}%; height:100%; background:${corPerc}; border-radius:10px;"></div>
                </div>
            </div>

            <!-- Pendências deste mês -->
            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:18px;">
                <div style="background:rgba(108,99,255,0.1); padding:12px; border-radius:10px; text-align:center; border-top:2px solid #6c63ff;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px;"><i class="fas fa-shopping-cart"></i> Compras/mês</div>
                    <div style="font-size:1.4rem; font-weight:700; color:#6c63ff;">${comprasMes.length}</div>
                </div>
                <div style="background:rgba(255,209,102,0.1); padding:12px; border-radius:10px; text-align:center; border-top:2px solid #ffd166;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px;"><i class="fas fa-hourglass-half"></i> Pendentes/mês</div>
                    <div style="font-size:1.4rem; font-weight:700; color:#ffd166;">${parcelasPendentesMes}</div>
                </div>
                <div style="background:rgba(255,75,75,0.1); padding:12px; border-radius:10px; text-align:center; border-top:2px solid #ff4b4b;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:4px;"><i class="fas fa-file-invoice-dollar"></i> Total pendente</div>
                    <div style="font-size:1rem; font-weight:700; color:#ff4b4b;">${formatBRL(totalPendente)}</div>
                </div>
            </div>

            <!-- Projeção de quitação -->
            ${dataQuitacao ? `
            <div style="background:linear-gradient(135deg,rgba(76,166,255,0.12),rgba(108,99,255,0.12)); border:1px solid rgba(76,166,255,0.2); border-radius:12px; padding:14px 16px; margin-bottom:18px; display:flex; align-items:center; gap:14px;">
                <i class="fas fa-flag-checkered" style="font-size:1.6rem; color:#4ca6ff; flex-shrink:0;"></i>
                <div>
                    <div style="font-weight:700; color:var(--text-primary); margin-bottom:4px;">Projeção de Quitação</div>
                    <div style="font-size:0.88rem; color:var(--text-secondary);">
                        Pagando em dia, este cartão estará quitado em <strong style="color:#4ca6ff;">${sanitizeHTML(formatarDataBR(dataQuitacao))}</strong>.
                        ${faturasVencidas.length > 0 ? `<span style="color:#ff4b4b; font-weight:600;"> (${faturasVencidas.length} fatura(s) vencida(s) — regularize!)</span>` : ''}
                    </div>
                </div>
            </div>` : ''}

            <!-- Faturas pendentes -->
            <div style="margin-bottom:18px;">
                <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem; margin-bottom:10px; display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-file-invoice" style="color:#ffd166;"></i> Faturas Pendentes
                    ${faturasPendentes.length > 0 ? `<span style="background:rgba(255,209,102,0.15); color:#ffd166; font-size:0.72rem; padding:2px 8px; border-radius:12px;">${faturasPendentes.length}</span>` : ''}
                </div>
                ${htmlFaturasPendentes}
            </div>

            <!-- Compras do mês -->
            <div style="margin-bottom:18px;">
                <div style="font-weight:700; color:var(--text-primary); font-size:0.9rem; margin-bottom:10px; display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-shopping-bag" style="color:#6c63ff;"></i> Compras em ${sanitizeHTML(getMesNome(mes))}
                    ${comprasMes.length > 0 ? `<span style="background:rgba(108,99,255,0.15); color:#6c63ff; font-size:0.72rem; padding:2px 8px; border-radius:12px;">${comprasMes.length}</span>` : ''}
                </div>
                ${htmlComprasMes}
            </div>

            <!-- Dica inteligente -->
            <div style="background:linear-gradient(135deg,rgba(108,99,255,0.15),rgba(76,166,255,0.15)); border:1px solid rgba(108,99,255,0.2); border-radius:12px; padding:14px 16px; margin-bottom:16px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <i class="fas fa-lightbulb" style="color:#ffd166; font-size:1.1rem;"></i>
                    <div style="font-weight:700; font-size:0.9rem; color:var(--text-primary);">Dica do GranaEvo</div>
                </div>
                <div id="dicaCartaoTexto" style="color:var(--text-secondary); font-size:0.88rem; line-height:1.6;"></div>
            </div>

            <button id="btnFecharCartaoRelatorioBottom" class="btn-primary" style="width:100%;">
                <i class="fas fa-xmark" style="margin-right:6px;"></i>Fechar
            </button>
        </div>
    `);

    document.getElementById('btnFecharCartaoRelatorio')?.addEventListener('click', _ctx.fecharPopup);
    document.getElementById('btnFecharCartaoRelatorioBottom')?.addEventListener('click', _ctx.fecharPopup);

    const dicaEl = document.getElementById('dicaCartaoTexto');
    if (dicaEl) {
        const strong = document.createElement('strong');
        strong.textContent = dica.titulo + ': ';
        dicaEl.appendChild(strong);
        dicaEl.appendChild(document.createTextNode(dica.texto));
    }
}

window.abrirDetalhesCartaoRelatorio = abrirDetalhesCartaoRelatorio;

// ========== HISTÓRICO PATRIMONIAL ==========

function _gerarPatrimonioCompleto(container) {
    container.innerHTML = '';

    // Score financeiro no topo
    const scoreWrap = document.createElement('div');
    scoreWrap.style.cssText = 'margin-bottom: 28px;';
    gerarScoreFinanceiro(scoreWrap);
    container.appendChild(scoreWrap);

    // Divisor
    const divisor = document.createElement('div');
    divisor.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.07); margin-bottom: 24px;';
    container.appendChild(divisor);

    // Histórico patrimonial — passamos um filho separado para evitar sobrescrever o score
    const patrimonioWrap = document.createElement('div');
    container.appendChild(patrimonioWrap);
    gerarHistoricoPatrimonial(patrimonioWrap);

    // ── Projeção de patrimônio (1/5/10 anos) ────────────────────────────────
    // Fecha o arco do relatório: score (como estou) → histórico (como cheguei) →
    // projeção (onde chego no ritmo atual). Lazy e best-effort: o motor só baixa
    // aqui e, se falhar, o resto do relatório continua de pé.
    const projWrap = document.createElement('div');
    container.appendChild(projWrap);
    import('../modules/patrimonio.js?v=1')
        .then(m => _renderProjecaoPatrimonio(projWrap, m))
        .catch(() => { /* projeção é complemento */ });
}

// Projeção de patrimônio — honesta de propósito: se o usuário está gastando mais do
// que ganha, mostra o patrimônio CAINDO em vez de forçar otimismo.
function _renderProjecaoPatrimonio(container, mod) {
    const r = mod.projetarPatrimonio(_ctx);
    container.textContent = '';

    const divisor = document.createElement('div');
    divisor.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.07); margin: 24px 0;';
    container.appendChild(divisor);

    const tit = document.createElement('h3');
    tit.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:1rem; margin-bottom:4px;';
    const titIc = document.createElement('i');
    titIc.className = 'fas fa-arrow-trend-up';
    titIc.style.color = 'var(--primary)';
    titIc.setAttribute('aria-hidden', 'true');
    tit.appendChild(titIc);
    tit.appendChild(document.createTextNode('Onde você chega neste ritmo'));
    container.appendChild(tit);

    const sub = document.createElement('p');
    sub.style.cssText = 'color:var(--text-muted); font-size:0.78rem; margin-bottom:14px;';
    sub.textContent = r.mesesObservados > 0
        ? `Hoje: ${formatBRL(r.patrimonioHoje)} · guardando ${formatBRL(r.poupancaMensal)}/mês (média de ${r.mesesObservados} ${r.mesesObservados === 1 ? 'mês' : 'meses'})`
        : `Hoje: ${formatBRL(r.patrimonioHoje)} · registre alguns meses para projetar seu ritmo`;
    container.appendChild(sub);

    if (r.mesesObservados === 0) return;

    if (r.poupancaMensal <= 0) {
        const alerta = document.createElement('p');
        alerta.style.cssText = 'font-size:0.82rem; color:#ff9f43; background:rgba(255,159,67,0.1); border:1px solid rgba(255,159,67,0.25); border-radius:10px; padding:10px 12px; line-height:1.5;';
        alerta.textContent = 'No ritmo atual você está gastando mais do que ganha, então não há patrimônio a projetar — ele diminuiria. Suba a taxa de poupança e a projeção aparece aqui.';
        container.appendChild(alerta);
        return;
    }

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(3,1fr); gap:10px;';
    for (const p of r.projecoes) {
        const box = document.createElement('div');
        box.style.cssText = 'background:rgba(255,255,255,0.05); padding:12px 8px; border-radius:12px; text-align:center;';
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:0.7rem; color:var(--text-secondary); margin-bottom:5px;';
        lbl.textContent = p.anos === 1 ? 'Em 1 ano' : `Em ${p.anos} anos`;
        const val = document.createElement('div');
        val.style.cssText = 'font-size:0.95rem; font-weight:700; color:var(--primary);';
        val.textContent = formatBRL(p.valor);
        box.appendChild(lbl);
        box.appendChild(val);
        grid.appendChild(box);
    }
    container.appendChild(grid);

    const nota = document.createElement('p');
    nota.style.cssText = 'color:var(--text-muted); font-size:0.72rem; margin-top:10px; line-height:1.5;';
    nota.textContent = r.taxaMensal > 0
        ? 'Projeção com juros compostos sobre o que você já tem mais o que guarda por mês. É uma estimativa no ritmo atual — não é promessa de rendimento.'
        : 'Projeção sem rendimento: só o que você já tem mais o que guarda por mês. Se investir, o número real tende a ser maior.';
    container.appendChild(nota);
}

function gerarHistoricoPatrimonial(container) {
    const tx    = _ctx.transacoes || [];
    const metas = _ctx.metas      || [];

    const _mNomes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                     'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // Coleta meses com dados
    const mesesSet = new Set();
    tx.forEach(t => {
        if (typeof t.data === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(t.data)) {
            const p = t.data.split('/');
            mesesSet.add(`${p[2]}-${p[1]}`);
        }
    });
    metas.forEach(m => {
        if (m.monthly && typeof m.monthly === 'object') {
            Object.keys(m.monthly).forEach(k => { if (/^\d{4}-\d{2}$/.test(k)) mesesSet.add(k); });
        }
    });

    const meses = Array.from(mesesSet).sort();

    if (meses.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:48px;color:var(--text-secondary)"><i class="fas fa-info-circle" style="font-size:2rem;margin-bottom:12px;display:block"></i>Sem dados de transações para gerar o histórico.</div>';
        return;
    }

    // Calcula dados por mês
    let saldoCum = 0;
    const linhas = [];

    meses.forEach(mesAno => {
        const [ano, mes] = mesAno.split('-');
        const sufixo = `/${mes}/${ano}`;
        let entMes = 0, saiMes = 0;

        tx.filter(t => typeof t.data === 'string' && t.data.endsWith(sufixo)).forEach(t => {
            const v = parseFloat(t.valor) || 0;
            if      (t.categoria === 'entrada')           { entMes += v; saldoCum += v; }
            else if (t.categoria === 'saida')             { saiMes += v; saldoCum -= v; }
            else if (t.categoria === 'reserva')           { saldoCum -= v; }
            else if (t.categoria === 'retirada_reserva')  { saldoCum += v; }
        });

        let resAcum = 0;
        metas.forEach(m => {
            if (m.monthly && typeof m.monthly === 'object') {
                Object.entries(m.monthly).forEach(([k, v]) => {
                    if (/^\d{4}-\d{2}$/.test(k) && k <= mesAno) resAcum += (parseFloat(v) || 0);
                });
            }
        });

        linhas.push({
            mesAno,
            label:      `${_mNomes[parseInt(mes,10)-1]} ${ano}`,
            entradas:   entMes,
            saidas:     saiMes,
            saldo:      parseFloat(saldoCum.toFixed(2)),
            reservas:   parseFloat(Math.max(0, resAcum).toFixed(2)),
            patrimonio: parseFloat((saldoCum + Math.max(0, resAcum)).toFixed(2)),
        });
    });

    // Métricas de resumo
    const ultimo    = linhas[linhas.length - 1];
    const primeiro  = linhas[0];
    const variacao  = ultimo.patrimonio - primeiro.patrimonio;
    const melhorMes = linhas.reduce((a, b) => (b.entradas - b.saidas > a.entradas - a.saidas ? b : a));
    const piorMes   = linhas.reduce((a, b) => (b.saidas - b.entradas > a.saidas - a.entradas ? b : a));

    const fmt = v => _ctx.formatBRL ? _ctx.formatBRL(v) : `R$ ${v.toFixed(2).replace('.', ',')}`;
    const corV = variacao >= 0 ? 'var(--success)' : 'var(--danger)';

    // Agrega linhas mensais conforme período selecionado
    function _agruparPorPeriodo(linhasBase, step) {
        if (step === 1) return linhasBase.map((l, i) => ({ ...l, _prev: i > 0 ? linhasBase[i-1].patrimonio : null }));
        const grupos = [];
        for (let i = 0; i < linhasBase.length; i += step) {
            const slice = linhasBase.slice(i, i + step);
            if (!slice.length) continue;
            const label = step >= 12
                ? slice[0].label.split(' ')[1] // só o ano
                : `${slice[0].label.split(' ')[0]}–${slice[slice.length-1].label.split(' ')[0]} ${slice[slice.length-1].label.split(' ')[1]}`;
            grupos.push({
                label,
                entradas:   slice.reduce((s, l) => s + l.entradas,   0),
                saidas:     slice.reduce((s, l) => s + l.saidas,     0),
                saldo:      slice[slice.length - 1].saldo,
                reservas:   slice[slice.length - 1].reservas,
                patrimonio: slice[slice.length - 1].patrimonio,
                _prev: grupos.length > 0 ? grupos[grupos.length - 1].patrimonio : null,
            });
        }
        return grupos;
    }

    function _renderLinhas(linhasAgrup) {
        const maxPatrL = Math.max(...linhasAgrup.map(l => l.patrimonio), 1);
        return linhasAgrup.map((l) => {
            const pct  = Math.max(0, Math.min(100, (l.patrimonio / maxPatrL) * 100));
            const delta = l._prev != null ? l.patrimonio - l._prev : 0;
            const corD  = delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--text-muted)';
            const icD   = delta > 0 ? 'arrow-up' : delta < 0 ? 'arrow-down' : 'minus';
            const mesEsc = _ctx.sanitizeHTML ? _ctx.sanitizeHTML(l.label) : l.label;
            return `<tr class="rel-patr-row">
                <td class="rel-patr-mes">${mesEsc}</td>
                <td style="color:var(--success)">${fmt(l.entradas)}</td>
                <td style="color:var(--danger)">${fmt(l.saidas)}</td>
                <td>${fmt(l.saldo)}</td>
                <td style="color:var(--warning)">${fmt(l.reservas)}</td>
                <td>
                    <div class="rel-patr-bar-wrap"><div class="rel-patr-bar" style="width:${pct.toFixed(1)}%"></div></div>
                    <span style="font-weight:700;color:var(--primary)">${fmt(l.patrimonio)}</span>
                    <span style="font-size:0.75rem;color:${corD};margin-left:6px"><i class="fas fa-${icD}"></i></span>
                </td>
            </tr>`;
        }).join('');
    }

    const _STEPS = { mensal:1, bimestral:2, trimestral:3, semestral:6, anual:12 };
    let _periodoAtivo = 'mensal';
    const linhasIniciais = _agruparPorPeriodo(linhas, 1);

    container.innerHTML = `
        <div class="rel-patrimonio-wrap">
            <div class="rel-patrimonio-header">
                <h2><i class="fas fa-chart-area"></i> Histórico Patrimonial</h2>
                <p>Evolução do seu patrimônio — saldo disponível + total em reservas</p>
            </div>

            <div class="rel-patrimonio-cards">
                <div class="rel-patr-card">
                    <div class="rel-patr-card-label">Patrimônio Atual</div>
                    <div class="rel-patr-card-value" style="color:var(--primary)">${fmt(ultimo.patrimonio)}</div>
                </div>
                <div class="rel-patr-card">
                    <div class="rel-patr-card-label">Variação Total</div>
                    <div class="rel-patr-card-value" style="color:${corV}">${variacao >= 0 ? '+' : ''}${fmt(variacao)}</div>
                </div>
                <div class="rel-patr-card">
                    <div class="rel-patr-card-label">Melhor Mês</div>
                    <div class="rel-patr-card-value" style="color:var(--success);font-size:1rem">${melhorMes.label}</div>
                    <div style="font-size:0.78rem;color:var(--text-secondary)">+${fmt(melhorMes.entradas - melhorMes.saidas)}</div>
                </div>
                <div class="rel-patr-card">
                    <div class="rel-patr-card-label">Mais Saídas</div>
                    <div class="rel-patr-card-value" style="color:var(--danger);font-size:1rem">${piorMes.label}</div>
                    <div style="font-size:0.78rem;color:var(--text-secondary)">${fmt(piorMes.saidas)} saídas</div>
                </div>
            </div>

            <div class="rel-patr-periodo-bar" id="patrPeriodoBar"></div>

            <div class="rel-patrimonio-table-wrap">
                <table class="rel-patrimonio-table">
                    <thead>
                        <tr><th>Período</th><th>Entradas</th><th>Saídas</th><th>Saldo</th><th>Reservas</th><th>Patrimônio</th></tr>
                    </thead>
                    <tbody id="patrTableBody">${_renderLinhas(linhasIniciais)}</tbody>
                </table>
            </div>
        </div>
    `;

    // Adiciona seletor de período via DOM (evita dados de usuário em innerHTML)
    const periodoBar = container.querySelector('#patrPeriodoBar');
    if (periodoBar) {
        [['mensal','Mensal'],['bimestral','Bimestral'],['trimestral','Trimestral'],['semestral','Semestral'],['anual','Anual']].forEach(([key, lbl]) => {
            const btn = document.createElement('button');
            btn.type      = 'button';
            btn.className = 'rel-patr-periodo-btn' + (key === _periodoAtivo ? ' rel-patr-periodo-btn--active' : '');
            btn.textContent = lbl;
            btn.addEventListener('click', () => {
                _periodoAtivo = key;
                periodoBar.querySelectorAll('.rel-patr-periodo-btn').forEach(b => {
                    b.classList.toggle('rel-patr-periodo-btn--active', b.textContent === lbl);
                });
                const agrup = _agruparPorPeriodo(linhas, _STEPS[key]);
                const tbody = container.querySelector('#patrTableBody');
                if (tbody) tbody.innerHTML = _renderLinhas(agrup);
            });
            periodoBar.appendChild(btn);
        });
    }
}

// ========== SCORE FINANCEIRO ==========
// O motor foi EXTRAÍDO para ../modules/score-financeiro.js (2026-07-14) para ser
// testável e reutilizável pelo semáforo do dashboard sem carregar este chunk
// (~32 KB gzip). Comportamento idêntico — só ganhou `hoje` injetável.
const _calcScore = (tx, metas, cartoes, orcamentos, hoje) =>
    _calcScoreCore(tx, metas, cartoes, orcamentos, hoje);

function gerarScoreFinanceiro(container) {
    const tx       = _ctx.transacoes   || [];
    const metas    = _ctx.metas        || [];
    const cartoes  = _ctx.cartoesCredito || [];
    const orcamentos = _ctx.orcamentos || {};

    const { score, nivel, componentes, entradas, saidas, taxaPoup } = _calcScore(tx, metas, cartoes, orcamentos);

    // Histórico mensal de score (últimos 6 meses)
    const hoje  = new Date();
    const hist  = [];
    for (let i = 5; i >= 0; i--) {
        const d   = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        const m   = d.getMonth() + 1, a = d.getFullYear();
        const ms  = String(m).padStart(2,'0');
        // Mini-score simplificado para histórico (só poupança + equilíbrio)
        const sfx = `/${ms}/${a}`;
        const txMs = tx.filter(t => typeof t.data === 'string' && t.data.endsWith(sfx));
        const ent  = txMs.filter(t => t.categoria === 'entrada').reduce((s,t) => s+(parseFloat(t.valor)||0), 0);
        const sai  = txMs.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((s,t) => s+(parseFloat(t.valor)||0), 0);
        if (ent + sai === 0) { hist.push({ label: `${ms}/${a}`, score: null }); continue; }
        // BUGFIX (2026-07-14): passa a data DAQUELE mês. Antes só as transações eram
        // filtradas — o _calcScore refiltrava pelo mês ATUAL internamente, então todo
        // mês do histórico zerava entradas/saídas e o gráfico saía constante e sem
        // sentido. Com `hoje` injetável, cada barra reflete o mês de verdade.
        const { score: sc } = _calcScore(txMs, metas, cartoes, orcamentos, d);
        hist.push({ label: ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][m-1], score: sc });
    }

    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'score-wrap';

    // — Hero do score —
    const hero = document.createElement('div');
    hero.className = 'score-hero';
    const circ = 2 * Math.PI * 54;
    const fill  = (score / 1000) * circ;
    hero.innerHTML = `
        <div class="score-ring-wrap">
            <svg width="140" height="140" viewBox="0 0 140 140">
                <circle cx="70" cy="70" r="54" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="10"/>
                <circle cx="70" cy="70" r="54" fill="none" stroke="${nivel.cor}" stroke-width="10"
                    stroke-dasharray="${fill.toFixed(1)} ${circ.toFixed(1)}"
                    stroke-dashoffset="${(circ/4).toFixed(1)}" stroke-linecap="round"/>
            </svg>
            <div class="score-ring-inner">
                <div class="score-num" style="color:${nivel.cor}">${score}</div>
                <div class="score-letra" style="color:${nivel.cor}">${nivel.letra}</div>
            </div>
        </div>
        <div class="score-hero-info">
            <div class="score-nivel" style="color:${nivel.cor}">${nivel.nome}</div>
            <div class="score-desc">Score do mês atual</div>
            <div class="score-stats">
                <div><span style="color:var(--success)">+${formatBRL(entradas)}</span><br><small>entradas</small></div>
                <div><span style="color:var(--danger)">-${formatBRL(saidas)}</span><br><small>saídas</small></div>
                <div><span style="color:${taxaPoup>=20?'var(--success)':'var(--warning)'}">${taxaPoup.toFixed(1)}%</span><br><small>poupado</small></div>
            </div>
        </div>`;
    wrap.appendChild(hero);

    // — Componentes —
    const compSec = document.createElement('div');
    compSec.className = 'score-comp-sec';
    const compTitle = document.createElement('div');
    compTitle.className = 'score-sec-title';
    compTitle.textContent = 'Detalhamento';
    compSec.appendChild(compTitle);
    componentes.forEach(c => {
        const pct = Math.round((c.pts / c.max) * 100);
        const cor = pct >= 80 ? '#4ecdc4' : pct >= 50 ? '#ffd166' : '#ff4b4b';
        const row = document.createElement('div');
        row.className = 'score-comp-row';
        row.innerHTML = `
            <div class="score-comp-left">
                <span class="score-comp-name">${c.nome}</span>
                <span class="score-comp-dica">${_ctx._sanitizeText(c.dica)}</span>
            </div>
            <div class="score-comp-right">
                <div class="score-comp-bar-wrap">
                    <div class="score-comp-bar" style="width:${pct}%; background:${cor};"></div>
                </div>
                <span class="score-comp-pts" style="color:${cor}">${c.pts}<small>/${c.max}</small></span>
            </div>`;
        compSec.appendChild(row);
    });
    wrap.appendChild(compSec);

    // — Histórico mensal —
    const histSec = document.createElement('div');
    histSec.className = 'score-hist-sec';
    const histTitle = document.createElement('div');
    histTitle.className = 'score-sec-title';
    histTitle.textContent = 'Evolução (6 meses)';
    histSec.appendChild(histTitle);
    const histGrid = document.createElement('div');
    histGrid.className = 'score-hist-grid';
    const maxHist = Math.max(...hist.map(h => h.score || 0), 1);
    hist.forEach(h => {
        const col = document.createElement('div');
        col.className = 'score-hist-col';
        const pct  = h.score !== null ? Math.max(4, (h.score / 1000) * 100) : 0;
        const cor  = h.score === null ? 'rgba(255,255,255,0.08)' : h.score >= 700 ? '#4ecdc4' : h.score >= 400 ? '#ffd166' : '#ff4b4b';
        col.innerHTML = `
            <div class="score-hist-bar-wrap">
                <div class="score-hist-bar" style="height:${pct}%; background:${cor};"></div>
            </div>
            <div class="score-hist-val" style="color:${cor}">${h.score !== null ? h.score : '–'}</div>
            <div class="score-hist-lbl">${h.label}</div>`;
        histGrid.appendChild(col);
    });
    histSec.appendChild(histGrid);
    wrap.appendChild(histSec);

    container.appendChild(wrap);
}

// ========== BANCO DE DICAS SOBRE CARTÕES ==========

function obterDicaAleatoria() {
    const dicas = [
        { titulo: 'Pagamento em dia',        texto: 'Sempre pague sua fatura no vencimento para evitar juros altíssimos e manter seu score de crédito saudável.' },
        { titulo: 'Controle de gastos',      texto: 'Utilize no máximo 30% do limite do seu cartão para manter um bom histórico de crédito.' },
        { titulo: 'Organize suas compras',   texto: 'Faça compras grandes logo após o fechamento da fatura para ter mais tempo de pagamento.' },
        { titulo: 'Cashback inteligente',    texto: 'Priorize cartões com cashback em categorias que você mais gasta, como supermercado e combustível.' },
        { titulo: 'Segurança em primeiro lugar', texto: 'Nunca compartilhe sua senha ou CVV com terceiros, mesmo que pareçam ser do banco.' },
        { titulo: 'App do banco',            texto: 'Ative notificações de compras no app do banco para detectar fraudes rapidamente.' },
        { titulo: 'Cartão virtual',          texto: 'Use cartões virtuais para compras online — eles podem ser bloqueados sem afetar o cartão físico.' },
        { titulo: 'Evite o rotativo',        texto: 'Nunca pague apenas o valor mínimo — os juros do rotativo podem chegar a 400% ao ano!' },
        { titulo: 'Programas de pontos',     texto: 'Acumule pontos e milhas em um único programa para maximizar benefícios e trocas.' },
        { titulo: 'Data de vencimento',      texto: 'Escolha a melhor data de vencimento de acordo com o dia que recebe seu salário.' },
        { titulo: 'Anuidade zero',           texto: 'Negocie isenção de anuidade com seu banco ou opte por cartões sem taxa.' },
        { titulo: 'Parcelamento consciente', texto: 'Parcele apenas compras essenciais e evite acumular muitas parcelas simultâneas.' },
        { titulo: 'Limite adequado',         texto: 'Mantenha um limite compatível com sua renda para não cair na tentação de gastar demais.' },
        { titulo: 'Taxa de juros',           texto: 'Conheça as taxas do seu cartão e compare com outros bancos — você pode estar pagando mais.' },
        { titulo: 'Compras por impulso',     texto: 'Espere 24 horas antes de fazer compras grandes no cartão — isso evita arrependimentos.' },
        { titulo: 'Múltiplos cartões',       texto: 'Ter mais de um cartão pode ser útil, mas só se você conseguir controlar todos.' },
        { titulo: 'Planejamento financeiro', texto: 'Reserve parte da sua renda mensal para pagar a fatura completa todo mês.' },
        { titulo: 'Revise sua fatura',       texto: 'Confira todas as compras mensalmente para identificar cobranças indevidas.' },
        { titulo: 'Emergências',             texto: 'Não use o cartão como reserva de emergência — crie uma poupança separada para isso.' },
        { titulo: 'Controle de parcelas',    texto: 'Anote todas as parcelas e seus vencimentos para não perder o controle financeiro.' },
        { titulo: 'Compare preços',          texto: 'Compras parceladas sem juros podem ser mais caras que à vista — sempre compare.' },
        { titulo: 'Antecipação de parcelas', texto: 'Se possível, quite parcelas antecipadamente para reduzir o comprometimento futuro.' },
        { titulo: 'Benefícios exclusivos',   texto: 'Use benefícios como seguros, descontos e acesso a salas VIP em aeroportos.' },
        { titulo: 'Pagamentos digitais',     texto: 'Carteiras digitais como Apple Pay e Google Pay adicionam uma camada extra de segurança.' },
        { titulo: 'Bloqueio temporário',     texto: 'Bloqueie seu cartão temporariamente quando não estiver usando para evitar fraudes.' },
        { titulo: 'Negociação de dívidas',   texto: 'Se estiver endividado, negocie diretamente com o banco — eles têm programas especiais.' },
        { titulo: 'Fechamento da fatura',    texto: 'Conheça a data de fechamento para planejar melhor suas compras mensais.' },
        { titulo: 'Metas de gastos',         texto: 'Estabeleça um limite mensal de gastos no cartão e respeite-o rigorosamente.' },
        { titulo: 'Educação financeira',     texto: 'Invista tempo aprendendo sobre finanças — isso vale mais que qualquer benefício de cartão.' },
        { titulo: 'Portabilidade',           texto: 'Se encontrar melhores condições em outro banco, considere fazer a portabilidade da dívida.' },
        { titulo: 'Refinanciamento',         texto: 'Evite refinanciar dívidas de cartão — as taxas são abusivas e prolongam o endividamento.' },
        { titulo: 'Saque no cartão',         texto: 'NUNCA faça saque no cartão de crédito — as taxas são extremamente altas.' },
        { titulo: 'Análise mensal',          texto: 'Reserve um tempo todo mês para analisar seus gastos e identificar padrões.' },
        { titulo: 'Descontos exclusivos',    texto: 'Muitos cartões oferecem descontos em estabelecimentos parceiros — aproveite!' },
        { titulo: 'Seguro de compras',       texto: 'Verifique se seu cartão oferece seguro para compras — pode ser muito útil.' },
        { titulo: 'Programa de fidelidade',  texto: 'Participe de programas de fidelidade para ganhar benefícios extras.' },
        { titulo: 'Token digital',           texto: 'Use a função de token digital para compras online mais seguras.' },
        { titulo: 'Autenticação de dois fatores', texto: 'Sempre que possível, ative a autenticação de dois fatores.' },
        { titulo: 'Limite pré-aprovado',     texto: 'Não aceite aumentos de limite automáticos — avalie se realmente precisa.' },
        { titulo: 'Categoria de gastos',     texto: 'Use cartões específicos para categorias diferentes e maximize benefícios.' },
        { titulo: 'Calendário financeiro',   texto: 'Crie um calendário com todas as datas de vencimento dos seus cartões.' },
        { titulo: 'Compras internacionais',  texto: 'Prefira cartões sem IOF para compras no exterior — economiza bastante.' },
        { titulo: 'Black Friday consciente', texto: 'Não compre apenas porque está em promoção — avalie se realmente precisa.' },
        { titulo: 'Reserva de emergência',   texto: 'Tenha pelo menos 3 meses de despesas guardadas antes de usar crédito.' },
        { titulo: 'Relatórios mensais',      texto: 'Use aplicativos como o GranaEvo para acompanhar seus gastos em tempo real.' },
        { titulo: 'Programas de desconto',   texto: 'Cadastre-se em programas de desconto vinculados ao seu cartão.' },
        { titulo: 'Leitura do contrato',     texto: 'Leia sempre o contrato do cartão para conhecer todas as taxas e condições.' },
        { titulo: 'Educação dos filhos',     texto: 'Ensine seus filhos sobre uso responsável de cartão desde cedo.' },
        { titulo: 'Relacionamento bancário', texto: 'Mantenha um bom relacionamento com seu banco para conseguir melhores condições.' },
        { titulo: 'Evite empréstimos',       texto: 'Prefira economizar e comprar à vista do que parcelar tudo no cartão.' },
    ];

    const d = dicas[Math.floor(Math.random() * dicas.length)];
    return { titulo: d.titulo, texto: d.texto };
}

// Expor função globalmente
window.abrirDetalhesCartaoRelatorio = abrirDetalhesCartaoRelatorio;

