// db-metas.js — Seção de Metas/Reservas (lazy-loaded)
import {
    fvComposto, mesesParaMeta, aporteNecessario, mesesAtePrazo, analisarRitmo,
} from '../modules/ritmo-metas.js?v=1';
import {
    contaCompartilhada, ehCompartilhada, membroAtual, registrarMovimento,
    porMembro, divisaoSugerida, perfilParticipa,
} from '../modules/reserva-familia.js?v=3';

let _ctx = null;
let _metaLinePeriod = 'mensal'; // mensal | bimestral | trimestral | semestral | anual

// ===== CDI automático =====
const _CDI_CACHE_KEY = '_ge_cdi_v2';
const _CDI_FALLBACK  = 10.5;
let   _cdiAnual      = _CDI_FALLBACK;

async function _fetchCDI() {
    try {
        const cached = localStorage.getItem(_CDI_CACHE_KEY);
        if (cached) {
            const { val, ts } = JSON.parse(cached);
            // Cache de 6h — BCB atualiza a série 4389 com lag após COPOM
            if (Date.now() - ts < 21_600_000) { _cdiAnual = val; return val; }
        }
    } catch {}

    // Busca série 4389 (CDI efetivo) e série 432 (Meta Selic) em paralelo.
    // A série 4389 costuma atrasar após decisões do COPOM; a 432 reflete
    // a meta imediatamente. Usamos o maior entre os dois.
    const _parseBCB = async (serie) => {
        const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados/ultimos/1?formato=json`;
        try {
            const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
            const json = await res.json();
            const v    = parseFloat(String(json[0]?.valor ?? '').replace(',', '.'));
            return Number.isFinite(v) && v > 0 ? v : null;
        } catch { return null; }
    };

    const [cdi, selic] = await Promise.all([_parseBCB(4389), _parseBCB(432)]);
    const val = [cdi, selic].reduce((max, v) => (v !== null && v > max ? v : max), 0);

    if (val > 0) {
        _cdiAnual = val;
        try { localStorage.setItem(_CDI_CACHE_KEY, JSON.stringify({ val, ts: Date.now() })); } catch {}
        _atualizarLabelCDI(val);
        return val;
    }
    return null;
}

function _atualizarLabelCDI(val) {
    document.querySelectorAll('[data-cdi-rate]').forEach(el => {
        el.textContent = `CDI atual: ${val.toFixed(2).replace('.', ',')}% a.a.`;
    });
}

// Proxies para utilitários de dashboard.js disponíveis via _ctx após init()
const formatBRL     = (...a) => _ctx.formatBRL(...a);
const _sanitizeText = (...a) => _ctx._sanitizeText(...a);

// ===== Funções financeiras =====
// fvComposto / mesesParaMeta / aporteNecessario MUDARAM-SE para
// modules/ritmo-metas.js (importadas no topo) — mesma matemática, agora coberta
// por testes e compartilhada com o cálculo de ritmo da lista. Manter uma cópia
// local aqui faria o preview do form e a tag da lista divergirem com o tempo.

/**
 * Tag de ritmo da meta na lista (item 3), ou null quando não há o que dizer.
 *
 * Tom deliberado: ORIENTA, não acusa. Meta recém-criada mostra "guarde R$X/mês"
 * (útil) em vez de "atrasada" (injusto — não deu tempo de aportar ainda).
 */
function _tagRitmo(m) {
    let r;
    try {
        r = analisarRitmo(m, _ctx.transacoes, _taxaMensal(m), new Date());
    } catch (e) {
        _ctx._log?.warn?.('RITMO_TAG_001', e);
        return null;                       // ritmo é complemento: nunca quebra a lista
    }

    const tag = document.createElement('span');
    tag.className = 'meta-tag';

    switch (r.status) {
        case 'no_ritmo':
            tag.classList.add('meta-tag-ritmo-ok');
            tag.textContent = '✅ no ritmo';
            tag.title = r.necessario > 0
                ? `Precisa de ${formatBRL(r.necessario)}/mês — você guarda ${formatBRL(r.real)}/mês`
                : 'O rendimento sozinho já leva ao objetivo dentro do prazo';
            return tag;

        case 'atrasada':
            tag.classList.add('meta-tag-ritmo-off');
            tag.textContent = `⚠️ faltam ${formatBRL(r.gap)}/mês`;
            tag.title = `Precisa de ${formatBRL(r.necessario)}/mês para chegar no prazo — `
                      + `você guarda ${formatBRL(r.real)}/mês`;
            return tag;

        case 'sem_historico':
            tag.classList.add('meta-tag-ritmo-neutro');
            tag.textContent = `🎯 guarde ${formatBRL(r.necessario)}/mês`;
            tag.title = `Para chegar em ${formatBRL(parseFloat(m.objetivo) || 0)} no prazo, `
                      + `em ${r.mesesRestantes} ${r.mesesRestantes === 1 ? 'mês' : 'meses'}`;
            return tag;

        case 'vencida':
            tag.classList.add('meta-tag-ritmo-off');
            tag.textContent = '⏰ prazo vencido';
            tag.title = `Ainda faltam ${formatBRL(r.falta)} para o objetivo`;
            return tag;

        default:                            // sem_prazo / concluida: nada a dizer
            return null;
    }
}

// Retorna taxa diária efetiva para uma meta com rendimento
// Para CDI: sempre usa o _cdiAnual atual (não o salvo em taxaJuros)
// Para personalizado: taxaJuros está em % mensal efetivo
function _taxaDiaria(meta) {
    if (meta.tipoRendimento === 'cdi' && (meta.cdiPct || 0) > 0) {
        const taxaAa = _cdiAnual * meta.cdiPct / 100;
        return Math.pow(1 + taxaAa / 100, 1 / 365) - 1;
    }
    if (meta.tipoRendimento === 'personalizado' && (meta.taxaJuros || 0) > 0) {
        // taxaJuros = % mensal efetivo; converte para diário via anualização
        const taxaAa = (Math.pow(1 + meta.taxaJuros / 100, 12) - 1) * 100;
        return Math.pow(1 + taxaAa / 100, 1 / 365) - 1;
    }
    return 0;
}

// Retorna taxa mensal efetiva para projeções
function _taxaMensal(meta) {
    if (meta.tipoRendimento === 'cdi' && (meta.cdiPct || 0) > 0) {
        const taxaAa = _cdiAnual * meta.cdiPct / 100;
        return Math.pow(1 + taxaAa / 100, 1 / 12) - 1;
    }
    if (meta.tipoRendimento === 'personalizado' && (meta.taxaJuros || 0) > 0) {
        return meta.taxaJuros / 100;
    }
    return 0;
}

// Aplica juros compostos diários em todas as metas com rendimento
// Chamado automaticamente ao abrir a tela de reservas
async function aplicarRendimentosDiarios() {
    await _fetchCDI();

    const hojeISO = new Date().toISOString().slice(0, 10);
    const mesKey  = hojeISO.slice(0, 7);
    let houveMudanca = false;

    (_ctx.metas || []).forEach(meta => {
        if (!meta.tipoRendimento || meta.tipoRendimento === 'sem_rendimento') return;
        if (!meta.saved || meta.saved <= 0) return;

        const rDiario = _taxaDiaria(meta);
        if (rDiario <= 0) return;

        // Primeira vez: marca o ponto de início, sem creditar rendimento ainda
        if (!meta.lastRendimento) {
            meta.lastRendimento = hojeISO;
            houveMudanca = true;
            return;
        }

        const dias = Math.floor(
            (new Date(hojeISO) - new Date(meta.lastRendimento)) / 86_400_000
        );
        if (dias < 1) return;

        // Juros compostos: FV = PV × (1 + r)^d - PV
        const rendimento = meta.saved * (Math.pow(1 + rDiario, dias) - 1);

        // Atualiza lastRendimento mesmo se rendimento mínimo (evita re-contagem)
        meta.lastRendimento = hojeISO;
        houveMudanca = true;

        if (rendimento < 0.01) return; // menos de R$0,01 — não credita ainda

        const rendSeguro = parseFloat(rendimento.toFixed(2));
        meta.saved       = parseFloat((meta.saved + rendSeguro).toFixed(2));
        meta.monthly     = meta.monthly || {};
        meta.monthly[mesKey] = parseFloat(
            ((meta.monthly[mesKey] || 0) + rendSeguro).toFixed(2)
        );
    });

    if (houveMudanca) {
        _ctx.salvarDados();
    }
}

export function init(ctx) {
    _ctx = ctx;
    window._dbMetas = { renderMetasList };
    window.abrirMetaForm          = (id) => abrirMetaForm(id);
    window.removerMeta            = (id) => removerMeta(id);
    window.selecionarMeta         = (id) => selecionarMeta(id);
    window.abrirRetiradaForm      = (id) => abrirRetiradaForm(id);
    window.abrirGuardarForm       = () => abrirGuardarForm();
    window.abrirAjusteForm        = () => abrirAjusteForm();
    window.abrirAnaliseDisciplina    = () => abrirAnaliseDisciplina();
    window.renderMetaVisual          = () => renderMetaVisual();
    window.abrirFormReservaExistente = () => abrirFormReservaExistente();
    // Aplica rendimentos acumulados (busca CDI atual internamente) e renderiza
    aplicarRendimentosDiarios().then(() => renderMetasList());

    // Simulador "E se?" — projeta aportes mensais rendendo CDI (módulo lazy)
    document.getElementById('btnSimuladorESe')?.addEventListener('click', async () => {
        try {
            const m = await import('../modules/simulador-ese.js?v=1');
            m.abrirSimuladorESe(_ctx);
        } catch { /* módulo indisponível — sem quebra */ }
    });

    // search + filter listeners (elementos podem não existir em mobile — guarda com ?.)
    document.getElementById('metaSearchInput')?.addEventListener('input', () => {
        _metaPagina = 1;
        renderMetasList();
    });
    document.getElementById('metaStatusFilter')?.addEventListener('change', () => {
        _metaPagina = 1;
        renderMetasList();
    });
}

// ========== CADASTRO DE RESERVA EXISTENTE ==========
// Cria uma reserva com saldo inicial sem gerar transação de débito.
// Ideal para novos usuários que já possuem reservas na vida real.
function abrirFormReservaExistente() {
    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:480px; width:96%;';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:84vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        // ── Título ────────────────────────────────────────────────────────────
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:14px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.1rem;';
        const tIcon = document.createElement('i');
        tIcon.className = 'fas fa-wallet';
        tIcon.setAttribute('aria-hidden', 'true');
        tIcon.style.color = 'var(--primary)';
        titulo.appendChild(tIcon);
        titulo.appendChild(document.createTextNode(' Cadastrar Reserva Existente'));

        // ── Nota informativa ─────────────────────────────────────────────────
        const nota = document.createElement('div');
        nota.style.cssText = 'background:rgba(67,160,71,0.08); border:1px solid rgba(67,160,71,0.2); border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:0.82rem; color:var(--text-secondary); line-height:1.5;';
        const notaIcon = document.createElement('i');
        notaIcon.className = 'fas fa-info-circle';
        notaIcon.setAttribute('aria-hidden', 'true');
        notaIcon.style.cssText = 'color:var(--primary); margin-right:6px;';
        nota.appendChild(notaIcon);
        nota.appendChild(document.createTextNode('O saldo informado será adicionado à reserva sem descontar do seu saldo no dashboard. Use para registrar reservas que você já possui na vida real.'));

        // ── Helper: seção ─────────────────────────────────────────────────────
        function secao(labelTxt) {
            const sec = document.createElement('div');
            sec.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px 16px; margin-bottom:12px;';
            if (labelTxt) {
                const lbl = document.createElement('div');
                lbl.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:10px;';
                lbl.textContent = labelTxt;
                sec.appendChild(lbl);
            }
            return sec;
        }

        // ── Seção 1: Identificação ────────────────────────────────────────────
        const secId = secao('Identificação');

        const inpDesc = document.createElement('input');
        inpDesc.className = 'form-input'; inpDesc.id = 'reExistDesc';
        inpDesc.type = 'text'; inpDesc.maxLength = 200; inpDesc.autocomplete = 'off';
        inpDesc.placeholder = 'Nome da reserva (ex: Caixinha Nubank, Poupança BB...)';
        inpDesc.style.marginBottom = '10px';

        const lblTipo = document.createElement('div');
        lblTipo.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); margin-bottom:6px;';
        lblTipo.textContent = 'Onde está guardado?';

        const selTipo = document.createElement('select');
        selTipo.className = 'form-input'; selTipo.id = 'reExistTipo';

        const TIPOS_VALIDOS = ['', 'caixinha', 'poupanca', 'cdb', 'lci_lca', 'tesouro_direto', 'renda_fixa', 'outro'];
        [
            { value: '',              label: 'Selecione...' },
            { value: 'caixinha',      label: '📦 Caixinha (banco digital)' },
            { value: 'poupanca',      label: '🏦 Poupança' },
            { value: 'cdb',           label: '📊 CDB' },
            { value: 'lci_lca',       label: '📋 LCI / LCA' },
            { value: 'tesouro_direto',label: '🏛️ Tesouro Direto' },
            { value: 'renda_fixa',    label: '📈 Renda Fixa (outros)' },
            { value: 'outro',         label: '💰 Outro' },
        ].forEach(t => {
            const o = document.createElement('option');
            o.value = t.value; o.textContent = t.label;
            selTipo.appendChild(o);
        });

        secId.appendChild(inpDesc);
        secId.appendChild(lblTipo);
        secId.appendChild(selTipo);

        // ── Seção 2: Saldos ───────────────────────────────────────────────────
        const secSaldo = secao('Saldos');

        const inpSaldo = document.createElement('input');
        inpSaldo.className = 'form-input'; inpSaldo.id = 'reExistSaldo';
        inpSaldo.type = 'number'; inpSaldo.step = '0.01'; inpSaldo.min = '0'; inpSaldo.max = '9999999';
        inpSaldo.placeholder = 'Saldo atual (R$)';
        inpSaldo.style.marginBottom = '10px';

        const inpObj = document.createElement('input');
        inpObj.className = 'form-input'; inpObj.id = 'reExistObj';
        inpObj.type = 'number'; inpObj.step = '0.01'; inpObj.min = '0'; inpObj.max = '999999999';
        inpObj.placeholder = 'Objetivo / meta (R$) — opcional';

        secSaldo.appendChild(inpSaldo);
        secSaldo.appendChild(inpObj);

        // ── Seção 3: Rendimentos ──────────────────────────────────────────────
        const secRend = secao('Rendimentos');

        function criarRadioRend(value, labelTxt) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; padding:7px 8px; border-radius:8px; margin-bottom:4px; transition:background 0.15s;';
            lbl.addEventListener('mouseenter', () => { lbl.style.background = 'rgba(255,255,255,0.04)'; });
            lbl.addEventListener('mouseleave', () => { lbl.style.background = ''; });
            const radio = document.createElement('input');
            radio.type = 'radio'; radio.name = 'reExistRendType'; radio.value = value;
            radio.style.cssText = 'accent-color:var(--primary); cursor:pointer;';
            if (value === 'sem_rendimento') radio.checked = true;
            const span = document.createElement('span');
            span.style.cssText = 'font-size:0.9rem; color:var(--text-primary);';
            span.textContent = labelTxt;
            lbl.appendChild(radio);
            lbl.appendChild(span);
            return lbl;
        }

        secRend.appendChild(criarRadioRend('sem_rendimento', '❌ Sem rendimento'));
        secRend.appendChild(criarRadioRend('cdi',            '📈 % do CDI (Selic)'));
        secRend.appendChild(criarRadioRend('personalizado',  '⚙️ Taxa personalizada'));

        // Container CDI
        const divCDI = document.createElement('div');
        divCDI.id = 'reExistCDIWrap';
        divCDI.style.cssText = 'display:none; margin-top:10px;';

        const labelCDIInfo = document.createElement('div');
        labelCDIInfo.style.cssText = 'font-size:0.78rem; color:var(--text-muted); margin-bottom:6px;';
        labelCDIInfo.setAttribute('data-cdi-rate', '');
        labelCDIInfo.textContent = `CDI atual: ${_cdiAnual.toFixed(2).replace('.', ',')}% a.a.`;

        const inpCDI = document.createElement('input');
        inpCDI.className = 'form-input'; inpCDI.id = 'reExistCDIPct';
        inpCDI.type = 'number'; inpCDI.step = '1'; inpCDI.min = '1'; inpCDI.max = '200';
        inpCDI.placeholder = '% do CDI (ex: 100 = 100% do CDI)';

        divCDI.appendChild(labelCDIInfo);
        divCDI.appendChild(inpCDI);
        secRend.appendChild(divCDI);

        // Container personalizado
        const divCustom = document.createElement('div');
        divCustom.id = 'reExistCustomWrap';
        divCustom.style.cssText = 'display:none; margin-top:10px;';

        const inpTaxa = document.createElement('input');
        inpTaxa.className = 'form-input'; inpTaxa.id = 'reExistTaxa';
        inpTaxa.type = 'number'; inpTaxa.step = '0.01'; inpTaxa.min = '0.01'; inpTaxa.max = '999';
        inpTaxa.placeholder = 'Taxa (%)';
        inpTaxa.style.marginBottom = '6px';

        const selPeriodo = document.createElement('select');
        selPeriodo.className = 'form-input'; selPeriodo.id = 'reExistPeriodo';
        [{ v: 'mes', l: '% ao mês (a.m.)' }, { v: 'ano', l: '% ao ano (a.a.)' }].forEach(p => {
            const o = document.createElement('option');
            o.value = p.v; o.textContent = p.l;
            selPeriodo.appendChild(o);
        });

        divCustom.appendChild(inpTaxa);
        divCustom.appendChild(selPeriodo);
        secRend.appendChild(divCustom);

        // Conecta radios aos containers de input
        secRend.querySelectorAll('input[name="reExistRendType"]').forEach(r => {
            r.addEventListener('change', () => {
                divCDI.style.display    = r.value === 'cdi'           ? '' : 'none';
                divCustom.style.display = r.value === 'personalizado'  ? '' : 'none';
            });
        });

        // ── Botões ─────────────────────────────────────────────────────────────
        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = 'display:flex; gap:10px; margin-top:18px;';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar'; btnCancelar.type = 'button';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.style.flex = '1';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary'; btnOk.type = 'button';
        btnOk.style.cssText = 'flex:2; display:flex; align-items:center; justify-content:center; gap:6px;';
        const iOk = document.createElement('i');
        iOk.className = 'fas fa-check'; iOk.setAttribute('aria-hidden', 'true');
        btnOk.appendChild(iOk);
        btnOk.appendChild(document.createTextNode('Cadastrar Reserva'));

        btnOk.addEventListener('click', () => {
            // ── Validação: nome ───────────────────────────────────────────────
            const descRaw = inpDesc.value.trim();
            if (!descRaw)            return _ctx.mostrarNotificacao('Informe o nome da reserva.', 'error');
            if (descRaw.length > 200) return _ctx.mostrarNotificacao('Nome muito longo (máx. 200 caracteres).', 'error');
            const desc = _sanitizeText(descRaw);

            // ── Validação: tipo ───────────────────────────────────────────────
            const tipoVal = selTipo.value;
            if (!TIPOS_VALIDOS.includes(tipoVal)) return _ctx.mostrarNotificacao('Tipo de reserva inválido.', 'error');

            // ── Validação: saldo ──────────────────────────────────────────────
            const saldoStr = inpSaldo.value;
            const saldo    = parseFloat(saldoStr);
            if (saldoStr === '' || !Number.isFinite(saldo) || saldo < 0 || saldo > 9_999_999) {
                return _ctx.mostrarNotificacao('Informe um saldo válido (entre R$ 0,00 e R$ 9.999.999,00).', 'error');
            }
            const saldoSeguro = parseFloat(saldo.toFixed(2));

            // ── Validação: objetivo ───────────────────────────────────────────
            let objetivo = Math.max(saldoSeguro, 1);
            const objStr = inpObj.value.trim();
            if (objStr !== '') {
                const objVal = parseFloat(objStr);
                if (!Number.isFinite(objVal) || objVal < 0 || objVal > 999_999_999) {
                    return _ctx.mostrarNotificacao('Objetivo inválido (entre R$ 0,00 e R$ 999.999.999,00).', 'error');
                }
                objetivo = parseFloat(objVal.toFixed(2));
            }

            // ── Validação: rendimento ─────────────────────────────────────────
            const tipoR = document.querySelector('input[name="reExistRendType"]:checked')?.value ?? 'sem_rendimento';
            if (!['sem_rendimento', 'cdi', 'personalizado'].includes(tipoR)) return _ctx.mostrarNotificacao('Tipo de rendimento inválido.', 'error');

            let cdiPct           = null;
            let taxaJuros        = null;
            let rendimentoPeriodo = null;

            if (tipoR === 'cdi') {
                const cdiVal = parseFloat(inpCDI.value);
                if (!Number.isFinite(cdiVal) || cdiVal < 1 || cdiVal > 200) {
                    return _ctx.mostrarNotificacao('Informe a % do CDI entre 1% e 200%.', 'error');
                }
                cdiPct = parseFloat(cdiVal.toFixed(2));
            }

            if (tipoR === 'personalizado') {
                const taxaVal = parseFloat(inpTaxa.value);
                if (!Number.isFinite(taxaVal) || taxaVal <= 0 || taxaVal > 999) {
                    return _ctx.mostrarNotificacao('Informe uma taxa entre 0,01% e 999%.', 'error');
                }
                taxaJuros = parseFloat(taxaVal.toFixed(4));
                rendimentoPeriodo = selPeriodo.value === 'ano' ? 'ano' : 'mes';
            }

            // ── Criar reserva (sem transação de débito) ───────────────────────
            const novoId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;

            _ctx.metas.push({
                id:                 novoId,
                descricao:          desc,
                tipoReserva:        tipoVal || 'outro',
                objetivo,
                saved:              saldoSeguro,
                monthly:            {},
                prazo:              null,
                tipoRendimento:     tipoR,
                taxaJuros,
                cdiPct,
                rendimentoPeriodo,
                aporteRecorrente:   false,
                valorAporte:        null,
                origemExistente:    true,
            });

            _ctx.salvarDados();
            _ctx.renderMetasList();
            _ctx.atualizarTudo();
            _ctx.fecharPopup();
        });

        rowBtns.appendChild(btnCancelar);
        rowBtns.appendChild(btnOk);

        // ── Montagem ──────────────────────────────────────────────────────────
        wrapper.appendChild(titulo);
        wrapper.appendChild(nota);
        wrapper.appendChild(secId);
        wrapper.appendChild(secSaldo);
        wrapper.appendChild(secRend);
        wrapper.appendChild(rowBtns);
        popup.appendChild(wrapper);
    });
}

// ========== METAS/RESERVAS ==========
function abrirMetaForm(editId = null) {
    const isEdit = editId !== null;
    const meta   = isEdit ? _ctx.metas.find(m => m.id === editId) : null;
    if (isEdit && !meta) return;

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:500px; width:96%;';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:18px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.15rem;';
        const tIcon = document.createElement('i');
        tIcon.className = isEdit ? 'fas fa-pen' : 'fas fa-piggy-bank';
        tIcon.style.color = 'var(--primary)';
        titulo.appendChild(tIcon);
        titulo.appendChild(document.createTextNode(isEdit ? ' Editar Reserva' : ' Nova Reserva'));

        // ── Helper: cria uma seção com fundo glass
        function secao(labelTxt) {
            const sec = document.createElement('div');
            sec.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px 16px; margin-bottom:12px;';
            if (labelTxt) {
                const lbl = document.createElement('div');
                lbl.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:10px;';
                lbl.textContent = labelTxt;
                sec.appendChild(lbl);
            }
            return sec;
        }

        // ─────────────────────────── SEÇÃO 1: Básico ───────────────────────────
        const secBasico = secao('Informações básicas');

        const inpDesc = document.createElement('input');
        inpDesc.className = 'form-input'; inpDesc.id = 'metaDesc';
        inpDesc.placeholder = 'Nome da reserva (ex: Viagem, Emergência...)';
        inpDesc.maxLength = 200; inpDesc.style.marginBottom = '10px';
        if (meta) inpDesc.value = meta.descricao;

        const inpObj = document.createElement('input');
        inpObj.className = 'form-input'; inpObj.id = 'metaObj';
        inpObj.type = 'number'; inpObj.step = '0.01'; inpObj.min = '0';
        inpObj.placeholder = 'Objetivo (R$)';
        if (meta) inpObj.value = meta.objetivo;

        secBasico.appendChild(inpDesc);
        secBasico.appendChild(inpObj);

        // ─────────── SEÇÃO: Reserva da família (C1) — só conta compartilhada ────
        // Marca a caixinha como compartilhada e guarda o roster: "com quem você
        // quer criar a reserva?". O dinheiro é o fluxo normal de caixinha (sai do
        // saldo); o que a marcação acrescenta é a trilha de quem colocou/tirou.
        const ehContaComp = contaCompartilhada(_ctx.usuarioLogado);
        let   rosterMembros = (meta && Array.isArray(meta.membros)) ? meta.membros.slice(0, 12) : [];
        let   chkCompart = null;
        let   secCompartEl = null;
        // Preenchido pela seção de perfis; lê os checkboxes no momento do save.
        let   lerPerfisSelecionados = null;
        if (ehContaComp) {
            const secCompart = secao('Reserva da família');
            secCompartEl = secCompart;

            const lblChk = document.createElement('label');
            lblChk.style.cssText = 'display:flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:10px;';
            chkCompart = document.createElement('input');
            chkCompart.type = 'checkbox'; chkCompart.id = 'metaCompartilhada';
            chkCompart.style.cssText = 'width:17px; height:17px; accent-color:var(--primary); cursor:pointer; flex-shrink:0;';
            if (meta && meta.compartilhada) chkCompart.checked = true;
            const spanChk = document.createElement('span');
            spanChk.style.fontSize = '0.9rem';
            spanChk.textContent = '👥 Compartilhada — todos veem quem colocou e tirou';
            lblChk.appendChild(chkCompart); lblChk.appendChild(spanChk);
            secCompart.appendChild(lblChk);

            const divRoster = document.createElement('div');
            divRoster.style.display = (meta && meta.compartilhada) ? 'block' : 'none';

            const rosterHint = document.createElement('div');
            rosterHint.style.cssText = 'font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;';
            rosterHint.textContent = 'Quais perfis participam desta reserva?';
            divRoster.appendChild(rosterHint);

            // SELEÇÃO DE PERFIS (não mais nomes digitados). Só os perfis marcados
            // veem a reserva na lista e podem guardar/retirar.
            //
            // ⚠️ ISTO É ORGANIZAÇÃO DE TELA, NÃO SIGILO. Dono e convidado
            // compartilham UM blob: quem exportar os dados ou abrir o DevTools vê
            // tudo. Serve para não poluir a tela de quem não participa — e a nota
            // abaixo diz isso ao usuário, para ninguém contar com uma proteção
            // que a arquitetura não entrega.
            const perfisConta = Array.isArray(_ctx.usuarioLogado?.perfis) ? _ctx.usuarioLogado.perfis : [];
            const idAtivo = String(_ctx.perfilAtivo?.id ?? '');

            const listaPerfis = document.createElement('div');
            listaPerfis.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-bottom:8px;';

            perfisConta.forEach((p) => {
                const pid = String(p.id);
                const lbl = document.createElement('label');
                lbl.style.cssText = 'display:flex; align-items:center; gap:9px; cursor:pointer; padding:6px 8px; border-radius:8px; background:rgba(255,255,255,0.03);';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = pid;
                cb.style.cssText = 'width:16px; height:16px; accent-color:var(--primary); cursor:pointer; flex-shrink:0;';
                // Marcado se já está no roster; numa reserva nova, o perfil ATIVO
                // vem marcado e travado — criar uma reserva da qual você mesmo não
                // participa (e que some da sua tela) seria só um jeito de perder a
                // reserva de vista.
                cb.checked = rosterMembros.length ? rosterMembros.includes(pid) : (pid === idAtivo);
                if (pid === idAtivo) { cb.checked = true; cb.disabled = true; }

                const nome = document.createElement('span');
                nome.style.fontSize = '0.9rem';
                nome.textContent = String(p.nome || 'Perfil');   // textContent — sem XSS
                if (pid === idAtivo) {
                    const vc = document.createElement('span');
                    vc.style.cssText = 'font-size:0.75rem; color:var(--text-muted);';
                    vc.textContent = ' (você)';
                    nome.appendChild(vc);
                }

                lbl.appendChild(cb); lbl.appendChild(nome);
                listaPerfis.appendChild(lbl);
            });

            divRoster.appendChild(listaPerfis);

            const notaSigilo = document.createElement('div');
            notaSigilo.style.cssText = 'font-size:0.75rem; color:var(--text-muted); line-height:1.45; background:rgba(148,163,184,0.08); border-radius:8px; padding:8px 10px;';
            notaSigilo.textContent = 'Os perfis não marcados não veem esta reserva na lista deles. É uma organização da tela — não é um cofre: quem exporta os dados da conta continua enxergando tudo.';
            divRoster.appendChild(notaSigilo);

            secCompart.appendChild(divRoster);

            // Lê a seleção na hora de salvar (evita manter estado paralelo que
            // possa divergir do que está marcado na tela).
            lerPerfisSelecionados = () => Array.from(
                listaPerfis.querySelectorAll('input[type="checkbox"]')
            ).filter(cb => cb.checked).map(cb => cb.value);

            chkCompart.addEventListener('change', () => {
                divRoster.style.display = chkCompart.checked ? 'block' : 'none';
            });
        }

        // ─────────────────────────── SEÇÃO 2: Prazo ────────────────────────────
        const secPrazo = secao('Prazo (opcional)');
        const rowPrazo = document.createElement('div');
        rowPrazo.style.cssText = 'display:flex; gap:10px;';

        const selMeses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                          'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

        const selPM = document.createElement('select');
        selPM.className = 'form-input'; selPM.id = 'metaPrazoMes'; selPM.style.flex = '1';
        const optPMV = document.createElement('option'); optPMV.value = ''; optPMV.textContent = 'Mês';
        selPM.appendChild(optPMV);
        selMeses.forEach((n, i) => {
            const o = document.createElement('option');
            o.value = String(i + 1).padStart(2, '0'); o.textContent = n;
            selPM.appendChild(o);
        });

        const selPA = document.createElement('select');
        selPA.className = 'form-input'; selPA.id = 'metaPrazoAno'; selPA.style.flex = '1';
        const optPAV = document.createElement('option'); optPAV.value = ''; optPAV.textContent = 'Ano';
        selPA.appendChild(optPAV);
        const anoBase = new Date().getFullYear();
        for (let a = anoBase; a <= anoBase + 20; a++) {
            const o = document.createElement('option'); o.value = String(a); o.textContent = String(a);
            selPA.appendChild(o);
        }

        if (meta && meta.prazo) {
            const [pm, pa] = meta.prazo.split('/');
            if (pm) selPM.value = pm;
            if (pa) selPA.value = pa;
        }
        rowPrazo.appendChild(selPM); rowPrazo.appendChild(selPA);
        secPrazo.appendChild(rowPrazo);

        // ─────────────────────────── SEÇÃO 3: Rendimentos ──────────────────────
        const secRend = secao('Rendimentos');
        const tipoRAtual = meta ? (meta.tipoRendimento || 'sem_rendimento') : 'sem_rendimento';

        function criarRadio(name, value, labelTxt) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex; align-items:center; gap:8px; cursor:pointer; padding:7px 8px; border-radius:8px; margin-bottom:4px; transition:background 0.15s;';
            lbl.addEventListener('mouseenter', () => { lbl.style.background = 'rgba(255,255,255,0.04)'; });
            lbl.addEventListener('mouseleave', () => { lbl.style.background = ''; });
            const r = document.createElement('input');
            r.type = 'radio'; r.name = name; r.value = value; r.style.accentColor = 'var(--primary)';
            if (tipoRAtual === value && name === 'tipoRend') r.checked = true;
            const s = document.createElement('span'); s.style.fontSize = '0.9rem'; s.textContent = labelTxt;
            lbl.appendChild(r); lbl.appendChild(s);
            return { lbl, r };
        }

        const { lbl: lblSem }            = criarRadio('tipoRend', 'sem_rendimento', 'Sem rendimentos');
        const { lbl: lblCdi }            = criarRadio('tipoRend', 'cdi', 'CDI');
        const { lbl: lblPers }           = criarRadio('tipoRend', 'personalizado', 'Taxa personalizada');

        // CDI sub-opções
        const divCdi = document.createElement('div');
        divCdi.id = 'cdiOpts';
        divCdi.style.cssText = `display:${tipoRAtual === 'cdi' ? 'block' : 'none'}; padding:4px 0 6px 26px;`;

        const rowCdiTaxa = document.createElement('div');
        rowCdiTaxa.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
        const inpCdiPct = document.createElement('input');
        inpCdiPct.className = 'form-input'; inpCdiPct.id = 'metaCdiPct';
        inpCdiPct.type = 'number'; inpCdiPct.step = '1'; inpCdiPct.min = '1'; inpCdiPct.max = '200';
        inpCdiPct.placeholder = '100'; inpCdiPct.style.cssText = 'width:72px; flex-shrink:0;';
        inpCdiPct.value = (meta && meta.cdiPct != null) ? meta.cdiPct : '100';
        const spanCdiPct = document.createElement('span');
        spanCdiPct.style.cssText = 'font-size:0.82rem; color:var(--text-muted);';
        spanCdiPct.textContent = '% do CDI';
        const spanCdiRate = document.createElement('span');
        spanCdiRate.setAttribute('data-cdi-rate', '');
        spanCdiRate.style.cssText = 'font-size:0.78rem; color:var(--primary); margin-left:4px;';
        spanCdiRate.textContent = `CDI atual: ${_cdiAnual.toFixed(2).replace('.', ',')}% a.a.`;
        rowCdiTaxa.appendChild(inpCdiPct); rowCdiTaxa.appendChild(spanCdiPct); rowCdiTaxa.appendChild(spanCdiRate);

        const rowCdiPer = document.createElement('div');
        rowCdiPer.style.cssText = 'display:flex; gap:16px;';
        function criarPeriodoRadio(name, val, txt, checkedIf) {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:0.82rem; color:var(--text-secondary);';
            const r = document.createElement('input');
            r.type = 'radio'; r.name = name; r.value = val; r.style.accentColor = 'var(--primary)';
            if (checkedIf) r.checked = true;
            lbl.appendChild(r); lbl.appendChild(document.createTextNode(txt));
            return lbl;
        }
        const periodoAtual = meta ? (meta.rendimentoPeriodo || 'mes') : 'mes';
        rowCdiPer.appendChild(criarPeriodoRadio('periodoRendCdi', 'mes', 'Ao mês',  periodoAtual !== 'ano'));
        rowCdiPer.appendChild(criarPeriodoRadio('periodoRendCdi', 'ano', 'Ao ano',  periodoAtual === 'ano'));
        divCdi.appendChild(rowCdiTaxa); divCdi.appendChild(rowCdiPer);

        // Personalizado sub-opções
        const divPers = document.createElement('div');
        divPers.id = 'persOpts';
        divPers.style.cssText = `display:${tipoRAtual === 'personalizado' ? 'block' : 'none'}; padding:4px 0 6px 26px;`;

        const rowPersTaxa = document.createElement('div');
        rowPersTaxa.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
        const inpPersPct = document.createElement('input');
        inpPersPct.className = 'form-input'; inpPersPct.id = 'metaPersPct';
        inpPersPct.type = 'number'; inpPersPct.step = '0.01'; inpPersPct.min = '0'; inpPersPct.max = '999';
        inpPersPct.placeholder = '0.5'; inpPersPct.style.cssText = 'width:72px; flex-shrink:0;';
        if (meta && meta.taxaJuros != null) inpPersPct.value = meta.taxaJuros;
        const spanPersPct = document.createElement('span');
        spanPersPct.style.cssText = 'font-size:0.82rem; color:var(--text-muted);';
        spanPersPct.textContent = '%';
        rowPersTaxa.appendChild(inpPersPct); rowPersTaxa.appendChild(spanPersPct);

        const rowPersPer = document.createElement('div');
        rowPersPer.style.cssText = 'display:flex; gap:16px;';
        rowPersPer.appendChild(criarPeriodoRadio('periodoRendPers', 'mes', 'Ao mês', periodoAtual !== 'ano'));
        rowPersPer.appendChild(criarPeriodoRadio('periodoRendPers', 'ano', 'Ao ano', periodoAtual === 'ano'));
        divPers.appendChild(rowPersTaxa); divPers.appendChild(rowPersPer);

        secRend.appendChild(lblSem);
        secRend.appendChild(lblCdi);
        secRend.appendChild(divCdi);
        secRend.appendChild(lblPers);
        secRend.appendChild(divPers);

        secRend.addEventListener('change', e => {
            if (e.target.name === 'tipoRend') {
                divCdi.style.display  = e.target.value === 'cdi'          ? 'block' : 'none';
                divPers.style.display = e.target.value === 'personalizado' ? 'block' : 'none';
            }
        });

        // ─────────────────────────── SEÇÃO 4: Aporte Recorrente ────────────────
        const secAporte = secao('Aporte Recorrente');

        const lblChkAporte = document.createElement('label');
        lblChkAporte.style.cssText = 'display:flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:10px;';
        const chkAporte = document.createElement('input');
        chkAporte.type = 'checkbox'; chkAporte.id = 'metaAporteRecorrente';
        chkAporte.style.cssText = 'width:17px; height:17px; accent-color:var(--primary); cursor:pointer; flex-shrink:0;';
        if (meta && meta.aporteRecorrente) chkAporte.checked = true;
        const spanChkAporte = document.createElement('span');
        spanChkAporte.style.fontSize = '0.9rem';
        spanChkAporte.textContent = 'Criar aporte mensal automático';
        lblChkAporte.appendChild(chkAporte); lblChkAporte.appendChild(spanChkAporte);

        const divAporteVal = document.createElement('div');
        divAporteVal.id = 'aporteValorDiv';
        divAporteVal.style.cssText = `display:${(meta && meta.aporteRecorrente) ? 'flex' : 'none'}; align-items:center; gap:10px;`;
        const inpAporteV = document.createElement('input');
        inpAporteV.className = 'form-input'; inpAporteV.id = 'metaAporteValor';
        inpAporteV.type = 'number'; inpAporteV.step = '0.01'; inpAporteV.min = '0';
        inpAporteV.placeholder = 'Valor mensal (R$)'; inpAporteV.style.flex = '1';
        if (meta && meta.valorAporte) inpAporteV.value = meta.valorAporte;
        const spanAporteMes = document.createElement('span');
        spanAporteMes.style.cssText = 'font-size:0.8rem; color:var(--text-muted); white-space:nowrap;';
        spanAporteMes.textContent = '/mês';
        divAporteVal.appendChild(inpAporteV); divAporteVal.appendChild(spanAporteMes);

        chkAporte.addEventListener('change', () => {
            divAporteVal.style.display = chkAporte.checked ? 'flex' : 'none';
        });
        secAporte.appendChild(lblChkAporte); secAporte.appendChild(divAporteVal);

        // ─────────────────────────── SEÇÃO 5: Projeção ─────────────────────────
        const secProj = document.createElement('div');
        secProj.id = 'metaProjecaoPreview';
        secProj.style.cssText = 'display:none; background:rgba(67,160,71,0.06); border:1px solid rgba(67,160,71,0.22); border-radius:12px; padding:14px 16px; margin-bottom:12px;';

        const btnSimular = document.createElement('button');
        btnSimular.className = 'btn-primary'; btnSimular.type = 'button';
        btnSimular.style.cssText = 'width:100%; margin-bottom:12px; display:flex; align-items:center; justify-content:center; gap:8px;';
        const bsI = document.createElement('i'); bsI.className = 'fas fa-calculator';
        btnSimular.appendChild(bsI); btnSimular.appendChild(document.createTextNode(' Ver Projeção'));

        // fvComposto / mesesParaMeta / aporteNecessario usam escopo do módulo

        btnSimular.addEventListener('click', () => {
            const obj     = parseFloat(document.getElementById('metaObj').value) || 0;
            const savedPV = isEdit && meta ? Number(meta.saved || 0) : 0;
            const tipoR   = document.querySelector('input[name="tipoRend"]:checked')?.value || 'sem_rendimento';
            const aporte  = parseFloat(document.getElementById('metaAporteValor')?.value) || 0;
            const prazoM  = document.getElementById('metaPrazoMes')?.value || '';
            const prazoA  = document.getElementById('metaPrazoAno')?.value || '';

            let r = 0;
            if (tipoR === 'cdi') {
                const pct = parseFloat(document.getElementById('metaCdiPct').value) || 100;
                const per = document.querySelector('input[name="periodoRendCdi"]:checked')?.value || 'mes';
                const taxaAnual = _cdiAnual * pct / 100;
                r = per === 'ano'
                    ? Math.pow(1 + taxaAnual / 100, 1/12) - 1
                    : taxaAnual / 100 / 12;
            } else if (tipoR === 'personalizado') {
                const pct = parseFloat(document.getElementById('metaPersPct').value) || 0;
                const per = document.querySelector('input[name="periodoRendPers"]:checked')?.value || 'mes';
                r = per === 'ano'
                    ? Math.pow(1 + pct / 100, 1/12) - 1
                    : pct / 100;
            }

            // Mesma função que a tag de ritmo da lista usa. Antes era uma
            // aproximação de 30,44 dias até o 1º dia do mês, que dava ±1 mês de
            // diferença — o preview e a tag mostrariam R$/mês diferentes para a
            // mesma meta, e o usuário não teria como saber qual acreditar.
            let mesesPrazo = null;
            if (prazoM && prazoA) {
                const m = mesesAtePrazo(`${prazoM}/${prazoA}`);
                mesesPrazo = (m !== null && m > 0) ? m : null;
            }

            const secP = document.getElementById('metaProjecaoPreview');
            secP.style.display = 'block';
            // Limpa conteúdo anterior
            while (secP.firstChild) secP.removeChild(secP.firstChild);

            const tP = document.createElement('div');
            tP.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--primary); margin-bottom:10px;';
            tP.textContent = '📊 Projeção calculada';
            secP.appendChild(tP);

            function addLinha(icon, lbl, val, cor) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:7px 10px; border-radius:8px; margin-bottom:5px; background:rgba(255,255,255,0.03);';
                const left = document.createElement('span');
                left.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); display:flex; align-items:center; gap:6px;';
                const ic = document.createElement('i'); ic.className = icon;
                ic.style.color = cor || 'var(--primary)'; ic.style.width = '14px';
                left.appendChild(ic); left.appendChild(document.createTextNode(lbl));
                const right = document.createElement('span');
                right.style.cssText = `font-size:0.88rem; font-weight:700; color:${cor || 'var(--text-primary)'};`;
                right.textContent = val;
                row.appendChild(left); row.appendChild(right);
                secP.appendChild(row);
            }

            if (obj <= 0) {
                addLinha('fas fa-exclamation-triangle', 'Defina um objetivo', 'Necessário', '#ffd166');
                return;
            }

            const falta = Math.max(0, obj - savedPV);
            addLinha('fas fa-piggy-bank', 'Falta atingir', _ctx.formatBRL(falta), '#ffd166');

            if (aporte > 0 || r > 0) {
                const meses = mesesParaMeta(savedPV, obj, aporte, r);
                if (meses !== null) {
                    const anos = Math.floor(meses / 12);
                    const mr   = meses % 12;
                    const tStr = anos > 0
                        ? `${anos}a ${mr}m`
                        : `${meses} mês${meses !== 1 ? 'es' : ''}`;
                    addLinha('fas fa-clock', 'Tempo estimado', tStr, 'var(--primary)');
                    const fvFinal    = fvComposto(savedPV, aporte, r, meses);
                    const rendim     = Math.max(0, fvFinal - (savedPV + aporte * meses));
                    if (rendim > 1) addLinha('fas fa-chart-line', 'Rendimentos acumulados', `+${formatBRL(rendim)}`, '#00ff99');
                }
            }

            if (mesesPrazo !== null) {
                const ap = aporteNecessario(savedPV, obj, r, mesesPrazo);
                if (ap !== null && ap > 0) {
                    addLinha('fas fa-calendar-check', `Aporte p/ prazo (${mesesPrazo}m)`, `${formatBRL(ap)}/mês`, '#a78bfa');
                }
                const fvP = fvComposto(savedPV, aporte, r, mesesPrazo);
                const ok  = fvP >= obj;
                addLinha(
                    ok ? 'fas fa-check-circle' : 'fas fa-exclamation-circle',
                    'Status no prazo',
                    ok ? 'Atingirá o objetivo!' : `Chegará a ${formatBRL(Math.min(fvP, obj))}`,
                    ok ? '#00ff99' : '#ff4b4b'
                );
            }
        });

        // ─────────────────────────── BOTÕES ────────────────────────────────────
        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = 'display:flex; gap:10px; margin-top:4px;';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar'; btnCancelar.type = 'button';
        btnCancelar.style.flex = '1'; btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary'; btnOk.type = 'button'; btnOk.style.flex = '2';
        const btnOkI = document.createElement('i');
        btnOkI.className = isEdit ? 'fas fa-save' : 'fas fa-plus';
        btnOkI.style.marginRight = '6px';
        btnOk.appendChild(btnOkI);
        btnOk.appendChild(document.createTextNode(isEdit ? 'Salvar' : 'Criar Reserva'));

        btnOk.addEventListener('click', () => {
            const desc   = document.getElementById('metaDesc').value.trim();
            const objStr = document.getElementById('metaObj').value;

            if (!desc)                                                              return _ctx.mostrarNotificacao('Digite o nome da reserva.', 'error');
            if (desc.length > 200)                                                  return _ctx.mostrarNotificacao('Nome muito longo (máx. 200 caracteres).', 'error');
            if (!objStr || !Number.isFinite(Number(objStr)) || Number(objStr) <= 0) return _ctx.mostrarNotificacao('Digite um objetivo válido.', 'error');

            const objetivo = parseFloat(parseFloat(objStr).toFixed(2));
            if (!Number.isFinite(objetivo) || objetivo <= 0) return _ctx.mostrarNotificacao('Digite um objetivo válido.', 'error');

            // Prazo
            const prazoMV = document.getElementById('metaPrazoMes').value;
            const prazoAV = document.getElementById('metaPrazoAno').value;
            const prazo   = (prazoMV && prazoAV) ? `${prazoMV}/${prazoAV}` : null;

            // Rendimentos
            const tipoR = document.querySelector('input[name="tipoRend"]:checked')?.value || 'sem_rendimento';
            let taxaJuros = null, rendimentoPeriodo = null, cdiPct = null;

            if (tipoR === 'cdi') {
                const pct = parseFloat(document.getElementById('metaCdiPct').value);
                if (!Number.isFinite(pct) || pct <= 0 || pct > 200) return _ctx.mostrarNotificacao('Digite uma porcentagem válida do CDI (1–200).', 'error');
                cdiPct = pct;
                rendimentoPeriodo = document.querySelector('input[name="periodoRendCdi"]:checked')?.value || 'mes';
                const taxaAnual = _cdiAnual * pct / 100;
                taxaJuros = rendimentoPeriodo === 'ano'
                    ? parseFloat(((Math.pow(1 + taxaAnual / 100, 1/12) - 1) * 100).toFixed(6))
                    : parseFloat((taxaAnual / 12).toFixed(6));
            } else if (tipoR === 'personalizado') {
                const pct = parseFloat(document.getElementById('metaPersPct').value);
                if (!Number.isFinite(pct) || pct < 0 || pct > 999) return _ctx.mostrarNotificacao('Digite uma taxa válida (0–999).', 'error');
                rendimentoPeriodo = document.querySelector('input[name="periodoRendPers"]:checked')?.value || 'mes';
                taxaJuros = rendimentoPeriodo === 'ano'
                    ? parseFloat(((Math.pow(1 + pct / 100, 1/12) - 1) * 100).toFixed(6))
                    : parseFloat(pct.toFixed(6));
            }

            // Aporte
            const aporteRecorrente = document.getElementById('metaAporteRecorrente').checked;
            let valorAporte = null;
            if (aporteRecorrente) {
                const apStr = document.getElementById('metaAporteValor').value;
                valorAporte = parseFloat(apStr);
                if (!Number.isFinite(valorAporte) || valorAporte <= 0) return _ctx.mostrarNotificacao('Digite um valor de aporte válido.', 'error');
            }

            // Compartilhada (C1): só vale em conta casal/família. Roster nunca vazio
            // (semeia com quem cria) para o "quem colocou" ter de quem partir.
            const compartilhada = ehContaComp && !!(chkCompart && chkCompart.checked);
            if (compartilhada && typeof lerPerfisSelecionados === 'function') {
                rosterMembros = lerPerfisSelecionados();
            }
            // Nunca vazio: o perfil ativo entra sempre (o checkbox dele é travado,
            // mas isto protege contra qualquer caminho que devolva lista vazia —
            // uma reserva sem participantes sumiria da tela de todo mundo).
            if (compartilhada && rosterMembros.length === 0) {
                rosterMembros = [String(_ctx.perfilAtivo?.id ?? '')].filter(Boolean);
            }

            if (isEdit) {
                const aporteAnterior    = meta.aporteRecorrente;
                const valorAporteAnterior = meta.valorAporte;

                meta.descricao        = desc;
                meta.objetivo         = objetivo;
                meta.prazo            = prazo;
                meta.tipoRendimento   = tipoR;
                meta.taxaJuros        = taxaJuros;
                meta.cdiPct           = cdiPct;
                meta.rendimentoPeriodo = rendimentoPeriodo;
                meta.aporteRecorrente = aporteRecorrente;
                meta.valorAporte      = valorAporte;
                meta.compartilhada    = compartilhada;
                if (compartilhada) {
                    meta.membros = rosterMembros.slice(0, 12);
                    if (!Array.isArray(meta.movimentos)) meta.movimentos = [];
                }

                // Sincroniza conta fixa de aporte quando muda configuração
                _sincronizarContaFixaAporte(meta, aporteRecorrente, valorAporte, aporteAnterior, valorAporteAnterior, desc);
            } else {
                const novoId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const novaMeta = {
                    id: novoId, descricao: desc, objetivo, saved: 0, monthly: {},
                    prazo, tipoRendimento: tipoR, taxaJuros, cdiPct,
                    rendimentoPeriodo, aporteRecorrente, valorAporte,
                };
                if (compartilhada) {
                    novaMeta.compartilhada = true;
                    novaMeta.membros = rosterMembros.slice(0, 12);
                    novaMeta.movimentos = [];
                }
                _ctx.metas.push(novaMeta);

                // Cria conta fixa de aporte recorrente
                if (aporteRecorrente && valorAporte > 0) {
                    const hoje = new Date();
                    const mm   = hoje.getMonth() + 2 > 12 ? 1 : hoje.getMonth() + 2;
                    const aa   = hoje.getMonth() + 2 > 12 ? hoje.getFullYear() + 1 : hoje.getFullYear();
                    _ctx.contasFixas.push({
                        id:          (typeof crypto !== 'undefined' && crypto.randomUUID)
                                         ? crypto.randomUUID()
                                         : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                        descricao:   `Aporte ${desc}`.slice(0, 200),
                        valor:       valorAporte,
                        vencimento:  `${aa}-${String(mm).padStart(2,'0')}-01`,
                        pago:        false,
                    });
                }
            }

            _ctx.salvarDados();
            _ctx.renderMetasList();
            _ctx.atualizarTudo();
            _ctx.fecharPopup();
        });

        rowBtns.appendChild(btnCancelar);
        rowBtns.appendChild(btnOk);

        // ─────────────────────────── MONTAGEM ──────────────────────────────────
        wrapper.appendChild(titulo);
        wrapper.appendChild(secBasico);
        if (secCompartEl) wrapper.appendChild(secCompartEl);
        wrapper.appendChild(secPrazo);
        wrapper.appendChild(secRend);
        wrapper.appendChild(secAporte);
        wrapper.appendChild(btnSimular);
        wrapper.appendChild(secProj);
        wrapper.appendChild(rowBtns);
        popup.appendChild(wrapper);
    });
}

// Sincroniza a conta fixa de aporte recorrente ao editar uma meta.
// Se o aporte foi ativado: cria conta fixa pendente para o próximo mês se não existir.
// Se o aporte foi desativado: remove contas fixas de aporte NÃO pagas vinculadas a esta meta.
// Se o valor mudou: atualiza o valor da conta fixa pendente.
function _sincronizarContaFixaAporte(meta, aporteAtivo, valorAporte, aporteAnterior, valorAnterior, descMeta) {
    const hoje = new Date();
    const mm   = hoje.getMonth() + 2 > 12 ? 1 : hoje.getMonth() + 2;
    const aa   = hoje.getMonth() + 2 > 12 ? hoje.getFullYear() + 1 : hoje.getFullYear();
    const descContaFixa = `Aporte ${descMeta}`.slice(0, 200);

    // Procura conta fixa de aporte já existente (não paga) para essa meta
    const contaExistente = _ctx.contasFixas.find(c =>
        !c.pago &&
        c.descricao === descContaFixa &&
        c.tipoContaFixa !== 'fatura_cartao'
    );

    if (aporteAtivo && valorAporte > 0) {
        if (contaExistente) {
            // Atualiza valor se mudou
            if (contaExistente.valor !== valorAporte) {
                contaExistente.valor = valorAporte;
                _ctx.mostrarNotificacao(`Aporte de "${descMeta}" atualizado para ${_ctx.formatBRL(valorAporte)}.`, 'info');
            }
        } else if (!aporteAnterior) {
            // Cria nova conta fixa de aporte (aporte foi ativado agora)
            _ctx.contasFixas.push({
                id: (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                descricao:  descContaFixa,
                valor:      valorAporte,
                vencimento: `${aa}-${String(mm).padStart(2,'0')}-01`,
                pago:       false,
            });
            _ctx.mostrarNotificacao(`Aporte mensal de "${descMeta}" criado em Contas Fixas.`, 'success');
        }
    } else if (!aporteAtivo && aporteAnterior) {
        // Remove conta fixa de aporte não paga (aporte foi desativado)
        if (contaExistente) {
            _ctx.contasFixas = _ctx.contasFixas.filter(c => c !== contaExistente);
            _ctx.mostrarNotificacao(`Aporte mensal de "${descMeta}" removido das Contas Fixas.`, 'info');
        }
    }
}

const _META_POR_PAGINA = 5;
let _metaPagina = 1;

// ── Cofre visual: jarro que enche conforme a meta cresce ──────────────────────
// Substitui o ícone estático (era um fa-piggy-bank que não dizia nada) por um
// pote que enche proporcionalmente — mostra progresso onde antes não havia
// informação alguma. Construído com createElementNS (nunca innerHTML) — mantém a
// disciplina anti-XSS do projeto mesmo com valores dinâmicos.
// Ícone de categoria — usado na tela de DETALHE da reserva (renderMetaVisual).
// ⚠️ NÃO REMOVER: o card da lista passou a usar o jarro (_criarJarro), mas o detalhe
// continua usando este ícone. Removê-lo daqui já quebrou a tela uma vez
// (ReferenceError em renderMetaVisual → os botões de adicionar/retirar sumiam).
// Ícone da reserva. `tipoReserva` (o que o usuário escolhe no formulário) vinha
// sendo gravado e descartado no save — a pergunta existia e a resposta não ia a
// lugar nenhum. Agora ela decide o ícone, que é onde a escolha faz diferença
// para quem olha a lista.
const _ICONE_POR_TIPO = Object.freeze({
    caixinha:        'fa-box',
    poupanca:        'fa-piggy-bank',
    cdb:             'fa-chart-line',
    lci_lca:         'fa-chart-line',
    tesouro_direto:  'fa-landmark',
    renda_fixa:      'fa-chart-line',
});

function _metaIconClass(m) {
    if (String(m.id) === 'emergency') return 'fa-shield-alt';
    const porTipo = _ICONE_POR_TIPO[m.tipoReserva];
    if (porTipo) return porTipo;
    // Sem tipo declarado (reservas antigas): cai no comportamento anterior.
    if (m.tipoRendimento && m.tipoRendimento !== 'sem_rendimento') return 'fa-chart-line';
    return 'fa-piggy-bank';
}

const _SVG_NS = 'http://www.w3.org/2000/svg';
// Corpo do pote — serve de contorno E de máscara (clip) do líquido.
// Cantos: topo r=1.5, fundo r=2.5. As laterais ficam RETAS de y=8.5 a 18.5, então o
// nível sobe de forma linear e legível em qualquer percentual. (A 1ª versão usava
// r=4 nos dois cantos do fundo, virando um "U": com pouco progresso o líquido
// enchia só a ponta estreita e praticamente não aparecia.)
const _JARRO_D = 'M7 7H17A1.5 1.5 0 0 1 18.5 8.5V18.5A2.5 2.5 0 0 1 16 21H8A2.5 2.5 0 0 1 5.5 18.5V8.5A1.5 1.5 0 0 1 7 7Z';
const _JARRO_TOPO = 7;    // y do topo útil
const _JARRO_BASE = 21;   // y do fundo útil
const _JARRO_ALT  = _JARRO_BASE - _JARRO_TOPO;

const _el = (tag, attrs) => {
    const n = document.createElementNS(_SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    return n;
};

function _criarJarro(percentual, uid) {
    const pct = Math.max(0, Math.min(100, Number(percentual) || 0));
    const svg = _el('svg', { viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true' });
    svg.classList.add('meta-jarro');

    // ids precisam ser únicos por meta (vários jarros na mesma página)
    const uidSafe = String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
    const clipId = `jarroC-${uidSafe}`;
    const gradId = `jarroG-${uidSafe}`;

    const defs = _el('defs', {});
    const clip = _el('clipPath', { id: clipId });
    clip.appendChild(_el('path', { d: _JARRO_D }));
    defs.appendChild(clip);

    // Gradiente vertical dá profundidade ao líquido (claro em cima, fundo mais denso).
    const grad = _el('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(_el('stop', { offset: '0',   'stop-color': '#34d399' }));
    grad.appendChild(_el('stop', { offset: '1',   'stop-color': '#059669' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Vidro fosco (fundo do pote), sempre visível — dá corpo mesmo com 0%.
    svg.appendChild(_el('path', { d: _JARRO_D, fill: 'currentColor', opacity: '.10' }));

    if (pct > 0) {
        // Líquido com SUPERFÍCIE ONDULADA — é o detalhe que faz ler como líquido
        // em vez de "barra de progresso dentro de um pote".
        const yTopo = _JARRO_BASE - (_JARRO_ALT * pct) / 100;
        const onda = Math.min(0.7, (_JARRO_ALT * pct) / 100); // sem onda quando é um fio
        const d = `M4 ${yTopo} Q8 ${yTopo - onda} 12 ${yTopo} T20 ${yTopo} L20 22 L4 22 Z`;
        svg.appendChild(_el('path', { d, fill: `url(#${gradId})`, 'clip-path': `url(#${clipId})` }));
    }

    // Brilho de vidro — faixa suave à esquerda.
    svg.appendChild(_el('rect', {
        x: '7.6', y: '9.4', width: '1.7', height: '7.6', rx: '.85',
        fill: '#ffffff', opacity: '.14', 'clip-path': `url(#${clipId})`,
    }));

    // Contorno do pote (neutro — a cor do progresso vive no líquido e no badge %).
    svg.appendChild(_el('path', {
        d: _JARRO_D, fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.4', 'stroke-linejoin': 'round', opacity: '.55',
    }));

    // Tampa + aro
    svg.appendChild(_el('rect', { x: '5.2', y: '3.4', width: '13.6', height: '3.2', rx: '1.1', fill: 'currentColor', opacity: '.5' }));
    svg.appendChild(_el('rect', { x: '8.4', y: '2.2', width: '7.2', height: '1.6', rx: '.8', fill: 'currentColor', opacity: '.35' }));

    return svg;
}

// Carrega o card da reserva compartilhada dentro do slot já reservado.
// Best-effort de ponta a ponta: se o chunk não baixar ou a query falhar, o slot
// fica vazio e a tela de Reservas segue normal. Uma reserva de família não pode
// derrubar a tela das metas individuais.
function renderMetasList() {
    const cont = document.getElementById('listaMetas');
    if (!cont) return;

    const searchVal  = (document.getElementById('metaSearchInput')?.value  || '').toLowerCase();
    const statusVal  = (document.getElementById('metaStatusFilter')?.value || '');

    cont.innerHTML = '';

    // Reserva compartilhada (item 13): NÃO é mais um card à parte. Reconstruída
    // como caixinha normal no blob (meta.compartilhada) — aparece na lista com
    // as outras, só com um selo "👥". Ver modules/reserva-familia.js.

    if (_ctx.metas.length === 0) {
        const wrap = document.createElement('div');
        wrap.className = 'reservas-empty-state';
        wrap.innerHTML = `
            <div class="reservas-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M19 5c-1.5 0-2.8 1.4-3 2-3.5-1.5-11-.3-11 5 0 1.8 0 3 2 4.5V20h4v-2h3v2h4v-4c1-.5 1.7-1 2-2h2v-4h-2c0-1-.5-1.5-1-2V5z"/>
                    <path d="M2 9v1c0 1.1.9 2 2 2h1"/>
                    <path d="M16 11h.01"/>
                </svg>
            </div>
            <p class="reservas-empty-title">Nenhuma reserva criada</p>
            <p class="reservas-empty-sub">Crie sua primeira reserva — viagem, emergência ou qualquer objetivo financeiro.</p>`;
        const btn = document.createElement('button');
        btn.className = 'btn-primary reservas-empty-cta';
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> Nova Reserva';
        btn.addEventListener('click', () => document.getElementById('btnNovaMeta')?.click());
        wrap.appendChild(btn);
        cont.appendChild(wrap);
        return;
    }

    const filtradas = _ctx.metas.filter(m => {
        // Reserva compartilhada só aparece para os perfis que participam dela.
        // (Organização de tela — ver perfilParticipa em reserva-familia.js.)
        if (!perfilParticipa(m, _ctx.perfilAtivo?.id)) return false;

        const nome = _ctx._sanitizeText(m.descricao).toLowerCase();
        if (searchVal && !nome.includes(searchVal)) return false;
        if (statusVal) {
            const concluida = Number(m.saved || 0) >= Number(m.objetivo || 1);
            if (statusVal === 'concluida' && !concluida) return false;
            if (statusVal === 'ativa'     &&  concluida) return false;
        }
        return true;
    });

    if (filtradas.length === 0) {
        const p       = document.createElement('p');
        p.className   = 'empty-state';
        p.textContent = 'Nenhuma reserva encontrada.';
        cont.appendChild(p);
        return;
    }

    const total   = filtradas.length;
    const inicio  = (_metaPagina - 1) * _META_POR_PAGINA;
    const pagina  = filtradas.slice(inicio, inicio + _META_POR_PAGINA);

    pagina.forEach(m => {
        const div         = document.createElement('div');
        div.className     = 'meta-item';
        div.dataset.id    = String(m.id);

        const saved      = Number(m.saved    || 0);
        const objetivo   = Number(m.objetivo || 0);
        const percentual = objetivo > 0
            ? Math.min(100, parseFloat(((saved / objetivo) * 100).toFixed(1)))
            : 0;

        let corProgresso = '#ff4b4b';
        if      (percentual >= 70) corProgresso = '#00ff99';
        else if (percentual >= 40) corProgresso = '#ffd166';

        // ── Linha superior: ícone + info + percentual
        const rowTop = document.createElement('div');
        rowTop.className = 'meta-item-top';

        const iconWrap = document.createElement('div');
        iconWrap.className = 'meta-item-icon';
        iconWrap.style.color = corProgresso;
        iconWrap.appendChild(_criarJarro(percentual, corProgresso, m.id));

        const colInfo = document.createElement('div');
        colInfo.className = 'meta-item-info';

        const strongDesc       = document.createElement('strong');
        strongDesc.textContent = _ctx._sanitizeText(m.descricao);

        const divValores       = document.createElement('div');
        divValores.className   = 'meta-item-valores';
        divValores.textContent = `${formatBRL(saved)} de ${formatBRL(objetivo)}`;

        colInfo.appendChild(strongDesc);
        colInfo.appendChild(divValores);

        // Reserva compartilhada (C3): selo para distinguir na lista.
        if (m.compartilhada) {
            const badge = document.createElement('span');
            badge.style.cssText = 'display:inline-block; margin-top:4px; background:rgba(67,160,71,0.14); color:var(--primary); border-radius:10px; padding:2px 8px; font-size:0.72rem; font-weight:600;';
            badge.textContent = '👥 Compartilhada';
            colInfo.appendChild(badge);
        }

        // Tags: prazo + rendimentos + aporte
        if (m.prazo || (m.tipoRendimento && m.tipoRendimento !== 'sem_rendimento') || (m.aporteRecorrente && m.valorAporte)) {
            const rowTags = document.createElement('div');
            rowTags.className = 'meta-item-tags';

            if (m.prazo) {
                const [pm, pa] = m.prazo.split('/');
                const nomeMes  = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
                const tagPrazo = document.createElement('span');
                tagPrazo.className = 'meta-tag meta-tag-prazo';
                tagPrazo.textContent = `⏰ ${nomeMes[parseInt(pm,10) - 1] || pm}/${pa}`;
                rowTags.appendChild(tagPrazo);

                // ── Ritmo (item 3) ───────────────────────────────────────────
                // O prazo sozinho é decoração: não diz se você vai chegar lá. A
                // tag abaixo responde isso a cada render, a partir dos aportes
                // REAIS (transações com metaId) — nunca de m.monthly, que soma o
                // rendimento diário e faria o juro passar por esforço.
                const tagRitmo = _tagRitmo(m);
                if (tagRitmo) rowTags.appendChild(tagRitmo);
            }
            if (m.tipoRendimento === 'cdi') {
                const tagRend = document.createElement('span');
                tagRend.className = 'meta-tag meta-tag-rend';
                tagRend.textContent = `📈 CDI ${m.cdiPct != null ? m.cdiPct + '%' : ''}`.trim();
                rowTags.appendChild(tagRend);
            } else if (m.tipoRendimento === 'personalizado' && m.taxaJuros != null) {
                const tagRend = document.createElement('span');
                tagRend.className = 'meta-tag meta-tag-rend';
                tagRend.textContent = `📈 ${m.taxaJuros.toFixed(2)}%/mês`;
                rowTags.appendChild(tagRend);
            }
            if (m.aporteRecorrente && m.valorAporte) {
                const tagAp = document.createElement('span');
                tagAp.className = 'meta-tag meta-tag-aporte';
                tagAp.textContent = `💰 ${formatBRL(m.valorAporte)}/mês`;
                rowTags.appendChild(tagAp);
            }
            colInfo.appendChild(rowTags);
        }

        const divPerc = document.createElement('div');
        divPerc.className = 'meta-item-perc';
        divPerc.style.background = `rgba(${percentual >= 70 ? '0,255,153' : percentual >= 40 ? '255,209,102' : '255,75,75'},0.15)`;
        divPerc.style.color      = corProgresso;
        divPerc.textContent      = `${percentual}%`;

        rowTop.appendChild(iconWrap);
        rowTop.appendChild(colInfo);
        rowTop.appendChild(divPerc);

        // ── Barra de progresso
        const barraContainer = document.createElement('div');
        barraContainer.className = 'meta-barra-wrap';

        const barraFill = document.createElement('div');
        barraFill.className          = 'meta-barra-fill';
        barraFill.style.width        = `${percentual}%`;
        barraFill.style.background   = corProgresso;
        barraFill.style.boxShadow    = `0 0 8px ${corProgresso}55`;
        barraContainer.appendChild(barraFill);

        // ── Botões de ação
        const rowBotoes = document.createElement('div');
        rowBotoes.className = 'meta-item-botoes';

        const btnEditar     = document.createElement('button');
        btnEditar.className = 'btn-meta-edit';
        btnEditar.type      = 'button';
        const iEdit = document.createElement('i');
        iEdit.className = 'fas fa-pen';
        iEdit.setAttribute('aria-hidden', 'true');
        btnEditar.appendChild(iEdit);
        btnEditar.appendChild(document.createTextNode(' Editar'));
        btnEditar.addEventListener('click', e => { e.stopPropagation(); abrirMetaForm(m.id); });

        const btnExcluir     = document.createElement('button');
        btnExcluir.className = 'btn-meta-del';
        btnExcluir.type      = 'button';
        const iDel = document.createElement('i');
        iDel.className = 'fas fa-trash';
        iDel.setAttribute('aria-hidden', 'true');
        btnExcluir.appendChild(iDel);
        btnExcluir.appendChild(document.createTextNode(' Excluir'));
        btnExcluir.addEventListener('click', e => { e.stopPropagation(); removerMeta(m.id); });

        rowBotoes.appendChild(btnEditar);
        rowBotoes.appendChild(btnExcluir);

        if (m.historicoRetiradas && m.historicoRetiradas.length > 0) {
            const btnAnalise     = document.createElement('button');
            btnAnalise.className = 'btn-meta-analise';
            btnAnalise.type      = 'button';
            const iAn = document.createElement('i');
            iAn.className = 'fas fa-chart-bar';
            iAn.setAttribute('aria-hidden', 'true');
            btnAnalise.appendChild(iAn);
            btnAnalise.appendChild(document.createTextNode(' Análise'));
            btnAnalise.addEventListener('click', e => { e.stopPropagation(); abrirAnaliseDisciplina(m.id); });
            rowBotoes.appendChild(btnAnalise);
        }

        div.appendChild(rowTop);
        div.appendChild(barraContainer);
        div.appendChild(rowBotoes);

        div.addEventListener('click', () => {
            document.querySelectorAll('.meta-item').forEach(x => x.classList.remove('selected'));
            div.classList.add('selected');
            selecionarMeta(m.id);
        });

        cont.appendChild(div);
    });

    // ── Paginação
    const pagination = document.createElement('div');
    pagination.className = 'meta-pagination';

    const info = document.createElement('span');
    info.className = 'meta-pagination-info';
    const fim = Math.min(inicio + _META_POR_PAGINA, total);
    info.textContent = `Mostrando ${inicio + 1} a ${fim} de ${total} ${total === 1 ? 'reserva' : 'reservas'}`;

    const btnPrev = document.createElement('button');
    btnPrev.className = 'meta-pag-btn';
    btnPrev.type      = 'button';
    btnPrev.innerHTML = '<i class="fas fa-chevron-left" aria-hidden="true"></i>';
    btnPrev.disabled  = _metaPagina === 1;
    btnPrev.addEventListener('click', () => { _metaPagina--; renderMetasList(); });

    const btnNext = document.createElement('button');
    btnNext.className = 'meta-pag-btn';
    btnNext.type      = 'button';
    btnNext.innerHTML = '<i class="fas fa-chevron-right" aria-hidden="true"></i>';
    btnNext.disabled  = fim >= total;
    btnNext.addEventListener('click', () => { _metaPagina++; renderMetasList(); });

    const pageNum = document.createElement('span');
    pageNum.className = 'meta-pag-num active';
    pageNum.textContent = String(_metaPagina);

    pagination.appendChild(info);
    const pagControls = document.createElement('div');
    pagControls.className = 'meta-pag-controls';
    pagControls.appendChild(btnPrev);
    pagControls.appendChild(pageNum);
    pagControls.appendChild(btnNext);
    pagination.appendChild(pagControls);
    cont.appendChild(pagination);

    // Confetti ao bater uma meta. `saved` muda em 5 pontos diferentes (transação de
    // reserva, aporte aqui, rendimento diário, edição, retirada) — detectar a
    // travessia dos 100% neste ponto único pós-mudança cobre todos eles. Lazy e
    // best-effort: celebração é enfeite, nunca pode quebrar a tela.
    import('../modules/celebracao.js?v=1')
        .then(m => m.celebrarMetasConcluidas(_ctx))
        .catch(() => { /* sem festa, sem problema */ });
}

// C4 — dissolver reserva compartilhada devolvendo o saldo a cada membro.
// O dinheiro volta a UM saldo (o blob é compartilhado); a divisão é o registro
// de justiça: uma transação de retorno por pessoa, mostrando quem levou quanto.
// A soma tem que fechar com meta.saved (nunca cria nem some dinheiro do saldo).
function _dissolverReservaCompartilhada(meta) {
    const total = Number(meta.saved || 0);

    // `meta.membros` guarda IDS de perfil (desde 2026-07-19), mas divisaoSugerida
    // usa o roster como NOMES no fallback (quando ninguém tem líquido positivo).
    // Sem traduzir, a tela de dissolução listaria UUIDs crus no lugar das pessoas.
    // Rosters legados já são nomes e passam intactos pelo mapa.
    const perfis = Array.isArray(_ctx.usuarioLogado?.perfis) ? _ctx.usuarioLogado.perfis : [];
    const nomePorId = new Map(perfis.map(p => [String(p.id), String(p.nome || 'Perfil')]));
    const rosterNomes = (meta.membros || []).map(m => nomePorId.get(String(m)) || String(m));

    const divisao = divisaoSugerida(meta.movimentos, total, rosterNomes);

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:440px; width:96%;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:6px;';
        titulo.textContent = 'Dissolver reserva';

        const sub = document.createElement('div');
        sub.style.cssText = 'text-align:center; color:var(--text-secondary); font-size:0.88rem; margin-bottom:14px;';
        sub.appendChild(document.createTextNode(`${formatBRL(total)} voltam ao saldo. Com quanto cada um fica?`));

        const linhasWrap = document.createElement('div');
        const totalLbl = document.createElement('div');
        totalLbl.style.cssText = 'text-align:right; font-size:0.85rem; margin:10px 2px;';

        const inputs = [];
        const recalc = () => {
            const soma = Math.round(inputs.reduce((s, it) => s + (parseFloat(it.input.value) || 0), 0) * 100) / 100;
            totalLbl.textContent = `Soma: ${formatBRL(soma)} de ${formatBRL(total)}`;
            totalLbl.style.color = Math.abs(soma - total) < 0.01 ? 'var(--primary)' : '#ff6b6b';
        };

        (divisao.length ? divisao : [{ nome: 'Você', valor: total }]).forEach(d => {
            const linha = document.createElement('div');
            linha.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:8px;';
            const nome = document.createElement('span');
            nome.style.cssText = 'flex:1; font-size:0.92rem;';
            nome.textContent = d.nome;                     // textContent — sem XSS
            const inp = document.createElement('input');
            inp.className = 'form-input'; inp.type = 'number'; inp.step = '0.01'; inp.min = '0';
            inp.style.cssText = 'width:130px; flex-shrink:0;';
            inp.value = Number(d.valor).toFixed(2);
            inp.addEventListener('input', recalc);
            inputs.push({ nome: d.nome, input: inp });
            linha.appendChild(nome); linha.appendChild(inp);
            linhasWrap.appendChild(linha);
        });
        recalc();

        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = 'display:flex; gap:10px; margin-top:14px;';
        const btnCancel = document.createElement('button');
        btnCancel.className = 'btn-cancelar'; btnCancel.type = 'button'; btnCancel.style.flex = '1';
        btnCancel.textContent = 'Cancelar';
        btnCancel.addEventListener('click', () => _ctx.fecharPopup());

        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary'; btnOk.type = 'button'; btnOk.style.flex = '2';
        btnOk.textContent = 'Dissolver e devolver';
        btnOk.addEventListener('click', () => {
            const partes = inputs.map(it => ({ nome: it.nome, valor: Math.round((parseFloat(it.input.value) || 0) * 100) / 100 }));
            const soma = Math.round(partes.reduce((s, p) => s + p.valor, 0) * 100) / 100;
            if (Math.abs(soma - total) > 0.01) {
                return _ctx.mostrarNotificacao(`A soma precisa dar ${formatBRL(total)} (está ${formatBRL(soma)}).`, 'error');
            }
            const dh = _ctx.agoraDataHora();
            // Retorno por membro → o saldo recebe o total; o histórico mostra quem levou.
            partes.forEach(p => {
                if (p.valor <= 0) return;
                _ctx.transacoes.push({
                    categoria:      'retirada_reserva',
                    tipo:           'Retirada de Reserva',
                    descricao:      `Dissolução: ${p.nome} — ${meta.descricao}`.slice(0, 200),
                    valor:          p.valor,
                    data:           dh.data,
                    hora:           dh.hora,
                    metaId:         null,
                    motivoRetirada: 'Dissolução da reserva',
                });
            });
            _ctx.metas = _ctx.metas.filter(m => m.id !== meta.id);
            _ctx.transacoes = _ctx.transacoes.map(t =>
                (t.metaId && String(t.metaId) === String(meta.id)) ? Object.assign({}, t, { metaId: null }) : t);
            if (String(_ctx.metaSelecionadaId) === String(meta.id)) _ctx.metaSelecionadaId = null;
            _ctx.salvarDados();
            _ctx.renderMetasList();
            _ctx.atualizarTudo();
            _ctx.atualizarHeaderReservas();
            _ctx.fecharPopup();
            _ctx.mostrarNotificacao(`Reserva dissolvida. ${formatBRL(total)} voltaram ao saldo.`, 'success');
        });

        rowBtns.appendChild(btnCancel); rowBtns.appendChild(btnOk);
        wrap.appendChild(titulo); wrap.appendChild(sub); wrap.appendChild(linhasWrap);
        wrap.appendChild(totalLbl); wrap.appendChild(rowBtns);
        popup.appendChild(wrap);
    });
}

function removerMeta(id) {
    const alvo = _ctx.metas.find(m => m.id === id);
    if (!alvo) return;

    // Reserva compartilhada COM saldo: não apaga seco — dissolve devolvendo a
    // cada membro (C4). Sem saldo, segue o fluxo normal de remoção.
    if (ehCompartilhada(alvo) && Number(alvo.saved || 0) > 0) {
        _dissolverReservaCompartilhada(alvo);
        return;
    }

    if(!confirm('Remover meta? Isso também removerá os valores mensais associados.')) return;

    _ctx.metas = _ctx.metas.filter(m => m.id !== id);
    _ctx.transacoes = _ctx.transacoes.map(t => {
        if(t.metaId && String(t.metaId) === String(id)) {
            return Object.assign({}, t, { metaId: null });
        }
        return t;
    });

    _ctx.salvarDados();
    _ctx.renderMetasList();
    _ctx.atualizarTudo();
    _ctx.atualizarHeaderReservas();
}

function selecionarMeta(id) {
    _ctx.metaSelecionadaId = id;
    renderMetaVisual();
    const metaActions = document.getElementById('metaActions');
    if(metaActions) metaActions.classList.remove('js-hidden');
}

// ========== CÁLCULO DE PROJEÇÃO DE CONCLUSÃO DA META ==========
function calcularProjecaoConclusao(meta) {
    const saved    = Number(meta.saved    || 0);
    const objetivo = Number(meta.objetivo || 0);
    const falta    = Math.max(0, objetivo - saved);

    if (saved >= objetivo) {
        return { temHistorico: true, concluida: true, dataEstimada: '🎉 Meta Concluída!', mediaMensal: 0, mesesRestantes: 0, mesesComDados: 0 };
    }

    const monthly          = meta.monthly || {};
    const valoresHistorico = Object.values(monthly).filter(v => v > 0);

    if (valoresHistorico.length < 1) {
        return { temHistorico: false, mesesComDados: 0 };
    }

    // Média mensal histórica (inclui rendimentos já acumulados)
    const mediaMensal = valoresHistorico.reduce((sum, v) => sum + v, 0) / valoresHistorico.length;
    if (mediaMensal <= 0) {
        return { temHistorico: false, mesesComDados: valoresHistorico.length };
    }

    // Taxa mensal efetiva usando CDI atual (para CDI metas sempre recalcula)
    const r = _taxaMensal(meta);

    // PMT: usa aporte recorrente configurado ou média histórica
    const pmt = (meta.aporteRecorrente && meta.valorAporte > 0)
        ? meta.valorAporte
        : mediaMensal;

    // Projeção com juros compostos (FV = PV(1+r)^n + PMT*((1+r)^n-1)/r)
    const mesesRestantes = mesesParaMeta(saved, objetivo, pmt, r) ?? Math.ceil(falta / mediaMensal);

    const hoje        = new Date();
    const dtEstimada  = new Date(hoje.getFullYear(), hoje.getMonth() + mesesRestantes, 1);
    const dataFormatada = dtEstimada.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    // Rendimento total estimado até a conclusão
    const fvFinal    = fvComposto(saved, pmt, r, mesesRestantes);
    const rendEstim  = r > 0 ? Math.max(0, fvFinal - (saved + pmt * mesesRestantes)) : 0;

    let sugestao = null, avisoAjuste = null;
    if (mesesRestantes > 24) {
        avisoAjuste = 'No ritmo atual, esta meta levará mais de 2 anos. Considere aumentar o valor mensal.';
        const apNecessario = aporteNecessario(saved, objetivo, r, 12);
        const apStr = apNecessario > 0 ? formatBRL(Math.ceil(apNecessario)) : null;
        sugestao = apStr ? `Guardando ${apStr}/mês, você conclui em aproximadamente 1 ano.` : null;
    } else if (mesesRestantes <= 6) {
        sugestao = 'Você está em um ótimo ritmo! Continue assim para alcançar sua meta em breve.';
    } else if (mesesRestantes <= 12) {
        sugestao = 'Bom progresso! Mantenha a disciplina para concluir dentro do prazo estimado.';
    } else {
        const apNecessario = aporteNecessario(saved, objetivo, r, 12);
        const apStr = apNecessario > 0 ? formatBRL(Math.ceil(apNecessario)) : null;
        sugestao = apStr ? `Para concluir em 1 ano, tente guardar ${apStr}/mês.` : null;
    }

    return {
        temHistorico:   true,
        concluida:      false,
        mediaMensal,
        mesesRestantes,
        rendEstimado:   rendEstim > 0.01 ? rendEstim : 0,
        dataEstimada:   dataFormatada.charAt(0).toUpperCase() + dataFormatada.slice(1),
        mesesComDados:  valoresHistorico.length,
        sugestao,
        avisoAjuste,
    };
}

function _desenharGraficoLinha(meta, ctxLine, line, period) {
    const objetivo = Number(meta.objetivo || 0);
    ctxLine.clearRect(0, 0, line.width, line.height);
    const padding = 40;
    const w = line.width  - padding * 2;
    const h = line.height - padding * 2;
    const now = new Date();

    // Agrupa dados mensais por período solicitado
    let buckets = []; // [{ label, value, keys }]

    if (period === 'anual') {
        // 3 anos completos
        for (let y = now.getFullYear() - 2; y <= now.getFullYear(); y++) {
            let total = 0;
            for (let m = 1; m <= 12; m++) {
                const key = `${y}-${String(m).padStart(2, '0')}`;
                total += Number(meta.monthly?.[key] || 0);
            }
            buckets.push({ label: String(y), value: total });
        }
    } else {
        // Últimos 12 meses, depois agrupa conforme period
        const rawMonths = [];
        for (let i = 11; i >= 0; i--) {
            const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            rawMonths.push({ key, label: d.toLocaleString('pt-BR', { month: 'short' }), year: d.getFullYear(), month: d.getMonth() + 1 });
        }

        const step = period === 'bimestral' ? 2 : period === 'trimestral' ? 3 : period === 'semestral' ? 6 : 1;
        for (let i = 0; i < rawMonths.length; i += step) {
            const slice = rawMonths.slice(i, i + step);
            const total = slice.reduce((s, mk) => s + Number(meta.monthly?.[mk.key] || 0), 0);
            const lbl   = step === 1 ? slice[0].label : `${slice[0].label}–${slice[slice.length - 1].label}`;
            buckets.push({ label: lbl, value: total });
        }
    }

    const values = buckets.map(b => b.value);
    const maxV   = Math.max(...values, objetivo > 0 ? objetivo * 0.1 : 50, 50);

    // Background
    ctxLine.strokeStyle = 'rgba(255,255,255,0.1)';
    ctxLine.lineWidth   = 1;
    ctxLine.strokeRect(padding, padding, w, h);

    // Linha do objetivo
    if (objetivo > 0 && objetivo <= maxV) {
        const objY = padding + h - (objetivo / maxV) * h;
        ctxLine.beginPath();
        ctxLine.setLineDash([6, 4]);
        ctxLine.strokeStyle = 'rgba(0,255,153,0.4)';
        ctxLine.lineWidth   = 1;
        ctxLine.moveTo(padding, objY);
        ctxLine.lineTo(padding + w, objY);
        ctxLine.stroke();
        ctxLine.setLineDash([]);
    }

    // Área sob a linha (gradiente)
    const points = buckets.map((b, i) => ({
        x: padding + (buckets.length > 1 ? (i / (buckets.length - 1)) : 0.5) * w,
        y: padding + h - (b.value / maxV) * h,
        v: b.value,
        month: b.label,
    }));

    if (points.length > 1) {
        const grad = ctxLine.createLinearGradient(0, padding, 0, padding + h);
        grad.addColorStop(0,   'rgba(77,166,255,0.25)');
        grad.addColorStop(1,   'rgba(77,166,255,0)');
        ctxLine.beginPath();
        ctxLine.moveTo(points[0].x, padding + h);
        points.forEach(p => ctxLine.lineTo(p.x, p.y));
        ctxLine.lineTo(points[points.length - 1].x, padding + h);
        ctxLine.closePath();
        ctxLine.fillStyle = grad;
        ctxLine.fill();
    }

    // Linha principal
    ctxLine.beginPath();
    points.forEach((p, i) => { if (i === 0) ctxLine.moveTo(p.x, p.y); else ctxLine.lineTo(p.x, p.y); });
    ctxLine.strokeStyle = '#4da6ff';
    ctxLine.lineWidth   = 2.5;
    ctxLine.stroke();

    // Pontos
    points.forEach(p => {
        ctxLine.beginPath();
        ctxLine.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctxLine.fillStyle = '#fff';
        ctxLine.fill();
        ctxLine.beginPath();
        ctxLine.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctxLine.fillStyle = '#4da6ff';
        ctxLine.fill();
    });

    line._points = points;

    // Labels de eixo X
    ctxLine.fillStyle  = 'rgba(255,255,255,0.6)';
    ctxLine.font       = '10px sans-serif';
    ctxLine.textAlign  = 'center';
    points.forEach(p => ctxLine.fillText(p.month, p.x, padding + h + 16));
}

function renderMetaVisual() {
    const details = document.getElementById('metaDetalhes');
    const donut = document.getElementById('donutChart');
    const line = document.getElementById('lineChart');
    
    if(!donut || !line || !details) return;
    
    const ctxDonut = donut.getContext('2d');
    const ctxLine = line.getContext('2d');
    
    ctxDonut.clearRect(0, 0, donut.width, donut.height);
    ctxLine.clearRect(0, 0, line.width, line.height);
    
    if(!_ctx.metaSelecionadaId) {
        details.innerHTML = '';
        const _emptyMsg = document.createElement('div');
        _emptyMsg.className = 'text-secondary';
        _emptyMsg.textContent = 'Selecione uma reserva para ver detalhes e gráficos';
        details.appendChild(_emptyMsg);
        const progressEl = document.getElementById('metaProgress');
        if(progressEl) progressEl.textContent = 'Selecione uma reserva';
        const metaActions = document.getElementById('metaActions');
        if(metaActions) metaActions.classList.add('js-hidden');
        return;
    }

    const meta = _ctx.metas.find(m => String(m.id) === String(_ctx.metaSelecionadaId));
    if(!meta) {
        details.innerHTML = '';
        const _notFound = document.createElement('div');
        _notFound.className = 'text-secondary';
        _notFound.textContent = 'Meta não encontrada';
        details.appendChild(_notFound);
        const metaActions = document.getElementById('metaActions');
        if(metaActions) metaActions.classList.add('js-hidden');
        return;
    }
    
    const saved = Number(meta.saved || 0);
    const objetivo = Number(meta.objetivo || 0);
    const perc = objetivo > 0 ? Math.min(100, Math.round((saved/objetivo)*100)) : 0;
    
    const progressEl = document.getElementById('metaProgress');
    if(progressEl) {
        progressEl.textContent = `${perc}% concluído – ${formatBRL(saved)} de ${formatBRL(objetivo)}`;
    }
    
    // ✅ NOVO: Calcular projeção de conclusão
    const projecao = calcularProjecaoConclusao(meta);
    
    // Desenha gráfico donut
    const cx = donut.width/2, cy = donut.height/2, r = Math.min(cx,cy)-8;
    ctxDonut.clearRect(0,0,donut.width,donut.height);
    ctxDonut.beginPath();
    ctxDonut.arc(cx,cy,r,0,Math.PI*2);
    ctxDonut.fillStyle = '#0f1226';
    ctxDonut.fill();
    
    const ang = objetivo>0 ? (saved/objetivo) * Math.PI*2 : 0;
    ctxDonut.beginPath();
    ctxDonut.moveTo(cx,cy);
    ctxDonut.arc(cx,cy,r,-Math.PI/2, -Math.PI/2 + ang, false);
    ctxDonut.closePath();
    ctxDonut.fillStyle = '#00ff99';
    ctxDonut.fill();
    
    ctxDonut.beginPath();
    ctxDonut.moveTo(cx,cy);
    ctxDonut.arc(cx,cy,r,-Math.PI/2 + ang, -Math.PI/2 + Math.PI*2, false);
    ctxDonut.closePath();
    ctxDonut.fillStyle = '#ff4b4b';
    ctxDonut.fill();
    
    ctxDonut.beginPath();
    ctxDonut.arc(cx,cy,r*0.6,0,Math.PI*2);
    ctxDonut.fillStyle = '#11173a';
    ctxDonut.fill();
    
    ctxDonut.fillStyle = '#fff';
    ctxDonut.font = 'bold 14px sans-serif';
    ctxDonut.textAlign='center';
    ctxDonut.fillText(`${perc}%`, cx, cy+6);
    
    // Desenha gráfico de linha com suporte a períodos
    _desenharGraficoLinha(meta, ctxLine, line, _metaLinePeriod);
    
    // ── Reconstrói details via DOM — zero dados do usuário em innerHTML
    details.innerHTML = '';

    // ── Reserva compartilhada (C3): quem colocou e quem tirou ──────────────
    // O coração da feature de família. Líquido por pessoa, do que mais
    // contribuiu para o que menos. textContent — nunca innerHTML com nome.
    if (ehCompartilhada(meta)) {
        const membros = porMembro(meta.movimentos);
        const secQuem = document.createElement('div');
        secQuem.style.cssText = 'background:rgba(67,160,71,0.06); border:1px solid rgba(67,160,71,0.2); border-radius:12px; padding:12px 14px; margin-bottom:14px;';
        const tit = document.createElement('div');
        tit.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--primary); margin-bottom:8px;';
        tit.textContent = '👥 Quem colocou';
        secQuem.appendChild(tit);
        if (membros.length === 0) {
            const vazio = document.createElement('div');
            vazio.style.cssText = 'font-size:0.85rem; color:var(--text-muted);';
            vazio.textContent = 'Ninguém colocou nada ainda. Use "Guardar" para começar.';
            secQuem.appendChild(vazio);
        } else {
            for (const mem of membros) {
                const linha = document.createElement('div');
                linha.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:4px 0; font-size:0.9rem;';
                const n = document.createElement('span');
                n.textContent = mem.nome;
                const q = document.createElement('strong');
                q.style.color = mem.liquido < 0 ? '#ff6b6b' : 'var(--primary)';
                q.textContent = formatBRL(mem.liquido);
                if (mem.retiradas > 0) q.title = `Colocou ${formatBRL(mem.aportes)} · retirou ${formatBRL(mem.retiradas)}`;
                linha.appendChild(n); linha.appendChild(q);
                secQuem.appendChild(linha);
            }
        }
        details.appendChild(secQuem);
    }

    // ── Seletor de período para o gráfico de linha ─────────────────────────
    const periodos = [
        { key: 'mensal',     label: 'Mensal'    },
        { key: 'bimestral',  label: 'Bimestral' },
        { key: 'trimestral', label: 'Trimestral' },
        { key: 'semestral',  label: 'Semestral'  },
        { key: 'anual',      label: 'Anual'      },
    ];
    const periodoBar = document.createElement('div');
    periodoBar.className = 'meta-periodo-bar';
    periodos.forEach(p => {
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'meta-periodo-btn' + (p.key === _metaLinePeriod ? ' meta-periodo-btn--active' : '');
        btn.textContent = p.label;
        btn.dataset.periodo = p.key;
        btn.addEventListener('click', () => {
            _metaLinePeriod = p.key;
            // Atualiza botões ativos sem re-renderizar tudo
            periodoBar.querySelectorAll('.meta-periodo-btn').forEach(b => {
                b.classList.toggle('meta-periodo-btn--active', b.dataset.periodo === p.key);
            });
            // Redesenha apenas o canvas de linha
            const lineCanvas = document.getElementById('lineChart');
            if (lineCanvas) _desenharGraficoLinha(meta, lineCanvas.getContext('2d'), lineCanvas, _metaLinePeriod);
        });
        periodoBar.appendChild(btn);
    });
    // Insere o seletor de período entre o título e o canvas do gráfico de linha,
    // removendo qualquer barra anterior para evitar duplicatas em re-renders.
    const _lineSection = line.closest('.chart-section');
    const _existingBar = _lineSection.querySelector('.meta-periodo-bar');
    if (_existingBar) _existingBar.remove();
    const _chartWrapper = _lineSection.querySelector('.chart-wrapper');
    _lineSection.insertBefore(periodoBar, _chartWrapper);

    const falta = Math.max(0, Number(meta.objetivo || 0) - Number(meta.saved || 0));
    const concluida = Number(meta.saved || 0) >= Number(meta.objetivo || 1);

    // ── Card de detalhe
    const detCard = document.createElement('div');
    detCard.className = 'res-detail-card';

    // Header: ícone + nome/subtítulo + badge Ativa/Concluída
    const detHeader = document.createElement('div');
    detHeader.className = 'res-detail-header';

    const detIconWrap = document.createElement('div');
    detIconWrap.className = 'res-detail-icon';
    const detIconI = document.createElement('i');
    detIconI.className = `fas ${_metaIconClass(meta)}`;
    detIconI.setAttribute('aria-hidden', 'true');
    detIconWrap.appendChild(detIconI);

    const detInfo = document.createElement('div');
    detInfo.className = 'res-detail-info';
    const detName = document.createElement('div');
    detName.className = 'res-detail-name';
    detName.textContent = _ctx._sanitizeText(meta.descricao);
    const detSub = document.createElement('div');
    detSub.className = 'res-detail-sub';
    detSub.textContent = `Objetivo: ${_ctx._sanitizeText(meta.descricao)}`;
    detInfo.appendChild(detName);
    detInfo.appendChild(detSub);

    const detBadge = document.createElement('span');
    detBadge.className = concluida ? 'res-ativa-badge res-ativa-badge--done' : 'res-ativa-badge';
    detBadge.textContent = concluida ? '● Concluída' : '● Ativa';

    detHeader.appendChild(detIconWrap);
    detHeader.appendChild(detInfo);
    detHeader.appendChild(detBadge);

    // Stat boxes: Objetivo / Guardado / Falta
    const detStats = document.createElement('div');
    detStats.className = 'res-detail-stats';

    const statsData = [
        { label: 'Objetivo',  value: formatBRL(meta.objetivo), sub: 'Valor alvo da reserva',    cls: '' },
        { label: 'Guardado',  value: formatBRL(meta.saved),    sub: 'Valor acumulado',           cls: 'res-stat-guardado' },
        { label: 'Falta',     value: formatBRL(falta),         sub: 'Para atingir o objetivo',   cls: 'res-stat-falta' },
    ];

    statsData.forEach(s => {
        const box = document.createElement('div');
        box.className = 'res-stat-box';
        const lbl = document.createElement('div');
        lbl.className = 'res-stat-box-label';
        lbl.textContent = s.label;
        const val = document.createElement('div');
        val.className = `res-stat-box-value ${s.cls}`;
        val.textContent = s.value;
        const sub = document.createElement('div');
        sub.className = 'res-stat-box-sub';
        sub.textContent = s.sub;
        box.appendChild(lbl);
        box.appendChild(val);
        box.appendChild(sub);
        detStats.appendChild(box);
    });

    detCard.appendChild(detHeader);
    detCard.appendChild(detStats);
    details.appendChild(detCard);

    if (projecao.temHistorico) {
        // ── Card de projeção
        const cardProjecao             = document.createElement('div');
        cardProjecao.style.background  = 'rgba(108,99,255,0.1)';
        cardProjecao.style.padding     = '14px';
        cardProjecao.style.borderRadius = '12px';
        cardProjecao.style.marginTop   = '16px';
        cardProjecao.style.borderLeft  = '3px solid #6c63ff';

        // ── Header do card
        const headerCard             = document.createElement('div');
        headerCard.style.display     = 'flex';
        headerCard.style.alignItems  = 'center';
        headerCard.style.gap         = '10px';
        headerCard.style.marginBottom = '10px';

        const iconProjecao           = document.createElement('div');
        iconProjecao.style.fontSize  = '1.8rem';
        iconProjecao.textContent     = '📊';

        const colHeader = document.createElement('div');

        const tituloProjecao           = document.createElement('div');
        tituloProjecao.style.fontWeight = '700';
        tituloProjecao.style.color      = 'var(--text-primary)';
        tituloProjecao.style.fontSize   = '1rem';
        tituloProjecao.textContent      = 'Projeção de Conclusão'; // ✅ texto estático

        const subTituloProjecao         = document.createElement('div');
        subTituloProjecao.style.fontSize = '0.85rem';
        subTituloProjecao.style.color    = 'var(--text-secondary)';
        // ✅ mesesComDados é número calculado internamente — seguro
        subTituloProjecao.textContent    = `Baseado no seu histórico de ${projecao.mesesComDados} ${projecao.mesesComDados === 1 ? 'mês' : 'meses'}`;

        colHeader.appendChild(tituloProjecao);
        colHeader.appendChild(subTituloProjecao);
        headerCard.appendChild(iconProjecao);
        headerCard.appendChild(colHeader);

        // ── Grid média/meses
        const grid               = document.createElement('div');
        grid.style.display       = 'grid';
        grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
        grid.style.gap           = '12px';
        grid.style.marginTop     = '12px';

        const celulaMedia             = document.createElement('div');
        celulaMedia.style.background  = 'rgba(255,255,255,0.05)';
        celulaMedia.style.padding     = '10px';
        celulaMedia.style.borderRadius = '8px';
        celulaMedia.style.textAlign   = 'center';

        const labelMedia           = document.createElement('div');
        labelMedia.style.fontSize  = '0.75rem';
        labelMedia.style.color     = 'var(--text-muted)';
        labelMedia.style.marginBottom = '4px';
        labelMedia.textContent     = 'Média Mensal'; // ✅ texto estático

        const valorMedia           = document.createElement('div');
        valorMedia.style.fontSize  = '1.1rem';
        valorMedia.style.fontWeight = '700';
        valorMedia.style.color     = '#00ff99';
        valorMedia.textContent     = _ctx.formatBRL(projecao.mediaMensal); // ✅ número calculado internamente

        celulaMedia.appendChild(labelMedia);
        celulaMedia.appendChild(valorMedia);

        const celulaMeses             = document.createElement('div');
        celulaMeses.style.background  = 'rgba(255,255,255,0.05)';
        celulaMeses.style.padding     = '10px';
        celulaMeses.style.borderRadius = '8px';
        celulaMeses.style.textAlign   = 'center';

        const labelMeses           = document.createElement('div');
        labelMeses.style.fontSize  = '0.75rem';
        labelMeses.style.color     = 'var(--text-muted)';
        labelMeses.style.marginBottom = '4px';
        labelMeses.textContent     = 'Meses Restantes'; // ✅ texto estático

        const valorMeses            = document.createElement('div');
        valorMeses.style.fontSize   = '1.1rem';
        valorMeses.style.fontWeight = '700';
        valorMeses.style.color      = '#ffd166';
        valorMeses.textContent      = String(projecao.mesesRestantes); // ✅ número calculado internamente

        celulaMeses.appendChild(labelMeses);
        celulaMeses.appendChild(valorMeses);

        grid.appendChild(celulaMedia);
        grid.appendChild(celulaMeses);

        // ── Data estimada
        const cardData               = document.createElement('div');
        cardData.style.background    = 'rgba(108,99,255,0.2)';
        cardData.style.padding       = '12px';
        cardData.style.borderRadius  = '10px';
        cardData.style.marginTop     = '12px';
        cardData.style.textAlign     = 'center';

        const labelData              = document.createElement('div');
        labelData.style.fontSize     = '0.85rem';
        labelData.style.color        = 'var(--text-secondary)';
        labelData.style.marginBottom = '6px';
        labelData.textContent        = '🎯 Data Estimada de Conclusão'; // ✅ texto estático

        const valorData             = document.createElement('div');
        valorData.style.fontSize    = '1.3rem';
        valorData.style.fontWeight  = '700';
        valorData.style.color       = '#6c63ff';
        // ✅ dataEstimada vem de Date.toLocaleDateString — dado do sistema, não do usuário
        //    mas sanitizamos por precaução
        valorData.textContent       = _ctx._sanitizeText(String(projecao.dataEstimada));

        cardData.appendChild(labelData);
        cardData.appendChild(valorData);

        // ── Aviso de ajuste (opcional)
        if (projecao.avisoAjuste) {
            const divAviso              = document.createElement('div');
            divAviso.style.fontSize     = '0.8rem';
            divAviso.style.color        = '#ffd166';
            divAviso.style.marginTop    = '8px';
            divAviso.style.padding      = '8px';
            divAviso.style.background   = 'rgba(255,209,102,0.1)';
            divAviso.style.borderRadius = '6px';
            // ✅ avisoAjuste é string interna calculada em calcularProjecaoConclusao — textContent por precaução
            divAviso.textContent        = `⚠️ ${_sanitizeText(String(projecao.avisoAjuste))}`;
            cardData.appendChild(divAviso);
        }

        // ── Sugestão (opcional)
        if (projecao.sugestao) {
            const divSugestao              = document.createElement('div');
            divSugestao.style.marginTop    = '12px';
            divSugestao.style.padding      = '10px';
            divSugestao.style.background   = 'rgba(0,255,153,0.1)';
            divSugestao.style.borderRadius = '8px';
            divSugestao.style.borderLeft   = '3px solid #00ff99';
            divSugestao.style.fontSize     = '0.85rem';
            divSugestao.style.color        = 'var(--text-primary)';

            const strongSug       = document.createElement('strong');
            strongSug.textContent = '💡 Sugestão: ';

            const spanSug       = document.createElement('span');
            // ✅ sugestao é string interna calculada — textContent por precaução
            spanSug.textContent = _ctx._sanitizeText(String(projecao.sugestao));

            divSugestao.appendChild(strongSug);
            divSugestao.appendChild(spanSug);
            cardData.appendChild(divSugestao);
        }

        cardProjecao.appendChild(headerCard);
        cardProjecao.appendChild(grid);
        cardProjecao.appendChild(cardData);
        details.appendChild(cardProjecao);

    } else {
        // ── Card de histórico insuficiente
        const cardInsuf               = document.createElement('div');
        cardInsuf.style.background    = 'rgba(255,209,102,0.1)';
        cardInsuf.style.padding       = '14px';
        cardInsuf.style.borderRadius  = '12px';
        cardInsuf.style.marginTop     = '16px';
        cardInsuf.style.borderLeft    = '3px solid #ffd166';

        const rowInsuf             = document.createElement('div');
        rowInsuf.style.display     = 'flex';
        rowInsuf.style.alignItems  = 'center';
        rowInsuf.style.gap         = '10px';

        const iconInsuf           = document.createElement('div');
        iconInsuf.style.fontSize  = '1.5rem';
        iconInsuf.textContent     = '📊';

        const colInsuf = document.createElement('div');

        const tituloInsuf              = document.createElement('div');
        tituloInsuf.style.fontWeight   = '600';
        tituloInsuf.style.color        = 'var(--text-primary)';
        tituloInsuf.style.marginBottom = '4px';
        tituloInsuf.textContent        = 'Histórico Insuficiente'; // ✅ texto estático

        const subInsuf            = document.createElement('div');
        subInsuf.style.fontSize   = '0.85rem';
        subInsuf.style.color      = 'var(--text-secondary)';
        subInsuf.textContent      = 'Faça o primeiro aporte para calcular a projeção de conclusão.'; // ✅ texto estático

        colInsuf.appendChild(tituloInsuf);
        colInsuf.appendChild(subInsuf);
        rowInsuf.appendChild(iconInsuf);
        rowInsuf.appendChild(colInsuf);
        cardInsuf.appendChild(rowInsuf);
        details.appendChild(cardInsuf);
    }
    
    // ── Compound interest info — usa taxa mensal calculada em tempo real
    const _rMensal = _taxaMensal(meta);
    if (_rMensal > 0) {
        const r = _rMensal;
        const aporte = Number(meta.valorAporte || 0);

        const cardRendim              = document.createElement('div');
        cardRendim.style.background   = 'rgba(0,255,153,0.06)';
        cardRendim.style.padding      = '14px';
        cardRendim.style.borderRadius = '12px';
        cardRendim.style.marginTop    = '12px';
        cardRendim.style.borderLeft   = '3px solid #00ff99';

        const rdTit = document.createElement('div');
        rdTit.style.cssText = 'font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#00cc7a; margin-bottom:10px;';
        rdTit.textContent = '📈 Projeção com Rendimentos';
        cardRendim.appendChild(rdTit);

        function addRendRow(lbl, val, cor) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid rgba(255,255,255,0.05);';
            const l = document.createElement('span');
            l.style.cssText = 'font-size:0.83rem; color:var(--text-secondary);';
            l.textContent = lbl;
            const v = document.createElement('span');
            v.style.cssText = `font-size:0.88rem; font-weight:700; color:${cor || 'var(--text-primary)'};`;
            v.textContent = val;
            row.appendChild(l); row.appendChild(v);
            cardRendim.appendChild(row);
        }

        const taxaLabel = meta.tipoRendimento === 'cdi'
            ? `${(r * 100).toFixed(4)}% (${meta.cdiPct}% CDI · ${_cdiAnual.toFixed(2)}% a.a.)`
            : `${(r * 100).toFixed(4)}%/mês`;
        addRendRow('Taxa mensal efetiva', taxaLabel, '#00ff99');
        if (aporte > 0) {
            const fv12 = fvComposto(saved, aporte, r, 12);
            const rend12 = Math.max(0, fv12 - (saved + aporte * 12));
            addRendRow('Rendimento estimado (12m)', `+${formatBRL(rend12)}`, '#00ff99');
            addRendRow('Saldo após 12m', _ctx.formatBRL(fv12), 'var(--primary)');
        }

        details.appendChild(cardRendim);
    }

    // ── Smart tips based on real transactions
    const gastosPorCategoria = {};
    const hoje = new Date();
    const mesAtualKey = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    _ctx.transacoes.filter(t => t.categoria === 'saida').forEach(t => {
        const cat = t.tipo || 'Outros';
        if (!gastosPorCategoria[cat]) gastosPorCategoria[cat] = 0;
        gastosPorCategoria[cat] += Number(t.valor || 0);
    });
    const top5Cats = Object.entries(gastosPorCategoria)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    if (top5Cats.length > 0 && saved < objetivo) {
        const falta = objetivo - saved;
        const cardTips              = document.createElement('div');
        cardTips.style.background   = 'rgba(108,99,255,0.07)';
        cardTips.style.padding      = '14px';
        cardTips.style.borderRadius = '12px';
        cardTips.style.marginTop    = '12px';
        cardTips.style.borderLeft   = '3px solid #6c63ff';

        const tTit = document.createElement('div');
        tTit.style.cssText = 'font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:#6c63ff; margin-bottom:10px;';
        tTit.textContent = '💡 Dicas Personalizadas';
        cardTips.appendChild(tTit);

        // Tip 1: save 10% per top category
        const economiaTop5 = top5Cats.reduce((s, [, v]) => s + v * 0.1, 0);
        if (economiaTop5 > 0) {
            const p = document.createElement('p');
            p.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); margin-bottom:8px; line-height:1.5;';
            const meses10pct = economiaTop5 > 0 ? Math.ceil(falta / economiaTop5) : null;
            p.textContent = `Se economizar 10% nas suas ${top5Cats.length} maiores categorias de gasto, você guardaria ${formatBRL(economiaTop5)}/mês${meses10pct ? ` e atingiria a meta em ~${meses10pct} meses` : ''}.`;
            cardTips.appendChild(p);
        }

        // Tip 2: specific category suggestion
        if (top5Cats[0]) {
            const [catNome, catVal] = top5Cats[0];
            const p2 = document.createElement('p');
            p2.style.cssText = 'font-size:0.83rem; color:var(--text-secondary); margin-bottom:0; line-height:1.5;';
            p2.textContent = `Sua maior despesa é "${_sanitizeText(catNome)}" com ${formatBRL(catVal)} no total. Reduzir 15% aqui = ${formatBRL(catVal * 0.15)} a mais por período para sua reserva.`;
            cardTips.appendChild(p2);
        }

        details.appendChild(cardTips);
    }

    // ── Widget simulador de aportes ─────────────────────────────────────────
    if (saved < objetivo) {
        const falta       = objetivo - saved;
        const rMensal     = _taxaMensal(meta);
        const aporteRec   = Number(meta.valorAporte || 0);

        const cardSim             = document.createElement('div');
        cardSim.className         = 'meta-sim-card';

        const simTit              = document.createElement('div');
        simTit.className          = 'meta-sim-title';
        simTit.textContent        = '🧮 Simulador de Aportes';
        cardSim.appendChild(simTit);

        const simDesc             = document.createElement('div');
        simDesc.className         = 'meta-sim-desc';
        simDesc.textContent       = 'Simule quanto tempo levará para atingir sua meta com um aporte mensal.';
        cardSim.appendChild(simDesc);

        // Input row
        const inputRow            = document.createElement('div');
        inputRow.className        = 'meta-sim-input-row';

        const prefixo             = document.createElement('span');
        prefixo.className         = 'meta-sim-prefix';
        prefixo.textContent       = 'R$';

        const simInput            = document.createElement('input');
        simInput.type             = 'text';
        simInput.inputMode        = 'decimal';
        simInput.className        = 'meta-sim-input';
        simInput.placeholder      = aporteRec > 0 ? formatBRL(aporteRec).replace('R$ ','').replace('R$ ','') : '0,00';
        simInput.setAttribute('aria-label', 'Aporte mensal para simulação');

        const sufixo              = document.createElement('span');
        sufixo.className          = 'meta-sim-suffix';
        sufixo.textContent        = '/ mês';

        inputRow.appendChild(prefixo);
        inputRow.appendChild(simInput);
        inputRow.appendChild(sufixo);
        cardSim.appendChild(inputRow);

        // Result area
        const simResult           = document.createElement('div');
        simResult.className       = 'meta-sim-result meta-sim-hidden';
        cardSim.appendChild(simResult);

        details.appendChild(cardSim);

        let _simTimer = null;
        function _atualizarSim() {
            const raw = simInput.value.replace(/\./g,'').replace(',','.');
            const pmt = parseFloat(raw) || 0;
            if (pmt <= 0) { simResult.className = 'meta-sim-result meta-sim-hidden'; return; }

            const n = mesesParaMeta(saved, objetivo, pmt, rMensal);
            simResult.className   = 'meta-sim-result';
            simResult.textContent = '';

            function addRow(lbl, val, cor) {
                const row = document.createElement('div');
                row.className = 'meta-sim-row';
                const l = document.createElement('span');
                l.className   = 'meta-sim-row-label';
                l.textContent = lbl;
                const v = document.createElement('span');
                v.className   = 'meta-sim-row-value';
                v.style.color = cor || 'var(--text-primary)';
                v.textContent = val;
                row.appendChild(l); row.appendChild(v);
                simResult.appendChild(row);
            }

            if (!isFinite(n) || n > 1200) {
                const warn = document.createElement('div');
                warn.className   = 'meta-sim-warn';
                warn.textContent = '⚠️ O aporte está muito baixo — os rendimentos não superam o déficit. Aumente o valor mensal.';
                simResult.appendChild(warn);
                return;
            }

            const mesesInt  = Math.ceil(n);
            const anos      = Math.floor(mesesInt / 12);
            const mesesRes  = mesesInt % 12;
            const tempo     = anos > 0
                ? `${anos} ano${anos > 1 ? 's' : ''} e ${mesesRes} mês${mesesRes !== 1 ? 'es' : ''}`
                : `${mesesInt} mês${mesesInt !== 1 ? 'es' : ''}`;

            const fvFinal      = fvComposto(saved, pmt, rMensal, mesesInt);
            const totalAportes = pmt * mesesInt;
            const rendimentos  = Math.max(0, fvFinal - saved - totalAportes);

            const dataChegada = new Date();
            dataChegada.setMonth(dataChegada.getMonth() + mesesInt);
            const dataStr = dataChegada.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

            addRow('Tempo estimado', tempo, '#00ff99');
            addRow('Chegada em', dataStr, 'var(--text-secondary)');
            addRow('Total de aportes', formatBRL(totalAportes), 'var(--text-primary)');
            if (rMensal > 0) addRow('Rendimentos acumulados', `+${formatBRL(rendimentos)}`, '#00cc7a');
            addRow('Saldo final projetado', formatBRL(fvFinal), 'var(--primary-light)');
        }

        simInput.addEventListener('input', () => {
            clearTimeout(_simTimer);
            _simTimer = setTimeout(_atualizarSim, 250);
        });

        // Pre-populate with recurring aporte if set
        if (aporteRec > 0) {
            simInput.value = String(aporteRec).replace('.', ',');
            _atualizarSim();
        }
    }

    if (!line._clickListenerRegistrado) {
        line._clickListenerRegistrado = true;
        line.addEventListener('click', function(ev) {
            const rect = line.getBoundingClientRect();
            const mx = ev.clientX - rect.left;
            const my = ev.clientY - rect.top;

            const ponto = (line._points || []).find(p => {
                const dx = p.x - mx, dy = p.y - my;
                return Math.sqrt(dx * dx + dy * dy) <= 8;
            });

            if (ponto) {
                _ctx.mostrarNotificacao(
                    `${_sanitizeText(ponto.month)}: ${formatBRL(ponto.v)}`,
                    'info'
                );
            }
        });
    }
}

function abrirRetiradaForm() {
    if(!_ctx.metaSelecionadaId) return _ctx.mostrarNotificacao('Selecione uma meta primeiro.', 'error');

    const meta = _ctx.metas.find(m => String(m.id) === String(_ctx.metaSelecionadaId));
    if(!meta) return _ctx.mostrarNotificacao('Meta não encontrada.', 'error');
    // Guarda de participacao: nao basta a reserva estar escondida da lista —
    // um perfil que nao participa tambem nao pode movimentar o dinheiro dela.
    if (!perfilParticipa(meta, _ctx.perfilAtivo?.id)) {
        return _ctx.mostrarNotificacao('Esta reserva e de outro(s) perfil(is).', 'error');
    }

    const saldoDisponivel = Number(meta.saved || 0);
    if(saldoDisponivel <= 0) return _ctx.mostrarNotificacao('Não há saldo disponível nesta reserva para retirar.', 'error');

    _ctx.criarPopup(`
        <h3>💸 Retirar Dinheiro</h3>
        <div class="small" id="popupMetaNome"></div>
        <div id="popupSaldoDisponivel" style="margin-bottom:12px; color: var(--text-secondary);"></div>

        <label style="display:block; text-align:left; margin-top:12px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">
            💰 Valor a Retirar:
        </label>
        <input type="number" id="valorRetirada" class="form-input"
               placeholder="Valor a retirar (R$)" step="0.01" min="0.01"><br>

        <label style="display:block; text-align:left; margin-top:16px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">
            📝 Motivo da Retirada: <span style="color: #ff4b4b;">*</span>
        </label>
        <select id="motivoRetirada" class="form-input" style="margin-bottom:8px;">
            <option value="">Selecione o motivo...</option>
            <option value="Emergência Médica">🏥 Emergência Médica</option>
            <option value="Emergência Familiar">👨‍👩‍👧 Emergência Familiar</option>
            <option value="Reparo Urgente">🔧 Reparo Urgente (Casa/Carro)</option>
            <option value="Investimento">📈 Investimento</option>
            <option value="Compra Planejada">🛒 Compra Planejada</option>
            <option value="Oportunidade">💡 Oportunidade de Negócio</option>
            <option value="Dívida Urgente">💳 Pagamento de Dívida Urgente</option>
            <option value="Viagem">✈️ Viagem</option>
            <option value="Educação">📚 Educação/Curso</option>
            <option value="Outro">📄 Outro Motivo</option>
        </select>

        <div id="outroMotivoDiv" style="display:none; margin-top:8px;">
            <input type="text" id="outroMotivoTexto" class="form-input"
                   placeholder="Descreva o motivo..." maxlength="100">
        </div>

        <div style="background: rgba(255,209,102,0.1); padding: 12px; border-radius: 8px; margin-top: 16px; border-left: 3px solid #ffd166;">
            <div style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
                <strong>💡 Dica:</strong> Registrar o motivo ajuda você a entender seu comportamento financeiro e manter disciplina nas suas metas.
            </div>
        </div>

        <button class="btn-primary" id="confirmarRetirada" style="margin-top:16px;">Confirmar Retirada</button>
        <button class="btn-cancelar" id="cancelarRetirada">Cancelar</button>
    `);

    // ✅ Dados dinâmicos via textContent — sem interpolação no HTML do popup
    document.getElementById('popupMetaNome').textContent       = `Meta: ${meta.descricao}`;
    document.getElementById('popupSaldoDisponivel').textContent = `Saldo disponível: ${formatBRL(saldoDisponivel)}`;

    // ✅ max definido via propriedade — não interpolado no HTML
    document.getElementById('valorRetirada').max = saldoDisponivel;

    // ✅ Cancelar via addEventListener — sem onclick inline
    document.getElementById('cancelarRetirada').addEventListener('click', () => _ctx.fecharPopup());

    const selectMotivo  = document.getElementById('motivoRetirada');
    const outroMotivoDiv = document.getElementById('outroMotivoDiv');

    selectMotivo.addEventListener('change', function() {
        if(this.value === 'Outro') {
            outroMotivoDiv.style.display = 'block';
            document.getElementById('outroMotivoTexto').focus();
        } else {
            outroMotivoDiv.style.display = 'none';
            document.getElementById('outroMotivoTexto').value = '';
        }
    });

    document.getElementById('confirmarRetirada').addEventListener('click', () => {
        const valorStr        = document.getElementById('valorRetirada').value;
        const motivoSelect    = document.getElementById('motivoRetirada').value;
        const outroMotivoTexto = document.getElementById('outroMotivoTexto').value.trim();

        if(!valorStr || !Number.isFinite(Number(valorStr)) || Number(valorStr) <= 0) {
        return _ctx.mostrarNotificacao('Digite um valor válido.', 'error');
        }
        if(!motivoSelect) {
            return _ctx.mostrarNotificacao('Por favor, selecione o motivo da retirada.', 'warning');
        }
        if(motivoSelect === 'Outro' && !outroMotivoTexto) {
            return _ctx.mostrarNotificacao('Por favor, descreva o motivo da retirada.', 'warning');
        }

        const valorRetirar = parseFloat(parseFloat(valorStr).toFixed(2));
        if(!Number.isFinite(valorRetirar) || valorRetirar <= 0) {
            return _ctx.mostrarNotificacao('Valor inválido após processamento.', 'error');
        }
        if(valorRetirar > saldoDisponivel) {
            return _ctx.mostrarNotificacao('Valor maior que o saldo disponível!', 'error');
        }

        const motivoFinal = motivoSelect === 'Outro' ? outroMotivoTexto : motivoSelect;
        const dh          = _ctx.agoraDataHora();

        // ✅ Sem id — banco gera via gen_random_uuid()
        _ctx.transacoes.push({
            categoria:       'retirada_reserva',
            tipo:            'Retirada de Reserva',
            descricao:       `Retirada: ${meta.descricao}`,
            valor:           valorRetirar,
            data:            dh.data,
            hora:            dh.hora,
            metaId:          meta.id,
            motivoRetirada:  motivoFinal
        });

        meta.saved = Number((Number(meta.saved || 0) - valorRetirar).toFixed(2));

        const ym = _ctx.yearMonthKey(_ctx.isoDate());
        meta.monthly = meta.monthly || {};
        meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) - valorRetirar).toFixed(2));
        if(meta.monthly[ym] < 0) meta.monthly[ym] = 0;

        if(!meta.historicoRetiradas) meta.historicoRetiradas = [];
        meta.historicoRetiradas.push({
            data:           dh.data,
            valor:          valorRetirar,
            motivo:         motivoFinal,
            saldoAnterior:  saldoDisponivel,
            saldoPosterior: meta.saved
        });

        // Reserva compartilhada: registra QUEM retirou (o dinheiro já voltou ao
        // saldo pela transação acima — aqui é só a trilha de atribuição).
        if (ehCompartilhada(meta)) {
            const quem = membroAtual(_ctx);
            registrarMovimento(meta, { id: quem.id, nome: quem.nome, tipo: 'retirada', valor: valorRetirar, data: dh.data, hora: dh.hora });
        }

        _ctx.salvarDados();
        _ctx.atualizarTudo();
        renderMetaVisual();
        _ctx.fecharPopup();

        let mensagemFinal = `Retirada de ${formatBRL(valorRetirar)} realizada! O valor voltou ao seu saldo.`;
        if(motivoFinal.includes('Emergência'))        mensagemFinal += ' 💙 Esperamos que tudo se resolva bem.';
        else if(motivoFinal.includes('Investimento')) mensagemFinal += ' 📈 Ótima escolha!';
        else if(motivoFinal.includes('Dívida'))        mensagemFinal += ' 💪 Parabéns por priorizar a quitação!';

        _ctx.mostrarNotificacao(mensagemFinal, 'success');
    });
}

// Saldo disponível no dashboard = acumulado de TODAS as transações.
// Mesma regra de cálculo do engine (dashboard.js): entrada/retirada somam,
// saída/reserva subtraem. Usado para validar quanto o usuário pode guardar.
function _saldoDashboard() {
    return (_ctx.transacoes || []).reduce((s, t) => {
        const v = Number(t.valor);
        if (!Number.isFinite(v) || v < 0) return s;
        if (t.categoria === 'entrada')          return s + v;
        if (t.categoria === 'saida')            return s - v;
        if (t.categoria === 'reserva')          return s - v;
        if (t.categoria === 'retirada_reserva') return s + v;
        return s;
    }, 0);
}

// Helper compartilhado: seção com fundo glass (mesmo visual dos demais popups)
function _secaoGlass(labelTxt) {
    const sec = document.createElement('div');
    sec.style.cssText = 'background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px 16px; margin-bottom:12px;';
    if (labelTxt) {
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); margin-bottom:10px;';
        lbl.textContent = labelTxt;
        sec.appendChild(lbl);
    }
    return sec;
}

// ========== GUARDAR DINHEIRO NA RESERVA ==========
// Move dinheiro do saldo do dashboard para a reserva selecionada criando uma
// transação categoria 'reserva' — exatamente o mesmo fluxo da aba Transações
// (db-transacoes.js): o valor sai do saldo e entra na reserva (meta.saved).
function abrirGuardarForm() {
    if (!_ctx.metaSelecionadaId) return _ctx.mostrarNotificacao('Selecione uma reserva primeiro.', 'error');

    const meta = _ctx.metas.find(m => String(m.id) === String(_ctx.metaSelecionadaId));
    if (!meta) return _ctx.mostrarNotificacao('Reserva não encontrada.', 'error');
    // Guarda de participacao: nao basta a reserva estar escondida da lista —
    // um perfil que nao participa tambem nao pode movimentar o dinheiro dela.
    if (!perfilParticipa(meta, _ctx.perfilAtivo?.id)) {
        return _ctx.mostrarNotificacao('Esta reserva e de outro(s) perfil(is).', 'error');
    }

    const saldoDisponivel = parseFloat(_saldoDashboard().toFixed(2));

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:440px; width:96%;';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:84vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        // ── Título ────────────────────────────────────────────────────────────
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:6px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.12rem;';
        const tIcon = document.createElement('i');
        tIcon.className = 'fas fa-piggy-bank';
        tIcon.setAttribute('aria-hidden', 'true');
        tIcon.style.color = 'var(--primary)';
        titulo.appendChild(tIcon);
        titulo.appendChild(document.createTextNode(' Guardar Dinheiro'));

        // ── Subtítulo: nome da reserva (textContent — blindado contra XSS) ────
        const subtitulo = document.createElement('div');
        subtitulo.style.cssText = 'text-align:center; color:var(--text-secondary); font-size:0.9rem; margin-bottom:14px;';
        subtitulo.appendChild(document.createTextNode('Reserva: '));
        const subStrong = document.createElement('strong');
        subStrong.textContent = String(meta.descricao || '');
        subtitulo.appendChild(subStrong);

        // ── Card: saldo disponível no dashboard ───────────────────────────────
        const cardSaldo = document.createElement('div');
        cardSaldo.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(67,160,71,0.08); border:1px solid rgba(67,160,71,0.2); border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:0.88rem;';
        const csLabel = document.createElement('span');
        csLabel.style.color = 'var(--text-secondary)';
        csLabel.textContent = 'Saldo disponível';
        const csVal = document.createElement('strong');
        csVal.style.color = saldoDisponivel > 0 ? 'var(--primary)' : '#ff4b4b';
        csVal.textContent = formatBRL(saldoDisponivel);
        cardSaldo.appendChild(csLabel);
        cardSaldo.appendChild(csVal);

        // ── Seção: valor + descrição ──────────────────────────────────────────
        const secDados = _secaoGlass('Quanto guardar?');

        const lblValor = document.createElement('label');
        lblValor.style.cssText = 'display:block; text-align:left; margin-bottom:6px; color:var(--text-secondary); font-weight:600; font-size:0.85rem;';
        lblValor.textContent = '💰 Valor a guardar:';
        const inpValor = document.createElement('input');
        inpValor.className = 'form-input'; inpValor.id = 'guardarValor';
        inpValor.type = 'number'; inpValor.step = '0.01'; inpValor.min = '0.01'; inpValor.max = '9999999';
        inpValor.placeholder = 'Valor a guardar (R$)';
        inpValor.autocomplete = 'off';
        inpValor.style.marginBottom = '12px';

        const lblDesc = document.createElement('label');
        lblDesc.style.cssText = 'display:block; text-align:left; margin-bottom:6px; color:var(--text-secondary); font-weight:600; font-size:0.85rem;';
        lblDesc.textContent = '📝 Descrição (opcional):';
        const inpDesc = document.createElement('input');
        inpDesc.className = 'form-input'; inpDesc.id = 'guardarDesc';
        inpDesc.type = 'text'; inpDesc.maxLength = 200; inpDesc.autocomplete = 'off';
        inpDesc.placeholder = 'Ex: Sobra do mês, 13º, venda...';

        secDados.appendChild(lblValor);
        secDados.appendChild(inpValor);
        secDados.appendChild(lblDesc);
        secDados.appendChild(inpDesc);

        // ── Nota informativa ──────────────────────────────────────────────────
        const nota = document.createElement('div');
        nota.style.cssText = 'background:rgba(77,166,255,0.08); border-left:3px solid #4da6ff; border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:0.82rem; color:var(--text-secondary); line-height:1.5;';
        const notaIcon = document.createElement('i');
        notaIcon.className = 'fas fa-info-circle';
        notaIcon.setAttribute('aria-hidden', 'true');
        notaIcon.style.cssText = 'color:#4da6ff; margin-right:6px;';
        nota.appendChild(notaIcon);
        nota.appendChild(document.createTextNode('O valor sai do seu saldo e entra nesta reserva. Fica registrado em Transações como uma reserva.'));

        // ── Botões ────────────────────────────────────────────────────────────
        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = 'display:flex; gap:10px;';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar'; btnCancelar.type = 'button';
        btnCancelar.style.flex = '1'; btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary'; btnOk.type = 'button';
        btnOk.style.cssText = 'flex:2; display:flex; align-items:center; justify-content:center; gap:6px;';
        const iOk = document.createElement('i');
        iOk.className = 'fas fa-piggy-bank'; iOk.setAttribute('aria-hidden', 'true');
        btnOk.appendChild(iOk);
        btnOk.appendChild(document.createTextNode('Guardar'));

        btnOk.addEventListener('click', () => {
            // ── Validação: valor ──────────────────────────────────────────────
            const valorStr = inpValor.value;
            const valorNum = parseFloat(valorStr);
            if (valorStr === '' || !Number.isFinite(valorNum) || valorNum <= 0) {
                return _ctx.mostrarNotificacao('Digite um valor válido para guardar.', 'error');
            }
            if (valorNum > 9_999_999) {
                return _ctx.mostrarNotificacao('Valor muito alto (máx. R$ 9.999.999,00).', 'error');
            }
            const valor = parseFloat(valorNum.toFixed(2));
            if (!Number.isFinite(valor) || valor <= 0) {
                return _ctx.mostrarNotificacao('Valor inválido após processamento.', 'error');
            }
            // Revalida o saldo no momento da confirmação (defesa contra alteração entre abrir/confirmar)
            const saldoAtual = parseFloat(_saldoDashboard().toFixed(2));
            if (valor > saldoAtual) {
                return _ctx.mostrarNotificacao(`Saldo insuficiente. Disponível: ${formatBRL(saldoAtual)}.`, 'error');
            }

            // ── Descrição (opcional, sanitizada) ─────────────────────────────
            const descRaw = inpDesc.value.trim();
            if (descRaw.length > 200) {
                return _ctx.mostrarNotificacao('Descrição muito longa (máx. 200 caracteres).', 'error');
            }
            const descricao = descRaw
                ? _sanitizeText(descRaw)
                : `Guardado: ${meta.descricao}`.slice(0, 200);

            const dh = _ctx.agoraDataHora();

            // ── Transação 'reserva' (saldo → reserva) — sem id, banco gera UUID ─
            _ctx.transacoes.push({
                categoria: 'reserva',
                tipo:      'Reserva',
                descricao,
                valor,
                data:      dh.data,
                hora:      dh.hora,
                metaId:    meta.id,
            });

            // ── Atualiza saldo da reserva e histórico mensal ─────────────────
            meta.saved = Number((Number(meta.saved || 0) + valor).toFixed(2));
            const ym = _ctx.yearMonthKey(_ctx.isoDate());
            meta.monthly = meta.monthly || {};
            meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + valor).toFixed(2));

            // Reserva compartilhada: registra QUEM colocou (o dinheiro já saiu do
            // saldo pela transação acima — aqui é só a trilha de atribuição).
            if (ehCompartilhada(meta)) {
                const quem = membroAtual(_ctx);
                registrarMovimento(meta, { id: quem.id, nome: quem.nome, tipo: 'aporte', valor, data: dh.data, hora: dh.hora });
            }

            _ctx.salvarDados();
            _ctx.atualizarTudo();
            renderMetaVisual();
            _ctx.fecharPopup();

            let msg = `${formatBRL(valor)} guardado em "${meta.descricao}"! 🐷`;
            if (Number(meta.saved) >= Number(meta.objetivo || 0) && Number(meta.objetivo || 0) > 0) {
                msg = `Meta "${meta.descricao}" concluída! 🎉 Você atingiu ${formatBRL(meta.objetivo)}.`;
            }
            _ctx.mostrarNotificacao(msg, 'success');
        });

        rowBtns.appendChild(btnCancelar);
        rowBtns.appendChild(btnOk);

        // ── Montagem ──────────────────────────────────────────────────────────
        wrapper.appendChild(titulo);
        wrapper.appendChild(subtitulo);
        wrapper.appendChild(cardSaldo);
        wrapper.appendChild(secDados);
        wrapper.appendChild(nota);
        wrapper.appendChild(rowBtns);
        popup.appendChild(wrapper);
    });
}

// ========== AJUSTAR VALOR DA RESERVA ==========
// Reconciliação: corrige o valor atual da reserva (meta.saved) para bater com
// o valor real do usuário. NÃO cria transação e NÃO mexe no saldo do dashboard —
// apenas acerta o valor exibido da reserva. Registra o ajuste em historicoAjustes.
function abrirAjusteForm() {
    if (!_ctx.metaSelecionadaId) return _ctx.mostrarNotificacao('Selecione uma reserva primeiro.', 'error');

    const meta = _ctx.metas.find(m => String(m.id) === String(_ctx.metaSelecionadaId));
    if (!meta) return _ctx.mostrarNotificacao('Reserva não encontrada.', 'error');
    // Guarda de participacao: nao basta a reserva estar escondida da lista —
    // um perfil que nao participa tambem nao pode movimentar o dinheiro dela.
    if (!perfilParticipa(meta, _ctx.perfilAtivo?.id)) {
        return _ctx.mostrarNotificacao('Esta reserva e de outro(s) perfil(is).', 'error');
    }

    const valorAtual = parseFloat(Number(meta.saved || 0).toFixed(2));

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:440px; width:96%;';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:84vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

        // ── Título ────────────────────────────────────────────────────────────
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:6px; display:flex; align-items:center; justify-content:center; gap:10px; font-size:1.12rem;';
        const tIcon = document.createElement('i');
        tIcon.className = 'fas fa-sliders-h';
        tIcon.setAttribute('aria-hidden', 'true');
        tIcon.style.color = 'var(--primary)';
        titulo.appendChild(tIcon);
        titulo.appendChild(document.createTextNode(' Ajustar Valor'));

        // ── Subtítulo: nome da reserva ────────────────────────────────────────
        const subtitulo = document.createElement('div');
        subtitulo.style.cssText = 'text-align:center; color:var(--text-secondary); font-size:0.9rem; margin-bottom:14px;';
        subtitulo.appendChild(document.createTextNode('Reserva: '));
        const subStrong = document.createElement('strong');
        subStrong.textContent = String(meta.descricao || '');
        subtitulo.appendChild(subStrong);

        // ── Card: valor atual registrado ──────────────────────────────────────
        const cardAtual = document.createElement('div');
        cardAtual.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 14px; margin-bottom:14px; font-size:0.88rem;';
        const caLabel = document.createElement('span');
        caLabel.style.color = 'var(--text-secondary)';
        caLabel.textContent = 'Valor atual registrado';
        const caVal = document.createElement('strong');
        caVal.textContent = formatBRL(valorAtual);
        cardAtual.appendChild(caLabel);
        cardAtual.appendChild(caVal);

        // ── Seção: novo valor ─────────────────────────────────────────────────
        const secNovo = _secaoGlass('Valor real da reserva');

        const lblNovo = document.createElement('label');
        lblNovo.style.cssText = 'display:block; text-align:left; margin-bottom:6px; color:var(--text-secondary); font-weight:600; font-size:0.85rem;';
        lblNovo.textContent = '🎯 Novo valor:';
        const inpNovo = document.createElement('input');
        inpNovo.className = 'form-input'; inpNovo.id = 'ajusteValor';
        inpNovo.type = 'number'; inpNovo.step = '0.01'; inpNovo.min = '0'; inpNovo.max = '9999999';
        inpNovo.placeholder = 'Valor real da reserva (R$)';
        inpNovo.autocomplete = 'off';
        inpNovo.value = String(valorAtual);

        // Pré-visualização da diferença (atualiza ao digitar)
        const previewDiff = document.createElement('div');
        previewDiff.style.cssText = 'margin-top:10px; font-size:0.83rem; color:var(--text-muted); min-height:1.2em;';

        const _renderDiff = () => {
            const nv = parseFloat(inpNovo.value);
            if (!Number.isFinite(nv) || nv < 0) { previewDiff.textContent = ''; return; }
            const delta = parseFloat((nv - valorAtual).toFixed(2));
            while (previewDiff.firstChild) previewDiff.removeChild(previewDiff.firstChild);
            if (delta === 0) {
                previewDiff.style.color = 'var(--text-muted)';
                previewDiff.textContent = 'Sem alteração.';
            } else {
                const up = delta > 0;
                previewDiff.style.color = up ? '#00ff99' : '#ff4b4b';
                previewDiff.textContent = `${up ? '▲ Aumento de ' : '▼ Redução de '}${formatBRL(Math.abs(delta))}`;
            }
        };
        inpNovo.addEventListener('input', _renderDiff);

        secNovo.appendChild(lblNovo);
        secNovo.appendChild(inpNovo);
        secNovo.appendChild(previewDiff);

        // ── Nota informativa ──────────────────────────────────────────────────
        const nota = document.createElement('div');
        nota.style.cssText = 'background:rgba(255,209,102,0.1); border-left:3px solid #ffd166; border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:0.82rem; color:var(--text-secondary); line-height:1.5;';
        const notaIcon = document.createElement('i');
        notaIcon.className = 'fas fa-info-circle';
        notaIcon.setAttribute('aria-hidden', 'true');
        notaIcon.style.cssText = 'color:#ffd166; margin-right:6px;';
        nota.appendChild(notaIcon);
        nota.appendChild(document.createTextNode('Use para corrigir o valor da reserva quando ele estiver diferente do real. Isto NÃO movimenta seu saldo do dashboard — apenas acerta o valor desta reserva.'));

        // ── Botões ────────────────────────────────────────────────────────────
        const rowBtns = document.createElement('div');
        rowBtns.style.cssText = 'display:flex; gap:10px;';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar'; btnCancelar.type = 'button';
        btnCancelar.style.flex = '1'; btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        const btnOk = document.createElement('button');
        btnOk.className = 'btn-primary'; btnOk.type = 'button';
        btnOk.style.cssText = 'flex:2; display:flex; align-items:center; justify-content:center; gap:6px;';
        const iOk = document.createElement('i');
        iOk.className = 'fas fa-check'; iOk.setAttribute('aria-hidden', 'true');
        btnOk.appendChild(iOk);
        btnOk.appendChild(document.createTextNode('Ajustar Valor'));

        btnOk.addEventListener('click', () => {
            const novoStr = inpNovo.value;
            const novoNum = parseFloat(novoStr);
            if (novoStr === '' || !Number.isFinite(novoNum) || novoNum < 0) {
                return _ctx.mostrarNotificacao('Digite um valor válido (R$ 0,00 ou mais).', 'error');
            }
            if (novoNum > 9_999_999) {
                return _ctx.mostrarNotificacao('Valor muito alto (máx. R$ 9.999.999,00).', 'error');
            }
            const novoValor = parseFloat(novoNum.toFixed(2));
            if (!Number.isFinite(novoValor) || novoValor < 0) {
                return _ctx.mostrarNotificacao('Valor inválido após processamento.', 'error');
            }

            const valorAnterior = parseFloat(Number(meta.saved || 0).toFixed(2));
            const delta = parseFloat((novoValor - valorAnterior).toFixed(2));
            if (delta === 0) {
                _ctx.fecharPopup();
                return _ctx.mostrarNotificacao('Nenhuma alteração no valor da reserva.', 'info');
            }

            // ── Aplica o ajuste (reconciliação — sem transação) ──────────────
            meta.saved = novoValor;

            const dh = _ctx.agoraDataHora();
            if (!Array.isArray(meta.historicoAjustes)) meta.historicoAjustes = [];
            meta.historicoAjustes.push({
                data:           dh.data,
                hora:           dh.hora,
                valorAnterior,
                valorNovo:      novoValor,
                delta,
            });

            _ctx.salvarDados();
            _ctx.atualizarTudo();
            renderMetaVisual();
            _ctx.fecharPopup();

            const sinal = delta > 0 ? 'aumentado' : 'reduzido';
            _ctx.mostrarNotificacao(
                `Reserva "${meta.descricao}" ${sinal} para ${formatBRL(novoValor)}.`,
                'success'
            );
        });

        rowBtns.appendChild(btnCancelar);
        rowBtns.appendChild(btnOk);

        // ── Montagem ──────────────────────────────────────────────────────────
        wrapper.appendChild(titulo);
        wrapper.appendChild(subtitulo);
        wrapper.appendChild(cardAtual);
        wrapper.appendChild(secNovo);
        wrapper.appendChild(nota);
        wrapper.appendChild(rowBtns);
        popup.appendChild(wrapper);
    });
}

// ========== ANÁLISE DE DISCIPLINA FINANCEIRA NAS RETIRADAS ==========
function analisarDisciplinaRetiradas(metaId) {
    const meta = _ctx.metas.find(m => String(m.id) === String(metaId));
    if(!meta || !meta.historicoRetiradas || meta.historicoRetiradas.length === 0) {
        return {
            temDados: false,
            mensagem: 'Nenhuma retirada registrada ainda.'
        };
    }
    
    const retiradas = meta.historicoRetiradas;
    const totalRetiradas = retiradas.length;
    const valorTotalRetirado = retiradas.reduce((sum, r) => sum + Number(r.valor), 0);
    
    const motivosCategorias = {
        emergencia: ['Emergência Médica', 'Emergência Familiar', 'Reparo Urgente', 'Dívida Urgente'],
        planejado: ['Compra Planejada', 'Viagem', 'Educação'],
        investimento: ['Investimento', 'Oportunidade']
    };
    
    let countEmergencia = 0;
    let countPlanejado = 0;
    let countInvestimento = 0;
    let countOutros = 0;
    
    retiradas.forEach(r => {
        // ✅ CORREÇÃO: type guard — garante que motivo é string antes de chamar .includes()
        //    Sem isso, r.motivo undefined/null lança TypeError silencioso
        const motivo = typeof r.motivo === 'string' ? r.motivo : '';
        if(motivosCategorias.emergencia.some(m => motivo.includes(m))) {
            countEmergencia++;
        } else if(motivosCategorias.planejado.some(m => motivo.includes(m))) {
            countPlanejado++;
        } else if(motivosCategorias.investimento.some(m => motivo.includes(m))) {
            countInvestimento++;
        } else {
            countOutros++;
        }
    });
    
    const percEmergencia = ((countEmergencia / totalRetiradas) * 100).toFixed(1);
    const percPlanejado = ((countPlanejado / totalRetiradas) * 100).toFixed(1);
    const percInvestimento = ((countInvestimento / totalRetiradas) * 100).toFixed(1);
    const percOutros = ((countOutros / totalRetiradas) * 100).toFixed(1);
    
    // ── Score numérico de disciplina (0–100) ────────────────────────────────
    //    ⚠️ percXxx vêm de toFixed() → são STRINGS. Converter antes de qualquer
    //    soma/comparação, senão "40.0"+"20.0" vira concatenação ("40.020.0").
    const nEmerg = Number(percEmergencia)   || 0;
    const nPlan  = Number(percPlanejado)    || 0;
    const nInv   = Number(percInvestimento) || 0;
    const nOut   = Number(percOutros)       || 0;

    // Planejado/Investimento = uso intencional (peso cheio); Emergência = neutro;
    // Outros (impulso / não categorizado) = quase sem crédito.
    const score = Math.round(Math.min(100, Math.max(0,
        nPlan * 1.0 + nInv * 1.0 + nEmerg * 0.4 + nOut * 0.15
    )));

    let nivelDisciplina, corDisciplina;
    if      (score >= 70) { nivelDisciplina = 'Excelente';          corDisciplina = '#00ff99'; }
    else if (score >= 45) { nivelDisciplina = 'Boa';                corDisciplina = '#00ff99'; }
    else if (score >= 25) { nivelDisciplina = 'Pode Melhorar';      corDisciplina = '#ffd166'; }
    else                  { nivelDisciplina = 'Atenção Necessária'; corDisciplina = '#ff4b4b'; }

    // Mensagem contextual — detecta o padrão dominante das retiradas
    let mensagemDisciplina;
    if (nEmerg > 50) {
        mensagemDisciplina = 'Boa parte das retiradas foi por emergência. Vale manter um fundo de emergência separado para não comprometer esta reserva.';
    } else if (nPlan + nInv >= 50) {
        mensagemDisciplina = 'Excelente! Você usa suas reservas de forma planejada e intencional. Continue assim.';
    } else if (nOut > 40) {
        mensagemDisciplina = 'Muitas retiradas sem um motivo planejado. Definir o propósito antes de retirar ajuda a manter a disciplina.';
    } else {
        mensagemDisciplina = 'Você mantém um equilíbrio razoável no uso das suas reservas.';
    }

    // ── Métricas avançadas ──────────────────────────────────────────────────
    const valores       = retiradas.map(r => Number(r.valor) || 0);
    const retiradaMedia = totalRetiradas > 0 ? valorTotalRetirado / totalRetiradas : 0;
    const maiorRetirada = valores.length ? Math.max(...valores) : 0;

    // Datas em pt-BR ("DD/MM/AAAA") → cadência e tempo desde a última retirada
    function _parseDataBR(s) {
        if (typeof s !== 'string') return null;
        const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) return null;
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        return isNaN(d.getTime()) ? null : d;
    }
    const MS_DIA = 86400000;
    const datas  = retiradas.map(r => _parseDataBR(r.data)).filter(Boolean).sort((a, b) => a - b);

    let cadenciaDias = null;
    if (datas.length >= 2) {
        const span = (datas[datas.length - 1] - datas[0]) / MS_DIA;
        cadenciaDias = Math.max(1, Math.round(span / (datas.length - 1)));
    }
    let diasDesdeUltima = null;
    if (datas.length) {
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        diasDesdeUltima = Math.max(0, Math.round((hoje - datas[datas.length - 1]) / MS_DIA));
    }

    // Impacto acumulado das retiradas sobre o objetivo da meta
    const objetivoMeta = Number(meta.objetivo) || 0;
    const impactoObjetivoPerc = objetivoMeta > 0
        ? Math.round((valorTotalRetirado / objetivoMeta) * 100)
        : null;

    return {
        temDados: true,
        totalRetiradas: totalRetiradas,
        valorTotalRetirado: valorTotalRetirado,
        distribuicao: {
            emergencia: { count: countEmergencia, perc: percEmergencia },
            planejado: { count: countPlanejado, perc: percPlanejado },
            investimento: { count: countInvestimento, perc: percInvestimento },
            outros: { count: countOutros, perc: percOutros }
        },
        score: score,
        nivelDisciplina: nivelDisciplina,
        corDisciplina: corDisciplina,
        mensagemDisciplina: mensagemDisciplina,
        retiradaMedia: retiradaMedia,
        maiorRetirada: maiorRetirada,
        cadenciaDias: cadenciaDias,
        diasDesdeUltima: diasDesdeUltima,
        impactoObjetivoPerc: impactoObjetivoPerc,
        ultimaRetirada: retiradas[retiradas.length - 1]
    };
}

// ========== POPUP DE ANÁLISE DE DISCIPLINA ==========
function abrirAnaliseDisciplina(metaId) {
    const meta = _ctx.metas.find(m => String(m.id) === String(metaId));
    if (!meta) return;

    const analise = analisarDisciplinaRetiradas(metaId);

    if (!analise.temDados) {
        _ctx.criarPopup(`
            <h3>📊 Análise de Disciplina</h3>
            <div style="text-align:center; padding:40px;">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">📭</div>
                <div style="color: var(--text-secondary);" id="textoSemDados"></div>
            </div>
            <button class="btn-primary" id="btnFecharSemDados">Fechar</button>
        `);
        document.getElementById('textoSemDados').textContent = analise.mensagem;
        document.getElementById('btnFecharSemDados').addEventListener('click', _ctx.fecharPopup);
        return;
    }

    // ✅ Todos os valores numéricos calculados internamente — sem dado do usuário
    const CORES_PERMITIDAS_DISCIPLINA = new Set(['#ff4b4b', '#00ff99', '#ffd166']);
    const corSegura = CORES_PERMITIDAS_DISCIPLINA.has(analise.corDisciplina)
        ? analise.corDisciplina
        : '#ffd166';

    const distEmergPerc  = Number(analise.distribuicao.emergencia.perc)    || 0;
    const distPlanPerc   = Number(analise.distribuicao.planejado.perc)     || 0;
    const distInvPerc    = Number(analise.distribuicao.investimento.perc)  || 0;
    const distOutPerc    = Number(analise.distribuicao.outros.perc)        || 0;

    // ✅ Estrutura estática — zero dados do usuário no HTML do criarPopup
    _ctx.criarPopupDOM((popup) => {

        // ── Wrapper scroll
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'max-height:70vh; overflow-y:auto; padding-right:10px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align:center; margin-bottom:8px;';
        titulo.textContent = '📊 Análise de Disciplina Financeira';

        // ── Subtítulo com nome da meta
        const subtitulo = document.createElement('div');
        subtitulo.style.cssText = 'text-align:center; color:var(--text-secondary); margin-bottom:20px; font-size:0.9rem;';
        const subtituloLabel = document.createElement('span');
        subtituloLabel.textContent = 'Meta: ';
        const subtituloValor = document.createElement('strong');
        subtituloValor.textContent = String(meta.descricao || ''); // ✅ textContent
        subtitulo.appendChild(subtituloLabel);
        subtitulo.appendChild(subtituloValor);

        // ── Hero: anel de score (gauge SVG) + chip de nível ──────────────────
        // ✅ Score é numérico interno; re-clamp defensivo antes de renderizar
        const scoreSeguro = Math.max(0, Math.min(100, Math.round(Number(analise.score) || 0)));

        function _criarRingScore(valor, cor) {
            const NS = 'http://www.w3.org/2000/svg';
            const size = 140, raio = 58, centro = size / 2;
            const C = 2 * Math.PI * raio;
            const prog = Math.max(0, Math.min(100, Number(valor) || 0));

            const box = document.createElement('div');
            box.style.cssText = `position:relative; width:${size}px; height:${size}px; margin:0 auto;`;

            const svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('width', String(size));
            svg.setAttribute('height', String(size));
            svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
            svg.style.transform = 'rotate(-90deg)';

            const track = document.createElementNS(NS, 'circle');
            track.setAttribute('cx', String(centro));
            track.setAttribute('cy', String(centro));
            track.setAttribute('r', String(raio));
            track.setAttribute('fill', 'none');
            track.setAttribute('stroke', 'rgba(255,255,255,0.08)');
            track.setAttribute('stroke-width', '11');

            const arco = document.createElementNS(NS, 'circle');
            arco.setAttribute('cx', String(centro));
            arco.setAttribute('cy', String(centro));
            arco.setAttribute('r', String(raio));
            arco.setAttribute('fill', 'none');
            arco.setAttribute('stroke', cor); // ✅ cor da whitelist CORES_PERMITIDAS_DISCIPLINA
            arco.setAttribute('stroke-width', '11');
            arco.setAttribute('stroke-linecap', 'round');
            arco.setAttribute('stroke-dasharray', `0 ${C}`);
            arco.style.transition = 'stroke-dasharray 0.9s cubic-bezier(0.22,1,0.36,1)';

            svg.appendChild(track);
            svg.appendChild(arco);

            // Anima o preenchimento após o primeiro paint (double rAF)
            requestAnimationFrame(() => requestAnimationFrame(() => {
                arco.setAttribute('stroke-dasharray', `${(prog / 100) * C} ${C}`);
            }));

            const miolo = document.createElement('div');
            miolo.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;';
            const num = document.createElement('div');
            num.style.cssText = `font-size:2.6rem; font-weight:800; line-height:1; color:${cor};`;
            num.textContent = String(prog); // ✅ numérico
            const den = document.createElement('div');
            den.style.cssText = 'font-size:0.72rem; letter-spacing:0.5px; color:var(--text-secondary); margin-top:3px; text-transform:uppercase;';
            den.textContent = 'de 100';
            miolo.appendChild(num);
            miolo.appendChild(den);

            box.appendChild(svg);
            box.appendChild(miolo);
            return box;
        }

        const hero = document.createElement('div');
        hero.style.cssText = 'background:linear-gradient(160deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01)); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:24px 20px; margin-bottom:16px; text-align:center;';

        const heroLabel = document.createElement('div');
        heroLabel.style.cssText = 'font-size:0.78rem; letter-spacing:0.5px; text-transform:uppercase; color:var(--text-secondary); margin-bottom:14px;';
        heroLabel.textContent = 'Nível de Disciplina';

        const ring = _criarRingScore(scoreSeguro, corSegura);

        const chipNivel = document.createElement('div');
        chipNivel.style.cssText = `display:inline-block; margin:16px 0 0; padding:6px 16px; border-radius:999px; font-weight:700; font-size:0.95rem; color:${corSegura}; background:${corSegura}1f; border:1px solid ${corSegura}44;`;
        chipNivel.textContent = String(analise.nivelDisciplina || ''); // ✅ textContent

        const mensagemNivel = document.createElement('div');
        mensagemNivel.style.cssText = 'font-size:0.88rem; color:var(--text-secondary); line-height:1.55; margin:12px auto 0; max-width:360px;';
        mensagemNivel.textContent = String(analise.mensagemDisciplina || ''); // ✅ textContent

        hero.appendChild(heroLabel);
        hero.appendChild(ring);
        hero.appendChild(chipNivel);
        hero.appendChild(mensagemNivel);

        // ── Grid de estatísticas (com ícones) ────────────────────────────────
        // corValor restrita a literais seguros / var() — nunca dado do usuário
        function _criarStatCard(icone, rotulo, valor, corValor) {
            const card = document.createElement('div');
            card.style.cssText = 'background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); padding:14px; border-radius:12px;';
            const topo = document.createElement('div');
            topo.style.cssText = 'font-size:0.78rem; color:var(--text-secondary); margin-bottom:8px; display:flex; align-items:center; gap:6px;';
            const ic = document.createElement('span'); ic.textContent = icone;
            const rt = document.createElement('span'); rt.textContent = rotulo;
            topo.appendChild(ic); topo.appendChild(rt);
            const v = document.createElement('div');
            v.style.cssText = `font-size:1.3rem; font-weight:700; color:${corValor || 'var(--text-primary)'};`;
            v.textContent = valor; // ✅ textContent — valores numéricos/formatBRL
            card.appendChild(topo);
            card.appendChild(v);
            return card;
        }

        const gridTotais = document.createElement('div');
        gridTotais.style.cssText = 'display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin-bottom:16px;';
        gridTotais.appendChild(_criarStatCard('🔢', 'Retiradas',      String(Number(analise.totalRetiradas) || 0)));
        gridTotais.appendChild(_criarStatCard('💸', 'Total retirado', _ctx.formatBRL(analise.valorTotalRetirado), '#ff4b4b'));
        gridTotais.appendChild(_criarStatCard('📊', 'Média/retirada', _ctx.formatBRL(analise.retiradaMedia)));
        gridTotais.appendChild(_criarStatCard('⬆️', 'Maior retirada', _ctx.formatBRL(analise.maiorRetirada)));

        // ── Insights dinâmicos (texto derivado apenas de números internos) ───
        const insightsDados = [];
        if (analise.cadenciaDias != null && Number(analise.totalRetiradas) >= 2) {
            insightsDados.push(['📅', `Em média, uma retirada a cada ${analise.cadenciaDias} dia(s).`]);
        }
        if (analise.diasDesdeUltima != null) {
            insightsDados.push(analise.diasDesdeUltima === 0
                ? ['🕐', 'Sua última retirada foi hoje.']
                : ['🕐', `Há ${analise.diasDesdeUltima} dia(s) sem retiradas — mantenha o ritmo!`]);
        }
        if (analise.impactoObjetivoPerc != null) {
            insightsDados.push(['🎯', `As retiradas equivalem a ${analise.impactoObjetivoPerc}% do objetivo desta meta.`]);
        }

        let cardInsights = null;
        if (insightsDados.length) {
            cardInsights = document.createElement('div');
            cardInsights.style.cssText = 'background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:16px; margin-bottom:16px;';
            const tituloIns = document.createElement('div');
            tituloIns.style.cssText = 'font-weight:600; color:var(--text-primary); margin-bottom:10px;';
            tituloIns.textContent = '💡 Insights';
            cardInsights.appendChild(tituloIns);
            insightsDados.forEach(([ic, txt]) => {
                const linha = document.createElement('div');
                linha.style.cssText = 'display:flex; gap:8px; align-items:flex-start; font-size:0.88rem; color:var(--text-secondary); line-height:1.5; margin-bottom:7px;';
                const sIc = document.createElement('span'); sIc.textContent = ic;
                const sTx = document.createElement('span'); sTx.textContent = txt; // ✅ texto derivado de números
                linha.appendChild(sIc); linha.appendChild(sTx);
                cardInsights.appendChild(linha);
            });
        }

        // ── Distribuição por motivo
        const secaoDistribuicao = document.createElement('div');
        secaoDistribuicao.style.cssText = 'background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:16px; margin-bottom:16px;';

        const tituloDistribuicao = document.createElement('div');
        tituloDistribuicao.style.cssText = 'font-weight:600; margin-bottom:14px; color:var(--text-primary);';
        tituloDistribuicao.textContent = '📋 Distribuição por Motivo';
        secaoDistribuicao.appendChild(tituloDistribuicao);

        // ✅ Helper interno para criar barra de distribuição — zero dado do usuário
        function _criarBarraDistribuicao(rotulo, count, perc, cor) {
            if (count <= 0) return null;
            const container = document.createElement('div');
            container.style.marginBottom = '12px';

            const rowLabel = document.createElement('div');
            rowLabel.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px;';

            const spanRotulo = document.createElement('span');
            spanRotulo.style.color = 'var(--text-primary)';
            spanRotulo.textContent = rotulo; // ✅ texto estático — nunca dado do usuário

            const spanCount = document.createElement('span');
            spanCount.style.color = 'var(--text-secondary)';
            spanCount.textContent = `${count} (${perc}%)`; // ✅ valores numéricos internos

            rowLabel.appendChild(spanRotulo);
            rowLabel.appendChild(spanCount);

            const barContainer = document.createElement('div');
            barContainer.style.cssText = 'width:100%; height:8px; background:rgba(255,255,255,0.08); border-radius:999px; overflow:hidden;';

            const barFill = document.createElement('div');
            barFill.style.width        = `${perc}%`;
            barFill.style.height       = '100%';
            barFill.style.background    = cor;
            barFill.style.borderRadius  = '999px';
            barFill.style.transition    = 'width 0.7s cubic-bezier(0.22,1,0.36,1)';

            barContainer.appendChild(barFill);
            container.appendChild(rowLabel);
            container.appendChild(barContainer);
            return container;
        }

        const barEmerg = _criarBarraDistribuicao(
            '🚨 Emergências',
            analise.distribuicao.emergencia.count,
            distEmergPerc,
            '#ff4b4b'
        );
        if (barEmerg) secaoDistribuicao.appendChild(barEmerg);

        const barPlan = _criarBarraDistribuicao(
            '🎯 Compras Planejadas',
            analise.distribuicao.planejado.count,
            distPlanPerc,
            '#00ff99'
        );
        if (barPlan) secaoDistribuicao.appendChild(barPlan);

        const barInv = _criarBarraDistribuicao(
            '📈 Investimentos',
            analise.distribuicao.investimento.count,
            distInvPerc,
            '#6c63ff'
        );
        if (barInv) secaoDistribuicao.appendChild(barInv);

        const barOut = _criarBarraDistribuicao(
            '📄 Outros',
            analise.distribuicao.outros.count,
            distOutPerc,
            '#ffd166'
        );
        if (barOut) secaoDistribuicao.appendChild(barOut);

        // ── Card última retirada
        const cardUltima = document.createElement('div');
        cardUltima.style.cssText = 'background:rgba(108,99,255,0.1); padding:14px; border-radius:12px; border-left:3px solid #6c63ff;';

        const tituloUltima = document.createElement('div');
        tituloUltima.style.cssText = 'font-weight:600; color:var(--text-primary); margin-bottom:8px;';
        tituloUltima.textContent = '🕐 Última Retirada';

        const gridUltima = document.createElement('div');
        gridUltima.style.cssText = 'display:grid; gap:6px; font-size:0.9rem; color:var(--text-secondary);';

        function _criarLinhaDetalhe(rotulo, valor) {
            const div = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = rotulo; // ✅ texto estático
            div.appendChild(strong);
            div.appendChild(document.createTextNode(String(valor || ''))); // ✅ createTextNode — nunca innerHTML
            return div;
        }

        gridUltima.appendChild(_criarLinhaDetalhe('Data: ', analise.ultimaRetirada.data));
        gridUltima.appendChild(_criarLinhaDetalhe('Valor: ', _ctx.formatBRL(analise.ultimaRetirada.valor)));
        gridUltima.appendChild(_criarLinhaDetalhe('Motivo: ', analise.ultimaRetirada.motivo)); // ✅ createTextNode

        cardUltima.appendChild(tituloUltima);
        cardUltima.appendChild(gridUltima);

        // ── Histórico completo — 100% via DOM, zero innerHTML com dados do usuário
        const secaoHistorico = document.createElement('div');
        secaoHistorico.style.cssText = 'background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:16px; margin-top:16px;';

        const tituloHistorico = document.createElement('div');
        tituloHistorico.style.cssText = 'font-weight:600; margin-bottom:12px; color:var(--text-primary);';
        tituloHistorico.textContent = '📜 Histórico Completo';

        const listaHistorico = document.createElement('div');
        listaHistorico.style.cssText = 'max-height:200px; overflow-y:auto;';

        meta.historicoRetiradas
            .slice()
            .reverse()
            .forEach(r => {
                // ✅ Validação defensiva de cada item antes de renderizar
                if (!r || typeof r !== 'object') return;

                const item = document.createElement('div');
                item.style.cssText = 'background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; margin-bottom:8px; border-left:2px solid var(--border);';

                const rowTopo = document.createElement('div');
                rowTopo.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:4px;';

                const spanData = document.createElement('span');
                spanData.style.cssText = 'font-size:0.85rem; color:var(--text-secondary);';
                spanData.textContent = String(r.data || ''); // ✅ textContent

                const spanValor = document.createElement('span');
                spanValor.style.cssText = 'font-size:0.9rem; font-weight:600; color:#ff4b4b;';
                spanValor.textContent = _ctx.formatBRL(Number(r.valor) || 0); // ✅ textContent

                rowTopo.appendChild(spanData);
                rowTopo.appendChild(spanValor);

                const rowMotivo = document.createElement('div');
                rowMotivo.style.cssText = 'font-size:0.85rem; color:var(--text-primary);';

                const strongMotivo = document.createElement('strong');
                strongMotivo.textContent = 'Motivo: '; // ✅ texto estático

                const spanMotivo = document.createElement('span');
                spanMotivo.textContent = String(r.motivo || ''); // ✅ textContent — DADO DO USUÁRIO, nunca innerHTML

                rowMotivo.appendChild(strongMotivo);
                rowMotivo.appendChild(spanMotivo);

                item.appendChild(rowTopo);
                item.appendChild(rowMotivo);
                listaHistorico.appendChild(item);
            });

        secaoHistorico.appendChild(tituloHistorico);
        secaoHistorico.appendChild(listaHistorico);

        // ── Botão fechar
        const btnFechar = document.createElement('button');
        btnFechar.className   = 'btn-primary';
        btnFechar.style.cssText = 'width:100%; margin-top:16px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', _ctx.fecharPopup);

        // ── Montagem final
        wrapper.appendChild(titulo);
        wrapper.appendChild(subtitulo);
        wrapper.appendChild(hero);
        wrapper.appendChild(gridTotais);
        if (cardInsights) wrapper.appendChild(cardInsights);
        wrapper.appendChild(secaoDistribuicao);
        wrapper.appendChild(cardUltima);
        wrapper.appendChild(secaoHistorico);

        popup.appendChild(wrapper);
        popup.appendChild(btnFechar);
    });
}

// Expor função globalmente
window.abrirAnaliseDisciplina = abrirAnaliseDisciplina;

// BANCO_ABREV, BANCO_COR e BANCO_ICON são constantes de dashboard.js,
// acessíveis via _ctx.BANCO_ABREV, _ctx.BANCO_COR e _ctx.BANCO_ICON.

