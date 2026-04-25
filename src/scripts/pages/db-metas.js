// db-metas.js — Seção de Metas/Reservas (lazy-loaded)
let _ctx = null;

// Proxies para utilitários de dashboard.js disponíveis via _ctx após init()
const formatBRL     = (...a) => _ctx.formatBRL(...a);
const _sanitizeText = (...a) => _ctx._sanitizeText(...a);

export function init(ctx) {
    _ctx = ctx;
    window._dbMetas = { renderMetasList };
    window.abrirMetaForm          = (id) => abrirMetaForm(id);
    window.removerMeta            = (id) => removerMeta(id);
    window.selecionarMeta         = (id) => selecionarMeta(id);
    window.abrirRetiradaForm      = (id) => abrirRetiradaForm(id);
    window.abrirAnaliseDisciplina = () => abrirAnaliseDisciplina();
    window.renderMetaVisual       = () => renderMetaVisual();
    renderMetasList();

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
        rowCdiTaxa.appendChild(inpCdiPct); rowCdiTaxa.appendChild(spanCdiPct);

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

        // Funções de cálculo financeiro (usadas também no clique)
        function fvComposto(pv, pmt, r, n) {
            if (r <= 0) return pv + pmt * n;
            return pv * Math.pow(1 + r, n) + pmt * (Math.pow(1 + r, n) - 1) / r;
        }
        function mesesParaMeta(pv, obj, pmt, r) {
            for (let n = 1; n <= 600; n++) {
                if (fvComposto(pv, pmt, r, n) >= obj) return n;
            }
            return null;
        }
        function aporteNecessario(pv, obj, r, n) {
            if (n <= 0) return null;
            const fv = obj - pv * Math.pow(1 + r, n);
            if (r <= 0) return fv / n;
            const fator = Math.pow(1 + r, n) - 1;
            if (fator <= 0) return null;
            return fv * r / fator;
        }

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
                const taxaAnual = 10.5 * pct / 100;
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

            let mesesPrazo = null;
            if (prazoM && prazoA) {
                const hoje = new Date();
                const dt   = new Date(parseInt(prazoA), parseInt(prazoM) - 1, 1);
                mesesPrazo = Math.max(1, Math.round((dt - hoje) / (1000 * 60 * 60 * 24 * 30.44)));
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

            if (!desc)                                                              return alert('Digite o nome da reserva.');
            if (desc.length > 200)                                                  return alert('Nome muito longo (máx. 200 caracteres).');
            if (!objStr || !Number.isFinite(Number(objStr)) || Number(objStr) <= 0) return alert('Digite um objetivo válido.');

            const objetivo = parseFloat(parseFloat(objStr).toFixed(2));
            if (!Number.isFinite(objetivo) || objetivo <= 0) return alert('Digite um objetivo válido.');

            // Prazo
            const prazoMV = document.getElementById('metaPrazoMes').value;
            const prazoAV = document.getElementById('metaPrazoAno').value;
            const prazo   = (prazoMV && prazoAV) ? `${prazoMV}/${prazoAV}` : null;

            // Rendimentos
            const tipoR = document.querySelector('input[name="tipoRend"]:checked')?.value || 'sem_rendimento';
            let taxaJuros = null, rendimentoPeriodo = null, cdiPct = null;

            if (tipoR === 'cdi') {
                const pct = parseFloat(document.getElementById('metaCdiPct').value);
                if (!Number.isFinite(pct) || pct <= 0 || pct > 200) return alert('Digite uma porcentagem válida do CDI (1–200).');
                cdiPct = pct;
                rendimentoPeriodo = document.querySelector('input[name="periodoRendCdi"]:checked')?.value || 'mes';
                const taxaAnual = 10.5 * pct / 100;
                taxaJuros = rendimentoPeriodo === 'ano'
                    ? parseFloat(((Math.pow(1 + taxaAnual / 100, 1/12) - 1) * 100).toFixed(6))
                    : parseFloat((taxaAnual / 12).toFixed(6));
            } else if (tipoR === 'personalizado') {
                const pct = parseFloat(document.getElementById('metaPersPct').value);
                if (!Number.isFinite(pct) || pct < 0 || pct > 999) return alert('Digite uma taxa válida (0–999).');
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
                if (!Number.isFinite(valorAporte) || valorAporte <= 0) return alert('Digite um valor de aporte válido.');
            }

            if (isEdit) {
                meta.descricao        = desc;
                meta.objetivo         = objetivo;
                meta.prazo            = prazo;
                meta.tipoRendimento   = tipoR;
                meta.taxaJuros        = taxaJuros;
                meta.cdiPct           = cdiPct;
                meta.rendimentoPeriodo = rendimentoPeriodo;
                meta.aporteRecorrente = aporteRecorrente;
                meta.valorAporte      = valorAporte;
            } else {
                const novoId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                _ctx.metas.push({
                    id: novoId, descricao: desc, objetivo, saved: 0, monthly: {},
                    prazo, tipoRendimento: tipoR, taxaJuros, cdiPct,
                    rendimentoPeriodo, aporteRecorrente, valorAporte,
                });

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
        wrapper.appendChild(secPrazo);
        wrapper.appendChild(secRend);
        wrapper.appendChild(secAporte);
        wrapper.appendChild(btnSimular);
        wrapper.appendChild(secProj);
        wrapper.appendChild(rowBtns);
        popup.appendChild(wrapper);
    });
}

const _META_POR_PAGINA = 5;
let _metaPagina = 1;

function _metaIconClass(m) {
    if (String(m.id) === 'emergency') return 'fa-shield-alt';
    if (m.tipoRendimento && m.tipoRendimento !== 'sem_rendimento') return 'fa-chart-line';
    return 'fa-piggy-bank';
}

function renderMetasList() {
    const cont = document.getElementById('listaMetas');
    if (!cont) return;

    const searchVal  = (document.getElementById('metaSearchInput')?.value  || '').toLowerCase();
    const statusVal  = (document.getElementById('metaStatusFilter')?.value || '');

    cont.innerHTML = '';

    if (_ctx.metas.length === 0) {
        const p       = document.createElement('p');
        p.className   = 'empty-state';
        p.textContent = 'Nenhuma reserva criada.';
        cont.appendChild(p);
        return;
    }

    const filtradas = _ctx.metas.filter(m => {
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
        const iconI = document.createElement('i');
        iconI.className = `fas ${_metaIconClass(m)}`;
        iconI.setAttribute('aria-hidden', 'true');
        iconWrap.appendChild(iconI);

        const colInfo = document.createElement('div');
        colInfo.className = 'meta-item-info';

        const strongDesc       = document.createElement('strong');
        strongDesc.textContent = _ctx._sanitizeText(m.descricao);

        const divValores       = document.createElement('div');
        divValores.className   = 'meta-item-valores';
        divValores.textContent = `${formatBRL(saved)} de ${formatBRL(objetivo)}`;

        colInfo.appendChild(strongDesc);
        colInfo.appendChild(divValores);

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
}

function removerMeta(id) {
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
    atualizarHeaderReservas();
}

function selecionarMeta(id) {
    _ctx.metaSelecionadaId = id;
    renderMetaVisual();
    const btnRetirar = document.getElementById('btnRetirar');
    if(btnRetirar) btnRetirar.style.display = 'block';
}

// ========== CÁLCULO DE PROJEÇÃO DE CONCLUSÃO DA META ==========
function calcularProjecaoConclusao(meta) {
    const saved = Number(meta.saved || 0);
    const objetivo = Number(meta.objetivo || 0);
    const falta = Math.max(0, objetivo - saved);
    
    // Se já atingiu a meta
    if(saved >= objetivo) {
        return {
            temHistorico: true,
            concluida: true,
            dataEstimada: '🎉 Meta Concluída!',
            mediaMensal: 0,
            mesesRestantes: 0,
            mesesComDados: 0
        };
    }
    
    // Calcular média mensal baseado no histórico
    const monthly = meta.monthly || {};
    const valoresHistorico = Object.values(monthly).filter(v => v > 0);
    
    // Precisa de pelo menos 2 meses com dados
    if(valoresHistorico.length < 2) {
        return {
            temHistorico: false,
            mesesComDados: valoresHistorico.length
        };
    }
    
    // Calcular média mensal
    const mediaMensal = valoresHistorico.reduce((sum, v) => sum + v, 0) / valoresHistorico.length;
    
    // Se a média é zero ou negativa, não há projeção
    if(mediaMensal <= 0) {
        return {
            temHistorico: false,
            mesesComDados: valoresHistorico.length
        };
    }
    
    // Calcular meses restantes
    const mesesRestantes = Math.ceil(falta / mediaMensal);
    
    // Calcular data estimada
    const hoje = new Date();
    const dataEstimada = new Date(hoje.getFullYear(), hoje.getMonth() + mesesRestantes, 1);
    const dataFormatada = dataEstimada.toLocaleDateString('pt-BR', { 
        month: 'long', 
        year: 'numeric' 
    });
    
    // Gerar sugestões e avisos
    let sugestao = null;
    let avisoAjuste = null;
    
    // Se a média é muito baixa (meta levará mais de 2 anos)
    if(mesesRestantes > 24) {
        avisoAjuste = 'No ritmo atual, esta meta levará mais de 2 anos. Considere aumentar o valor mensal.';
        const valorNecessario = Math.ceil(falta / 12); // Para concluir em 1 ano
        sugestao = `Guardando ${formatBRL(valorNecessario)}/mês, você conclui em aproximadamente 1 ano.`;
    }
    // Se está indo bem (menos de 6 meses)
    else if(mesesRestantes <= 6) {
        sugestao = 'Você está em um ótimo ritmo! Continue assim para alcançar sua meta em breve.';
    }
    // Ritmo moderado (6 a 12 meses)
    else if(mesesRestantes <= 12) {
        sugestao = 'Bom progresso! Mantenha a disciplina para concluir dentro do prazo estimado.';
    }
    // Ritmo lento (12 a 24 meses)
    else {
        const valorSugerido = Math.ceil(falta / 12);
        sugestao = `Para concluir em 1 ano, tente guardar ${formatBRL(valorSugerido)}/mês.`;
    }
    
    return {
        temHistorico: true,
        concluida: false,
        mediaMensal: mediaMensal,
        mesesRestantes: mesesRestantes,
        dataEstimada: dataFormatada.charAt(0).toUpperCase() + dataFormatada.slice(1),
        mesesComDados: valoresHistorico.length,
        sugestao: sugestao,
        avisoAjuste: avisoAjuste
    };
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
        const btnRetirar = document.getElementById('btnRetirar');
        if(btnRetirar) btnRetirar.style.display = 'none';
        return;
    }
    
    const meta = _ctx.metas.find(m => String(m.id) === String(_ctx.metaSelecionadaId));
    if(!meta) {
        details.innerHTML = '';
        const _notFound = document.createElement('div');
        _notFound.className = 'text-secondary';
        _notFound.textContent = 'Meta não encontrada';
        details.appendChild(_notFound);
        const btnRetirar = document.getElementById('btnRetirar');
        if(btnRetirar) btnRetirar.style.display = 'none';
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
    
    // Desenha gráfico de linha
    ctxLine.clearRect(0,0,line.width,line.height);
    const padding = 40;
    const w = line.width - padding*2, h = line.height - padding*2;
    
    const months = [];
    const points = [];
    const now = new Date();
    
    for(let i=11;i>=0;i--){
        const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
        const y = d.getFullYear();
        const m = d.getMonth()+1;
        const key = `${y}-${String(m).padStart(2,'0')}`;
        months.push({ key, label: d.toLocaleString('pt-BR', {month:'short'}), month: m });
    }
    
    const values = months.map(mk => Number(meta.monthly && meta.monthly[mk.key] ? meta.monthly[mk.key] : 0));
    const maxV = Math.max(...values, objetivo, 50);
    
    ctxLine.strokeStyle = '#ccc';
    ctxLine.lineWidth = 1;
    ctxLine.strokeRect(padding, padding, w, h);
    
    ctxLine.beginPath();
    values.forEach((v,i)=>{
        const x = padding + (i/(values.length-1)) * w;
        const y = padding + h - (v / maxV) * h;
        if(i === 0) ctxLine.moveTo(x, y);
        else ctxLine.lineTo(x, y);
        points.push({x,y,v,month:months[i].label, key: months[i].key});
    });
    ctxLine.strokeStyle = '#4da6ff';
    ctxLine.lineWidth = 2;
    ctxLine.stroke();
    
    points.forEach(p=>{
        ctxLine.beginPath();
        ctxLine.arc(p.x,p.y,4,0,Math.PI*2);
        ctxLine.fillStyle = '#fff';
        ctxLine.fill();
        ctxLine.beginPath();
        ctxLine.arc(p.x,p.y,3,0,Math.PI*2);
        ctxLine.fillStyle = '#4da6ff';
        ctxLine.fill();
    });
    
    line._points = points;
    
    ctxLine.fillStyle = '#ccc';
    ctxLine.font = '11px sans-serif';
    ctxLine.textAlign = 'center';
    points.forEach(p=>{
        ctxLine.fillText(p.month, p.x, padding + h + 16);
    });
    
    // ── Reconstrói details via DOM — zero dados do usuário em innerHTML
    details.innerHTML = '';

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
        subInsuf.textContent      = 'Continue guardando por mais alguns meses para calcular a projeção de conclusão.'; // ✅ texto estático

        colInsuf.appendChild(tituloInsuf);
        colInsuf.appendChild(subInsuf);
        rowInsuf.appendChild(iconInsuf);
        rowInsuf.appendChild(colInsuf);
        cardInsuf.appendChild(rowInsuf);
        details.appendChild(cardInsuf);
    }
    
    // ── Compound interest info if meta has taxaJuros
    if (meta.taxaJuros && meta.taxaJuros > 0) {
        const r = meta.taxaJuros / 100;
        const aporte = Number(meta.valorAporte || 0);
        const fvComposto = (pv, pmt, rate, n) =>
            rate <= 0 ? pv + pmt * n : pv * Math.pow(1 + rate, n) + pmt * (Math.pow(1 + rate, n) - 1) / rate;

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

        addRendRow('Taxa mensal', `${meta.taxaJuros.toFixed(4)}%`, '#00ff99');
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
    if(!_ctx.metaSelecionadaId) return alert('Selecione uma meta primeiro.');

    const meta = _ctx.metas.find(m => String(m.id) === String(_ctx.metaSelecionadaId));
    if(!meta) return alert('Meta não encontrada.');

    const saldoDisponivel = Number(meta.saved || 0);
    if(saldoDisponivel <= 0) return alert('Não há saldo disponível nesta reserva para retirar.');

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
        return alert('Digite um valor válido.');
        }
        if(!motivoSelect) {
            return alert('⚠️ Por favor, selecione o motivo da retirada.');
        }
        if(motivoSelect === 'Outro' && !outroMotivoTexto) {
            return alert('⚠️ Por favor, descreva o motivo da retirada.');
        }

        const valorRetirar = parseFloat(parseFloat(valorStr).toFixed(2));
        if(!Number.isFinite(valorRetirar) || valorRetirar <= 0) {
            return alert('Valor inválido após processamento.');
        }
        if(valorRetirar > saldoDisponivel) {
            return alert('Valor maior que o saldo disponível!');
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

        _ctx.salvarDados();
        _ctx.atualizarTudo();
        renderMetaVisual();
        _ctx.fecharPopup();

        let mensagemFinal = `Retirada de ${formatBRL(valorRetirar)} realizada com sucesso!\nO valor foi devolvido ao seu saldo.`;
        if(motivoFinal.includes('Emergência'))  mensagemFinal += '\n\n💙 Esperamos que tudo se resolva bem.';
        else if(motivoFinal.includes('Investimento')) mensagemFinal += '\n\n📈 Ótima escolha! Investir é construir seu futuro.';
        else if(motivoFinal.includes('Dívida'))      mensagemFinal += '\n\n💪 Parabéns por priorizar a quitação de dívidas!';

        alert(mensagemFinal);
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
    
    let nivelDisciplina = 'Boa';
    let corDisciplina = '#00ff99';
    let mensagemDisciplina = '';
    
    if(percEmergencia > 60) {
        nivelDisciplina = 'Atenção Necessária';
        corDisciplina = '#ff4b4b';
        mensagemDisciplina = 'Muitas retiradas por emergência podem indicar falta de um fundo de emergência separado.';
    } else if(percPlanejado + percInvestimento > 50) {
        nivelDisciplina = 'Excelente';
        corDisciplina = '#00ff99';
        mensagemDisciplina = 'Parabéns! Você está usando suas reservas de forma planejada e inteligente.';
    } else if(percOutros > 40) {
        nivelDisciplina = 'Pode Melhorar';
        corDisciplina = '#ffd166';
        mensagemDisciplina = 'Tente planejar melhor o uso das suas reservas para evitar retiradas não planejadas.';
    } else {
        mensagemDisciplina = 'Você mantém um bom equilíbrio no uso das suas reservas.';
    }
    
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
        nivelDisciplina: nivelDisciplina,
        corDisciplina: corDisciplina,
        mensagemDisciplina: mensagemDisciplina,
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

        // ── Card de nível de disciplina
        const cardNivel = document.createElement('div');
        cardNivel.style.background    = `linear-gradient(135deg, ${corSegura}20, ${corSegura}10)`;
        cardNivel.style.padding       = '20px';
        cardNivel.style.borderRadius  = '12px';
        cardNivel.style.marginBottom  = '20px';
        cardNivel.style.borderLeft    = `4px solid ${corSegura}`;
        cardNivel.style.textAlign     = 'center';

        const labelNivel = document.createElement('div');
        labelNivel.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;';
        labelNivel.textContent = 'Nível de Disciplina';

        const valorNivel = document.createElement('div');
        valorNivel.style.cssText = `font-size:1.8rem; font-weight:700; color:${corSegura}; margin-bottom:12px;`;
        valorNivel.textContent = String(analise.nivelDisciplina || ''); // ✅ textContent — valor interno calculado

        const mensagemNivel = document.createElement('div');
        mensagemNivel.style.cssText = 'font-size:0.9rem; color:var(--text-secondary); line-height:1.5;';
        mensagemNivel.textContent = String(analise.mensagemDisciplina || ''); // ✅ textContent — valor interno calculado

        cardNivel.appendChild(labelNivel);
        cardNivel.appendChild(valorNivel);
        cardNivel.appendChild(mensagemNivel);

        // ── Grid totais
        const gridTotais = document.createElement('div');
        gridTotais.style.cssText = 'display:grid; grid-template-columns:repeat(2,1fr); gap:12px; margin-bottom:20px;';

        const celulaRetiradas = document.createElement('div');
        celulaRetiradas.style.cssText = 'background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;';
        const labelRet = document.createElement('div');
        labelRet.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:6px;';
        labelRet.textContent = 'Total de Retiradas';
        const valorRet = document.createElement('div');
        valorRet.style.cssText = 'font-size:1.5rem; font-weight:700; color:var(--text-primary);';
        valorRet.textContent = String(Number(analise.totalRetiradas) || 0); // ✅ textContent — numérico
        celulaRetiradas.appendChild(labelRet);
        celulaRetiradas.appendChild(valorRet);

        const celulaValor = document.createElement('div');
        celulaValor.style.cssText = 'background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;';
        const labelVal = document.createElement('div');
        labelVal.style.cssText = 'font-size:0.85rem; color:var(--text-secondary); margin-bottom:6px;';
        labelVal.textContent = 'Valor Total Retirado';
        const valorVal = document.createElement('div');
        valorVal.style.cssText = 'font-size:1.5rem; font-weight:700; color:#ff4b4b;';
        valorVal.textContent = _ctx.formatBRL(analise.valorTotalRetirado); // ✅ textContent — formatBRL retorna numérico formatado
        celulaValor.appendChild(labelVal);
        celulaValor.appendChild(valorVal);

        gridTotais.appendChild(celulaRetiradas);
        gridTotais.appendChild(celulaValor);

        // ── Distribuição por motivo
        const secaoDistribuicao = document.createElement('div');
        secaoDistribuicao.style.marginBottom = '20px';

        const tituloDistribuicao = document.createElement('h4');
        tituloDistribuicao.style.cssText = 'margin-bottom:12px; color:var(--text-primary);';
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
            barContainer.style.cssText = 'width:100%; height:10px; background:rgba(255,255,255,0.1); border-radius:5px; overflow:hidden;';

            const barFill = document.createElement('div');
            barFill.style.width      = `${perc}%`;
            barFill.style.height     = '100%';
            barFill.style.background = cor;
            barFill.style.transition = 'width 0.5s';

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
        secaoHistorico.style.marginTop = '20px';

        const tituloHistorico = document.createElement('h4');
        tituloHistorico.style.cssText = 'margin-bottom:12px; color:var(--text-primary);';
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
        wrapper.appendChild(cardNivel);
        wrapper.appendChild(gridTotais);
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

