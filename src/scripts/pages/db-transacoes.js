// db-transacoes.js — Seção de Transações (lazy-loaded)
let _ctx = null;

export function init(ctx) {
    _ctx = ctx;
    window._dbTransacoes = { atualizarMovimentacoesUI };
    window.lancarTransacao     = () => lancarTransacao();
    window.abrirDetalhesTransacao = (t) => abrirDetalhesTransacao(t);
    bindFiltrosMovimentacoes();
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
        ['Mercado', 'Farmácia', 'Eletrônico', 'Roupas', 'Assinaturas', 'Beleza', 'Presente', 
         'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte', 'Shopee', 'Mercado Livre', 
         'Ifood', 'Amazon', 'Outros', 'Transação Via Chat'].forEach(x => {
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
let _ctx._movPaginaAtual  = 1;
let _ctx._movVisivelCache = [];   // backing array for delegated click handler
let _ctx._movDelegateSet  = false;

function _renderizarItemMovimentacao(t, lista) {
    const dataExibida = _ctx._sanitizeText(t.data || '');
    return { dataExibida, t };
}

function _ctx.atualizarMovimentacoesUI(resetPagina = true) {
    const lista = document.getElementById('listaMovimentacoes');
    if (!lista) return;

    // Event delegation — um único listener para todos os itens da lista
    if (!_ctx._movDelegateSet) {
        lista.addEventListener('click', e => {
            const item = e.target.closest('.mov-item');
            if (!item) return;
            const idx = parseInt(item.dataset.txIdx, 10);
            if (!isNaN(idx) && _ctx._movVisivelCache[idx]) abrirDetalhesTransacao(_ctx._movVisivelCache[idx]);
        });
        _ctx._movDelegateSet = true;
    }

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

    // Usar DocumentFragment para inserir todos os itens em um único reflow
    const frag     = document.createDocumentFragment();
    let ultimaData = null;

    visivel.forEach((t, txIdx) => {
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

        const categoriasPermitidas = ['entrada', 'saida', 'reserva', 'retirada_reserva'];
        const categoriaSegura = categoriasPermitidas.includes(t.categoria) ? t.categoria : 'saida';

        const iconeBadge     = document.createElement('div');
        iconeBadge.className = `mov-icon-badge ${categoriaSegura}`;

        const iconeEl = document.createElement('i');
        iconeEl.className = `fas ${_obterIconeTransacao(t.categoria, t.tipo)}`;
        iconeEl.setAttribute('aria-hidden', 'true');
        iconeBadge.appendChild(iconeEl);

        const left    = document.createElement('div');
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

        const sinal = (t.categoria === 'entrada' || t.categoria === 'retirada_reserva') ? '+' : '-';

        const divValor       = document.createElement('div');
        divValor.className   = categoriaSegura;
        divValor.textContent = `${sinal} ${formatBRL(t.valor)}`;
        right.appendChild(divValor);

        div.dataset.txIdx = txIdx;
        div.appendChild(iconeBadge);
        div.appendChild(left);
        div.appendChild(right);

        frag.appendChild(div);
    });

    lista.appendChild(frag);

    // Botão "Carregar mais" — evita renderizar centenas de itens de uma vez
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

function abrirDetalhesTransacao(t) {
    if (!t) return;

    // ✅ HTML estático — zero dados do usuário interpolados
    _ctx.criarPopup(`
        <h3>Detalhes da Transação</h3>
        <div class="small" id="detTransId"></div>
        <div style="text-align:left; margin:20px 0; color: var(--text-secondary);">
            <b>Categoria:</b> <span id="detCategoria"></span><br>
            <b>Tipo:</b>      <span id="detTipo"></span><br>
            <b>Descrição:</b> <span id="detDescricao"></span><br>
            <b>Valor:</b>     <span id="detValor"></span><br>
            <b>Data:</b>      <span id="detData"></span><br>
            <b>Hora:</b>      <span id="detHora"></span>
        </div>
        <button class="btn-excluir" id="delTransBtn">Excluir</button>
        <button class="btn-primary" id="fecharDetalhesBtn">Fechar</button>
    `);

    // ✅ Preenchimento via textContent — nunca innerHTML com dados do usuário
    document.getElementById('detTransId').textContent  = t.id ? `ID: ${String(t.id).slice(0, 40)}` : '';
    document.getElementById('detCategoria').textContent = _ctx._sanitizeText(t.categoria);
    document.getElementById('detTipo').textContent      = _ctx._sanitizeText(t.tipo);
    document.getElementById('detDescricao').textContent = _ctx._sanitizeText(t.descricao);
    document.getElementById('detValor').textContent     = _ctx.formatBRL(t.valor);
    document.getElementById('detData').textContent      = _ctx._sanitizeText(t.data);
    document.getElementById('detHora').textContent      = _ctx._sanitizeText(t.hora);

    // ✅ addEventListener — sem onclick inline
    document.getElementById('fecharDetalhesBtn').addEventListener('click', () => _ctx.fecharPopup());

    document.getElementById('delTransBtn').addEventListener('click', () => {
        _ctx.transacoes = _ctx.transacoes.filter(x => x !== t);

        if (t.categoria === 'reserva' && t.metaId) {
            const meta = _ctx.metas.find(m => String(m.id) === String(t.metaId));
            if (meta) {
                meta.saved = Number((Number(meta.saved || 0) - Number(t.valor)).toFixed(2));
                const ym = _ctx.yearMonthKey(t.data);
                if (meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym]) - Number(t.valor)).toFixed(2));
                }
            }
        } else if (t.categoria === 'retirada_reserva' && t.metaId) {
            const meta = _ctx.metas.find(m => String(m.id) === String(t.metaId));
            if (meta) {
                meta.saved = Number((Number(meta.saved || 0) + Number(t.valor)).toFixed(2));
                const ym = _ctx.yearMonthKey(t.data);
                if (meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + Number(t.valor)).toFixed(2));
                }
            }
        }

        _ctx.salvarDados();
        _ctx.atualizarTudo();
        _ctx.fecharPopup();
    });
}
