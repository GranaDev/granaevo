// db-transacoes.js — Seção de Transações (lazy-loaded)
let _ctx = null;

// Proxy para utilitários de dashboard.js disponíveis via _ctx após init()
const formatBRL = (...a) => _ctx.formatBRL(...a);

export function init(ctx) {
    _ctx = ctx;
    window._dbTransacoes = { atualizarMovimentacoesUI };
    window.lancarTransacao          = () => lancarTransacao();
    window.abrirDetalhesTransacao   = (t) => abrirDetalhesTransacao(t);
    window.atualizarTiposDinamicos  = () => atualizarTiposDinamicos();

    // Botão importar extrato — via addEventListener (CSP não permite inline onclick)
    const btnImport = document.getElementById('btnImportarExtrato');
    if (btnImport) {
        const newBtn = btnImport.cloneNode(true);
        btnImport.parentNode.replaceChild(newBtn, btnImport);
        newBtn.addEventListener('click', () => abrirImportarExtrato());
    }

    bindFiltrosMovimentacoes();
    renderizarOrcamentos();
    atualizarMovimentacoesUI();
}

// ========== TRANSAÇÕES ==========
function atualizarTiposDinamicos() {
    const cat = document.getElementById('selectCategoria').value;
    const tipoSelect = document.getElementById('selectTipo');
    tipoSelect.innerHTML = '';
    
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = cat ? (cat === 'reserva' ? 'Meta (reserva)' : 'Tipo') : 'Tipo';
    tipoSelect.appendChild(placeholder);
    
    if(cat === 'entrada') {
        ['Salário', 'Renda Extra', 'Outros Recebimentos'].forEach(x => {
            const o = document.createElement('option');
            o.value = x;
            o.textContent = x;
            tipoSelect.appendChild(o);
        });
    } else if(cat === 'saida' || cat === 'saida_credito') {
        const tiposPadrao = ['Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 'Beleza', 'Presente',
         'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte', 'Shopee', 'Mercado Livre',
         'Ifood', 'Amazon', 'Outros'];
        const personalizados = (_ctx.tiposPersonalizados || []).filter(t => typeof t === 'string' && t.trim());
        [...tiposPadrao, ...personalizados].forEach(x => {
            const o = document.createElement('option');
            o.value = x;
            o.textContent = x;
            tipoSelect.appendChild(o);
        });
    } else if(cat === 'reserva') {
        const metasExistentes = _ctx.metas.filter(m => m.id !== 'emergency');
        if(metasExistentes.length === 0) {
            const aviso = document.createElement('option');
            aviso.value = '';
            aviso.textContent = 'Nenhuma meta disponível';
            tipoSelect.appendChild(aviso);
        } else {
            metasExistentes.forEach(m => {
                const o = document.createElement('option');
                o.value = 'meta_' + m.id;
                o.textContent = m.descricao;
                tipoSelect.appendChild(o);
            });
        }
    }
    
    atualizarCamposCredito();
}

function atualizarCamposCredito() {
    const creditDiv      = document.getElementById('creditoFields');
    const parcelasSelect = document.getElementById('selectParcelas');
    const cartaoSelect   = document.getElementById('selectCartao');
    const catVal         = document.getElementById('selectCategoria').value;

    if (parcelasSelect) {
        parcelasSelect.innerHTML = '';
        for (let i = 1; i <= 24; i++) {
            const opt = document.createElement('option');
            opt.value       = i;
            opt.textContent = `${String(i).padStart(2, '0')}x`;
            parcelasSelect.appendChild(opt);
        }
    }

    if (catVal === 'saida_credito') {
        creditDiv.classList.remove('js-hidden');
        cartaoSelect.innerHTML  = '';

        if (_ctx.cartoesCredito.length === 0) {
            const opt       = document.createElement('option');
            opt.value       = '';
            opt.textContent = 'Cadastre um cartão no menu "Cartões"';
            cartaoSelect.appendChild(opt);
            cartaoSelect.disabled = true;
        } else {
            // ✅ Opção placeholder
            const placeholder       = document.createElement('option');
            placeholder.value       = '';
            placeholder.textContent = 'Selecione o cartão';
            cartaoSelect.appendChild(placeholder);

            // ✅ Cada cartão via DOM — nomeBanco e id nunca passam por innerHTML
            _ctx.cartoesCredito.forEach(c => {
                const opt       = document.createElement('option');
                opt.value       = String(c.id);          // ✅ atribuição direta — não interpolado
                opt.textContent = _ctx._sanitizeText(c.nomeBanco); // ✅ sanitizado via textContent
                cartaoSelect.appendChild(opt);
            });

            cartaoSelect.disabled = false;
        }
    } else {
        creditDiv.classList.add('js-hidden');
    }
}

function lancarTransacao() {
    const categoria = document.getElementById('selectCategoria').value;
    const tipo      = document.getElementById('selectTipo').value;
    const descricao = document.getElementById('inputDescricao').value.trim();
    const valorStr  = document.getElementById('inputValor').value;

    if(!categoria) return alert('Escolha Entrada, Saída ou Reserva.');
    if(categoria === 'reserva' && _ctx.metas.filter(m => m.id !== 'emergency').length === 0) {
        return alert('Você ainda não criou nenhuma meta ou reserva, crie no menu "Reservas"');
    }
    if(!tipo && categoria !== 'saida_credito') return alert('Escolha o tipo.');
    if(!descricao) return alert('Digite a descrição.');
    if(!valorStr || !Number.isFinite(Number(valorStr)) || Number(valorStr) <= 0) return alert('Digite um valor válido.');

    const valor = parseFloat(parseFloat(valorStr).toFixed(2));
    const dh    = _ctx.agoraDataHora();

    if(categoria === 'saida_credito') {
        const cartaoSel   = document.getElementById('selectCartao').value;
        const parcelasSel = Number(document.getElementById('selectParcelas').value);

        if(!cartaoSel)   return alert("Selecione o cartão!");
        if(!parcelasSel) return alert("Selecione a quantidade de parcelas!");

        const cartao = _ctx.cartoesCredito.find(c => String(c.id) === String(cartaoSel));
        if(!cartao) return alert("Cartão não encontrado!");
        if(cartao.congelado) { _ctx.mostrarNotificacao('Cartão congelado. Descongele no menu de Cartões para utilizá-lo.', 'error'); return; }

        if(!confirm(`Compra de ${formatBRL(valor)} no cartão ${cartao.nomeBanco}, em ${parcelasSel}x de ${formatBRL(valor/parcelasSel)}.\nProsseguir?`)) return;

        let hoje       = new Date();
        let anoAtual   = hoje.getFullYear();
        let mesAtual   = hoje.getMonth() + 1;
        let diaHoje    = hoje.getDate();
        // diaFechamento determina qual ciclo a compra pertence (cutoff real do cartão)
        // fallback para vencimentoDia mantém compatibilidade com cartões antigos sem fechamentoDia
        let diaFechamento = cartao.fechamentoDia ?? cartao.vencimentoDia;
        let diaFatura     = cartao.vencimentoDia;

        let proxMes, proxAno;
        if(diaHoje >= diaFechamento) {
            // Fatura já fechou ou fecha hoje → compra vai pro próximo ciclo
            proxMes = mesAtual + 1;
            proxAno = anoAtual;
            if(proxMes > 12) { proxMes = 1; proxAno++; }
        } else {
            proxMes = mesAtual;
            proxAno = anoAtual;
        }

        const dataFaturaISO = `${proxAno}-${String(proxMes).padStart(2, '0')}-${String(diaFatura).padStart(2, '0')}`;

        const faturaExistente = _ctx.contasFixas.find(c =>
            c.cartaoId === cartao.id &&
            c.vencimento === dataFaturaISO &&
            c.tipoContaFixa === 'fatura_cartao'
        );

        // ✅ CORREÇÃO: gera UUID local para cada compra.
        //    Compras são armazenadas como JSON aninhado no Supabase (não como rows),
        //    portanto o banco NUNCA gera IDs para objetos dentro do array.
        //    Sem id, String(undefined) === String(undefined) é true para todas as compras,
        //    fazendo find() em pagarCompraIndividual/editarCompraFatura/excluirCompraFatura
        //    retornar sempre a primeira — causando pagar/editar/excluir a compra errada.
        const novaCompra = {
            id: (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `compra_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            tipo,
            descricao,
            valorTotal:    valor,
            valorParcela:  Number((valor / parcelasSel).toFixed(2)),
            totalParcelas: parcelasSel,
            parcelaAtual:  1,
            dataCompra:    dh.data
        };

        if(faturaExistente) {
            if(!faturaExistente.compras) faturaExistente.compras = [];

            // ✅ Previne inserção duplicada em caso de double-click
            const jaExiste = faturaExistente.compras.some(c => c.id === novaCompra.id);
            if(!jaExiste) {
                faturaExistente.compras.push(novaCompra);
            }
            faturaExistente.valor = faturaExistente.compras.reduce((sum, c) => {
                const p = parseFloat(c.valorParcela);
                return sum + (isFinite(p) && p > 0 ? p : 0);
            }, 0);
        } else {
            _ctx.contasFixas.push({
                // ✅ A fatura também recebe UUID — consistência com demais contasFixas
                id: (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `fatura_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                descricao:      `Fatura ${cartao.nomeBanco}`,
                valor:          Number((valor / parcelasSel).toFixed(2)),
                vencimento:     dataFaturaISO,
                pago:           false,
                cartaoId:       cartao.id,
                tipoContaFixa:  'fatura_cartao',
                compras:        [novaCompra]
            });
        }

        cartao.usado = (cartao.usado || 0) + valor;

        _ctx.salvarDados();
        _ctx.atualizarTudo();

        document.getElementById('selectCategoria').value = '';
        atualizarTiposDinamicos();
        document.getElementById('inputDescricao').value = '';
        document.getElementById('inputValor').value     = '';

        alert("Compra lançada! A fatura do cartão foi atualizada.");
        return;
    }

    let showTipo = tipo;
    if(categoria === 'reserva' && tipo.startsWith('meta_')) {
        showTipo = 'Reserva';
    }

    _ctx.criarPopup(`
        <h3>Comprovante</h3>
        <div class="small">Confirme antes de lançar</div>
        <div style="text-align:left; margin:20px 0; color: var(--text-secondary);">
            <div><b>Categoria:</b> <span id="compCategoria"></span></div>
            <div><b>Tipo:</b>      <span id="compTipo"></span></div>
            <div><b>Descrição:</b> <span id="compDescricao"></span></div>
            <div><b>Valor:</b>     <span id="compValor"></span></div>
            <div><b>Data:</b>      <span id="compData"></span></div>
            <div><b>Hora:</b>      <span id="compHora"></span></div>
        </div>
        <button class="btn-primary" id="confirmBtn">Confirmar</button>
        <button class="btn-cancelar" id="cancelarComprovante">Cancelar</button>
    `);

    document.getElementById('compCategoria').textContent = categoria;
    document.getElementById('compTipo').textContent      = showTipo;
    document.getElementById('compDescricao').textContent = descricao;
    document.getElementById('compValor').textContent     = _ctx.formatBRL(valor);
    document.getElementById('compData').textContent      = dh.data;
    document.getElementById('compHora').textContent      = dh.hora;

    document.getElementById('cancelarComprovante').addEventListener('click', () => _ctx.fecharPopup());

    document.getElementById('confirmBtn').addEventListener('click', () => {
        let metaIdInner = null;
        let tipoSalvo   = tipo;

        if(categoria === 'reserva' && tipo.startsWith('meta_')) {
            metaIdInner = tipo.split('_')[1];
            tipoSalvo   = 'Reserva';
        }

        // ✅ Sem id — banco gera via gen_random_uuid() (rows individuais no Supabase)
        const t = {
            categoria,
            tipo:    tipoSalvo,
            descricao,
            valor,
            data:    dh.data,
            hora:    dh.hora,
            metaId:  metaIdInner
        };
        _ctx.transacoes.push(t);

        if(categoria === 'reserva' && metaIdInner) {
            const meta = _ctx.metas.find(m => String(m.id) === String(metaIdInner));
            if(meta) {
                meta.saved = Number((Number(meta.saved || 0) + Number(valor)).toFixed(2));
                const ym = _ctx.yearMonthKey(_ctx.isoDate());
                meta.monthly = meta.monthly || {};
                meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + Number(valor)).toFixed(2));
            }
        }

        _ctx.salvarDados();
        _ctx.atualizarTudo();
        _ctx.fecharPopup();
        _verificarAlertasOrcamento(categoria, tipoSalvo, valor);
        _ctx.verificarAnomaliaGasto?.(tipoSalvo, valor);
        renderizarOrcamentos();

        document.getElementById('selectCategoria').value    = '';
        document.getElementById('selectTipo').innerHTML     = '<option value="">Tipo</option>';
        document.getElementById('inputDescricao').value     = '';
        document.getElementById('inputValor').value         = '';
    });
}

function _obterIconeTransacao(categoria, tipo) {
    const t = (tipo || '').toLowerCase();

    if (categoria === 'entrada') {
        if (t.includes('sal') && (t.includes('rio') || t.includes('rio'))) return 'fa-money-bill-wave';
        if (t.includes('renda') || t.includes('extra')) return 'fa-chart-line';
        if (t.includes('recebimento')) return 'fa-hand-holding-dollar';
        return 'fa-arrow-trend-up';
    }

    if (categoria === 'reserva')          return 'fa-piggy-bank';
    if (categoria === 'retirada_reserva') return 'fa-arrow-right-from-bracket';

    if (t.includes('mercado livre'))                              return 'fa-store';
    if (t.includes('mercado'))                                    return 'fa-cart-shopping';
    if (t.includes('farm'))                                       return 'fa-pills';
    if (t.includes('eletr'))                                      return 'fa-laptop';
    if (t.includes('roupa') || t.includes('vestuário'))          return 'fa-shirt';
    if (t.includes('assinatura') || t.includes('streaming'))     return 'fa-rotate';
    if (t.includes('beleza') || t.includes('cabelo'))            return 'fa-scissors';
    if (t.includes('presente'))                                   return 'fa-gift';
    if (t.includes('conta') || t.includes('fatura'))             return 'fa-file-invoice-dollar';
    if (t.includes('cart'))                                       return 'fa-credit-card';
    if (t.includes('academia') || t.includes('gym'))             return 'fa-dumbbell';
    if (t.includes('lazer') || t.includes('entretenimento'))     return 'fa-gamepad';
    if (t.includes('transporte') || t.includes('uber') || t.includes('gasolina') || t.includes('combustível')) return 'fa-bus';
    if (t.includes('shopee'))                                     return 'fa-bag-shopping';
    if (t.includes('ifood') || t.includes('restaurante') || t.includes('alimenta')) return 'fa-utensils';
    if (t.includes('amazon'))                                     return 'fa-box';
    if (t.includes('chat') || t.includes('ia') || t.includes('robot')) return 'fa-robot';
    if (t.includes('saúde') || t.includes('médico') || t.includes('consulta')) return 'fa-stethoscope';
    if (t.includes('educação') || t.includes('curso') || t.includes('livro')) return 'fa-graduation-cap';
    if (t.includes('viagem') || t.includes('hotel') || t.includes('passagem')) return 'fa-plane';

    return 'fa-arrow-up-right-dots';
}

function filtrarTransacoesParaUI() {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    return _ctx.transacoes.filter(t => {
        if (_ctx.filtroMovAtivo === 'todo') return true;

        const iso = _ctx.dataParaISO(t.data || '');
        if (!iso) return false;
        const d = new Date(iso + 'T00:00:00');

        if (_ctx.filtroMovAtivo === 'mes_atual') {
            return d.getMonth() === hoje.getMonth() && d.getFullYear() === hoje.getFullYear();
        }
        if (_ctx.filtroMovAtivo === '15_dias') {
            const limite = new Date(hoje); limite.setDate(hoje.getDate() - 14);
            return d >= limite && d <= hoje;
        }
        if (_ctx.filtroMovAtivo === '30_dias') {
            const limite = new Date(hoje); limite.setDate(hoje.getDate() - 29);
            return d >= limite && d <= hoje;
        }
        if (_ctx.filtroMovAtivo === '60_dias') {
            const limite = new Date(hoje); limite.setDate(hoje.getDate() - 59);
            return d >= limite && d <= hoje;
        }
        if (_ctx.filtroMovAtivo === 'periodo') {
            const mes = _ctx.filtroMovMes !== null ? filtroMovMes : hoje.getMonth();
            const ano = _ctx.filtroMovAno !== null ? filtroMovAno : hoje.getFullYear();
            return d.getMonth() === mes && d.getFullYear() === ano;
        }
        return true;
    });
}

function bindFiltrosMovimentacoes() {
    const container = document.getElementById('movFiltros');
    if (!container) return;

    // Toggle do painel de filtros
    const toggleBtn = document.getElementById('toggleFiltrosBtn');
    const wrapper   = document.getElementById('movFiltrosWrapper');
    if (toggleBtn && wrapper) {
        toggleBtn.addEventListener('click', () => {
            const isOpen = wrapper.classList.toggle('open');
            toggleBtn.setAttribute('aria-expanded', String(isOpen));
        });
    }

    // Mapa para exibir nome legível do filtro ativo
    const nomeFiltros = {
        mes_atual: 'Mês atual',
        '15_dias': 'Últimos 15 dias',
        '30_dias': 'Últimos 30 dias',
        '60_dias': 'Últimos 60 dias',
        periodo:   'Mês/ano',
        todo:      'Todo o período',
    };

    function atualizarLabelAtivo(filtro) {
        const label = document.getElementById('filtroAtivoLabel');
        if (label) label.textContent = nomeFiltros[filtro] || filtro;
    }

    container.addEventListener('click', e => {
        const btn = e.target.closest('.mov-filtro-btn');
        if (!btn) return;

        container.querySelectorAll('.mov-filtro-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        _ctx.filtroMovAtivo = btn.dataset.filtro;
        atualizarLabelAtivo(_ctx.filtroMovAtivo);

        // Fecha o painel após selecionar (exceto "período" que precisa de sub-seleção)
        if (_ctx.filtroMovAtivo !== 'periodo' && wrapper) {
            wrapper.classList.remove('open');
            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        }

        const periodoSel = document.getElementById('movPeriodoSelector');
        if (periodoSel) periodoSel.style.display = _ctx.filtroMovAtivo === 'periodo' ? 'flex' : 'none';

        if (_ctx.filtroMovAtivo !== 'periodo') _ctx.atualizarMovimentacoesUI();
    });

    const btnAplicar = document.getElementById('btnAplicarFiltroMes');
    if (btnAplicar) {
        btnAplicar.addEventListener('click', () => {
            const mesEl = document.getElementById('movFiltroMes');
            const anoEl = document.getElementById('movFiltroAno');
            if (mesEl) _ctx.filtroMovMes = parseInt(mesEl.value, 10);
            if (anoEl) _ctx.filtroMovAno = parseInt(anoEl.value, 10);
            _ctx.atualizarMovimentacoesUI();
        });
    }

    // Populate year select
    const anoEl = document.getElementById('movFiltroAno');
    if (anoEl && anoEl.options.length === 0) {
        const anoAtual = new Date().getFullYear();
        for (let a = anoAtual; a >= anoAtual - 5; a--) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a;
            if (a === anoAtual) opt.selected = true;
            anoEl.appendChild(opt);
        }
    }

    // Pre-select current month in month select
    const mesEl = document.getElementById('movFiltroMes');
    if (mesEl) mesEl.value = new Date().getMonth();
}

// Paginação das movimentações — 50 itens por página para não sobrecarregar o DOM
const MOV_POR_PAGINA = 50;
// _movPaginaAtual, _movVisivelCache e _movDelegateSet são estado de dashboard.js,
// acessíveis via _ctx.

const _CAT_LABELS = { entrada: 'Entrada', saida: 'Saída', reserva: 'Reserva', retirada_reserva: 'Retirada' };
const _CAT_PERMITIDAS = ['entrada', 'saida', 'reserva', 'retirada_reserva'];
const _TIPO_ICON = {
    entrada:          'fa-arrow-up',
    saida:            'fa-arrow-down',
    reserva:          'fa-piggy-bank',
    retirada_reserva: 'fa-wallet',
};

function _buildTable(visivel) {
    const table = document.createElement('table');
    table.className = 'mov-table';

    const thead  = document.createElement('thead');
    const trHead = document.createElement('tr');
    ['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor', 'Ações'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    visivel.forEach(t => {
        const cat = _CAT_PERMITIDAS.includes(t.categoria) ? t.categoria : 'saida';
        const tr  = document.createElement('tr');

        // — Data com ícone de calendário —
        const tdData = document.createElement('td');
        tdData.className = 'td-data';
        const calIcon = document.createElement('i');
        calIcon.className = 'fas fa-calendar-alt td-cal-icon';
        calIcon.setAttribute('aria-hidden', 'true');
        tdData.appendChild(calIcon);
        tdData.appendChild(document.createTextNode(_ctx._sanitizeText(t.data || '')));
        tr.appendChild(tdData);

        // — Descrição com subtítulo —
        const tdDesc = document.createElement('td');
        tdDesc.className = 'td-desc';
        const descMain = document.createElement('div');
        descMain.className = 'td-desc-main';
        descMain.textContent = _ctx._sanitizeText(t.descricao || '');
        tdDesc.appendChild(descMain);
        if (t.tipo) {
            const descSub = document.createElement('div');
            descSub.className = 'td-desc-sub';
            descSub.textContent = _ctx._sanitizeText(t.tipo);
            tdDesc.appendChild(descSub);
        }
        tr.appendChild(tdDesc);

        // — Categoria —
        const tdCat = document.createElement('td');
        tdCat.className = 'td-cat';
        const badge = document.createElement('span');
        badge.className = `cat-badge cat-${cat}`;
        badge.textContent = _CAT_LABELS[cat] || cat;
        tdCat.appendChild(badge);
        tr.appendChild(tdCat);

        // — Tipo com ícone colorido —
        const tdTipo = document.createElement('td');
        tdTipo.className = 'td-tipo';
        const tipoIconWrap = document.createElement('span');
        tipoIconWrap.className = `tipo-icon tipo-icon-${cat}`;
        const tipoI = document.createElement('i');
        tipoI.className = `fas ${_TIPO_ICON[cat] || 'fa-circle'}`;
        tipoI.setAttribute('aria-hidden', 'true');
        tipoIconWrap.appendChild(tipoI);
        tdTipo.appendChild(tipoIconWrap);
        tdTipo.appendChild(document.createTextNode(_ctx._sanitizeText(t.tipo || '')));
        tr.appendChild(tdTipo);

        // — Valor colorido —
        const sinal   = (cat === 'entrada' || cat === 'retirada_reserva') ? '+' : '-';
        const tdValor = document.createElement('td');
        tdValor.className = `td-valor val-${cat}`;
        tdValor.textContent = `${sinal} ${formatBRL(t.valor)}`;
        tr.appendChild(tdValor);

        // — Ações —
        const tdAcoes = document.createElement('td');
        tdAcoes.className = 'td-acoes';

        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn-tx-action btn-tx-edit';
        btnEdit.type  = 'button';
        btnEdit.title = 'Editar';
        btnEdit.setAttribute('aria-label', 'Editar transação');
        const iEdit = document.createElement('i');
        iEdit.className = 'fas fa-pen';
        iEdit.setAttribute('aria-hidden', 'true');
        btnEdit.appendChild(iEdit);
        btnEdit.addEventListener('click', () => editarTransacao(t));

        const btnDel = document.createElement('button');
        btnDel.className = 'btn-tx-action btn-tx-del';
        btnDel.type  = 'button';
        btnDel.title = 'Excluir';
        btnDel.setAttribute('aria-label', 'Excluir transação');
        const iDel = document.createElement('i');
        iDel.className = 'fas fa-trash';
        iDel.setAttribute('aria-hidden', 'true');
        btnDel.appendChild(iDel);
        btnDel.addEventListener('click', () => excluirTransacao(t));

        tdAcoes.appendChild(btnEdit);
        tdAcoes.appendChild(btnDel);
        tr.appendChild(tdAcoes);

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    return table;
}

function _buildCards(visivel) {
    const wrapper  = document.createElement('div');
    wrapper.className = 'mov-cards';
    const frag     = document.createDocumentFragment();
    let ultimaData = null;

    visivel.forEach(t => {
        const cat         = _CAT_PERMITIDAS.includes(t.categoria) ? t.categoria : 'saida';
        const dataExibida = _ctx._sanitizeText(t.data || '');

        if (dataExibida && dataExibida !== ultimaData) {
            ultimaData = dataExibida;
            const sep       = document.createElement('div');
            sep.className   = 'mov-date-separator';
            sep.textContent = dataExibida;
            frag.appendChild(sep);
        }

        const div     = document.createElement('div');
        div.className = 'mov-item';

        const iconeBadge     = document.createElement('div');
        iconeBadge.className = `mov-icon-badge ${cat}`;
        const iconeEl = document.createElement('i');
        iconeEl.className = `fas ${_obterIconeTransacao(t.categoria, t.tipo)}`;
        iconeEl.setAttribute('aria-hidden', 'true');
        iconeBadge.appendChild(iconeEl);

        const left = document.createElement('div');
        left.className = 'mov-left';

        const divTipo       = document.createElement('div');
        divTipo.className   = 'mov-tipo';
        divTipo.textContent = _ctx._sanitizeText(t.tipo);

        const divDesc       = document.createElement('div');
        divDesc.className   = 'mov-desc';
        divDesc.textContent = _ctx._sanitizeText(t.descricao);

        left.appendChild(divTipo);
        left.appendChild(divDesc);

        const right     = document.createElement('div');
        right.className = 'mov-right';

        const sinal = (cat === 'entrada' || cat === 'retirada_reserva') ? '+' : '-';
        const divValor       = document.createElement('div');
        divValor.className   = cat;
        divValor.textContent = `${sinal} ${formatBRL(t.valor)}`;
        right.appendChild(divValor);

        div.appendChild(iconeBadge);
        div.appendChild(left);
        div.appendChild(right);
        div.addEventListener('click', () => editarTransacao(t));

        frag.appendChild(div);
    });

    wrapper.appendChild(frag);
    return wrapper;
}

function atualizarMovimentacoesUI(resetPagina = true) {
    const lista = document.getElementById('listaMovimentacoes');
    if (!lista) return;

    if (resetPagina) _ctx._movPaginaAtual = 1;

    lista.innerHTML = '';

    const todos   = filtrarTransacoesParaUI().slice().reverse();
    const total   = todos.length;
    const visivel = todos.slice(0, _ctx._movPaginaAtual * MOV_POR_PAGINA);
    const restam  = total - visivel.length;

    if (total === 0) {
        const p       = document.createElement('p');
        p.className   = 'empty-state';
        p.textContent = 'Nenhuma movimentação registrada.';
        lista.appendChild(p);
        return;
    }

    _ctx._movVisivelCache = visivel;

    lista.appendChild(_buildTable(visivel));
    lista.appendChild(_buildCards(visivel));

    if (restam > 0) {
        const btnMais       = document.createElement('button');
        btnMais.className   = 'btn-load-more';
        btnMais.type        = 'button';
        btnMais.textContent = `Carregar mais ${Math.min(restam, MOV_POR_PAGINA)} de ${restam} movimentações`;
        btnMais.addEventListener('click', () => {
            _ctx._movPaginaAtual++;
            _ctx.atualizarMovimentacoesUI(false);
        });
        lista.appendChild(btnMais);
    }
}

function editarTransacao(t) {
    if (!t) return;

    const _TIPOS_SAIDA   = ['Mercado','Farmácia','Eletrônico','Roupas','Assinaturas','Beleza','Presente',
        'Conta fixa','Cartão','Academia','Lazer','Transporte','Shopee','Mercado Livre','Ifood','Amazon','Outros'];
    const _TIPOS_ENTRADA = ['Salário','Renda Extra','Outros Recebimentos'];
    const _CATS_EDIT = [
        { value: 'entrada',          label: 'Entrada' },
        { value: 'saida',            label: 'Saída' },
        { value: 'saida_credito',    label: 'Saída no Crédito' },
        { value: 'reserva',          label: 'Reserva' },
        { value: 'retirada_reserva', label: 'Retirada de Reserva' },
    ];

    _ctx.criarPopupDOM((box) => {
        const form = document.createElement('div');
        form.className = 'edit-tx-form';

        function _lbl(txt, forId) {
            const l = document.createElement('label');
            l.className = 'edit-tx-label'; l.htmlFor = forId; l.textContent = txt;
            return l;
        }

        // Descrição
        const inpDesc = document.createElement('input');
        inpDesc.type = 'text'; inpDesc.id = 'editDescricao'; inpDesc.className = 'form-input';
        inpDesc.maxLength = 300; inpDesc.placeholder = 'Descrição'; inpDesc.value = t.descricao || '';
        form.appendChild(_lbl('Descrição', 'editDescricao')); form.appendChild(inpDesc);

        // Categoria (entrada/saída)
        const selCat = document.createElement('select');
        selCat.id = 'editCategoria'; selCat.className = 'form-input';
        _CATS_EDIT.forEach(c => {
            const o = document.createElement('option'); o.value = c.value; o.textContent = c.label;
            if (c.value === t.categoria) o.selected = true;
            selCat.appendChild(o);
        });
        form.appendChild(_lbl('Categoria', 'editCategoria')); form.appendChild(selCat);

        // Tipo (subcategoria — dinâmico)
        const selTipo = document.createElement('select');
        selTipo.id = 'editTipo'; selTipo.className = 'form-input';

        function _popularTipos(catVal) {
            selTipo.innerHTML = '';
            const lista = (catVal === 'entrada' || catVal === 'retirada_reserva')
                ? _TIPOS_ENTRADA : _TIPOS_SAIDA;
            const personalizados = (_ctx.tiposPersonalizados || []).filter(tp => typeof tp === 'string' && tp.trim());
            [...lista, ...personalizados].forEach(tp => {
                const o = document.createElement('option'); o.value = tp; o.textContent = tp;
                if (tp === t.tipo) o.selected = true;
                selTipo.appendChild(o);
            });
        }
        _popularTipos(t.categoria);
        selCat.addEventListener('change', () => _popularTipos(selCat.value));
        form.appendChild(_lbl('Tipo', 'editTipo')); form.appendChild(selTipo);

        // Valor
        const inpValor = document.createElement('input');
        inpValor.type = 'number'; inpValor.id = 'editValor'; inpValor.className = 'form-input';
        inpValor.step = '0.01'; inpValor.min = '0.01'; inpValor.placeholder = 'Valor';
        inpValor.value = t.valor || '';
        form.appendChild(_lbl('Valor (R$)', 'editValor')); form.appendChild(inpValor);

        // Título
        const h3 = document.createElement('h3'); h3.textContent = 'Editar Transação';

        // Botões
        const btnSalvar = document.createElement('button');
        btnSalvar.className = 'btn-primary'; btnSalvar.type = 'button'; btnSalvar.textContent = 'Salvar';
        const btnExcluir = document.createElement('button');
        btnExcluir.className = 'btn-excluir'; btnExcluir.type = 'button'; btnExcluir.textContent = 'Excluir';
        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar'; btnCancelar.type = 'button'; btnCancelar.textContent = 'Cancelar';

        box.appendChild(h3); box.appendChild(form);
        box.appendChild(btnSalvar); box.appendChild(btnExcluir); box.appendChild(btnCancelar);

        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());
        btnExcluir.addEventListener('click', () => { _ctx.fecharPopup(); excluirTransacao(t); });

        btnSalvar.addEventListener('click', () => {
            const novaDesc     = inpDesc.value.trim();
            const novoValorStr = inpValor.value;
            const novaCat      = selCat.value;
            const novoTipo     = selTipo.value;

            if (!novaDesc) return alert('Digite a descrição.');
            const novoValor = parseFloat(parseFloat(novoValorStr).toFixed(2));
            if (!novoValorStr || !Number.isFinite(novoValor) || novoValor <= 0) return alert('Digite um valor válido.');

            const diff = novoValor - Number(t.valor);
            if (diff !== 0 && t.metaId) {
                const meta = _ctx.metas.find(m => String(m.id) === String(t.metaId));
                if (meta) {
                    const sinal = t.categoria === 'reserva' ? 1 : -1;
                    meta.saved = Number((Number(meta.saved || 0) + sinal * diff).toFixed(2));
                    const ym = _ctx.yearMonthKey(t.data);
                    meta.monthly = meta.monthly || {};
                    meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + sinal * diff).toFixed(2));
                }
            }

            t.descricao = novaDesc;
            t.valor     = novoValor;
            t.categoria = novaCat;
            t.tipo      = novoTipo;

            _ctx.salvarDados();
            _ctx.atualizarTudo();
            renderizarOrcamentos();
            _ctx.fecharPopup();
        });
    });

}

function excluirTransacao(t) {
    if (!t) return;

    _ctx.criarPopup(`
        <h3>Excluir Transação</h3>
        <p id="excluirMsg" style="color:var(--text-secondary);margin:16px 0;"></p>
        <button class="btn-excluir" id="confirmarExcluirBtn">Excluir</button>
        <button class="btn-cancelar" id="cancelarExcluirBtn">Cancelar</button>
    `);

    document.getElementById('excluirMsg').textContent = `Deseja excluir "${_ctx._sanitizeText(t.descricao)}"?`;

    document.getElementById('cancelarExcluirBtn').addEventListener('click', () => _ctx.fecharPopup());

    document.getElementById('confirmarExcluirBtn').addEventListener('click', () => {
        _ctx.transacoes = _ctx.transacoes.filter(x => x !== t);

        if (t.metaId) {
            const meta = _ctx.metas.find(m => String(m.id) === String(t.metaId));
            if (meta) {
                const sinal = t.categoria === 'reserva' ? -1 : 1;
                meta.saved = Number((Number(meta.saved || 0) + sinal * Number(t.valor)).toFixed(2));
                const ym = _ctx.yearMonthKey(t.data);
                if (meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + sinal * Number(t.valor)).toFixed(2));
                }
            }
        }

        _ctx.salvarDados();
        _ctx.atualizarTudo();
        _ctx.fecharPopup();
    });
}

function abrirDetalhesTransacao(t) {
    editarTransacao(t);
}

// ========== ORÇAMENTOS POR CATEGORIA ==========

const _TIPOS_ORCAMENTO = Object.freeze([
    'Mercado','Farmácia','Eletrônico','Roupas','Assinaturas','Beleza','Presente',
    'Conta fixa','Cartão','Academia','Lazer','Transporte','Shopee','Mercado Livre',
    'Ifood','Amazon','Outros',
]);

function _gastoMesAtualPorTipo(tipo) {
    const hoje = new Date();
    const mes  = hoje.getMonth();
    const ano  = hoje.getFullYear();
    return _ctx.transacoes
        .filter(t => {
            if (t.tipo !== tipo) return false;
            if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') return false;
            const iso = _ctx.dataParaISO(t.data || '');
            if (!iso) return false;
            const d = new Date(iso + 'T00:00:00');
            return d.getMonth() === mes && d.getFullYear() === ano;
        })
        .reduce((s, t) => s + (parseFloat(t.valor) || 0), 0);
}

function _corOrcamento(pct) {
    if (pct >= 100) return 'var(--danger)';
    if (pct >= 80)  return 'var(--warning)';
    return 'var(--success)';
}

function renderizarOrcamentos() {
    const section = document.getElementById('orcamentosSection');
    if (!section) return;

    const orc = _ctx.orcamentos || {};
    const entradas = Object.entries(orc);

    section.innerHTML = '';

    // — Cabeçalho —
    const header = document.createElement('div');
    header.className = 'orc-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'orc-title-wrap';
    const icon = document.createElement('i');
    icon.className = 'fas fa-wallet';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.textContent = 'Orçamentos do Mês';
    titleWrap.appendChild(icon);
    titleWrap.appendChild(title);

    const btnAdd = document.createElement('button');
    btnAdd.className = 'orc-btn-add';
    btnAdd.type = 'button';
    btnAdd.setAttribute('aria-label', 'Adicionar orçamento');
    btnAdd.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> Adicionar';
    btnAdd.addEventListener('click', () => abrirModalOrcamento(null));

    header.appendChild(titleWrap);
    header.appendChild(btnAdd);
    section.appendChild(header);

    if (entradas.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'orc-empty';
        empty.innerHTML = '<i class="fas fa-chart-pie"></i><span>Defina limites mensais por categoria para acompanhar seus gastos.</span>';
        section.appendChild(empty);
        return;
    }

    // — Grid de cards —
    const grid = document.createElement('div');
    grid.className = 'orc-grid';

    entradas.forEach(([tipo, cfg]) => {
        const limite = parseFloat(cfg.limite) || 0;
        const gasto  = _gastoMesAtualPorTipo(tipo);
        const pct    = limite > 0 ? Math.min((gasto / limite) * 100, 999) : 0;
        const cor    = _corOrcamento(pct);
        const pctBar = Math.min(pct, 100);

        const card = document.createElement('div');
        card.className = 'orc-card';
        if (pct >= 100) card.classList.add('orc-card--over');
        else if (pct >= 80) card.classList.add('orc-card--warn');

        // Ícone da categoria
        const iconeWrap = document.createElement('div');
        iconeWrap.className = 'orc-card-icon';
        const icEl = document.createElement('i');
        icEl.className = `fas ${_obterIconeTransacao('saida', tipo)}`;
        icEl.setAttribute('aria-hidden', 'true');
        iconeWrap.appendChild(icEl);

        // Corpo
        const body = document.createElement('div');
        body.className = 'orc-card-body';

        const topRow = document.createElement('div');
        topRow.className = 'orc-card-top';

        const nameEl = document.createElement('span');
        nameEl.className = 'orc-card-name';
        nameEl.textContent = tipo;

        const pctEl = document.createElement('span');
        pctEl.className = 'orc-card-pct';
        pctEl.style.color = cor;
        pctEl.textContent = `${pct >= 999 ? '+999' : pct.toFixed(0)}%`;

        topRow.appendChild(nameEl);
        topRow.appendChild(pctEl);

        const barWrap = document.createElement('div');
        barWrap.className = 'orc-bar-wrap';
        const barFill = document.createElement('div');
        barFill.className = 'orc-bar-fill';
        barFill.style.width = pctBar.toFixed(1) + '%';
        barFill.style.background = cor;
        barWrap.appendChild(barFill);

        const valRow = document.createElement('div');
        valRow.className = 'orc-card-vals';
        const gastoEl = document.createElement('span');
        gastoEl.style.color = cor;
        gastoEl.textContent = formatBRL(gasto);
        const limEl = document.createElement('span');
        limEl.className = 'orc-card-limit';
        limEl.textContent = `/ ${formatBRL(limite)}`;
        valRow.appendChild(gastoEl);
        valRow.appendChild(limEl);

        body.appendChild(topRow);
        body.appendChild(barWrap);
        body.appendChild(valRow);

        card.appendChild(iconeWrap);
        card.appendChild(body);
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Ver detalhes de ${tipo}`);
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => abrirDetalheOrcamento(tipo));
        card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirDetalheOrcamento(tipo); } });
        grid.appendChild(card);
    });

    section.appendChild(grid);
}

// Abre popup de DETALHE ao clicar num card — lista de compras + opções
function abrirDetalheOrcamento(tipo) {
    const orc    = _ctx.orcamentos || {};
    const cfg    = orc[tipo];
    if (!cfg) return;

    const limite = parseFloat(cfg.limite) || 0;
    const gasto  = _gastoMesAtualPorTipo(tipo);
    const pct    = limite > 0 ? Math.min((gasto / limite) * 100, 999) : 0;
    const cor    = _corOrcamento(pct);
    const pctBar = Math.min(pct, 100);

    // Transações do mês nessa categoria
    const hoje = new Date();
    const txMes = _ctx.transacoes
        .filter(t => {
            if (t.tipo !== tipo) return false;
            if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') return false;
            const iso = _ctx.dataParaISO(t.data || '');
            if (!iso) return false;
            const d = new Date(iso + 'T00:00:00');
            return d.getMonth() === hoje.getMonth() && d.getFullYear() === hoje.getFullYear();
        })
        .slice()
        .reverse();

    const popupEl = document.createElement('div');
    popupEl.className = 'orc-detalhe-wrap';

    // — Cabeçalho do popup —
    const hdr = document.createElement('div');
    hdr.className = 'orc-detalhe-hdr';

    const hdrLeft = document.createElement('div');
    hdrLeft.className = 'orc-detalhe-hdr-left';
    const hdrIcon = document.createElement('div');
    hdrIcon.className = 'orc-card-icon';
    const hdrI = document.createElement('i');
    hdrI.className = `fas ${_obterIconeTransacao('saida', tipo)}`;
    hdrI.setAttribute('aria-hidden', 'true');
    hdrIcon.appendChild(hdrI);
    const hdrTitle = document.createElement('div');
    const hdrName = document.createElement('strong');
    hdrName.textContent = tipo;
    const hdrSub = document.createElement('div');
    hdrSub.className = 'orc-detalhe-sub';
    hdrSub.textContent = `${formatBRL(gasto)} / ${formatBRL(limite)}`;
    hdrSub.style.color = cor;
    hdrTitle.appendChild(hdrName);
    hdrTitle.appendChild(hdrSub);
    hdrLeft.appendChild(hdrIcon);
    hdrLeft.appendChild(hdrTitle);

    const hdrPct = document.createElement('span');
    hdrPct.className = 'orc-detalhe-pct';
    hdrPct.style.color = cor;
    hdrPct.textContent = `${pct >= 999 ? '+999' : pct.toFixed(0)}%`;

    hdr.appendChild(hdrLeft);
    hdr.appendChild(hdrPct);

    // — Barra de progresso —
    const barWrap = document.createElement('div');
    barWrap.className = 'orc-bar-wrap';
    barWrap.style.marginBottom = '16px';
    const barFill = document.createElement('div');
    barFill.className = 'orc-bar-fill';
    barFill.style.width = pctBar.toFixed(1) + '%';
    barFill.style.background = cor;
    barWrap.appendChild(barFill);

    // — Lista de compras —
    const listTitle = document.createElement('div');
    listTitle.className = 'orc-detalhe-list-title';
    listTitle.textContent = txMes.length > 0
        ? `${txMes.length} lançamento${txMes.length > 1 ? 's' : ''} este mês`
        : 'Nenhum lançamento este mês';

    const list = document.createElement('div');
    list.className = 'orc-detalhe-list';

    if (txMes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'orc-detalhe-empty';
        empty.textContent = 'Nenhuma transação nesta categoria no mês atual.';
        list.appendChild(empty);
    } else {
        txMes.forEach(t => {
            const row = document.createElement('div');
            row.className = 'orc-detalhe-row';

            const left = document.createElement('div');
            left.className = 'orc-detalhe-row-left';
            const desc = document.createElement('span');
            desc.className = 'orc-detalhe-desc';
            desc.textContent = _ctx._sanitizeText(t.descricao || '');
            const date = document.createElement('span');
            date.className = 'orc-detalhe-date';
            date.textContent = _ctx._sanitizeText(t.data || '');
            left.appendChild(desc);
            left.appendChild(date);

            const val = document.createElement('span');
            val.className = 'orc-detalhe-val';
            val.textContent = `- ${formatBRL(parseFloat(t.valor) || 0)}`;

            row.appendChild(left);
            row.appendChild(val);
            list.appendChild(row);
        });
    }

    // — Ações —
    const acoes = document.createElement('div');
    acoes.className = 'orc-detalhe-acoes';

    const btnEditar = document.createElement('button');
    btnEditar.className = 'btn-primary';
    btnEditar.type = 'button';
    btnEditar.innerHTML = '<i class="fas fa-pen" aria-hidden="true"></i> Editar limite';
    btnEditar.addEventListener('click', () => {
        _ctx.fecharPopup();
        setTimeout(() => abrirModalOrcamento(tipo), 120);
    });

    const btnRemover = document.createElement('button');
    btnRemover.className = 'btn-excluir';
    btnRemover.type = 'button';
    btnRemover.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i> Remover';
    btnRemover.addEventListener('click', () => {
        if (!confirm(`Remover o orçamento de "${tipo}"?`)) return;
        const novo = Object.assign({}, _ctx.orcamentos);
        delete novo[tipo];
        _ctx.orcamentos = novo;
        _ctx.salvarDadosUrgente();
        renderizarOrcamentos();
        _ctx.fecharPopup();
        _ctx.mostrarNotificacao(`Orçamento de ${tipo} removido.`, 'info');
    });

    const btnFechar = document.createElement('button');
    btnFechar.className = 'btn-cancelar';
    btnFechar.type = 'button';
    btnFechar.textContent = 'Fechar';
    btnFechar.addEventListener('click', () => _ctx.fecharPopup());

    acoes.appendChild(btnEditar);
    acoes.appendChild(btnRemover);
    acoes.appendChild(btnFechar);

    _ctx.criarPopupDOM((box) => {
        box.appendChild(hdr);
        box.appendChild(barWrap);
        box.appendChild(listTitle);
        box.appendChild(list);
        box.appendChild(acoes);
    });
}

// Abre modal para ADICIONAR novo orçamento ou EDITAR limite de um existente
function abrirModalOrcamento(tipoEditar) {
    const orc         = _ctx.orcamentos || {};
    const editando    = tipoEditar !== null;
    const limiteAtual = editando && orc[tipoEditar] ? orc[tipoEditar].limite : '';

    const tiposDisponiveis = editando
        ? [tipoEditar]
        : _TIPOS_ORCAMENTO.filter(t => !Object.prototype.hasOwnProperty.call(orc, t));

    if (!editando && tiposDisponiveis.length === 0) {
        _ctx.mostrarNotificacao('Você já definiu orçamentos para todas as categorias!', 'info');
        return;
    }

    _ctx.criarPopup(`
        <h3>${editando ? 'Editar Limite' : 'Novo Orçamento'}</h3>
        <div class="edit-tx-form">
            <label class="edit-tx-label" for="orcTipoSelect">Categoria</label>
            <select id="orcTipoSelect" class="form-input" ${editando ? 'disabled' : ''}>
                ${tiposDisponiveis.map(t => `<option value="${t}">${t}</option>`).join('')}
            </select>
            <label class="edit-tx-label" for="orcLimiteInput">Limite mensal (R$)</label>
            <input type="number" id="orcLimiteInput" class="form-input" step="0.01" min="1" max="10000000" placeholder="Ex: 800,00" value="${limiteAtual}">
        </div>
        <button class="btn-primary" id="orcSalvarBtn" type="button">Salvar</button>
        <button class="btn-cancelar" id="orcCancelarBtn" type="button">Cancelar</button>
    `);

    document.getElementById('orcCancelarBtn').addEventListener('click', () => _ctx.fecharPopup());

    document.getElementById('orcSalvarBtn').addEventListener('click', () => {
        const tipoSel   = editando ? tipoEditar : document.getElementById('orcTipoSelect').value;
        const limiteStr = document.getElementById('orcLimiteInput').value;
        const limite    = parseFloat(parseFloat(limiteStr).toFixed(2));

        if (!tipoSel) return alert('Selecione a categoria.');
        if (!_TIPOS_ORCAMENTO.includes(tipoSel)) return alert('Categoria inválida.');
        if (!isFinite(limite) || limite <= 0) return alert('Digite um limite válido.');
        if (limite > 10_000_000) return alert('Limite muito alto.');

        const novo = Object.assign({}, _ctx.orcamentos);
        novo[tipoSel] = { limite };
        _ctx.orcamentos = novo;
        _ctx.salvarDadosUrgente();
        renderizarOrcamentos();
        _ctx.fecharPopup();
        _ctx.mostrarNotificacao(`Orçamento de ${tipoSel} definido em ${formatBRL(limite)}.`, 'success');
    });
}

function _verificarAlertasOrcamento(categoria, tipo, valorAdicionado) {
    if (categoria !== 'saida' && categoria !== 'saida_credito') return;
    const orc = _ctx.orcamentos || {};
    if (!Object.prototype.hasOwnProperty.call(orc, tipo)) return;
    const limite = parseFloat(orc[tipo].limite) || 0;
    if (limite <= 0) return;
    const gasto = _gastoMesAtualPorTipo(tipo);
    const pct   = (gasto / limite) * 100;
    if (pct >= 100) {
        _ctx.mostrarNotificacao(`⚠️ Limite de ${tipo} estourado! Gasto: ${formatBRL(gasto)} / ${formatBRL(limite)}`, 'error');
    } else if (pct >= 80) {
        _ctx.mostrarNotificacao(`Atenção: você usou ${pct.toFixed(0)}% do orçamento de ${tipo}.`, 'warning');
    }
}

// ========== IMPORTADOR DE EXTRATO OFX/CSV ==========
// Processamento 100% local — arquivo nunca sai do browser

const _CATEGORIAS_IMPORT = Object.freeze([
    'Mercado','Farmácia','Eletrônico','Roupas','Assinaturas','Beleza','Presente',
    'Conta fixa','Cartão','Academia','Lazer','Transporte','Shopee','Mercado Livre',
    'Ifood','Amazon','Outros','Salário','Renda Extra','Outros Recebimentos',
]);

const _AUTO_CAT = Object.freeze([
    // ── Entradas identificáveis PRIMEIRO (evita false-positives de sobrenomes) ─
    [/pix.*receb|receb.*pix|transfer.*receb|pix recebido/i,          { cat: 'entrada', tipo: 'Renda Extra' }],
    [/salario|holerite|pagto.*rh|folha.*pgto/i,                      { cat: 'entrada', tipo: 'Salário' }],
    [/pix.*envia|envia.*pix|transfer.*envia/i,                       { cat: 'saida',   tipo: 'Outros' }],
    // ── Food & delivery ────────────────────────────────────────────────────────
    [/ifood|rappi|uber.*eat|delivery/i,                              { cat: 'saida', tipo: 'Ifood' }],
    [/restauran|lanchon|padaria|pizzar|hamburguer|burger|sushi|churrasc|bar e|snack/i, { cat: 'saida', tipo: 'Ifood' }],
    // ── Marketplaces ───────────────────────────────────────────────────────────
    [/mercado livre|mercadolivre|meli\b/i,                           { cat: 'saida', tipo: 'Mercado Livre' }],
    [/shopee/i,                                                      { cat: 'saida', tipo: 'Shopee' }],
    [/amazon/i,                                                      { cat: 'saida', tipo: 'Amazon' }],
    // ── Supermercado (word-boundary — evita sobrenomes "Mercado") ─────────────
    [/supermercado|carrefour|atacad|hortifruti|pao de acucar|extra\b/i, { cat: 'saida', tipo: 'Mercado' }],
    [/\bsuperm|\bmerced|\bprecito|\bdia\b.*super|sacolao/i,          { cat: 'saida', tipo: 'Mercado' }],
    // ── Farmácia ───────────────────────────────────────────────────────────────
    [/farmacia|drogasil|ultrafarma|pacheco|droga\b|remedios/i,       { cat: 'saida', tipo: 'Farmácia' }],
    // ── Transporte ─────────────────────────────────────────────────────────────
    [/\buber\b|99pop|cabify|combustivel|gasolina|ipiranga|shell\b|posto\b|auto.*posto/i, { cat: 'saida', tipo: 'Transporte' }],
    [/\bmetro\b|onibus|passagem|bilhete/i,                           { cat: 'saida', tipo: 'Transporte' }],
    // ── Assinaturas ────────────────────────────────────────────────────────────
    [/netflix|spotify|\bprime\b|disney\+|hbo|youtube.*prem|twitch|apple.*one/i, { cat: 'saida', tipo: 'Assinaturas' }],
    // ── Academia ───────────────────────────────────────────────────────────────
    [/academia|smartfit|bluefit|bodytech|\bgym\b/i,                  { cat: 'saida', tipo: 'Academia' }],
    // ── Contas fixas ───────────────────────────────────────────────────────────
    [/aluguel|condominio|iptu|energia|enel\b|cemig\b|copel\b|internet|tim\b|claro\b|vivo\b|\boi\b/i, { cat: 'saida', tipo: 'Conta fixa' }],
    // ── Renda extra genérica ────────────────────────────────────────────────────
    [/renda|freelance|autonomo/i,                                    { cat: 'entrada', tipo: 'Renda Extra' }],
]);

function _autoCategorizar(memo) {
    // Normaliza: remove acentos para casar mesmo com encoding quebrado
    // Ex: "TransferÃncia" → "Transferencia" → casa com /transfer.*receb/
    const m = String(memo || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accent combining chars
        .replace(/[^\w\s]/g, ' ')                          // símbolos → espaço
        .toLowerCase();
    for (const [re, res] of _AUTO_CAT) {
        if (re.test(m)) return res;
    }
    return null;
}

// Corrige mojibake em OFX de bancos brasileiros.
// Cobre DOIS cenários distintos:
//   1. Full 2-byte: UTF-8 lido como Windows-1252 (ex: "Ãª" → "ê")
//   2. Truncated 1-byte: banco só grava o 1º byte do UTF-8
//      ê (0xC3 0xAA) → apenas 0xC3 → aparece como "Ã" seguido da próxima letra
//      Ex: "TransferÃncia" (Ã+n) em vez de "TransferÃªncia" (Ã+ª) ou "Transferência"
function _fixMojibake(s) {
    return s
        // ── Caso 1: full 2-byte sequences ─────────────────────────────────────
        .replace(/Ã£/g, 'ã').replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é')
        .replace(/Ãª/g, 'ê').replace(/Ã³/g, 'ó').replace(/Ã§/g, 'ç')
        .replace(/Ã­/g, 'í').replace(/Ã´/g, 'ô').replace(/Ãº/g, 'ú')
        .replace(/Ãà/g, 'à').replace(/Ã£/g, 'ã').replace(/Â /g, ' ')
        // ── Caso 2: truncated 1-byte — palavras bancárias comuns ──────────────
        // "Transfer" + qualquer char que não seja "e" ou "ê" + "ncia"
        // → "TransferÃncia", "Transferencia" (sem acento) → sempre "Transferência"
        .replace(/Transfer[^eê\s]ncia/gi, 'Transferência')
        .replace(/Dep[^oó\s]sito/gi,      'Depósito')
        .replace(/cobran[^cç\s]a/gi,      'Cobrança')
        .replace(/recibo[^s\s]?/gi,       'Recibo')
        // Smart quotes
        .replace(/â€™/g, "'").replace(/â€œ/g, '"').replace(/â€\b/g, '"');
}

// Capitaliza nomes: "JOAO DA SILVA" → "Joao da Silva"
function _capitalizarNome(s) {
    const prep = new Set(['da','de','do','das','dos','e','em','na','no','por','para']);
    return String(s || '').toLowerCase().split(/\s+/).map((w, i) =>
        (i === 0 || !prep.has(w)) ? w.charAt(0).toUpperCase() + w.slice(1) : w
    ).join(' ').trim();
}

// Limpa e formata descrição de extrato bancário.
// Objetivo: PIX e Transferências → "PIX - Nome" ou "Transferência - Nome"
// Remove CNPJ, CPF, agência, conta e sequências numéricas longas.
function _limparDescricao(raw) {
    let s = _fixMojibake(String(raw || '').trim());

    // ── 1. Remove dados sensíveis ──────────────────────────────────────────
    s = s
        .replace(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, '') // CNPJ xx.xxx.xxx/xxxx-xx
        .replace(/\d{3}\.\d{3}\.\d{3}-\d{2}/g,         '') // CPF xxx.xxx.xxx-xx
        .replace(/\bCNPJ\s*/gi,  '').replace(/\bCPF\s*/gi, '')
        .replace(/\bAg\.?\s*\d[\d.\-]*/gi,    '') // Ag. 1234 / Agência 001
        .replace(/\bConta\.?\s*\d[\d.\-]*/gi,  '') // Conta 12345-6
        .replace(/\b(NSU|Ref\.?|Doc\.?)\s*:?\s*[\dA-Z-]+/gi, '');

    // Remove sequências numéricas longas (≥6 dígitos com separadores), sem `\b` no fim
    // para capturar padrões como "10.573.521/" onde "/" é o último char
    s = s.replace(/\b\d[\d.\/\-]{5,}/g, '');

    // Normaliza espaços e traços duplos gerados pelas remoções
    s = s.replace(/\s*[-–]\s*[-–]+\s*/g, ' - ')
         .replace(/\s{2,}/g, ' ')
         .replace(/\s*[-–]\s*$/g, '')  // traço solto no final
         .trim();

    // ── 2. PIX ou Transferência: extrai nome via split por " - " ──────────
    // Estratégia: qualquer transação que contenha "pix" ou começa com "transf"
    // tem o nome da entidade na 1ª parte APÓS o primeiro separador " - ".
    // Não dependemos do prefixo estar com encoding correto.
    const hasPix  = /\bpix\b/i.test(s);
    const hasTed  = /\b(ted|doc)\b/i.test(s);
    const hasTransf = /^transf/i.test(s) || /\btransfer/i.test(s);

    if (hasPix || hasTed || hasTransf) {
        const partes = s.split(/\s*[-–]\s*/);
        // partes[0] = "Transferência enviada pelo Pix" / "Pix enviado" / etc.
        // partes[1] = nome da entidade (o que queremos)
        // partes[2...] = CNPJ/números (já removidos ou irrelevantes)
        for (let i = 1; i < partes.length; i++) {
            const parte = partes[i].trim();
            if (parte.length < 3) continue;
            if (/^\d/.test(parte)) continue;                          // começa com número
            if (/^(CNPJ|CPF|Ag|Op|NSU|Ref)$/i.test(parte)) continue; // só sigla
            const prefix = hasPix ? 'PIX' : (hasTed ? partes[0].trim().toUpperCase().split(' ')[0] : 'Transferência');
            return `${prefix} - ${_capitalizarNome(parte)}`.slice(0, 120);
        }

        // Fallback: "Pix recebido de NOME" sem separador " - "
        const deMatch = s.match(/(?:pix|transf\S*|ted|doc)\s+\S+\s+de\s+([^-–\n]{3,60})/i);
        if (deMatch) {
            const nome = deMatch[1].replace(/\s*[-–].*$/, '').trim();
            if (nome.length > 2)
                return `${hasPix ? 'PIX' : 'Transferência'} - ${_capitalizarNome(nome)}`.slice(0, 120);
        }
    }

    // ── 3. Limpeza genérica (compras, saques, tarifas, etc.) ──────────────
    return s
        .replace(/^compra no d[eé]bito\s*[-–]\s*/i,  '')
        .replace(/^compra no cr[eé]dito\s*[-–]\s*/i, '')
        .replace(/^compra\s*[-–]\s*/i,                '')
        .replace(/^pagamento\s*[-–]\s*/i,             '')
        .replace(/^transfer\S*\s*[-–]\s*/i,           '')
        .replace(/^pix\s*[-–]\s*/i,                   '')
        .replace(/\s*\/\s*\d{2}\.\d{2}\.\d{4}.*$/,  '') // "/ 15.05.2026 ..."
        .replace(/\s*[-–]\s*$/g,                      '')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 200);
}

// ── Parser OFX (SGML — formato exportado por bancos brasileiros) ──────────
function _parseOFX(texto) {
    const linhas = texto.replace(/\r/g, '').split('\n');
    const txs = [];
    let cur = null;

    const get = (tag) => {
        const re = new RegExp(`<${tag}>([^<\\n]+)`, 'i');
        const m  = texto.match(re);
        return m ? m[1].trim() : null;
    };

    for (const linha of linhas) {
        const l = linha.trim();
        if (l === '<STMTTRN>') { cur = {}; continue; }
        if (l === '</STMTTRN>' && cur) { txs.push(cur); cur = null; continue; }
        if (!cur) continue;
        const m = l.match(/^<([^>]+)>(.+)$/);
        if (!m) continue;
        const [, tag, val] = m;
        cur[tag.toUpperCase()] = val.trim();
    }

    return txs.map(t => {
        const rawAmt  = parseFloat(t.TRNAMT || '0');
        const isCredit = rawAmt > 0 || (t.TRNTYPE || '').toUpperCase() === 'CREDIT';
        const valor   = Math.abs(rawAmt);

        // DTPOSTED: 20260510120000[-3:BRT] → DD/MM/YYYY
        const dt = (t.DTPOSTED || '').replace(/\[.*\]/, '').trim();
        const data = dt.length >= 8
            ? `${dt.slice(6,8)}/${dt.slice(4,6)}/${dt.slice(0,4)}`
            : null;

        const memo = t.MEMO || t.NAME || '';
        const auto = _autoCategorizar(memo);

        return {
            _fitid:    t.FITID || '',
            descricao: _limparDescricao(memo),
            valor,
            data,
            categoria: auto?.cat ?? (isCredit ? 'entrada' : 'saida'),
            tipo:      auto?.tipo ?? (isCredit ? 'Outros Recebimentos' : 'Outros'),
            _isCredit: isCredit,
        };
    }).filter(t => t.valor > 0 && t.data);
}

// ── Parser CSV genérico (detecta Nubank e formato padrão) ────────────────
function _parseCSV(texto) {
    const linhas = texto.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (linhas.length < 2) return [];

    const headers = linhas[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());

    // Detecta colunas
    const iData  = headers.findIndex(h => /data|date/i.test(h));
    const iDesc  = headers.findIndex(h => /descri|memo|narrat|hist/i.test(h));
    const iValor = headers.findIndex(h => /valor|amount|value/i.test(h));
    if (iData < 0 || iDesc < 0 || iValor < 0) return [];

    const txs = [];
    for (let i = 1; i < linhas.length; i++) {
        const cols = linhas[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        if (cols.length <= Math.max(iData, iDesc, iValor)) continue;

        const rawAmt  = parseFloat((cols[iValor] || '0').replace(',', '.'));
        if (!isFinite(rawAmt) || rawAmt === 0) continue;

        // Tenta converter data para DD/MM/YYYY
        const rawDate = cols[iData] || '';
        let data = null;
        if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
            const [y,m,d] = rawDate.split('-');
            data = `${d.slice(0,2)}/${m}/${y}`;
        } else if (/^\d{2}\/\d{2}\/\d{4}/.test(rawDate)) {
            data = rawDate.slice(0, 10);
        }
        if (!data) continue;

        const memo  = (cols[iDesc] || '').slice(0, 200);
        const auto  = _autoCategorizar(memo);
        const isPos = rawAmt > 0;

        txs.push({
            _fitid:    `csv_${i}_${rawAmt}_${rawDate}`,
            descricao: _limparDescricao(memo),
            valor:     Math.abs(rawAmt),
            data,
            categoria: auto?.cat ?? (isPos ? 'entrada' : 'saida'),
            tipo:      auto?.tipo ?? (isPos ? 'Outros Recebimentos' : 'Outros'),
            _isCredit: isPos,
        });
    }
    return txs;
}

// ── Deduplicação: detecta provável duplicata por data+valor+sinal ─────────
function _isDuplicata(tx) {
    const existentes = _ctx.transacoes || [];
    return existentes.some(e => {
        if (typeof e.data !== 'string' || !e.valor) return false;
        // Converte DD/MM/YYYY para comparação
        const eISO = _ctx.dataParaISO(e.data);
        const tISO = _ctx.dataParaISO(tx.data);
        if (!eISO || !tISO || eISO !== tISO) return false;
        return Math.abs(parseFloat(e.valor) - tx.valor) < 0.01;
    });
}

// ── Tela de revisão ──────────────────────────────────────────────────────
function _renderRevisao(txs, container) {
    container.innerHTML = '';
    if (txs.length === 0) {
        const p = document.createElement('p');
        p.style.cssText = 'text-align:center; color:var(--text-secondary); padding:24px;';
        p.textContent = 'Nenhuma transação válida encontrada no arquivo.';
        container.appendChild(p);
        return;
    }

    const totalDup = txs.filter(t => t._dup).length;

    const info = document.createElement('div');
    info.className = 'imp-info-bar';
    info.textContent = `${txs.length} transação(ões) encontrada(s)${totalDup > 0 ? ` · ${totalDup} possível(is) duplicata(s)` : ''} — revise e confirme.`;
    container.appendChild(info);

    // — Barra de filtro —
    const filtroWrap = document.createElement('div');
    filtroWrap.className = 'imp-filtro-bar';

    const inputBusca = document.createElement('input');
    inputBusca.type        = 'text';
    inputBusca.className   = 'form-input imp-busca';
    inputBusca.placeholder = '🔍 Buscar descrição…';

    const selFiltro = document.createElement('select');
    selFiltro.className = 'form-input imp-filtro-cat';
    const optTodas = document.createElement('option');
    optTodas.value = ''; optTodas.textContent = 'Todas as categorias';
    selFiltro.appendChild(optTodas);
    [...new Set(txs.map(t => t.tipo))].sort().forEach(tipo => {
        const o = document.createElement('option'); o.value = tipo; o.textContent = tipo;
        selFiltro.appendChild(o);
    });

    filtroWrap.appendChild(inputBusca);
    filtroWrap.appendChild(selFiltro);
    container.appendChild(filtroWrap);

    const lista = document.createElement('div');
    lista.className = 'imp-lista';

    function _aplicarFiltro() {
        const q   = inputBusca.value.toLowerCase().trim();
        const cat = selFiltro.value;
        lista.querySelectorAll('.imp-row').forEach(row => {
            const idx = parseInt(row.dataset.idx, 10);
            const tx  = txs[idx];
            const matchQ   = !q   || tx.descricao.toLowerCase().includes(q);
            const matchCat = !cat || tx.tipo === cat;
            row.style.display = (matchQ && matchCat) ? '' : 'none';
        });
    }
    inputBusca.addEventListener('input',  _aplicarFiltro);
    selFiltro.addEventListener('change', _aplicarFiltro);

    txs.forEach((tx, idx) => {
        const row = document.createElement('div');
        row.className = 'imp-row' + (tx._dup ? ' imp-row--dup' : '');
        row.dataset.idx = String(idx);

        // Checkbox
        const chk = document.createElement('input');
        chk.type    = 'checkbox';
        chk.className = 'imp-chk';
        chk.checked = !tx._dup;
        chk.id      = `imp_chk_${idx}`;
        chk.addEventListener('change', () => { tx._incluir = chk.checked; });
        tx._incluir = !tx._dup;

        const info2 = document.createElement('div');
        info2.className = 'imp-row-info';

        const desc = document.createElement('div');
        desc.className = 'imp-row-desc';
        desc.textContent = _ctx._sanitizeText(tx.descricao);

        const meta = document.createElement('div');
        meta.className = 'imp-row-meta';
        meta.textContent = tx.data;
        if (tx._dup) {
            const badge = document.createElement('span');
            badge.className = 'imp-dup-badge';
            badge.textContent = '⚠️ Duplicata provável';
            meta.appendChild(badge);
        }

        // Select de categoria
        const sel = document.createElement('select');
        sel.className = 'form-input imp-cat-sel';
        _CATEGORIAS_IMPORT.forEach(c => {
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            if (c === tx.tipo) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => { tx.tipo = sel.value; });

        const valor = document.createElement('div');
        valor.className = `imp-row-valor ${tx._isCredit ? 'imp-row-valor--entrada' : 'imp-row-valor--saida'}`;
        valor.textContent = `${tx._isCredit ? '+' : '-'} ${formatBRL(tx.valor)}`;

        info2.appendChild(desc);
        info2.appendChild(meta);

        row.appendChild(chk);
        row.appendChild(info2);
        row.appendChild(sel);
        row.appendChild(valor);
        lista.appendChild(row);
    });

    container.appendChild(lista);
}

// ── Modal principal de importação ────────────────────────────────────────
function abrirImportarExtrato() {
    let txsParsed = [];

    _ctx.criarPopupDOM((box) => {
        box.style.cssText = 'max-width:560px; width:97%;';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'max-height:85vh; overflow-y:auto; overflow-x:hidden;';

        // — Título —
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:4px;';
        const tI = document.createElement('i'); tI.className = 'fas fa-file-import'; tI.style.color = 'var(--primary)';
        titulo.appendChild(tI);
        titulo.appendChild(document.createTextNode('Importar Extrato'));

        const sub = document.createElement('p');
        sub.style.cssText = 'color:var(--text-muted); font-size:0.8rem; margin-bottom:16px;';
        sub.textContent = 'Arquivo processado localmente — nenhum dado é enviado ao servidor.';

        // — Drop zone —
        const dropZone = document.createElement('label');
        dropZone.className = 'imp-drop-zone';
        dropZone.htmlFor   = 'imp-file-input';
        dropZone.innerHTML = `<i class="fas fa-cloud-arrow-up imp-drop-icon"></i><div class="imp-drop-text">Clique ou arraste o arquivo aqui</div><div class="imp-drop-hint">Formatos aceitos: .OFX (todos os bancos) · .CSV (Nubank, inter, padrão)</div>`;

        const fileInput = document.createElement('input');
        fileInput.type    = 'file';
        fileInput.id      = 'imp-file-input';
        fileInput.accept  = '.ofx,.csv,.OFX,.CSV';
        fileInput.style.display = 'none';

        // — Container de revisão —
        const revisaoWrap = document.createElement('div');
        revisaoWrap.id = 'imp-revisao';

        // — Botões de ação —
        const acoes = document.createElement('div');
        acoes.className = 'imp-acoes';
        acoes.style.display = 'none';

        const btnSelAll = document.createElement('button');
        btnSelAll.className = 'orc-btn-add';
        btnSelAll.type = 'button';
        btnSelAll.textContent = 'Selecionar tudo';
        btnSelAll.addEventListener('click', () => {
            revisaoWrap.querySelectorAll('.imp-chk').forEach(c => { c.checked = true; txsParsed[parseInt(c.id.split('_')[2])]._ = true; });
            txsParsed.forEach(t => { t._incluir = true; });
        });

        const btnDesAll = document.createElement('button');
        btnDesAll.className = 'orc-btn-add';
        btnDesAll.style.background = 'rgba(255,75,75,0.1)';
        btnDesAll.style.borderColor = 'rgba(255,75,75,0.3)';
        btnDesAll.style.color = 'var(--danger)';
        btnDesAll.type = 'button';
        btnDesAll.textContent = 'Desmarcar duplicatas';
        btnDesAll.addEventListener('click', () => {
            txsParsed.forEach((t, i) => {
                if (t._dup) {
                    const chk = revisaoWrap.querySelector(`#imp_chk_${i}`);
                    if (chk) { chk.checked = false; }
                    t._incluir = false;
                }
            });
        });

        const btnConfirmar = document.createElement('button');
        btnConfirmar.className = 'btn-primary';
        btnConfirmar.type = 'button';
        btnConfirmar.id   = 'imp-btn-confirmar';
        btnConfirmar.textContent = 'Lançar selecionadas';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar';
        btnCancelar.type = 'button';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        acoes.appendChild(btnSelAll);
        acoes.appendChild(btnDesAll);
        acoes.appendChild(btnConfirmar);
        acoes.appendChild(btnCancelar);

        // — Processar arquivo —
        function processarArquivo(file) {
            if (!file) return;
            const ext = file.name.split('.').pop().toLowerCase();
            if (!['ofx','csv'].includes(ext)) {
                _ctx.mostrarNotificacao('Formato não suportado. Use .ofx ou .csv', 'error');
                return;
            }
            dropZone.classList.add('imp-drop-zone--loading');

            const reader = new FileReader();
            reader.onload = (e) => {
                dropZone.classList.remove('imp-drop-zone--loading');

                // Auto-detecta encoding: lê header ASCII para checar CHARSET,
                // depois decodifica com TextDecoder (UTF-8 ou windows-1252).
                const buf = e.target.result;
                const headerSlice = buf.slice(0, Math.min(1024, buf.byteLength));
                const headerAscii = new TextDecoder('ascii', { fatal: false }).decode(headerSlice);
                const charsetMatch = headerAscii.match(/CHARSET[:\s]+(\S+)/i);
                const declaredUtf8 = /utf-?8/i.test(charsetMatch?.[1] || '');
                const hasBOM = (new Uint8Array(buf, 0, 3)).join(',') === '239,187,191';
                const encoding = (declaredUtf8 || hasBOM) ? 'utf-8' : 'windows-1252';
                const texto = new TextDecoder(encoding, { fatal: false }).decode(buf);

                try {
                    txsParsed = ext === 'ofx' ? _parseOFX(texto) : _parseCSV(texto);
                } catch (err) {
                    _ctx.mostrarNotificacao('Erro ao ler o arquivo. Verifique o formato.', 'error');
                    return;
                }

                // Marca duplicatas
                txsParsed.forEach(t => { t._dup = _isDuplicata(t); });

                _renderRevisao(txsParsed, revisaoWrap);
                const sel = txsParsed.filter(t => t._incluir).length;
                btnConfirmar.textContent = `Lançar ${sel} transação(ões)`;
                acoes.style.display = 'flex';
                dropZone.querySelector('.imp-drop-text').textContent = `✅ ${file.name} — ${txsParsed.length} transações`;
            };
            reader.onerror = () => {
                dropZone.classList.remove('imp-drop-zone--loading');
                _ctx.mostrarNotificacao('Não foi possível ler o arquivo.', 'error');
            };
            reader.readAsArrayBuffer(file);
        }

        fileInput.addEventListener('change', (e) => { processarArquivo(e.target.files[0]); });

        // Drag & drop
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('imp-drop-zone--over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('imp-drop-zone--over'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('imp-drop-zone--over');
            processarArquivo(e.dataTransfer.files[0]);
        });

        // Atualiza contador ao marcar/desmarcar
        revisaoWrap.addEventListener('change', () => {
            const sel = txsParsed.filter(t => t._incluir).length;
            btnConfirmar.textContent = `Lançar ${sel} transação(ões)`;
        });

        // — Confirmar lançamento —
        btnConfirmar.addEventListener('click', () => {
            const selecionadas = txsParsed.filter(t => t._incluir);
            if (selecionadas.length === 0) {
                _ctx.mostrarNotificacao('Nenhuma transação selecionada.', 'warning');
                return;
            }

            let lancadas = 0;
            selecionadas.forEach(tx => {
                const cat = ['entrada','saida','reserva','retirada_reserva'].includes(tx.categoria) ? tx.categoria : 'saida';
                const tipo = _CATEGORIAS_IMPORT.includes(tx.tipo) ? tx.tipo : 'Outros';
                const valor = parseFloat(parseFloat(tx.valor).toFixed(2));
                if (!isFinite(valor) || valor <= 0 || valor > 10_000_000) return;
                if (!/^\d{2}\/\d{2}\/\d{4}$/.test(tx.data)) return;

                _ctx.transacoes.push({
                    categoria: cat,
                    tipo,
                    descricao: _ctx._sanitizeText(tx.descricao).slice(0, 300) || 'Importado do extrato',
                    valor,
                    data:  tx.data,
                    hora:  '00:00:00',
                    metaId: null,
                });
                lancadas++;
            });

            if (lancadas > 0) {
                _ctx.salvarDados();
                _ctx.atualizarTudo();
                renderizarOrcamentos();
                _ctx.fecharPopup();
                _ctx.mostrarNotificacao(`✅ ${lancadas} transaç${lancadas === 1 ? 'ão lançada' : 'ões lançadas'} com sucesso!`, 'success');
            } else {
                _ctx.mostrarNotificacao('Nenhuma transação válida para lançar.', 'error');
            }
        });

        wrap.appendChild(titulo);
        wrap.appendChild(sub);
        wrap.appendChild(dropZone);
        wrap.appendChild(fileInput);
        wrap.appendChild(revisaoWrap);
        box.appendChild(wrap);
        box.appendChild(acoes);
    });
}
