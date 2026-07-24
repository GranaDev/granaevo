// db-relatorios-export.js — as 4 funcoes de exportacao (PDF/CSV/Excel/slides)
// + helpers so-de-export, EXTRAIDAS de db-relatorios.js.
//
// POR QUE: sao codigo "so no clique de exportar". Ficavam no chunk que carrega
// ao ABRIR Relatorios. Aqui viram um sub-chunk carregado sob demanda (o
// dispatcher faz import() deste modulo). db-relatorios.js fica mais leve no boot.
//
// _ctx e os helpers COMPARTILHADOS com o render (que ficaram no modulo principal)
// chegam via init(ctx, deps). Os atalhos de _ctx sao recriados aqui (proxies).

// Atalhos para utilitarios de dashboard.js (via _ctx apos init) — mesmos do main.
let _ctx = null;
const formatBRL      = (...a) => _ctx.formatBRL(...a);
const sanitizeHTML   = (...a) => _ctx.sanitizeHTML(...a);
const getMesNome     = (...a) => _ctx.getMesNome(...a);
const formatarDataBR = (...a) => _ctx.formatarDataBR(...a);
const sanitizeNumber = (...a) => _ctx.sanitizeNumber(...a);
const sanitizeDate   = (...a) => _ctx.sanitizeDate(...a);
const dataParaISO    = (...a) => _ctx.dataParaISO(...a);
const _sanitizeText  = (...a) => _ctx._sanitizeText(...a);
const safeCategorias = (...a) => _ctx.safeCategorias(...a);
const sanitizarHTMLPopup = (...a) => _ctx.sanitizarHTMLPopup(...a);

// Helpers COMPARTILHADOS que ficaram no modulo principal (passados via init).
let _escapeXml, _getPeriodInfo, _getTxsDoPeriodo, _relExpandirTx, _downloadBlob;

export function init(ctx, deps) {
  _ctx = ctx;
  ({ _escapeXml, _getPeriodInfo, _getTxsDoPeriodo, _relExpandirTx, _downloadBlob } = deps);
}

function _fmtBRL(v) {
    const n = parseFloat(v) || 0;
    return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── CSV: transações do período (UTF-8 BOM, separador pt-BR) ───────────────
function _exportCSV() {
    const txs = _getTxsDoPeriodo();
    const { mesNome, anoNum, mesNum } = _getPeriodInfo();
    const perfil = _ctx.perfilAtivo?.nome || '';

    // Separador ';' (padrão pt-BR): Excel/Google Sheets em português abrem em
    // COLUNAS. Com vírgula, e com o decimal também em vírgula, o Excel pt-BR
    // jogava tudo numa coluna só. O decimal segue vírgula (R$ 10,50).
    const SEP = ';';
    const cel = (val) => {
        const s = String(val ?? '').replace(/"/g, '""');   // RFC 4180
        return /[";\n\r]/.test(s) ? `"${s}"` : s;
    };
    const linha = (arr) => arr.map(cel).join(SEP);

    const geradoEm = new Date().toLocaleDateString('pt-BR') + ' ' +
        new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    // Cabeçalho editorial (contexto antes da tabela) + tabela.
    const linhas = [
        linha(['GranaEvo — Transações']),
        linha([`Período: ${mesNome} ${anoNum}` + (perfil ? ` · Perfil: ${perfil}` : '')]),
        linha([`Gerado em: ${geradoEm} · ${txs.length} lançamento${txs.length === 1 ? '' : 's'}`]),
        '',
        linha(['Data', 'Hora', 'Categoria', 'Tipo', 'Descrição', 'Valor (R$)']),
    ];
    txs.forEach(t => {
        linhas.push(linha([
            t.data || '', t.hora || '', t.categoria || '', t.tipo || '', t.descricao || '',
            typeof t.valor === 'number' ? t.valor.toFixed(2).replace('.', ',') : (t.valor || '0,00'),
        ]));
    });

    const csv     = '﻿' + linhas.join('\r\n'); // BOM UTF-8 → Excel lê acento certo
    const arquivo = `GranaEvo_${anoNum}-${mesNum}_${perfil || 'relatorio'}_transacoes.csv`;
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

    // Metas: a tela usa um <select> interativo — um PDF é estático. Expando TODAS
    // as metas reaproveitando o próprio renderizador (disparo 'change' por meta e
    // capturo o HTML gerado). Restauro a tela ao fim.
    let metasPdfHtml = '';
    const selMeta = resultado.querySelector('#selectMetaRelatorio');
    const detMeta = resultado.querySelector('#detalhesMetaRelatorio');
    if (selMeta && detMeta) {
        const prev = selMeta.value;
        for (const opt of [...selMeta.options]) {
            if (!opt.value) continue;
            selMeta.value = opt.value;
            selMeta.dispatchEvent(new Event('change'));
            const h = detMeta.innerHTML.trim();
            if (h) metasPdfHtml += '<div class="rel-meta-pdf-item">' + h + '</div>';
        }
        selMeta.value = prev;
        selMeta.dispatchEvent(new Event('change'));  // restaura a tela
    }

    // Canvases (gráficos) e logos de banco dos cartões viram data URI: <img src=
    // "/assets/..."> e <canvas> não sobrevivem no arquivo .html isolado.
    const canvasMap = new Map();
    resultado.querySelectorAll('canvas').forEach(canvas => {
        try { canvasMap.set(canvas, canvas.toDataURL('image/png')); } catch { }
    });
    const imgMap = new Map();
    resultado.querySelectorAll('.rel-card-visual-img').forEach(img => {
        try {
            const cv = document.createElement('canvas');
            cv.width = img.naturalWidth || 48; cv.height = img.naturalHeight || 48;
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            imgMap.set(img, cv.toDataURL('image/png'));
        } catch { }
    });

    // Ícone do site no cabeçalho (data URI — custo ZERO de bundle, ver _logoDataUri)
    const logoUri = _logoDataUri();
    const markImg = logoUri ? '<img class="ge-mark" src="' + logoUri + '" alt="" aria-hidden="true">' : '';

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
    const origImgs = [...resultado.querySelectorAll('.rel-card-visual-img')];
    [...clone.querySelectorAll('.rel-card-visual-img')].forEach((im, idx) => {
        const url = imgMap.get(origImgs[idx]);
        if (url) im.src = url; else im.remove();
    });
    // Substitui o seletor interativo de metas pelas metas já expandidas
    if (metasPdfHtml) {
        const selWrap = clone.querySelector('.rel-meta-selector-wrap');
        const detClone = clone.querySelector('#detalhesMetaRelatorio');
        if (selWrap) selWrap.remove();
        if (detClone) { detClone.removeAttribute('style'); detClone.innerHTML = metasPdfHtml; }
    } else {
        const secMetas = clone.querySelector('.rel-section--metas');
        if (secMetas) secMetas.remove();  // sem metas expansíveis → não deixa seção vazia
    }
    clone.querySelectorAll('button,.btn-primary,.btn-cancelar,.rel-header-actions').forEach(el => el.remove());

    const html = '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n<meta charset="UTF-8">\n<title>GranaEvo — ' + _escapeXml(tipo) + ' ' + _escapeXml(mesNome) + ' ' + _escapeXml(anoNum) + '</title>\n' +
`<style>
/* Base do documento: só TOKENS claros (convertem o tema escuro do app p/ papel)
   e ajustes de impressão. O layout real vem de _coletarCssDoRelatorio + camada
   editorial no fim. */
*{box-sizing:border-box;margin:0;padding:0}
:root{
  /* Tokens do app, em claro — é isto que "vira" o relatório para o papel. */
  --color-bg:#ffffff; --color-bg-card:#ffffff; --color-bg-soft:#f8fafc;
  --color-bg-elevated:#f1f5f9; --color-surface:#ffffff;
  --color-text:#0f172a; --color-text-muted:#475569; --color-text-faint:#64748b;
  --color-text-lighter:#334155; --text-primary:#0f172a; --text-secondary:#475569;
  --color-border:rgba(15,23,42,0.10); --color-border-strong:rgba(15,23,42,0.18);
  --primary:#0d9488; --color-primary:#0d9488;
  --color-success:#0a7a4d; --color-danger:#b91c1c; --color-warning:#a16207;
  --color-info:#1d4ed8;
  /* Nomes CURTOS de token do app (o CSS do relatório os usa direto). Estavam
     faltando — por isso o miolo do donut caía p/ #1a1d2e e a legenda ficava
     sem cor. Todos aqui em versão clara. */
  --text-muted:#64748b; --text-tertiary:#94a3b8;
  --bg-primary:#ffffff; --bg-secondary:#ffffff; --bg-tertiary:#f1f5f9; --dark-card:#f8fafc;
  --primary-light:#14b8a6; --primary-dark:#0f766e; --secondary:#475569;
  --border:#e5e7eb; --success:#047857; --danger:#b91c1c; --warning:#b45309;
  --gradient-primary:linear-gradient(135deg,#0d9488,#0f766e);
  --gradient-dark:linear-gradient(135deg,#f8fafc,#eef2f7);
  --shadow-md:0 1px 3px rgba(15,23,42,.06); --shadow-lg:0 4px 12px rgba(15,23,42,.08);
  --shadow-card:0 1px 3px rgba(15,23,42,.06); --radius-sm:6px; --radius-2xl:18px;
  /* Calendário/relatório por tipo, já em tons legíveis no branco */
  --cal-c-fatura:#b91c1c; --cal-c-conta:#b45309; --cal-c-assinatura:#7e22ce;
  --cal-c-lembrete:#a16207; --cal-c-entrada:#047857; --cal-c-saida:#1d4ed8;

  --tinta:#0f172a; --tinta-2:#475569; --tinta-3:#94a3b8;
  --linha:#e8ecf1; --linha-forte:#cbd5e1; --papel-2:#f8fafc;
  --marca:#0d9488; --pos:#0a7a4d; --neg:#b91c1c; --res:#a16207;
}
body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:#fff;color:var(--tinta);font-size:14px;line-height:1.55;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"cv05" 1;
}
.ge-doc{max-width:880px;margin:0 auto;padding:40px 44px 64px}

/* Masthead: uma faixa de marca sóbria, com filete teal — a "capa" do documento */
.ge-hdr{
  display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;
  margin-bottom:34px;padding-bottom:18px;border-bottom:1px solid var(--linha-forte);
  position:relative;
}
.ge-hdr::after{content:'';position:absolute;left:0;bottom:-1px;width:76px;height:3px;background:var(--marca);border-radius:2px}
.ge-kicker{font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:0.18em;color:var(--tinta-3);margin-bottom:6px}
.ge-logo-row{display:flex;align-items:center;gap:10px}
.ge-mark{width:30px;height:30px;border-radius:7px;border:none !important;flex-shrink:0}
.ge-logo{font-size:1.75rem;font-weight:800;color:var(--marca);letter-spacing:-0.035em;line-height:1}
.ge-logo span{color:var(--tinta)}
.ge-meta{text-align:right;font-size:0.76rem;color:var(--tinta-3);line-height:1.65}
.ge-meta strong{color:var(--tinta);font-size:0.95rem;font-weight:700;display:block;margin-bottom:2px;letter-spacing:-0.01em}

.ge-btn{
  display:inline-flex;align-items:center;gap:8px;background:var(--marca);color:#fff;border:none;
  padding:11px 24px;border-radius:8px;font-size:0.86rem;font-weight:600;cursor:pointer;
  margin-bottom:30px;font-family:inherit;letter-spacing:0.01em;
}
.ge-btn:hover{background:#0f766e}
.ge-btn svg{width:15px;height:15px}

/* Tabelas genéricas (ex.: patrimônio): sem zebra; respiro e alinhamento bastam.
   Cards, seções e KPIs do relatório são estilizados na camada editorial lá
   embaixo, sobre as classes rel-* reais que o app emite. */
table{width:100%;border-collapse:collapse;font-size:0.8rem;margin-bottom:6px}
thead{display:table-header-group}  /* repete o cabeçalho a cada página impressa */
tr{page-break-inside:avoid;break-inside:avoid}
th{
  color:var(--tinta-3);font-weight:700;font-size:0.64rem;text-transform:uppercase;letter-spacing:0.08em;
  padding:0 12px 8px;text-align:left;border-bottom:1px solid var(--linha-forte);background:none;
}
td{padding:9px 12px;border-bottom:1px solid var(--linha);color:var(--tinta-2)}
td:first-child,th:first-child{padding-left:2px}
td:last-child,th:last-child{padding-right:2px;text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}

img{max-width:100%;height:auto;border-radius:8px;border:1px solid var(--linha)}

/* Impressão: margens de verdade, sem o botão, sem cortar bloco no meio */
@page{margin:14mm 12mm}
@media print{
  .ge-btn{display:none !important}
  .ge-doc{padding:0;max-width:none}
  body{font-size:11.5pt}
  a[href]:after{content:''}
}
</style>
<!-- Regras REAIS do relatório, vindas do próprio app (ver _coletarCssDoRelatorio).
     Ficam DEPOIS da base para vencer no empate de especificidade; os tokens claros
     declarados acima é que as convertem para papel branco. -->
<style>
` + _coletarCssDoRelatorio() + `
/* ═══ CAMADA EDITORIAL (mesma linguagem do Excel aprovado) ═══════════════════
   Vem por ÚLTIMO p/ vencer o CSS do app: card claro c/ filete teal no topo,
   seção com sublinha teal, tipografia no lugar de ícone. Os <i> do Font Awesome
   são escondidos (a fonte não existe no doc isolado → virariam caixa vazia). */
#relatorioResultado,.rel-resultado{background:none !important;padding:0 !important;border:none !important;box-shadow:none !important;margin:0 !important}
.rel-report-header{display:none !important}  /* capa .ge-hdr substitui — sem título duplo */

/* Ícones FA escondidos; os "dots" (.rel-*-dot) são <span>, não <i>, e ficam. */
.rel-section-header i,.rel-kpi-icon,.rel-insight-icon-wrap i,i.fas,i.far,i.fal,i.fab,i.fa,i[class*="fa-"]{display:none !important}

.rel-section{page-break-inside:avoid;break-inside:avoid;margin-bottom:30px}
.rel-section-header{
  font-size:0.98rem !important;font-weight:800 !important;color:var(--tinta) !important;
  letter-spacing:-0.01em !important;text-transform:none !important;
  padding-bottom:9px !important;margin-bottom:18px !important;
  border-bottom:2px solid var(--marca) !important;gap:0 !important;
  page-break-after:avoid;break-after:avoid;
}

/* KPI cards: claro + filete teal no topo (idêntico ao Excel) */
.rel-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:6px}
.rel-kpi-card{
  background:var(--papel-2) !important;border:1px solid var(--linha) !important;
  border-top:3px solid var(--marca) !important;border-radius:10px !important;
  padding:14px 16px !important;box-shadow:none !important;break-inside:avoid;display:block !important;
}
.rel-kpi-top{display:block !important;margin:0 !important;gap:0 !important}
.rel-kpi-label{
  font-size:0.63rem !important;font-weight:700 !important;text-transform:uppercase !important;
  letter-spacing:0.09em !important;color:var(--tinta-3) !important;margin:0 0 7px !important;display:block !important;
}
.rel-kpi-value{
  font-size:1.5rem !important;font-weight:800 !important;color:var(--tinta) !important;
  letter-spacing:-0.02em !important;line-height:1.15 !important;font-variant-numeric:tabular-nums;display:block !important;
}
.rel-kpi-sub{font-size:0.7rem !important;color:var(--tinta-3) !important;margin:5px 0 0 !important;display:block !important}
/* Cor semântica só no VALOR (entrada verde, saída vermelha, saldo teal) */
.rel-kpi-card--entradas .rel-kpi-value{color:var(--pos) !important}
.rel-kpi-card--saidas .rel-kpi-value{color:var(--neg) !important}
.rel-kpi-card--saldo .rel-kpi-value,.rel-kpi-card--economia .rel-kpi-value,.rel-kpi-card--guardado .rel-kpi-value{color:var(--marca) !important}

/* Barras de progresso (categorias/metas/cartões/patrimônio) na cor da marca */
.rel-cat-bar-fill,.rel-card-visual-bar-fill,.rel-meta-bar-fill,.rel-patr-bar{background:var(--marca) !important}
.rel-cat-bar-track,.rel-card-visual-bar-wrap,.rel-meta-bar-track,.rel-patr-bar-wrap{background:var(--linha) !important}
.rel-meta-bar-label{color:var(--marca) !important}

/* Visão Geral — donut: miolo branco (o --bg-secondary já resolve), texto legível,
   legenda temática (rótulo slate, valor slate-900, % em teal). */
.rel-vg-inner{background:#fff !important;box-shadow:0 0 0 1px var(--linha)}
.rel-vg-center-val{color:var(--tinta) !important}
.rel-vg-center-label{color:var(--tinta-3) !important}
.rel-vg-leg-item{background:var(--papel-2) !important;border:1px solid var(--linha)}
.rel-vg-leg-label{color:var(--tinta-2) !important}
.rel-vg-leg-val{color:var(--tinta) !important}
.rel-vg-leg-pct{color:var(--marca) !important}
.rel-vg-cats-header{border-top:1px solid var(--linha) !important}

/* Insights: o ícone FA não carrega → escondo o círculo e viro callout com
   acento teal à esquerda (o texto é o que importa). */
.rel-insight-icon-wrap{display:none !important}
.rel-insight-item{border-left:3px solid var(--marca) !important;padding-left:12px !important;background:var(--papel-2) !important;border-radius:8px}
.rel-insight-title{color:var(--tinta) !important}
.rel-insight-text{color:var(--tinta-2) !important}

/* Cartões: sem a dica "Toque para ver detalhes" (é PDF), logo do banco sem borda */
.rel-card-visual-hint{display:none !important}
.rel-card-visual-img{border:none !important;border-radius:6px}
/* Metas expandidas no PDF: cada meta vira um card com filete teal */
.rel-meta-pdf-item{padding:14px 16px;border:1px solid var(--linha);border-top:3px solid var(--marca);border-radius:10px;margin-bottom:12px;break-inside:avoid}

canvas{max-width:100% !important;height:auto !important}
@media print{@page{margin:14mm 12mm}.ge-btn{display:none !important}body{font-size:12.5px}.rel-section{page-break-inside:avoid}.rel-kpi-card{break-inside:avoid}}
</style>
</head>
<body>
<div class="ge-doc">
  <div class="ge-hdr">
    <div class="ge-brand"><div class="ge-kicker">Relatório Financeiro</div><div class="ge-logo-row">` + markImg + `<span class="ge-logo">Grana<span>Evo</span></span></div></div>
    <div class="ge-meta"><strong>` + _escapeXml(tipo) + ' · ' + _escapeXml(mesNome) + ' ' + _escapeXml(anoNum) + `</strong>` +
    (perfilNome ? 'Perfil: ' + perfilNome + '<br>' : '') +
    'Gerado em: ' + _escapeXml(geradoEm) + `</div>
  </div>
  <button class="ge-btn" onclick="window.print()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>Salvar como PDF (Ctrl + P)</button>
  ` + clone.innerHTML + `
</div>
</body>
</html>`;

    _downloadBlob(html, 'GranaEvo_' + anoNum + '-' + mesNum + '_' + (perfilNome || 'relatorio') + '.html', 'text/html;charset=utf-8');
    _ctx.mostrarNotificacao('Relatório baixado. Abra o arquivo e pressione Ctrl + P → Salvar como PDF.', 'success');
}

// ── Excel: SpreadsheetML XML (.xls) ─────────────────────────────────────
async function _exportExcel() {
    const { mesNome, anoNum, mesNum } = _getPeriodInfo();
    const perfilNome = _ctx.perfilAtivo?.nome || 'Perfil';
    const txs = _getTxsDoPeriodo();

    // Gerador OOXML carregado sob demanda — fora do chunk de boot de Relatórios.
    let gerarXlsx;
    try { ({ gerarXlsx } = await import('../modules/xlsx.js')); }
    catch { _ctx.mostrarNotificacao('Não foi possível carregar o gerador de planilha.', 'error'); return; }

    const entradas = txs.filter(t => t.categoria === 'entrada').reduce((s, t) => s + Number(t.valor || 0), 0);
    const saidas   = txs.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').reduce((s, t) => s + Number(t.valor || 0), 0);
    const reservas = txs.filter(t => t.categoria === 'reserva').reduce((s, t) => s + Number(t.valor || 0), 0);
    const saldo    = entradas - saidas;

    const catMap = {};
    txs.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').forEach(t => {
        catMap[t.tipo || 'Outros'] = (catMap[t.tipo || 'Outros'] || 0) + Number(t.valor || 0);
    });
    const categorias = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

    const entrCred = txs.filter(t => t.categoria === 'saida_credito').reduce((s, t) => s + Number(t.valor || 0), 0);
    const compromet = entradas > 0 ? Math.min(1, (saidas + reservas) / entradas) : 0;

    const _CAT_LBL = { entrada:'Entrada', saida:'Saída', saida_credito:'Crédito', reserva:'Reserva', retirada_reserva:'Retirada' };

    // ── Helpers de célula (ids de estilo definidos em modules/xlsx.js) ──────
    // 0 fundo · 1 header · 2 seção · 3 R$ · 4 R$+ · 5 R$− · 6 % · 7 KPI-rótulo
    // 8 KPI-valor · 9 muted · 10 data · 11 capa · 12 capa-sub · 13 texto
    // 14 R$ card · 15 header-num · 16 KPI-valor-neg
    const H  = (v) => ({ v, s: 1 });
    const Hn = (v) => ({ v, s: 15 });
    const T  = (v) => ({ v, s: 2 });
    const Cap = (v) => ({ v, s: 11 });
    const Sub = (v) => ({ v, s: 12 });
    const Tx  = (v) => ({ v, s: 13 });
    const Mu  = (v) => ({ v, s: 9 });
    const Dt  = (v) => ({ v, s: 10 });
    const M  = (v, pos) => ({ v: Number(v) || 0, s: pos === true ? 4 : pos === false ? 5 : 3 });
    const P  = (frac) => ({ v: Number(frac) || 0, s: 6 });
    const kL = (v) => ({ v, s: 7 });
    const kV = (v, neg) => ({ v: Number(v) || 0, s: neg ? 16 : 8 });
    const kS = (v) => ({ v, s: 17 });   // sublinha do KPI (dentro do card)

    const geradoEm = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    // ════════ ABA 1 — DASHBOARD ════════
    // Bloco de categorias começa na linha `catIni`; os gráficos apontam para ele.
    const catIni = 12;
    const catFim = Math.max(catIni, catIni + categorias.length - 1);
    const q = (col) => `'Dashboard'!$${col}$${catIni}:$${col}$${catFim}`;

    const dash = [
        [],                                                                     // 1
        [Cap('GranaEvo'), '', '', Sub('Relatório Financeiro')],                 // 2
        [Sub(`${mesNome} de ${anoNum}  ·  ${perfilNome}`), '', '', Mu(`Gerado em ${geradoEm}`)], // 3
        [],                                                                     // 4
        [T('RESUMO DO MÊS')],                                                   // 5
        [kL('ENTRADAS'), '', kL('SAÍDAS'), '', kL('RESERVADO'), '', kL('SALDO LIVRE')], // 6
        [kV(entradas), '', kV(saidas, true), '', kV(reservas), '', kV(saldo, saldo < 0)], // 7
        [kS(`${txs.filter(t=>t.categoria==='entrada').length} lançamento(s)`), '',
         kS(entrCred > 0 ? `${_brlLocal(entrCred)} no crédito` : `${txs.filter(t=>t.categoria==='saida'||t.categoria==='saida_credito').length} gasto(s)`), '',
         kS(entradas>0 ? `${Math.round((reservas/entradas)*100)}% do que entrou` : '—'), '',
         kS(entradas>0 ? `${Math.round((saldo/entradas)*100)}% da renda sobrou` : '—')], // 8
        [],                                                                     // 9
        [T('PARA ONDE FOI O DINHEIRO')],                                        // 10
        [H('CATEGORIA'), Hn('VALOR'), Hn('% DO TOTAL')],                        // 11
        ...categorias.map(([cat, val]) => [Tx(cat), M(val, false), P(saidas > 0 ? val / saidas : 0)]), // 12+
    ];

    // Gráficos À DIREITA da tabela (cols A–C) e ABAIXO dos KPIs (linhas 6–8),
    // começando alinhados ao cabeçalho da tabela (linha 11 = índice 10). Antes
    // a âncora na linha 4 caía por cima do card "Saldo livre".
    const graficos = categorias.length > 0 ? [
        { tipo: 'pizza', titulo: 'Participação por categoria',
          catRef: q('A'), valRef: q('B'), pontos: categorias.length,
          ancora: { col: 4, linha: 10, col2: 12, linha2: 26 } },
        { tipo: 'barra', titulo: 'Maiores gastos (R$)',
          catRef: q('A'), valRef: q('B'),
          ancora: { col: 4, linha: 27, col2: 12, linha2: 46 } },
    ] : [];

    // ════════ ABA 2 — TRANSAÇÕES (data + descrição, o ledger completo) ══════
    const transacoes = [
        [Cap('Transações'), '', '', '', Sub(`${mesNome} ${anoNum}`)],
        [Mu(`${txs.length} lançamento(s) no período`)],
        [],
        [H('DATA'), H('DESCRIÇÃO'), H('CATEGORIA'), H('TIPO'), Hn('VALOR (R$)')],
        ...txs.slice().reverse().map(t => [
            Dt(t.data || ''),
            Tx(t.descricao || ''),
            Tx(_CAT_LBL[t.categoria] || t.categoria || ''),
            Tx(t.tipo || ''),
            M(t.valor, t.categoria === 'entrada' || t.categoria === 'retirada_reserva'),
        ]),
    ];
    const txCab = 4;

    // ════════ ABA 3 — RESERVAS E METAS ══════
    const metas = [
        [Cap('Reservas e Metas'), '', '', '', Sub(`${anoNum}`)],
        [Mu(`${(_ctx.metas || []).length} meta(s)`)],
        [],
        [H('NOME'), Hn('OBJETIVO'), Hn('GUARDADO'), Hn('PROGRESSO'), H('PRAZO')],
        ...(_ctx.metas || []).map(m => [
            Tx(m.descricao || ''),
            M(m.objetivo),
            M(m.saved || 0, true),
            P(m.objetivo > 0 ? Math.min(1, (m.saved || 0) / m.objetivo) : 0),
            Tx(m.prazo || 'Sem prazo'),
        ]),
    ];

    // ════════ ABA 4 — CONTAS FIXAS ══════
    const contasArr = (_ctx.contasFixas || []).filter(c2 => c2.tipoContaFixa !== 'fatura_cartao');
    const contas = [
        [Cap('Contas Fixas'), '', '', Sub(`${mesNome} ${anoNum}`)],
        [Mu(`${contasArr.length} conta(s) · total ${_brlLocal(contasArr.reduce((s,c)=>s+Number(c.valor||0),0))}`)],
        [],
        [H('DESCRIÇÃO'), Hn('VALOR'), H('VENCIMENTO'), H('STATUS')],
        ...contasArr.map(cf => [
            Tx(cf.descricao || ''),
            M(cf.valor, false),
            Dt(cf.vencimento ? cf.vencimento.split('-').reverse().join('/') : ''),
            Tx(cf.pago ? 'Pago' : 'Pendente'),
        ]),
    ];

    const bytes = gerarXlsx([
        {
            // Larguras que igualam os 4 KPI cards: A:B=C:D=E:F=G:H=30, e a coluna
            // C (% do total) larga o bastante para não mostrar "##".
            nome: 'Dashboard', linhas: dash, larguras: [17, 13, 15, 15, 15, 15, 17, 13],
            congelar: false,
            alturaCapa: { 2: 34, 5: 24, 6: 18, 7: 32, 8: 16, 10: 24 },
            mesclar: ['A2:B2', 'A3:B3', 'A5:H5', 'A10:H10',
                      'A6:B6', 'C6:D6', 'E6:F6', 'G6:H6',
                      'A7:B7', 'C7:D7', 'E7:F7', 'G7:H7',
                      'A8:B8', 'C8:D8', 'E8:F8', 'G8:H8'],
            barras: categorias.length ? [{ ref: `C${catIni}:C${catFim}`, cor: '0D9488' }] : [],
            graficos,
        },
        {
            nome: 'Transações', linhas: transacoes, larguras: [13, 42, 14, 20, 15],
            congelarLinha: txCab,
            alturaCapa: { 1: 28 },
            mesclar: ['A1:D1'],
            filtro: `A${txCab}:E${Math.max(txCab, txCab + txs.length)}`,
        },
        {
            nome: 'Reservas e Metas', linhas: metas, larguras: [30, 16, 16, 14, 14],
            congelarLinha: 4,
            alturaCapa: { 1: 28 },
            mesclar: ['A1:D1'],
            barras: (_ctx.metas || []).length ? [{ ref: `D5:D${4 + (_ctx.metas || []).length}`, cor: '0D9488' }] : [],
        },
        {
            nome: 'Contas Fixas', linhas: contas, larguras: [32, 16, 15, 13],
            congelarLinha: 4,
            alturaCapa: { 1: 28 },
            mesclar: ['A1:C1'],
            filtro: `A4:D${Math.max(4, 4 + contasArr.length)}`,
        },
    ]);

    const nomArq = 'GranaEvo_' + anoNum + '-' + mesNum + '_' + perfilNome.replace(/\s+/g, '_') + '.xlsx';
    _downloadBlob(bytes, nomArq, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    _ctx.mostrarNotificacao('Planilha gerada! Abre no Excel, Google Sheets e no celular.', 'success');
}

// Formatação BRL local — usada nas legendas/subtítulos do Excel, onde precisamos
// do texto e não de um número formatado por célula.
function _brlLocal(v) {
    return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ── Apresentação HTML interativa com slides financeiros ───────────────────
/**
 * Logo real do GranaEvo (já carregado no DOM) convertido para data URI.
 *
 * POR QUE assim: o PDF e a apresentação são arquivos .html SOLTOS — um
 * `src="/assets/..."` não resolve fora do site. Converter em runtime custa ZERO
 * de bundle (o dado vem do DOM, não do JS). Devolve '' se o logo não carregou,
 * e quem chama simplesmente omite a marca.
 */
function _logoDataUri() {
    const el = document.querySelector('img[src*="granaevo-logo"]');
    if (!el || !el.naturalWidth) return '';
    try {
        const cv = document.createElement('canvas');
        cv.width = el.naturalWidth; cv.height = el.naturalHeight;
        cv.getContext('2d').drawImage(el, 0, 0);
        return cv.toDataURL('image/png');
    } catch { return ''; }
}

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
    const logoUri = _logoDataUri();
    const metas = (_ctx.metas||[]).slice(0,5);
    const contas = (_ctx.contasFixas||[]).filter(c=>c.tipoContaFixa!=='fatura_cartao').slice(0,6);

    // Paleta categórica VALIDADA para fundo escuro (surface #0d1524) pelo
    // validador do dataviz: banda de luminosidade, chroma, separação CVD,
    // piso de visão normal e contraste — todos PASS. Ordem fixa, nunca ciclada.
    const CORES = ['#0D9488','#D97706','#3B82F6','#F43F5E','#A855F7','#0891B2','#EC4899','#65A30D'];
    const SURF = '#0d1524';

    // Ícones em SVG (o deck é um arquivo solto: não há Font Awesome, e emoji
    // está fora de questão). Traço fino, herda a cor do container.
    const ico = p => '<svg class="kic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+p+'</svg>';
    const IC_UP   = ico('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>');
    const IC_DOWN = ico('<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>');
    const IC_RES  = ico('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>');
    const IC_SLD  = ico('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>');

    const nEnt = txs.filter(t=>t.categoria==='entrada').length;
    const nSai = txs.filter(t=>t.categoria==='saida'||t.categoria==='saida_credito').length;
    const pctRes = entradas>0 ? (reservas/entradas*100) : 0;
    const pctSld = entradas>0 ? (saldo/entradas*100) : 0;
    const totalTop = top5.reduce((s,[,v])=>s+v,0) || 1;

    // Maiores lançamentos — dado NOVO (o donut já mostra composição por categoria,
    // repetir top-5 de categoria em barras seria redundante).
    const dataBR = d => {
        const iso = _ctx.dataParaISO ? _ctx.dataParaISO(d) : d;
        return (typeof iso === 'string' && iso.includes('-')) ? iso.slice(0,10).split('-').reverse().join('/') : String(d||'');
    };
    const topTx = txs.filter(t=>t.categoria==='saida'||t.categoria==='saida_credito')
        .sort((a,b)=>Number(b.valor||0)-Number(a.valor||0)).slice(0,6);

    // Donut por conic-gradient, com folga de 0.7% na cor da superfície entre as
    // fatias (o "2px surface gap" das specs de marca do dataviz).
    let acc = 0;
    const segs = [];
    top5.forEach(([,v],i)=>{
        const a = acc/totalTop*100; acc += v; const b = acc/totalTop*100;
        const corte = Math.max(a, b-0.7);
        segs.push(CORES[i]+' '+a.toFixed(2)+'% '+corte.toFixed(2)+'%');
        segs.push(SURF+' '+corte.toFixed(2)+'% '+b.toFixed(2)+'%');
    });

    const N = 7;
    const slideHTML = (id, content) => '<section class="slide" id="s'+id+'" aria-label="Slide '+id+'">'+content+'</section>';
    const cab = (n, rot) => '<div class="shdr"><span class="snum">'+String(n).padStart(2,'0')+' / '+N+'</span><span class="sdiv"></span><span class="slbl">'+rot+'</span></div>';
    const tit = (t, sub) => '<h2 class="stit">'+t+'</h2>'+(sub?'<p class="ssub">'+sub+'</p>':'');
    const vazio = m => '<p class="empty-msg">'+m+'</p>';

    const slides = [
        slideHTML(1,
            '<div class="cov">'+
            (logoUri?'<img class="cov-mark" src="'+logoUri+'" alt="" aria-hidden="true">':'')+
            '<div class="cov-logo">Grana<span>Evo</span></div>'+
            '<div class="cov-rule"></div>'+
            '<div class="cov-title">Relatório Financeiro</div>'+
            '<div class="cov-period">'+_escapeXml(mesNome)+' '+_escapeXml(anoNum)+'</div>'+
            '<div class="cov-meta">'+
            (perfilNome?'<span class="cov-tag">'+_escapeXml(perfilNome)+'</span>':'')+
            '<span>Gerado em '+new Date().toLocaleDateString('pt-BR')+'</span></div></div>'),

        slideHTML(2,
            cab(2,'Visão Geral')+tit('Resumo do mês','Como o dinheiro entrou, saiu e sobrou no período.')+
            '<div class="kgrid">'+
            '<div class="kcard pos">'+IC_UP+'<div class="klabel">Entradas</div><div class="kval">'+_escapeXml(_fmtBRL(entradas))+'</div><div class="ksub">'+nEnt+' lançamento'+(nEnt===1?'':'s')+'</div></div>'+
            '<div class="kcard neg">'+IC_DOWN+'<div class="klabel">Saídas</div><div class="kval">'+_escapeXml(_fmtBRL(saidas))+'</div><div class="ksub">'+nSai+' lançamento'+(nSai===1?'':'s')+'</div></div>'+
            '<div class="kcard warn">'+IC_RES+'<div class="klabel">Reservas</div><div class="kval">'+_escapeXml(_fmtBRL(reservas))+'</div><div class="ksub">'+pctRes.toFixed(1)+'% do que entrou</div></div>'+
            '<div class="kcard '+(saldo>=0?'acc':'neg')+'">'+IC_SLD+'<div class="klabel">Saldo</div><div class="kval">'+_escapeXml(_fmtBRL(saldo))+'</div><div class="ksub">'+pctSld.toFixed(1)+'% da renda sobrou</div></div>'+
            '</div>'),

        slideHTML(3,
            cab(3,'Composição')+tit('Para onde foi o dinheiro','Participação de cada categoria no total de saídas.')+
            (top5.length===0?vazio('Nenhum gasto no período'):
            '<div class="dwrap"><div class="dring">'+
            '<div class="donut" style="background:conic-gradient('+segs.join(',')+')"></div>'+
            '<div class="dhole"><span class="dhole-v">'+_escapeXml(_fmtBRL(saidas))+'</span><span class="dhole-l">Total de saídas</span></div>'+
            '</div><div class="dleg">'+top5.map(([cat,val],i)=>
                '<div class="dleg-i"><span class="dot" style="background:'+CORES[i]+'"></span>'+
                '<span class="dleg-n">'+_escapeXml(cat)+'</span>'+
                '<span class="dleg-v">'+_escapeXml(_fmtBRL(val))+'</span>'+
                '<span class="dleg-p">'+(saidas>0?((val/saidas)*100).toFixed(1):'0')+'%</span></div>').join('')+
            '</div></div>')),

        slideHTML(4,
            cab(4,'Detalhe')+tit('Maiores lançamentos','Os gastos individuais de maior peso no período.')+
            '<div class="rows">'+(topTx.length===0?vazio('Nenhum gasto no período'):topTx.map((t,i)=>
                '<div class="row"><span class="rnum">'+String(i+1).padStart(2,'0')+'</span>'+
                '<span class="rname">'+_escapeXml(String(t.descricao||t.tipo||'Lançamento'))+'</span>'+
                '<span class="rdate">'+_escapeXml(dataBR(t.data))+'</span>'+
                '<span class="rval">'+_escapeXml(_fmtBRL(t.valor))+'</span></div>').join(''))+'</div>'),

        slideHTML(5,
            cab(5,'Reservas')+tit('Progresso das metas','Quanto já foi guardado de cada objetivo.')+
            '<div class="metas">'+(metas.length===0?vazio('Nenhuma reserva criada'):metas.map(m=>{
                const pct=m.objetivo>0?Math.min(100,((m.saved||0)/m.objetivo)*100):0;
                return '<div class="mrow">'+
                '<div class="minfo"><span class="mname">'+_escapeXml(m.descricao||'')+'</span>'+
                '<div class="mbar-w"><div class="mbar" data-w="'+pct.toFixed(1)+'" style="--pw:'+pct.toFixed(1)+'%"></div></div></div>'+
                '<div class="mvals"><span class="mval">'+_escapeXml(_fmtBRL(m.saved||0))+'</span><span class="mpct">'+pct.toFixed(0)+'%</span></div></div>';
            }).join(''))+'</div>'),

        slideHTML(6,
            cab(6,'Obrigações')+tit('Contas fixas','Compromissos recorrentes do período.')+
            '<div class="conts">'+(contas.length===0?vazio('Nenhuma conta fixa'):contas.map(cf=>{
                const venc=cf.vencimento?cf.vencimento.split('-').reverse().join('/'):'';
                return '<div class="cont-row">'+
                '<span class="cont-name">'+_escapeXml(cf.descricao||'')+'</span>'+
                '<span class="cont-venc">'+_escapeXml(venc)+'</span>'+
                '<span class="cont-val">'+_escapeXml(_fmtBRL(cf.valor))+'</span>'+
                '<span class="chip '+(cf.pago?'ok':'due')+'">'+(cf.pago?'Pago':'Pendente')+'</span></div>';
            }).join(''))+'</div>'),

        slideHTML(7,
            '<div class="end">'+
            (logoUri?'<img class="end-mark" src="'+logoUri+'" alt="" aria-hidden="true">':'')+
            '<div class="end-num">'+_escapeXml(_fmtBRL(saldo))+'</div>'+
            '<div class="end-lbl">'+(saldo>=0?'sobrou no período':'de déficit no período')+'</div>'+
            '<div class="cov-rule" style="margin:22px auto"></div>'+
            '<div class="end-sub">'+_escapeXml(mesNome)+' '+_escapeXml(anoNum)+(perfilNome?' · '+_escapeXml(perfilNome):'')+'</div>'+
            '<div class="end-brand">Grana<span>Evo</span></div></div>')
    ];

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GranaEvo — Apresentação ${_escapeXml(mesNome)} ${_escapeXml(anoNum)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#f1f5f9; --ink2:#94a3b8; --ink3:#64748b;
  --acc:#2dd4bf;            /* teal claro: acento de INTERFACE (texto/filete) */
  --line:rgba(255,255,255,.09); --panel:rgba(255,255,255,.035);
  --pos:#34d399; --neg:#f87171; --warn:#fbbf24;
}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#0a0f1a;color:var(--ink);overflow:hidden;height:100vh;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
.pres{width:100vw;height:100vh;position:relative}
.slide{width:100%;height:100%;position:absolute;inset:0;display:none;flex-direction:column;padding:54px 76px 74px;
  background:radial-gradient(1100px 620px at 78% -10%,rgba(13,148,136,.17),transparent 62%),linear-gradient(160deg,#0d1524 0%,#0a0f1a 100%)}
.slide.active{display:flex}
.prog{position:fixed;top:0;left:0;height:2px;width:0;background:var(--acc);z-index:120;transition:width .35s ease}

/* Capa e fechamento */
.cov{height:100%;display:flex;flex-direction:column;justify-content:center}
.cov-mark{width:62px;height:62px;border-radius:14px;margin-bottom:28px}
.cov-logo{font-size:3.4rem;font-weight:900;letter-spacing:-.045em;line-height:1;color:var(--acc)}
.cov-logo span{color:var(--ink)}
.cov-rule{width:76px;height:3px;background:var(--acc);border-radius:2px;margin:22px 0}
.cov-title{font-size:1.05rem;color:var(--ink2);letter-spacing:.03em}
.cov-period{font-size:2.1rem;font-weight:800;letter-spacing:-.03em;margin-top:4px}
.cov-meta{margin-top:auto;display:flex;gap:14px;align-items:center;font-size:.76rem;color:var(--ink3)}
.cov-tag{background:rgba(45,212,191,.1);border:1px solid rgba(45,212,191,.3);color:var(--acc);padding:5px 15px;border-radius:99px;font-weight:700;font-size:.74rem}
.end{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.end-mark{width:52px;height:52px;border-radius:12px;margin-bottom:26px}
.end-num{font-size:3.2rem;font-weight:900;letter-spacing:-.045em;line-height:1}
.end-lbl{font-size:.9rem;color:var(--ink2);margin-top:8px}
.end-sub{font-size:.8rem;color:var(--ink3)}
.end-brand{font-size:1.1rem;font-weight:800;color:var(--acc);margin-top:26px;letter-spacing:-.02em}
.end-brand span{color:var(--ink)}

/* Cabeçalho e título de slide */
.shdr{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.snum{font-size:.7rem;font-weight:800;color:var(--acc);letter-spacing:.1em}
.sdiv{width:22px;height:1px;background:var(--line)}
.slbl{font-size:.7rem;color:var(--ink3);letter-spacing:.16em;text-transform:uppercase;font-weight:700}
.stit{font-size:2rem;font-weight:800;letter-spacing:-.03em}
.stit::after{content:'';display:block;width:54px;height:3px;background:var(--acc);border-radius:2px;margin-top:13px}
.ssub{font-size:.83rem;color:var(--ink2);margin:14px 0 26px}

/* KPIs — mesmo sistema do Excel/PDF: filete no topo + rótulo, valor, contexto */
.kgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.kcard{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--acc);border-radius:14px;padding:20px 18px}
.kic{width:19px;height:19px;color:var(--acc);margin-bottom:13px;display:block}
.klabel{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--ink3);margin-bottom:8px}
.kval{font-size:1.5rem;font-weight:800;letter-spacing:-.03em;line-height:1.1}
.ksub{font-size:.7rem;color:var(--ink3);margin-top:8px}
.kcard.pos .kval{color:var(--pos)} .kcard.neg .kval{color:var(--neg)}
.kcard.warn .kval{color:var(--warn)} .kcard.acc .kval{color:var(--acc)}

/* Donut de composição + legenda (rótulo direto = 2ª codificação além da cor) */
.dwrap{display:grid;grid-template-columns:290px 1fr;gap:52px;align-items:center;flex:1}
.dring{position:relative;width:290px;height:290px}
.donut{width:100%;height:100%;border-radius:50%}
.dhole{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:58%;height:58%;background:#0d1524;border-radius:50%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 0 0 1px var(--line)}
.dhole-v{font-size:1.25rem;font-weight:800;letter-spacing:-.02em}
.dhole-l{font-size:.58rem;color:var(--ink3);text-transform:uppercase;letter-spacing:.12em;margin-top:5px}
.dleg{display:flex;flex-direction:column;gap:11px}
.dleg-i{display:grid;grid-template-columns:11px 1fr auto 52px;align-items:center;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.dot{width:11px;height:11px;border-radius:3px}
.dleg-n{font-size:.86rem;font-weight:600}
.dleg-v{font-size:.86rem;font-weight:700}
.dleg-p{font-size:.74rem;color:var(--acc);font-weight:700;text-align:right}

/* Maiores lançamentos */
.rows{display:flex;flex-direction:column;gap:9px}
.row{display:grid;grid-template-columns:30px 1fr 100px 130px;align-items:center;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:13px 16px}
.rnum{font-size:.78rem;font-weight:800;color:var(--acc)}
.rname{font-size:.88rem;font-weight:600}
.rdate{font-size:.76rem;color:var(--ink3)}
.rval{font-size:.9rem;font-weight:700;text-align:right;color:var(--neg)}

/* Metas */
.metas{display:flex;flex-direction:column;gap:18px}
.mrow{display:grid;grid-template-columns:1fr 160px;gap:16px;align-items:center}
.mname{font-size:.9rem;font-weight:600;display:block;margin-bottom:8px}
.mbar-w{background:rgba(255,255,255,.08);border-radius:99px;height:7px}
.mbar{background:var(--acc);height:7px;border-radius:99px;width:0;transition:width .55s ease}
.mvals{text-align:right}
.mval{display:block;font-weight:700;font-size:.95rem}
.mpct{font-size:.75rem;color:var(--acc);font-weight:700}

/* Contas fixas */
.conts{display:flex;flex-direction:column;gap:9px}
.cont-row{display:grid;grid-template-columns:1fr 100px 130px 104px;align-items:center;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 16px}
.cont-name{font-weight:600;font-size:.88rem}
.cont-venc{font-size:.79rem;color:var(--ink3)}
.cont-val{font-size:.86rem;font-weight:700;text-align:right}
.chip{font-size:.68rem;font-weight:800;text-align:center;padding:4px 0;border-radius:99px;letter-spacing:.04em}
.chip.ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.32);color:var(--pos)}
.chip.due{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:var(--warn)}

.empty-msg{color:var(--ink3);text-align:center;margin-top:56px;font-size:.95rem}

/* Navegação */
.nav{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;background:rgba(6,10,18,.72);backdrop-filter:blur(14px);padding:9px 18px;border-radius:99px;border:1px solid var(--line);z-index:100}
.nbtn{background:none;border:none;color:var(--ink2);cursor:pointer;padding:3px 6px;display:flex;transition:color .2s}
.nbtn:hover{color:var(--acc)}
.nbtn svg{width:16px;height:16px}
.ndot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.18);cursor:pointer;transition:background .2s,transform .2s}
.ndot.a{background:var(--acc);transform:scale(1.3)}
.ninfo{font-size:.78rem;color:var(--ink3);min-width:54px;text-align:center;font-weight:600}
.hint{position:fixed;top:16px;right:20px;font-size:.68rem;color:var(--ink3);opacity:.55}
@media print{@page{size:1280px 720px;margin:0}body{overflow:visible;height:auto}.pres{width:1280px;height:auto}
  .slide{position:relative;display:flex!important;page-break-after:always;height:720px}
  .nav,.hint,.prog{display:none}.mbar{width:var(--pw,0)!important}}
</style>
</head>
<body>
<div class="pres">
${slides.join('\n')}
</div>
<div class="prog" id="pg"></div>
<nav class="nav">
<button class="nbtn" onclick="go(-1)" aria-label="Slide anterior"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg></button>
<div id="dots" style="display:flex;gap:7px;align-items:center"></div>
<span class="ninfo" id="ni">1 / ${N}</span>
<button class="nbtn" onclick="go(1)" aria-label="Próximo slide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
</nav>
<div class="hint">F11 tela cheia &nbsp;·&nbsp; setas ou espaço navegam &nbsp;·&nbsp; Ctrl+P imprime os slides</div>
<script>
var cur=0;
var sls=document.querySelectorAll('.slide');
var dotsEl=document.getElementById('dots');
var ni=document.getElementById('ni');
var pg=document.getElementById('pg');
sls.forEach(function(_,i){var d=document.createElement('div');d.className='ndot'+(i===0?' a':'');d.onclick=function(){goTo(i);};dotsEl.appendChild(d);});
function animate(n){sls[n].querySelectorAll('.mbar').forEach(function(b){var w=b.getAttribute('data-w');b.style.width='0';setTimeout(function(){b.style.width=(w||'0')+'%';},90);});}
function goTo(n){sls[cur].classList.remove('active');dotsEl.children[cur].classList.remove('a');cur=Math.max(0,Math.min(n,sls.length-1));sls[cur].classList.add('active');dotsEl.children[cur].classList.add('a');ni.textContent=(cur+1)+' / '+sls.length;pg.style.width=((cur+1)/sls.length*100)+'%';animate(cur);}
function go(d){goTo(cur+d);}
document.addEventListener('keydown',function(e){
  if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '||e.key==='PageDown'){e.preventDefault();go(1);}
  if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();go(-1);}
  if(e.key==='Home')goTo(0); if(e.key==='End')goTo(sls.length-1);
});
goTo(0);
</script>
</body>
</html>`;

    const fn = 'GranaEvo_Apresentacao_' + anoNum + '-' + mesNum + '_' + (perfilNome||'perfil').replace(/\s+/g,'_') + '.html';
    _downloadBlob(html, fn, 'text/html;charset=utf-8');
    _ctx.mostrarNotificacao('Apresentação gerada. Abra o arquivo e pressione F11 para tela cheia.', 'success');
}

/**
 * Coleta do próprio app as regras CSS que estilizam o relatório.
 *
 * POR QUE (bug 2026-07-20): o CSS do PDF era escrito à mão mirando classes
 * `.relatorio-card`, `.relatorio-section`… que NÃO EXISTEM. O resultado real usa
 * `.rel-kpi-card`, `.rel-section`, `.rel-insight-item`… Ou seja: nenhuma regra
 * casava e o PDF saía como texto empilhado, sem cards nem tabelas.
 *
 * Em vez de adivinhar nomes de novo (e desincronizar na próxima mudança de UI),
 * pegamos as regras REAIS das folhas de estilo carregadas. O PDF passa a herdar
 * o layout da tela automaticamente; só os TOKENS de cor são redefinidos para o
 * papel branco (o app é escuro), o que converte tudo para claro de uma vez.
 */
function _coletarCssDoRelatorio() {
    const regras = [];
    for (const folha of Array.from(document.styleSheets || [])) {
        let lista;
        try { lista = folha.cssRules; }         // folha de outra origem lança
        catch { continue; }
        if (!lista) continue;
        for (const regra of Array.from(lista)) {
            const txt = regra.cssText || '';
            if (!txt) continue;
            // Só o que toca o relatório — não arrastamos o dashboard inteiro.
            if (/\.rel-|\.relatorio-|#relatorioResultado|\.chart-|\.grafico/.test(txt)) {
                regras.push(txt);
            }
        }
    }
    return regras.join('\n');
}
export { _exportCSV, _exportPDF, _exportExcel, _exportApresentacao };
