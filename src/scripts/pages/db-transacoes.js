// db-transacoes.js — Seção de Transações (lazy-loaded)
import { perfMark, perfMeasure, perfCount } from '../modules/perf-marks.js';
import { chipHorasVida } from '../modules/horas-vida.js?v=1';
import { construirModelo, sugerirCategoria } from '../modules/categorizacao.js?v=1';
import { gerarParcelas, anexarParcelas, paraISO } from '../modules/fatura-parcelas.js?v=1';

let _ctx = null;

// Proxy para utilitários de dashboard.js disponíveis via _ctx após init()
const formatBRL = (...a) => _ctx.formatBRL(...a);

// Chip "⏱ Xh de trabalho" ao lado de valores de saída (Horas de Vida).
// Retorna null se o recurso está desativado — appendChild condicional.
function _chipHoras(t, cat) {
    if (cat !== 'saida' && cat !== 'saida_credito') return null;
    try { return chipHorasVida(t.valor, _ctx.configPerfil); } catch { return null; }
}

export function init(ctx) {
    _ctx = ctx;
    window._dbTransacoes = { atualizarMovimentacoesUI };
    window.lancarTransacao          = () => lancarTransacao();
    window.abrirDetalhesTransacao   = (t) => abrirDetalhesTransacao(t);
    window.atualizarTiposDinamicos  = () => atualizarTiposDinamicos();

    // Botões de ação de transações — via addEventListener (CSP não permite inline onclick)
    const btnImport = document.getElementById('btnImportarExtrato');
    if (btnImport) {
        const newBtn = btnImport.cloneNode(true);
        btnImport.parentNode.replaceChild(newBtn, btnImport);
        newBtn.addEventListener('click', () => abrirImportarExtrato());
    }

    // Categorização em lote + gerenciar regras. As funções (_categorizarTudo /
    // _abrirGerenciarRegras) já eram completas — só faltava o ponto de entrada.
    const btnCat = document.getElementById('btnCategorizarTudo');
    if (btnCat) {
        const nb = btnCat.cloneNode(true);
        btnCat.parentNode.replaceChild(nb, btnCat);
        nb.addEventListener('click', () => _categorizarTudo());
    }
    const btnRegras = document.getElementById('btnGerenciarRegras');
    if (btnRegras) {
        const nb = btnRegras.cloneNode(true);
        btnRegras.parentNode.replaceChild(nb, btnRegras);
        nb.addEventListener('click', () => _abrirGerenciarRegras());
    }

    atualizarTiposDinamicos();
    _initAutoCategorizar();
    bindFiltrosMovimentacoes();
    renderizarOrcamentos();
    atualizarMovimentacoesUI();
}

// ========== TRANSAÇÕES ==========
function atualizarTiposDinamicos() {
    const cat = document.getElementById('selectCategoria').value;
    const tipoSelect = document.getElementById('selectTipo');
    const tipoWrap   = document.getElementById('tipoFieldWrap');
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
    } else if(cat === 'saida' || cat === 'saida_credito' || !cat) {
        const tiposPadrao = ['Mercado', 'Farmácia', 'Saúde', 'Eletrônico', 'Roupas', 'Assinaturas',
         'Beleza', 'Presente', 'Conta fixa', 'Cartão', 'Academia', 'Lazer', 'Transporte',
         'Viagem', 'Pet', 'Shopee', 'Mercado Livre', 'Ifood', 'Amazon', 'Educação', 'Outros'];
        const personalizados = (_ctx?.tiposPersonalizados || []).filter(t => typeof t === 'string' && t.trim());
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
    // cat === 'assinatura' não usa "tipo" — a própria assinatura é o tipo

    if (tipoWrap) tipoWrap.classList.toggle('js-hidden', cat === 'assinatura');

    atualizarCamposCredito();
}

// Popula um <select> de cartões — reutilizado pelos fluxos de crédito e assinatura
function _popularSelectCartao(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';

    if (_ctx.cartoesCredito.length === 0) {
        const opt       = document.createElement('option');
        opt.value       = '';
        opt.textContent = 'Cadastre um cartão no menu "Cartões"';
        selectEl.appendChild(opt);
        selectEl.disabled = true;
        return;
    }

    // ✅ Opção placeholder
    const placeholder       = document.createElement('option');
    placeholder.value       = '';
    placeholder.textContent = 'Selecione o cartão';
    selectEl.appendChild(placeholder);

    // ✅ Cada cartão via DOM — nomeBanco e id nunca passam por innerHTML
    _ctx.cartoesCredito.forEach(c => {
        const opt       = document.createElement('option');
        opt.value       = String(c.id);          // ✅ atribuição direta — não interpolado
        opt.textContent = _ctx._sanitizeText(c.nomeBanco); // ✅ sanitizado via textContent
        selectEl.appendChild(opt);
    });

    selectEl.disabled = false;
}

function atualizarCamposCredito() {
    const creditDiv       = document.getElementById('creditoFields');
    const parcelasSelect  = document.getElementById('selectParcelas');
    const cartaoSelect    = document.getElementById('selectCartao');
    const assinaturaDiv   = document.getElementById('assinaturaFields');
    const cartaoAssinSel  = document.getElementById('selectCartaoAssinatura');
    const catVal          = document.getElementById('selectCategoria').value;

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
        assinaturaDiv?.classList.add('js-hidden');
        _popularSelectCartao(cartaoSelect);
    } else if (catVal === 'assinatura') {
        creditDiv.classList.add('js-hidden');
        assinaturaDiv?.classList.remove('js-hidden');
        _popularSelectCartao(cartaoAssinSel);
    } else {
        creditDiv.classList.add('js-hidden');
        assinaturaDiv?.classList.add('js-hidden');
    }
}

// Sinaliza um campo inválido inline: aria-invalid + borda/shake + foco + toast.
// Limpa o estado automaticamente quando o usuário corrige o campo.
function _campoInvalido(el, mensagem) {
    if (el) {
        el.setAttribute('aria-invalid', 'true');
        el.classList.remove('campo-invalido');
        void el.offsetWidth; // reinicia a animação de shake
        el.classList.add('campo-invalido');
        const limpar = () => {
            el.removeAttribute('aria-invalid');
            el.classList.remove('campo-invalido');
        };
        el.addEventListener('input',  limpar, { once: true });
        el.addEventListener('change', limpar, { once: true });
        try { el.focus({ preventScroll: false }); } catch (_) {}
    }
    _ctx.mostrarNotificacao?.(mensagem, 'error');
}

function lancarTransacao() {
    let categoria = document.getElementById('selectCategoria').value;
    const descricao = document.getElementById('inputDescricao').value.trim();

    // Auto-aplicar categoria se usuário não escolheu mas digitou uma descrição reconhecível
    if (!categoria && descricao.length >= 3) {
        const auto = _autoCatComAprendizado(descricao);
        if (auto) {
            document.getElementById('selectCategoria').value = auto.cat;
            atualizarTiposDinamicos();
            if (auto.tipo) document.getElementById('selectTipo').value = auto.tipo;
            categoria = auto.cat;
        }
    }

    // Categoria padrão quando vazia — sistema aprende com edições futuras
    if (!categoria) {
        categoria = 'saida';
        document.getElementById('selectCategoria').value = 'saida';
        atualizarTiposDinamicos();
    }

    let tipo = document.getElementById('selectTipo').value;
    // Auto-seleciona primeiro tipo disponível para não bloquear o lançamento
    if (!tipo && categoria !== 'saida_credito') {
        const selTipo = document.getElementById('selectTipo');
        const firstOpt = [...selTipo.options].find(o => o.value !== '');
        tipo = firstOpt?.value ?? 'Outros';
        selTipo.value = tipo;
    }

    const valorEl   = document.getElementById('inputValor');
    // Suporte à máscara monetária: lê dataset.valorNumerico se disponível, senão parseia string
    const valorStr  = valorEl.dataset?.valorNumerico
        || valorEl.value.replace(/\./g, '').replace(',', '.');

    if(categoria === 'reserva' && _ctx.metas.filter(m => m.id !== 'emergency').length === 0) {
        return _ctx.mostrarNotificacao('Você ainda não criou nenhuma meta ou reserva, crie no menu "Reservas"', 'error');
    }
    if(!descricao) return _campoInvalido(document.getElementById('inputDescricao'), 'Digite a descrição.');
    if(!valorStr || !Number.isFinite(Number(valorStr)) || Number(valorStr) <= 0) return _campoInvalido(valorEl, 'Digite um valor válido.');

    const valor = parseFloat(parseFloat(valorStr).toFixed(2));
    const dh    = _ctx.agoraDataHora();

    if(categoria === 'saida_credito') {
        const cartaoSel   = document.getElementById('selectCartao').value;
        const parcelasSel = Number(document.getElementById('selectParcelas').value);

        if(!cartaoSel)   return _ctx.mostrarNotificacao("Selecione o cartão!", 'error');
        if(!parcelasSel) return _ctx.mostrarNotificacao("Selecione a quantidade de parcelas!", 'error');

        const cartao = _ctx.cartoesCredito.find(c => String(c.id) === String(cartaoSel));
        if(!cartao) return _ctx.mostrarNotificacao("Cartão não encontrado!", 'error');
        if(cartao.congelado) { _ctx.mostrarNotificacao('Cartão congelado. Descongele no menu de Cartões para utilizá-lo.', 'error'); return; }

        if(!confirm(`Compra de ${formatBRL(valor)} no cartão ${cartao.nomeBanco}, em ${parcelasSel}x de ${formatBRL(valor/parcelasSel)}.\nProsseguir?`)) return;

        // MODELO NOVO (2026-07-17): a compra vira N parcelas, uma por fatura
        // mensal — não mais 1 objeto numa fatura só. O motor calcula os
        // vencimentos (mesma regra de ciclo de antes) e distribui.
        // Ver modules/fatura-parcelas.js.
        const dataCompraISO = paraISO(dh.data) || new Date().toISOString().slice(0, 10);
        const geradas = gerarParcelas({
            cartao,
            tipo,
            descricao,
            valorTotal:  valor,
            parcelas:    parcelasSel,
            dataCompraISO,
        });

        if (geradas.length === 0) {
            _ctx.mostrarNotificacao('Não foi possível lançar a compra. Verifique os dados do cartão.', 'error');
            return;
        }

        anexarParcelas(_ctx.contasFixas, cartao, geradas);
        cartao.usado = (cartao.usado || 0) + valor;

        _ctx.salvarDados();
        _ctx.atualizarTudo();

        document.getElementById('selectCategoria').value = '';
        atualizarTiposDinamicos();
        document.getElementById('inputDescricao').value = '';
        document.getElementById('inputValor').value     = '';

        _ctx.mostrarNotificacao?.('Compra lançada! A fatura do cartão foi atualizada.', 'success');
        return;
    }

    if(categoria === 'assinatura') {
        const cartaoSel = document.getElementById('selectCartaoAssinatura').value;
        const diaSel    = document.getElementById('selectDiaCobranca').value;

        if(!cartaoSel) return _ctx.mostrarNotificacao("Selecione o cartão!", 'error');
        if(!diaSel)    return _ctx.mostrarNotificacao("Selecione o dia de cobrança!", 'error');

        const cartao = _ctx.cartoesCredito.find(c => String(c.id) === String(cartaoSel));
        if(!cartao) return _ctx.mostrarNotificacao("Cartão não encontrado!", 'error');
        if(cartao.congelado) { _ctx.mostrarNotificacao('Cartão congelado. Descongele no menu de Cartões para utilizá-lo.', 'error'); return; }

        const diaCobranca = Number(diaSel);
        if(!Number.isInteger(diaCobranca) || diaCobranca < 1 || diaCobranca > 28) return _ctx.mostrarNotificacao("Dia de cobrança inválido!", 'error');

        if(!confirm(`Criar assinatura "${descricao}" de ${formatBRL(valor)} no cartão ${cartao.nomeBanco}, com cobrança todo dia ${diaCobranca}.\nProsseguir?`)) return;

        const novaAssinatura = {
            id: (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `assinatura_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            nome:           descricao,
            valor,
            cartaoId:       cartao.id,
            diaCobranca,
            ativa:          true,
            criadaEm:       _ctx.isoDate(),
            ultimaCobranca: null,
        };

        // Lança a 1ª cobrança imediatamente, atribuída ao ciclo de fatura atual
        _ctx.assinaturas.push(novaAssinatura);
        _ctx.gerarCobrancasAssinaturas();
        _ctx.salvarDados();
        _ctx.atualizarTudo();

        document.getElementById('selectCategoria').value  = '';
        atualizarTiposDinamicos();
        document.getElementById('inputDescricao').value   = '';
        document.getElementById('inputValor').value       = '';
        document.getElementById('selectDiaCobranca').value = '';

        _ctx.mostrarNotificacao?.('Assinatura criada! A primeira cobrança já foi lançada na fatura do cartão.', 'success');
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

        document.getElementById('selectCategoria').value = '';
        atualizarTiposDinamicos();
        document.getElementById('inputDescricao').value = '';
        document.getElementById('inputValor').value     = '';

        _ctx.mostrarNotificacao?.('Transação lançada com sucesso!', 'success');
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
    if (t.includes('pet') || t.includes('veterinário') || t.includes('ração')) return 'fa-paw';

    return 'fa-arrow-up-right-dots';
}

// Varre TODAS as transações do perfil e roda a cada atualização da lista — com
// milhares de lançamentos é o trecho mais quente da tela.
//
// O que era caro (medido com 10 mil transações: 11,3 ms → 1,9 ms por chamada):
//   1. o limite de data era recalculado DENTRO do loop (`new Date(hoje)` +
//      setDate por transação), mas é constante — agora sai uma vez só;
//   2. cada transação virava um objeto Date só para ser comparada. Como as datas
//      já são 'YYYY-MM-DD', comparar STRING dá o mesmo resultado (ordem
//      lexicográfica == cronológica nesse formato) sem alocar nada.
// Equivalência conferida contra a versão antiga em 72 combinações de
// filtro × busca × mês/ano, incluindo as bordas (dia 14/15, 29/30, 59/60,
// datas futuras, data vazia e data inválida): zero divergências.
function filtrarTransacoesParaUI() {
    const filtro = _ctx.filtroMovAtivo;
    const termo  = _movBuscaTerm;

    // Sem filtro e sem busca não há o que decidir — evita varrer à toa.
    if (filtro === 'todo' && !termo) return _ctx.transacoes.slice();

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const isoDe   = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hojeISO = isoDe(hoje);

    // ── Limites do período: calculados UMA vez, fora do loop ───────────────
    let limISO = null;      // filtros "últimos N dias"
    let prefMes = null;     // filtros de mês inteiro ('YYYY-MM')
    if (filtro === '15_dias' || filtro === '30_dias' || filtro === '60_dias') {
        const dias = filtro === '15_dias' ? 14 : filtro === '30_dias' ? 29 : 59;
        const lim = new Date(hoje); lim.setDate(hoje.getDate() - dias);
        limISO = isoDe(lim);
    } else if (filtro === 'mes_atual') {
        prefMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    } else if (filtro === 'periodo') {
        const mes = _ctx.filtroMovMes !== null ? _ctx.filtroMovMes : hoje.getMonth();
        const ano = _ctx.filtroMovAno !== null ? _ctx.filtroMovAno : hoje.getFullYear();
        prefMes = `${ano}-${String(mes + 1).padStart(2, '0')}`;
    }

    return _ctx.transacoes.filter(t => {
        // ── Filtro de período (comparação de string, sem alocar Date) ──────
        if (filtro !== 'todo') {
            const iso = _ctx.dataParaISO(t.data || '');
            if (!iso) return false;
            if (prefMes !== null) {
                if (!iso.startsWith(prefMes)) return false;
            } else if (limISO !== null) {
                if (iso < limISO || iso > hojeISO) return false;
            }
        }

        // ── Filtro de busca textual ────────────────────────────────────────
        if (termo) {
            const desc = (t.descricao || '').toLowerCase();
            if (!desc.includes(termo) && !(t.tipo || '').toLowerCase().includes(termo)) return false;
        }

        return true;
    });
}

function bindFiltrosMovimentacoes() {
    _initBusca(); // inicia busca textual junto com os filtros
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
        // Feedback visual de período ativo
        if (typeof window._atualizarFeedbackPeriodo === 'function') {
            window._atualizarFeedbackPeriodo();
        }

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

// ── Busca textual ──────────────────────────────────────────────────────────
let _movBuscaTerm = ''; // termo atual de busca (normalizado)
let _movScrollObserver = null; // IntersectionObserver para carregar mais ao rolar

// ── Estado do render incremental do extrato ──────────────────────────────────
// Renderizamos APENAS o modo visível (tabela no desktop OU cards no mobile, breakpoint
// 640px = mesmo do CSS) e anexamos só a página nova ao rolar — sem reconstruir tudo.
const _mqMovMobile = window.matchMedia('(max-width: 640px)');
let _movMode      = null;   // 'table' | 'cards' | null (nada renderizado)
let _movContainer = null;   // <table> ou <div.mov-cards> atualmente no DOM
let _movRowsHost  = null;   // onde anexar novas linhas: <tbody> (tabela) ou wrapper (cards)
let _movCardState = { ultimaData: null }; // separador de data persiste entre páginas
let _movResizeBound = false; // garante 1 listener de breakpoint só

function _initBusca() {
    const input  = document.getElementById('movBuscaInput');
    const btnClr = document.getElementById('movBuscaClear');
    if (!input) return;

    // DEBOUNCE — a causa real do travamento ao digitar. Sem ele, CADA tecla
    // disparava: varredura de todas as transações + cópia do array + rebuild da
    // lista no DOM. Digitar "mercado" custava 7 re-renderizações completas, e
    // com milhares de lançamentos o campo engasgava a cada letra.
    // 180 ms: abaixo disso ainda dispara no meio de uma palavra; acima começa a
    // parecer que a busca não respondeu.
    let _buscaTimer = null;
    input.addEventListener('input', () => {
        // O botão de limpar reage NA HORA — é resposta visual, não custa nada.
        if (btnClr) btnClr.classList.toggle('js-hidden', !input.value.trim());
        clearTimeout(_buscaTimer);
        _buscaTimer = setTimeout(() => {
            _movBuscaTerm = input.value.trim().toLowerCase();
            _ctx._movPaginaAtual = 1;
            _ctx.atualizarMovimentacoesUI(true);
        }, 180);
    });

    if (btnClr) {
        btnClr.addEventListener('click', () => {
            input.value  = '';
            _movBuscaTerm = '';
            btnClr.classList.add('js-hidden');
            _ctx._movPaginaAtual = 1;
            _ctx.atualizarMovimentacoesUI(true);
            input.focus();
        });
    }
}

const _CAT_LABELS = { entrada: 'Entrada', saida: 'Saída', reserva: 'Reserva', retirada_reserva: 'Retirada' };
const _CAT_PERMITIDAS = ['entrada', 'saida', 'reserva', 'retirada_reserva'];
const _TIPO_ICON = {
    entrada:          'fa-arrow-up',
    saida:            'fa-arrow-down',
    reserva:          'fa-piggy-bank',
    retirada_reserva: 'fa-wallet',
};

// Cria UMA linha <tr> da tabela. Isolada para permitir append incremental.
function _criarLinhaTabela(t) {
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
    const chipTab = _chipHoras(t, cat);
    if (chipTab) tdValor.appendChild(chipTab);
    tr.appendChild(tdValor);

    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => editarTransacao(t));

    return tr;
}

// Anexa linhas ao <tbody> existente (via fragment — 1 reflow só).
function _appendLinhasTabela(tbody, txs) {
    const frag = document.createDocumentFragment();
    txs.forEach(t => frag.appendChild(_criarLinhaTabela(t)));
    tbody.appendChild(frag);
}

// Constrói a tabela vazia (thead + tbody) e popula com `visivel`.
// Retorna { table, tbody } para que o tbody seja reaproveitado nos appends.
function _buildTable(visivel) {
    const table = document.createElement('table');
    table.className = 'mov-table';

    const thead  = document.createElement('thead');
    const trHead = document.createElement('tr');
    ['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor'].forEach(col => {
        const th = document.createElement('th');
        th.textContent = col;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    _appendLinhasTabela(tbody, visivel);
    table.appendChild(tbody);
    return { table, tbody };
}


// Anexa cards ao wrapper existente. `state.ultimaData` persiste entre páginas
// para o separador de data não duplicar/saltar na fronteira de uma página e outra.
function _appendCards(wrapper, txs, state) {
    const frag = document.createDocumentFragment();

    txs.forEach(t => {
        const cat         = _CAT_PERMITIDAS.includes(t.categoria) ? t.categoria : 'saida';
        const dataExibida = _ctx._sanitizeText(t.data || '');

        if (dataExibida && dataExibida !== state.ultimaData) {
            state.ultimaData = dataExibida;
            const sep       = document.createElement('div');
            sep.className   = 'mov-date-separator';
            sep.textContent = dataExibida;
            frag.appendChild(sep);
        }

        const div     = document.createElement('div');
        div.className = 'mov-item';
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => editarTransacao(t));

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
        const chipCard = _chipHoras(t, cat);
        if (chipCard) right.appendChild(chipCard);

        div.appendChild(iconeBadge);
        div.appendChild(left);
        div.appendChild(right);

        frag.appendChild(div);
    });

    wrapper.appendChild(frag);
}

// Constrói o wrapper de cards e popula com `visivel`. `state` é o objeto de
// separador de data reaproveitado nos appends seguintes.
function _buildCards(visivel, state) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mov-cards';
    _appendCards(wrapper, visivel, state);
    return wrapper;
}

// Renderiza o estado vazio (sem transações ou busca sem resultado).
function _renderMovVazio(lista) {
    const wrap = document.createElement('div');
    wrap.className = 'mov-empty-state';

    const icon = document.createElement('div');
    icon.className = 'mov-empty-icon';
    icon.innerHTML = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>`;

    const title = document.createElement('p');
    title.className = 'mov-empty-title';
    title.textContent = _movBuscaTerm
        ? `Nenhum resultado para "${_movBuscaTerm}"`
        : 'Nenhuma movimentação registrada';

    const sub = document.createElement('p');
    sub.className = 'mov-empty-sub';
    sub.textContent = _movBuscaTerm
        ? 'Tente outro termo de busca.'
        : 'Registre sua primeira transação no formulário acima.';

    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(sub);

    if (!_movBuscaTerm) {
        const btn = document.createElement('button');
        btn.className = 'btn-primary mov-empty-cta';
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> Lançar transação';
        btn.addEventListener('click', () => {
            document.getElementById('selectCategoria')?.focus();
            document.getElementById('selectCategoria')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        wrap.appendChild(btn);
    }

    lista.appendChild(wrap);
}

// (Re)cria a sentinela de scroll-infinito ou o rodapé de total, sempre no fim da lista.
function _renderMovRodape(lista, total, restam) {
    if (restam > 0) {
        const sentinela = document.createElement('div');
        sentinela.className = 'mov-load-sentinela';
        sentinela.setAttribute('aria-hidden', 'true');

        const info = document.createElement('p');
        info.className = 'mov-load-info';
        info.textContent = `Carregando mais ${Math.min(restam, MOV_POR_PAGINA)} de ${restam} movimentações…`;
        sentinela.appendChild(info);

        lista.appendChild(sentinela);

        _movScrollObserver = new IntersectionObserver((entries) => {
            if (!entries[0].isIntersecting) return;
            _movScrollObserver.disconnect();
            _movScrollObserver = null;
            _ctx._movPaginaAtual++;
            _ctx.atualizarMovimentacoesUI(false);
        }, { rootMargin: '200px' });

        _movScrollObserver.observe(sentinela);
    } else {
        const footer = document.createElement('p');
        footer.className = 'mov-load-total';
        footer.textContent = `${total} ${total === 1 ? 'movimentação' : 'movimentações'} no período`;
        lista.appendChild(footer);
    }
}

// Re-renderiza ao cruzar o breakpoint 640px (desktop⇄mobile). Sem isso, o container
// renderizado (só um modo) ficaria escondido pelo CSS e a lista sumiria. Registra 1 vez.
function _bindMovBreakpoint() {
    if (_movResizeBound) return;
    _movResizeBound = true;
    const onChange = () => {
        // Só re-renderiza se a aba de transações está montada (lista existe e tem modo ativo)
        if (_movMode && document.getElementById('listaMovimentacoes')) {
            atualizarMovimentacoesUI(false);
        }
    };
    if (_mqMovMobile.addEventListener) _mqMovMobile.addEventListener('change', onChange);
    else _mqMovMobile.addListener(onChange); // Safari < 14
}

function atualizarMovimentacoesUI(resetPagina = true) {
    const lista = document.getElementById('listaMovimentacoes');
    if (!lista) return;
    perfMark('mov:render');

    _bindMovBreakpoint();

    // Desconecta observer anterior para evitar disparos duplos
    if (_movScrollObserver) { _movScrollObserver.disconnect(); _movScrollObserver = null; }

    if (resetPagina) _ctx._movPaginaAtual = 1;

    // `.reverse()` direto: filtrarTransacoesParaUI() já devolve um array NOVO
    // (filter/slice), então o `.slice()` que havia aqui era uma segunda cópia de
    // toda a lista a cada render — inverter no lugar não afeta `_ctx.transacoes`.
    const todos   = filtrarTransacoesParaUI().reverse();
    const total   = todos.length;
    const pagina  = _ctx._movPaginaAtual;
    const fim     = pagina * MOV_POR_PAGINA;
    const visivel = todos.slice(0, fim);
    const restam  = total - visivel.length;

    if (total === 0) {
        lista.innerHTML = '';
        _movMode = null; _movContainer = null; _movRowsHost = null;
        _renderMovVazio(lista);
        perfMeasure('mov:render', 'vazio');
        return;
    }

    _ctx._movVisivelCache = visivel;

    const modoAtual    = _mqMovMobile.matches ? 'cards' : 'table';
    const precisaFresh = resetPagina || _movMode !== modoAtual || !_movContainer || !_movContainer.isConnected;

    if (precisaFresh) {
        // Render do zero: reset de filtro/mês/busca OU mudança de modo (resize de breakpoint).
        lista.innerHTML = '';
        _movCardState = { ultimaData: null };
        _movMode = modoAtual;
        if (modoAtual === 'cards') {
            _movContainer = _buildCards(visivel, _movCardState);
            _movRowsHost  = _movContainer; // cards anexam direto no wrapper
        } else {
            const { table, tbody } = _buildTable(visivel);
            _movContainer = table;
            _movRowsHost  = tbody;
        }
        lista.appendChild(_movContainer);
    } else {
        // Load-more incremental: anexa SÓ a página nova ao container que já existe.
        // Antes era innerHTML='' + rebuild de TUDO (O(n²) ao rolar) — agora é O(página).
        const novos = todos.slice((pagina - 1) * MOV_POR_PAGINA, fim);
        lista.querySelector('.mov-load-sentinela')?.remove();
        lista.querySelector('.mov-load-total')?.remove();
        if (_movMode === 'cards') _appendCards(_movRowsHost, novos, _movCardState);
        else                      _appendLinhasTabela(_movRowsHost, novos);
    }

    _renderMovRodape(lista, total, restam);

    perfMeasure('mov:render', `${precisaFresh ? 'fresh' : 'append'} modo=${_movMode} total=${total} visíveis=${visivel.length}`);
    perfCount('mov:nós-DOM-lista', lista.querySelectorAll('*').length, `(página ${pagina})`);
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

            if (!novaDesc) return _ctx.mostrarNotificacao('Digite a descrição.', 'error');
            const novoValor = parseFloat(parseFloat(novoValorStr).toFixed(2));
            if (!novoValorStr || !Number.isFinite(novoValor) || novoValor <= 0) return _ctx.mostrarNotificacao('Digite um valor válido.', 'error');

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
    const idx = _ctx.transacoes.indexOf(t);
    if (idx === -1) return;

    // Snapshot do vínculo com meta (para reverter o saldo no Desfazer).
    const metaInfo = (() => {
        if (!t.metaId) return null;
        const meta = _ctx.metas.find(m => String(m.id) === String(t.metaId));
        if (!meta) return null;
        const ym = _ctx.yearMonthKey(t.data);
        return { meta, ym, tinhaMonthly: !!(meta.monthly && meta.monthly[ym]) };
    })();

    // sinal usado na REMOÇÃO; o Desfazer aplica o sinal oposto.
    const sinalRemover = t.categoria === 'reserva' ? -1 : 1;
    const aplicarDelta = (sinal) => {
        if (!metaInfo) return;
        const { meta, ym, tinhaMonthly } = metaInfo;
        meta.saved = Number((Number(meta.saved || 0) + sinal * Number(t.valor)).toFixed(2));
        if (tinhaMonthly) {
            meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + sinal * Number(t.valor)).toFixed(2));
        }
    };

    // D3: se esta transação é o PAGAMENTO de uma parcela (tem faturaId+compraId),
    // excluí-la volta a parcela para NÃO paga (e o Desfazer volta a marcar paga).
    // Sem isto, pagava-se 1/5, ficava 2/5, e excluir a transação não revertia.
    const parcelaInfo = (() => {
        if (!t.faturaId || !t.compraId) return null;
        const fatura = _ctx.contasFixas.find(f => String(f.id) === String(t.faturaId));
        const compra = fatura?.compras?.find(c => String(c.id) === String(t.compraId));
        if (!compra) return null;
        const cartao = _ctx.cartoesCredito.find(c => String(c.id) === String(fatura.cartaoId));
        return { fatura, compra, cartao };
    })();
    const reverterParcela = (desfazer) => {
        if (!parcelaInfo) return;
        const { fatura, compra, cartao } = parcelaInfo;
        const v = parseFloat(compra.valorParcela) || 0;
        if (desfazer) {
            // Desfazer a exclusão → re-marca paga e volta a descontar do cartão.
            compra.pago = true;
            if (cartao) cartao.usado = Math.max(0, (cartao.usado || 0) - v);
        } else {
            // Excluir o pagamento → parcela volta a PENDENTE, devolve ao cartão.
            compra.pago = false;
            if (cartao) cartao.usado = (cartao.usado || 0) + v;
        }
        // Fatura deixa de estar quitada se voltou a ter parcela em aberto.
        fatura.valor = fatura.compras.reduce((s, c) => c.pago === true ? s : s + (parseFloat(c.valorParcela) || 0), 0);
        fatura.pago = fatura.compras.every(c => c.pago === true);
    };

    // 1) Remoção otimista (local-first) — UI atualiza na hora, sem "Tem certeza?".
    _ctx.transacoes.splice(idx, 1);
    aplicarDelta(sinalRemover);
    reverterParcela(false);
    _ctx.salvarDados();
    _ctx.atualizarTudo();
    renderizarOrcamentos();

    // 2) Janela de Desfazer — reinsere na posição original e reverte o saldo da meta.
    _ctx.mostrarNotificacaoDesfazer(`"${t.descricao}" excluída`, () => {
        if (_ctx.transacoes.indexOf(t) !== -1) return; // já reinserida
        const pos = Math.min(idx, _ctx.transacoes.length);
        _ctx.transacoes.splice(pos, 0, t);
        aplicarDelta(-sinalRemover);
        reverterParcela(true);
        _ctx.salvarDados();
        _ctx.atualizarTudo();
        renderizarOrcamentos();
        _ctx.mostrarNotificacao('Exclusão desfeita', 'success');
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
    if (pct >= 50)  return '#f59e0b';
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
    // Horas de Vida: quanto do seu trabalho esse gasto do mês representa
    const chipOrc = gasto > 0 ? _chipHoras({ valor: gasto }, 'saida') : null;
    if (chipOrc) hdrTitle.appendChild(chipOrc);
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

    // "E se?" — simula cortar parte deste gasto e guardar rendendo CDI
    const btnSimular = document.createElement('button');
    btnSimular.className = 'btn-cancelar';
    btnSimular.type = 'button';
    btnSimular.innerHTML = '<i class="fas fa-calculator" aria-hidden="true"></i> Simular corte';
    btnSimular.addEventListener('click', async () => {
        _ctx.fecharPopup();
        try {
            const m = await import('../modules/simulador-ese.js?v=1');
            setTimeout(() => m.abrirSimuladorESe(_ctx, { valorMensal: gasto, origem: tipo }), 150);
        } catch { /* módulo indisponível — sem quebra */ }
    });

    acoes.appendChild(btnEditar);
    acoes.appendChild(btnSimular);
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

        if (!tipoSel) return _ctx.mostrarNotificacao('Selecione a categoria.', 'error');
        if (!_TIPOS_ORCAMENTO.includes(tipoSel)) return _ctx.mostrarNotificacao('Categoria inválida.', 'error');
        if (!isFinite(limite) || limite <= 0) return _ctx.mostrarNotificacao('Digite um limite válido.', 'error');
        if (limite > 10_000_000) return _ctx.mostrarNotificacao('Limite muito alto.', 'error');

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

    let titulo = null;
    let corpo  = null;
    let nivel  = null;

    if (pct >= 100) {
        titulo = `⚠️ Orçamento estourado: ${tipo}`;
        corpo  = `Você gastou ${formatBRL(gasto)} de ${formatBRL(limite)} (${pct.toFixed(0)}%).`;
        nivel  = 'error';
        _ctx.mostrarNotificacao(`Limite de ${tipo} estourado! Gasto: ${formatBRL(gasto)} / ${formatBRL(limite)}`, 'error');
    } else if (pct >= 80) {
        titulo = `Atenção: orçamento de ${tipo}`;
        corpo  = `Você usou ${pct.toFixed(0)}% do limite (${formatBRL(gasto)} / ${formatBRL(limite)}).`;
        nivel  = 'warning';
        _ctx.mostrarNotificacao(`Atenção: você usou ${pct.toFixed(0)}% do orçamento de ${tipo}.`, 'warning');
    } else if (pct >= 50) {
        titulo = `📊 Metade do orçamento: ${tipo}`;
        corpo  = `Você usou ${pct.toFixed(0)}% do limite (${formatBRL(gasto)} / ${formatBRL(limite)}).`;
        nivel  = 'info';
        _ctx.mostrarNotificacao(`Você usou ${pct.toFixed(0)}% do orçamento de ${tipo}.`, 'info');
    }

    // Dispara push notification se permitido e disponível
    if (titulo && 'Notification' in window && Notification.permission === 'granted') {
        try {
            navigator.serviceWorker?.ready?.then(reg => {
                // Chave de deduplicação por tipo+mês — evita notificações repetidas
                const tag = `orcamento-${tipo}-${new Date().getFullYear()}-${new Date().getMonth()}-${pct >= 100 ? '100' : pct >= 80 ? '80' : '50'}`;
                reg.showNotification(titulo, {
                    body: corpo,
                    tag,          // substitui notificação anterior do mesmo tipo
                    icon:  '/assets/icons/favicon.png',
                    badge: '/assets/icons/favicon.png',
                    data:  { url: '/dashboard.html' },
                });
            }).catch(() => {
                // ServiceWorker indisponível — fallback silencioso (já temos notif in-app)
            });
        } catch { /* notificação push não crítica */ }
    }
}

// ========== IMPORTADOR DE EXTRATO OFX/CSV ==========
// Processamento 100% local — arquivo nunca sai do browser

const _CATEGORIAS_IMPORT = Object.freeze([
    'Mercado','Farmácia','Saúde','Eletrônico','Roupas','Assinaturas','Beleza','Presente',
    'Conta fixa','Cartão','Academia','Lazer','Transporte','Viagem','Pet','Shopee','Mercado Livre',
    'Ifood','Amazon','Educação','Outros','Salário','Renda Extra','Outros Recebimentos',
]);

const _AUTO_CAT = Object.freeze([
    // ══ ENTRADAS — identificar ANTES das saídas (evita false-positives) ═══════
    [/pix.*receb|receb.*pix|transfer.*receb|pix recebido/i,                  { cat: 'entrada', tipo: 'Renda Extra' }],
    [/salario|holerite|pagto.*rh|folha.*pgto|pagamento.*emprego/i,           { cat: 'entrada', tipo: 'Salário' }],
    [/dividendo|jscp|lucro.*distribu|proventos/i,                            { cat: 'entrada', tipo: 'Investimento' }],
    [/rendimento|resgate.*investim|tesouro.*resg|resg.*poupanca/i,           { cat: 'entrada', tipo: 'Investimento' }],
    [/restituicao.*ir|imposto.*devolu|devolucao.*receita/i,                  { cat: 'entrada', tipo: 'Renda Extra' }],
    [/fgts\b|seguro.*desemprego|auxilio.*governo/i,                          { cat: 'entrada', tipo: 'Renda Extra' }],
    [/pix.*envia|envia.*pix|transfer.*envia/i,                               { cat: 'saida',   tipo: 'Outros' }],
    [/renda|freelance|autonomo|honorario|comissao|bico\b/i,                  { cat: 'entrada', tipo: 'Renda Extra' }],

    // ══ FOOD & DELIVERY ════════════════════════════════════════════════════════
    [/ifood|rappi|uber.*eat|delivery|james.*delivery/i,                      { cat: 'saida', tipo: 'Ifood' }],
    [/restauran|lanchon|padaria|pizzar|hamburguer|burger|sushi|churrasc/i,   { cat: 'saida', tipo: 'Ifood' }],
    [/\bbobs\b|outback|giraffas|spoleto|subway\b|mcdonalds|mcdonald|bk\b|burger king/i, { cat: 'saida', tipo: 'Ifood' }],
    [/bar e|snack|lanche|sorveteria|confeitaria|cafeteria|\bcafe\b.*loja/i,  { cat: 'saida', tipo: 'Ifood' }],

    // ══ MARKETPLACES ═══════════════════════════════════════════════════════════
    [/mercado livre|mercadolivre|meli\b/i,                                   { cat: 'saida', tipo: 'Mercado Livre' }],
    [/shopee/i,                                                              { cat: 'saida', tipo: 'Shopee' }],
    [/amazon/i,                                                              { cat: 'saida', tipo: 'Amazon' }],
    [/aliexpress|ali express|olx\b|enjoei|enjoy\b/i,                         { cat: 'saida', tipo: 'Outros' }],

    // ══ SUPERMERCADO ═══════════════════════════════════════════════════════════
    [/supermercado|carrefour|atacad|hortifruti|pao de acucar|grupo.*extra/i, { cat: 'saida', tipo: 'Mercado' }],
    [/\bsuperm|\bmerced|\bprecito|\bdia\b.*super|sacolao|feira\b/i,          { cat: 'saida', tipo: 'Mercado' }],
    [/assai\b|atacadao|makro|sam\'s club|costco|prezunic/i,                  { cat: 'saida', tipo: 'Mercado' }],

    // ══ FARMÁCIA ════════════════════════════════════════════════════════════════
    [/farmacia|drogasil|ultrafarma|pacheco|droga\b|remedios|raia\b|panvel/i, { cat: 'saida', tipo: 'Farmácia' }],
    [/drogaria\b|farma.*pop|popular.*farma/i,                                { cat: 'saida', tipo: 'Farmácia' }],

    // ══ SAÚDE ══════════════════════════════════════════════════════════════════
    [/medico|dentista|clinica|hospital|consulta|exame|plano.*saude/i,        { cat: 'saida', tipo: 'Saúde' }],
    [/unimed|amil|bradesco.*saude|sulamerica|laboratorio|hapvida|notredame/i, { cat: 'saida', tipo: 'Saúde' }],
    [/fisioterapia|psicolog|psicologo|terapia|nutricionista|quiroprax/i,     { cat: 'saida', tipo: 'Saúde' }],
    [/\binss\b|previdencia.*social|contrib.*previdenc/i,                     { cat: 'saida', tipo: 'Conta fixa' }],

    // ══ EDUCAÇÃO ════════════════════════════════════════════════════════════════
    [/faculdade|mensalidade.*escol|escola\b|universidade|\bcurso\b|matricula/i, { cat: 'saida', tipo: 'Educação' }],
    [/colegio|creche|udemy|alura|coursera|duolingo|descomplica|estacio/i,    { cat: 'saida', tipo: 'Educação' }],
    [/livro\b|sebrae|senai|senac|sesc\b|sebrae/i,                            { cat: 'saida', tipo: 'Educação' }],

    // ══ VIAGEM ═════════════════════════════════════════════════════════════════
    [/passagem.*aerea|airbnb|booking\.com|decolar|latam|gol\b|azul\b/i,     { cat: 'saida', tipo: 'Viagem' }],
    [/hotel|hospedagem|pousada|hostel|trivago|expedia|kayak\b/i,             { cat: 'saida', tipo: 'Viagem' }],

    // ══ ROUPAS E MODA ══════════════════════════════════════════════════════════
    [/renner|\bcea\b|riachuelo|zara|hering|levis|\bpuma\b|nike\b|adidas/i,   { cat: 'saida', tipo: 'Roupas' }],
    [/roupas|vestuario|calcado|sapato|tenis\b|lupo\b|havaianas|crocs\b/i,    { cat: 'saida', tipo: 'Roupas' }],
    [/farm\b|arezzo|schutz|melissa\b|animale|marisa\b|chico\b.*rei/i,        { cat: 'saida', tipo: 'Roupas' }],

    // ══ ELETRÔNICOS & INFORMÁTICA ══════════════════════════════════════════════
    [/kabum|casas bahia|magazine|magalu|informatica|notebook|celular/i,      { cat: 'saida', tipo: 'Eletrônico' }],
    [/eletronico|terabyte|pichau|gta\b.*comp|dell\b|apple\b.*store/i,        { cat: 'saida', tipo: 'Eletrônico' }],

    // ══ PETS ═══════════════════════════════════════════════════════════════════
    [/veterinario|petshop|racao|petz\b|cobasi|\bpet\b|animal.*consu/i,       { cat: 'saida', tipo: 'Pet' }],

    // ══ BELEZA ════════════════════════════════════════════════════════════════
    [/salao|manicure|pedicure|barbearia|barbeiro|estetica|\bspa\b|cabelei/i, { cat: 'saida', tipo: 'Beleza' }],
    [/sephora|boticario|natura\b|avon\b|oboticario|l\'oreal|loreal/i,        { cat: 'saida', tipo: 'Beleza' }],

    // ══ LAZER & ENTRETENIMENTO ═════════════════════════════════════════════════
    [/cinema|teatro|\bshow\b|evento|ingresso|sympla|bilheteria|parque/i,     { cat: 'saida', tipo: 'Lazer' }],
    [/boliche|karaoke|escape room|fliperamas|laser.*tag|paintball/i,         { cat: 'saida', tipo: 'Lazer' }],
    [/steam\b|playstation|xbox\b|nintendo|games\b|jogo.*digital/i,           { cat: 'saida', tipo: 'Lazer' }],

    // ══ TRANSPORTE ════════════════════════════════════════════════════════════
    [/\buber\b|99pop|\b99\b.*taxi|cabify|lady.*driver/i,                     { cat: 'saida', tipo: 'Transporte' }],
    [/combustivel|gasolina|ipiranga|shell\b|posto\b|auto.*posto|br.*distrib/i, { cat: 'saida', tipo: 'Transporte' }],
    [/\bmetro\b|onibus|bilhete.*unico|passagem.*onibus|sptrans|brt\b/i,      { cat: 'saida', tipo: 'Transporte' }],
    [/estacionamento|pedagio|sem.*parar|veloe\b|conectcar/i,                 { cat: 'saida', tipo: 'Transporte' }],
    [/manutencao.*carro|funilaria|mecanica|borracharia|troca.*oleo/i,        { cat: 'saida', tipo: 'Transporte' }],

    // ══ ASSINATURAS DIGITAIS ═══════════════════════════════════════════════════
    [/netflix|spotify|\bprime\b|disney\+|hbo|youtube.*prem|twitch/i,        { cat: 'saida', tipo: 'Assinaturas' }],
    [/apple.*one|globoplay|crunchyroll|deezer|paramount|star\+/i,           { cat: 'saida', tipo: 'Assinaturas' }],
    [/notion\b|figma\b|adobe\b|canva\b|github\b|dropbox|google.*one|icloud/i, { cat: 'saida', tipo: 'Assinaturas' }],
    [/granaevo|assinatura.*app/i,                                            { cat: 'saida', tipo: 'Assinaturas' }],

    // ══ ACADEMIA / ESPORTE ════════════════════════════════════════════════════
    [/academia|smartfit|bluefit|bodytech|\bgym\b|crossfit|pilates/i,         { cat: 'saida', tipo: 'Academia' }],
    [/natacao|yoga\b|musculacao|personal.*trainer|corrida.*club/i,           { cat: 'saida', tipo: 'Academia' }],

    // ══ CASA & REFORMA ════════════════════════════════════════════════════════
    [/leroy|telhanorte|c&c\b|tok.*stok|etna\b|mobly|camicado|tramontina/i,   { cat: 'saida', tipo: 'Outros' }],
    [/reforma|pintura.*casa|pedreiro|encanador|eletricista|marceneiro/i,     { cat: 'saida', tipo: 'Outros' }],

    // ══ FINANÇAS & INVESTIMENTOS ═══════════════════════════════════════════════
    [/tesouro.*direto|nuinvest|xp\b.*invest|rico\b.*invest|easynvest|inter\b.*invest/i, { cat: 'saida', tipo: 'Investimento' }],
    [/cdb\b|lci\b|lca\b|fundo.*invest|acoes\b|fundos.*imob/i,                { cat: 'saida', tipo: 'Investimento' }],
    [/iof\b|tarifa.*banc|taxa.*banc|manutencao.*conta|anuidade/i,            { cat: 'saida', tipo: 'Conta fixa' }],

    // ══ GOVERNO & CARTÓRIO ════════════════════════════════════════════════════
    [/correios\b|sedex|pac\b.*envio|ecf\b/i,                                 { cat: 'saida', tipo: 'Outros' }],
    [/cartorio|tabelionato|registro.*imovel|escritura/i,                     { cat: 'saida', tipo: 'Outros' }],
    [/detran\b|multa.*transit|licencia.*veiculo|dpvat\b/i,                   { cat: 'saida', tipo: 'Transporte' }],
    [/receita.*federal|darf\b|gru\b.*imposto|guia.*recolh/i,                 { cat: 'saida', tipo: 'Conta fixa' }],

    // ══ SEGUROS ═══════════════════════════════════════════════════════════════
    [/seguro\b|apolice|premio.*seguro|porto.*seguro|azul.*seguros/i,         { cat: 'saida', tipo: 'Conta fixa' }],

    // ══ CONTAS FIXAS ══════════════════════════════════════════════════════════
    [/aluguel|condominio|iptu|energia|enel\b|cemig\b|copel\b/i,              { cat: 'saida', tipo: 'Conta fixa' }],
    [/internet|tim\b|claro\b|vivo\b|\boi\b|net\b.*telecom|sky\b/i,           { cat: 'saida', tipo: 'Conta fixa' }],
    [/conta.*agua|sabesp|saneamento|\bgas\b|comgas|ipva\b|telefone\b/i,      { cat: 'saida', tipo: 'Conta fixa' }],
]);

function _autoCategorizar(memo) {
    // Normaliza: remove acentos para casar mesmo com encoding quebrado
    // Ex: "TransferÃncia" → "Transferencia" → casa com /transfer.*receb/
    const m = String(memo || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accent combining chars
        .replace(/[^\w\s]/g, ' ')
        .toLowerCase();
    for (const [re, res] of _AUTO_CAT) {
        if (re.test(m)) return res;
    }
    return null;
}

// Modelo aprendido do histórico — construído sob demanda e cacheado (build de ~16ms
// com 3000 transações; a consulta é imediata). Duas invalidações, e as DUAS importam:
//   • ge:save-done → os dados mudaram.
//   • troca de perfil → selecionarPerfil() troca as transações SEM salvar, então não
//     emite ge:save-done. Sem a chave por perfil, o modelo do perfil anterior
//     sobreviveria e sugeriria as categorias de OUTRA pessoa (casal/família).
let _modeloCat = null;
let _modeloCatPerfil = null;
function _modeloCategorias() {
    const perfil = _ctx?.perfilAtivo?.id ?? null;
    if (!_modeloCat || _modeloCatPerfil !== perfil) {
        _modeloCat = construirModelo(_ctx?.transacoes || []);
        _modeloCatPerfil = perfil;
    }
    return _modeloCat;
}
document.addEventListener('ge:save-done', () => { _modeloCat = null; });

// ORDEM DAS FONTES (decidida com o usuário em 2026-07-14):
//   1º SEU HISTÓRICO  → o que você mesmo escolheu nas últimas vezes. É o sinal mais
//                       forte e mais recente. Sem esta precedência, as regras antigas
//                       da importação venceriam calado o que o histórico aprendeu.
//   2º regras da importação (localStorage) → o que você corrigiu ao importar extrato.
//   3º lista fixa de palavras → o chute genérico que veio pronto no app.
// O módulo só sugere com evidência (senão devolve null) — então cair para o 2º/3º é
// o caminho normal de quem ainda não tem histórico, não um erro.
function _autoCatComAprendizado(memo) {
    const m = String(memo || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .toLowerCase()
        .trim();
    if (!m) return null;

    // 1º — histórico do próprio usuário
    try {
        const s = sugerirCategoria(_modeloCategorias(), memo);
        if (s && s.tipo) return { cat: s.categoria, tipo: s.tipo, learned: true };
    } catch { /* modelo indisponível → segue para as fontes antigas */ }

    // 2º — regras aprendidas na importação (palavras-chave exatas)
    try {
        const uid = _ctx?.user?.id || 'anon';
        const raw = localStorage.getItem(`ge_learned_cats_${uid}`);
        if (raw) {
            const learned = JSON.parse(raw);
            if (Array.isArray(learned)) {
                for (const rule of learned) {
                    if (rule.keyword && m.includes(rule.keyword.toLowerCase())) {
                        return { cat: rule.cat, tipo: rule.tipo, learned: true };
                    }
                }
            }
        }
    } catch { /* localStorage pode estar bloqueado */ }

    // 3º — lista fixa de palavras que veio pronta no app
    return _autoCategorizar(memo);
}

function _salvarRegrasAprendidas(keyword, cat, tipo) {
    try {
        const uid = _ctx?.user?.id || 'anon';
        const key = `ge_learned_cats_${uid}`;
        const raw = localStorage.getItem(key);
        const learned = raw ? (JSON.parse(raw) || []) : [];
        // Evita duplicação: atualiza se já existe keyword
        const idx = learned.findIndex(r => r.keyword === keyword);
        if (idx >= 0) {
            learned[idx] = { keyword, cat, tipo };
        } else {
            // Máximo 200 regras — remove a mais antiga se necessário
            if (learned.length >= 200) learned.shift();
            learned.push({ keyword, cat, tipo });
        }
        localStorage.setItem(key, JSON.stringify(learned));
    } catch { /* não crítico */ }
}

function _initAutoCategorizar() {
    const inputDesc = document.getElementById('inputDescricao');
    if (!inputDesc) return;

    // Estado interno — sem UI visível para o usuário
    let _debounceTimer  = null;
    let _lastSuggestion = null;
    let _lastMemo       = '';

    inputDesc.addEventListener('input', () => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
            const memo   = inputDesc.value.trim();
            const catSel = document.getElementById('selectCategoria');
            if (catSel && catSel.value) { _lastSuggestion = null; _lastMemo = ''; return; }
            if (memo.length < 3) { _lastSuggestion = null; _lastMemo = ''; return; }

            const suggestion = _autoCatComAprendizado(memo);
            if (suggestion) {
                // Guarda internamente — aplicado silenciosamente ao lançar
                _lastSuggestion = suggestion;
                _lastMemo       = memo;
            } else {
                _lastSuggestion = null;
                _lastMemo       = '';
            }
        }, 220);
    });

    // Aprende correção quando usuário altera o tipo manualmente após sugestão interna
    const tipoSel = document.getElementById('selectTipo');
    if (tipoSel) {
        tipoSel.addEventListener('change', () => {
            if (_lastSuggestion && _lastMemo && tipoSel.value && tipoSel.value !== _lastSuggestion.tipo) {
                const catSel  = document.getElementById('selectCategoria');
                const keyword = _lastMemo
                    .normalize('NFD').replace(/[̀-ͯ]/g, '')
                    .replace(/[^\w\s]/g, ' ')
                    .toLowerCase()
                    .trim()
                    .split(/\s+/)
                    .find(w => w.length >= 4) || _lastMemo.slice(0, 20);
                if (keyword) _salvarRegrasAprendidas(keyword, catSel?.value || _lastSuggestion.cat, tipoSel.value);
            }
        });
    }

    const catSel = document.getElementById('selectCategoria');
    if (catSel) catSel.addEventListener('change', () => { _lastSuggestion = null; _lastMemo = ''; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Categorização em lote: aplica auto-categorização a transações sem categoria
// ─────────────────────────────────────────────────────────────────────────────
function _categorizarTudo() {
    const semCat = (_ctx.transacoes || []).filter(t =>
        (!t.categoria || !t.tipo) && t.descricao
    );

    if (semCat.length === 0) {
        _ctx.mostrarNotificacao('Todas as transações já estão categorizadas!', 'success');
        return;
    }

    const sugestoes = semCat
        .map(t => ({ t, sugestao: _autoCatComAprendizado(t.descricao) }))
        .filter(({ sugestao }) => sugestao !== null);

    if (sugestoes.length === 0) {
        _ctx.mostrarNotificacao(
            `${semCat.length} transação(ões) sem categoria, mas nenhuma foi reconhecida pelas regras automáticas.`,
            'info'
        );
        return;
    }

    const _catLabel = c => ({ entrada: '↑ Entrada', saida: '↓ Saída', saida_credito: '↓ Crédito', reserva: '⬡ Reserva' }[c] || c);

    _ctx.criarPopupDOM((popup) => {
        const h3 = document.createElement('h3');
        h3.textContent = 'Categorizar Automaticamente';
        popup.appendChild(h3);

        const resumo = document.createElement('p');
        resumo.style.cssText = 'color: var(--text-secondary); margin: 8px 0 16px; font-size: 0.9rem;';
        resumo.textContent = `${sugestoes.length} transação(ões) identificadas de ${semCat.length} sem categoria.`;
        popup.appendChild(resumo);

        const listWrap = document.createElement('div');
        listWrap.style.cssText = 'max-height: 300px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; margin-bottom: 20px;';

        sugestoes.forEach(({ t, sugestao }, idx) => {
            const row = document.createElement('div');
            row.style.cssText = `padding: 10px 14px; display: flex; align-items: center; gap: 12px; font-size: 0.83rem; ${idx > 0 ? 'border-top: 1px solid rgba(255,255,255,0.07);' : ''}`;

            const icon = document.createElement('i');
            icon.className = sugestao.learned ? 'fas fa-brain' : 'fas fa-bolt';
            icon.style.cssText = 'color: var(--text-secondary); font-size: 0.75rem; flex-shrink: 0;';
            icon.title = sugestao.learned ? 'Regra aprendida' : 'Regra embutida';

            const desc = document.createElement('span');
            desc.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary);';
            desc.textContent = t.descricao;
            desc.title = t.descricao;

            const badge = document.createElement('span');
            badge.style.cssText = 'background: rgba(67,160,71,0.15); color: var(--primary); border-radius: 6px; padding: 2px 9px; font-size: 0.75rem; white-space: nowrap; font-weight: 600;';
            badge.textContent = `${_catLabel(sugestao.cat)} · ${sugestao.tipo}`;

            row.appendChild(icon);
            row.appendChild(desc);
            row.appendChild(badge);
            listWrap.appendChild(row);
        });

        popup.appendChild(listWrap);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 12px;';

        const btnCancelar = document.createElement('button');
        btnCancelar.type = 'button';
        btnCancelar.className = 'btn-secondary';
        btnCancelar.style.cssText = 'flex: 1;';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        const btnAplicar = document.createElement('button');
        btnAplicar.type = 'button';
        btnAplicar.className = 'btn-primary';
        btnAplicar.style.cssText = 'flex: 1;';
        btnAplicar.textContent = `Aplicar ${sugestoes.length} Sugestão(ões)`;
        btnAplicar.addEventListener('click', () => {
            sugestoes.forEach(({ t, sugestao }) => {
                t.categoria = sugestao.cat;
                t.tipo      = sugestao.tipo;
            });
            _ctx.salvarDados();
            _ctx.atualizarTudo();
            _ctx.fecharPopup();
            _ctx.mostrarNotificacao(`${sugestoes.length} transação(ões) categorizadas com sucesso!`, 'success');
        });

        btnRow.appendChild(btnCancelar);
        btnRow.appendChild(btnAplicar);
        popup.appendChild(btnRow);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Painel de gerenciamento de regras de categorização
// ─────────────────────────────────────────────────────────────────────────────
function _abrirGerenciarRegras() {
    const uid = _ctx?.user?.id || 'anon';
    const key = `ge_learned_cats_${uid}`;

    function _lerAprendidas() {
        try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
    }
    function _persistir(arr) {
        try { localStorage.setItem(key, JSON.stringify(arr)); } catch { }
    }

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'width: min(640px, 95vw); max-height: 80vh; display: flex; flex-direction: column; gap: 0;';

        const h3 = document.createElement('h3');
        h3.style.marginBottom = '12px';
        h3.textContent = 'Regras de Categorização';
        popup.appendChild(h3);

        // ── Tabs ─────────────────────────────────────────────────────────────
        const tabBar = document.createElement('div');
        tabBar.style.cssText = 'display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 16px; flex-shrink: 0;';

        const panels = {};

        function _makeTab(label, id) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.tab = id;
            btn.style.cssText = 'background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 16px; font-size: 0.85rem; cursor: pointer; color: var(--text-secondary); transition: color 0.15s, border-color 0.15s;';
            btn.textContent = label;
            return btn;
        }

        const tabA = _makeTab('Aprendidas', 'aprendidas');
        const tabE = _makeTab('Embutidas', 'embutidas');
        tabBar.appendChild(tabA);
        tabBar.appendChild(tabE);
        popup.appendChild(tabBar);

        // ── Scroll wrapper ───────────────────────────────────────────────────
        const scrollWrap = document.createElement('div');
        scrollWrap.style.cssText = 'overflow-y: auto; flex: 1; min-height: 0;';
        popup.appendChild(scrollWrap);

        // ── Panel: Aprendidas ─────────────────────────────────────────────────
        const panelA = document.createElement('div');

        function _renderAprendidas() {
            panelA.innerHTML = '';
            const list = _lerAprendidas();

            const toolbar = document.createElement('div');
            toolbar.style.cssText = 'display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;';

            const btnExport = document.createElement('button');
            btnExport.type = 'button';
            btnExport.style.cssText = 'background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px 14px; font-size: 0.8rem; cursor: pointer; color: var(--text-secondary);';
            btnExport.textContent = 'Exportar JSON';
            btnExport.disabled = list.length === 0;
            btnExport.addEventListener('click', () => {
                const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'regras-categorizacao.json';
                a.click();
                URL.revokeObjectURL(a.href);
            });

            const btnLimpar = document.createElement('button');
            btnLimpar.type = 'button';
            btnLimpar.style.cssText = 'background: rgba(229,62,62,0.1); border: 1px solid rgba(229,62,62,0.2); border-radius: 8px; padding: 6px 14px; font-size: 0.8rem; cursor: pointer; color: #e53e3e;';
            btnLimpar.textContent = 'Limpar Todas';
            btnLimpar.disabled = list.length === 0;
            btnLimpar.addEventListener('click', () => {
                if (!confirm(`Remover todas as ${list.length} regras aprendidas?`)) return;
                _persistir([]);
                _renderAprendidas();
            });

            toolbar.appendChild(btnExport);
            toolbar.appendChild(btnLimpar);
            panelA.appendChild(toolbar);

            if (list.length === 0) {
                const empty = document.createElement('p');
                empty.style.cssText = 'text-align: center; color: var(--text-secondary); padding: 32px 0; font-size: 0.9rem;';
                empty.textContent = 'Nenhuma regra aprendida. O sistema aprende quando você corrige uma sugestão automática.';
                panelA.appendChild(empty);
                return;
            }

            const counter = document.createElement('p');
            counter.style.cssText = 'color: var(--text-secondary); font-size: 0.78rem; margin-bottom: 10px;';
            counter.textContent = `${list.length} de 200 regras em uso. As regras aprendidas têm prioridade sobre as embutidas.`;
            panelA.appendChild(counter);

            const table = document.createElement('table');
            table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 0.83rem;';

            const thead = document.createElement('thead');
            const hrow = document.createElement('tr');
            ['Palavra-chave', 'Categoria', 'Tipo', ''].forEach(label => {
                const th = document.createElement('th');
                th.textContent = label;
                th.style.cssText = 'text-align: left; padding: 6px 10px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 0.78rem;';
                hrow.appendChild(th);
            });
            thead.appendChild(hrow);
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            list.forEach((rule, idx) => {
                const tr = document.createElement('tr');
                tr.style.cssText = idx % 2 === 0 ? 'background: rgba(255,255,255,0.02);' : '';

                const tdK = document.createElement('td');
                const code = document.createElement('code');
                code.style.cssText = 'background: rgba(255,255,255,0.07); padding: 2px 7px; border-radius: 4px; font-size: 0.78rem;';
                code.textContent = rule.keyword;
                tdK.appendChild(code);

                const tdC = document.createElement('td');
                tdC.textContent = rule.cat;

                const tdT = document.createElement('td');
                tdT.textContent = rule.tipo;

                const tdX = document.createElement('td');
                const btnDel = document.createElement('button');
                btnDel.type = 'button';
                btnDel.title = 'Remover regra';
                btnDel.style.cssText = 'background: none; border: none; color: rgba(229,62,62,0.7); cursor: pointer; padding: 4px 8px; font-size: 0.85rem;';
                btnDel.textContent = '✕';
                btnDel.addEventListener('click', () => {
                    const updated = _lerAprendidas().filter((_, i) => i !== idx);
                    _persistir(updated);
                    _renderAprendidas();
                });
                tdX.appendChild(btnDel);

                [tdK, tdC, tdT, tdX].forEach(td => {
                    td.style.cssText = (td.style.cssText || '') + 'padding: 9px 10px; vertical-align: middle; border-bottom: 1px solid rgba(255,255,255,0.05);';
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });

            table.appendChild(tbody);
            panelA.appendChild(table);
        }

        _renderAprendidas();
        panels.aprendidas = panelA;

        // ── Panel: Embutidas ──────────────────────────────────────────────────
        const panelE = document.createElement('div');

        const infoE = document.createElement('p');
        infoE.style.cssText = 'color: var(--text-secondary); font-size: 0.78rem; margin-bottom: 12px;';
        infoE.textContent = `${_AUTO_CAT.length} regras embutidas (somente leitura). Palavras-chave em regex, sem distinção maiúsculas/minúsculas.`;
        panelE.appendChild(infoE);

        const tableE = document.createElement('table');
        tableE.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 0.82rem;';

        const theadE = document.createElement('thead');
        const hrowE = document.createElement('tr');
        ['Padrão', 'Categoria', 'Tipo'].forEach(label => {
            const th = document.createElement('th');
            th.textContent = label;
            th.style.cssText = 'text-align: left; padding: 6px 10px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 0.78rem;';
            hrowE.appendChild(th);
        });
        theadE.appendChild(hrowE);
        tableE.appendChild(theadE);

        const tbodyE = document.createElement('tbody');
        _AUTO_CAT.forEach(([re, res], idx) => {
            const tr = document.createElement('tr');
            tr.style.cssText = idx % 2 === 0 ? 'background: rgba(255,255,255,0.02);' : '';

            const tdP = document.createElement('td');
            const code = document.createElement('code');
            code.style.cssText = 'background: rgba(255,255,255,0.07); padding: 2px 7px; border-radius: 4px; font-size: 0.75rem; word-break: break-all; display: inline-block; max-width: 320px;';
            code.textContent = re.source.length > 70 ? re.source.slice(0, 70) + '…' : re.source;
            code.title = re.source;
            tdP.appendChild(code);

            const tdC = document.createElement('td');
            tdC.textContent = res.cat;

            const tdT = document.createElement('td');
            tdT.textContent = res.tipo;

            [tdP, tdC, tdT].forEach(td => {
                td.style.cssText = (td.style.cssText || '') + 'padding: 8px 10px; vertical-align: middle; border-bottom: 1px solid rgba(255,255,255,0.05);';
                tr.appendChild(td);
            });
            tbodyE.appendChild(tr);
        });

        tableE.appendChild(tbodyE);
        panelE.appendChild(tableE);
        panels.embutidas = panelE;

        // ── Tab switching ────────────────────────────────────────────────────
        function _switchTab(id) {
            scrollWrap.innerHTML = '';
            scrollWrap.appendChild(panels[id]);
            [tabA, tabE].forEach(btn => {
                const on = btn.dataset.tab === id;
                btn.style.borderBottomColor = on ? 'var(--primary)' : 'transparent';
                btn.style.color = on ? 'var(--primary)' : 'var(--text-secondary)';
                btn.style.fontWeight = on ? '600' : '400';
            });
        }

        tabA.addEventListener('click', () => _switchTab('aprendidas'));
        tabE.addEventListener('click', () => _switchTab('embutidas'));
        _switchTab('aprendidas');

        const btnFechar = document.createElement('button');
        btnFechar.type = 'button';
        btnFechar.className = 'btn-secondary';
        btnFechar.style.cssText = 'margin-top: 16px; width: 100%; flex-shrink: 0;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => _ctx.fecharPopup());
        popup.appendChild(btnFechar);
    });
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

// ── Deduplicação robusta: data + valor + similaridade de descrição ─────────
// Três critérios (OR): qualquer um basta para marcar como duplicata provável.
// 1. Mesma data + mesmo valor (critério original)
// 2. Mesma data + mesmo valor + descrição com 60%+ de palavras em comum (forte)
// 3. Mesma data + mesmo valor + FITID idêntico (quando disponível no OFX)
function _isDuplicata(tx) {
    const existentes = _ctx.transacoes || [];
    const tISO  = _ctx.dataParaISO(tx.data || '');
    if (!tISO) return false;

    // Tokeniza descrição em palavras ≥3 chars
    function _tokens(str) {
        return String(str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
            .replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
    }
    function _similarity(a, b) {
        const setA = new Set(_tokens(a));
        const setB = new Set(_tokens(b));
        if (setA.size === 0 || setB.size === 0) return 0;
        const inter = [...setA].filter(w => setB.has(w)).length;
        return inter / Math.min(setA.size, setB.size);
    }

    return existentes.some(e => {
        if (typeof e.data !== 'string' || !e.valor) return false;
        const eISO = _ctx.dataParaISO(e.data);
        if (!eISO || eISO !== tISO) return false;
        if (Math.abs(parseFloat(e.valor) - tx.valor) >= 0.01) return false;
        // Data + valor iguais → duplicata (critério original mantido)
        // Adicionalmente marca como mais provável se descrições são similares
        tx._dupScore = _similarity(e.descricao, tx.descricao);
        return true;
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
        const _MAX_IMPORT_SIZE  = 5 * 1024 * 1024; // 5MB por arquivo
        const _MAX_IMPORT_TXS   = 2_000;            // máximo de transações por importação

        function processarArquivo(file) {
            if (!file) return;

            // ── Validações de segurança antes de qualquer leitura ──────────
            const ext = file.name.split('.').pop().toLowerCase();
            if (!['ofx','csv'].includes(ext)) {
                _ctx.mostrarNotificacao('Formato não suportado. Use .ofx ou .csv', 'error');
                return;
            }

            if (file.size > _MAX_IMPORT_SIZE) {
                _ctx.mostrarNotificacao(`Arquivo muito grande. Máximo: 5MB. Seu arquivo: ${(file.size / 1024 / 1024).toFixed(1)}MB.`, 'error');
                return;
            }

            if (file.size === 0) {
                _ctx.mostrarNotificacao('Arquivo vazio. Verifique e tente novamente.', 'error');
                return;
            }

            // Valida nome do arquivo (evita path traversal e caracteres maliciosos)
            const nomeSeguro = file.name.replace(/[^\w.\-_() ]/g, '').slice(0, 100);
            if (!nomeSeguro) {
                _ctx.mostrarNotificacao('Nome do arquivo inválido.', 'error');
                return;
            }

            dropZone.classList.add('imp-drop-zone--loading');

            const reader = new FileReader();
            reader.onload = (e) => {
                dropZone.classList.remove('imp-drop-zone--loading');

                // Auto-detecta encoding: lê header ASCII para checar CHARSET,
                // depois decodifica com TextDecoder (UTF-8 ou windows-1252).
                const buf = e.target.result;

                // ── Verificação de tamanho pós-leitura (defesa em profundidade) ──
                if (buf.byteLength > _MAX_IMPORT_SIZE) {
                    _ctx.mostrarNotificacao('Arquivo excede o limite de 5MB.', 'error');
                    return;
                }

                const headerSlice = buf.slice(0, Math.min(1024, buf.byteLength));
                const headerAscii = new TextDecoder('ascii', { fatal: false }).decode(headerSlice);
                const charsetMatch = headerAscii.match(/CHARSET[:\s]+(\S+)/i);
                const declaredUtf8 = /utf-?8/i.test(charsetMatch?.[1] || '');
                const hasBOM = (new Uint8Array(buf, 0, 3)).join(',') === '239,187,191';
                const encoding = (declaredUtf8 || hasBOM) ? 'utf-8' : 'windows-1252';
                const texto = new TextDecoder(encoding, { fatal: false }).decode(buf);

                // ── Valida que o conteúdo parece com OFX/CSV legítimo ─────────
                if (ext === 'ofx' && !/<OFX>/i.test(texto) && !/<STMTTRN>/i.test(texto) && !/OFXHEADER/i.test(texto)) {
                    _ctx.mostrarNotificacao('Arquivo não parece ser um OFX válido. Verifique o formato.', 'error');
                    dropZone.querySelector('.imp-drop-text').textContent = 'Clique ou arraste o arquivo aqui';
                    return;
                }

                let txsRaw = [];
                try {
                    txsRaw = ext === 'ofx' ? _parseOFX(texto) : _parseCSV(texto);
                } catch (err) {
                    _ctx.mostrarNotificacao('Erro ao ler o arquivo. Verifique o formato.', 'error');
                    dropZone.querySelector('.imp-drop-text').textContent = 'Clique ou arraste o arquivo aqui';
                    return;
                }

                // ── Limita número de transações por importação ────────────────
                if (txsRaw.length > _MAX_IMPORT_TXS) {
                    _ctx.mostrarNotificacao(`Arquivo contém ${txsRaw.length} transações — limite de ${_MAX_IMPORT_TXS} por importação. Importe em partes.`, 'warning');
                    txsRaw = txsRaw.slice(0, _MAX_IMPORT_TXS);
                }

                if (txsRaw.length === 0) {
                    _ctx.mostrarNotificacao('Nenhuma transação encontrada no arquivo. Verifique se o período exportado tem movimentações.', 'warning');
                    dropZone.querySelector('.imp-drop-text').textContent = 'Clique ou arraste o arquivo aqui';
                    return;
                }

                txsParsed = txsRaw;

                // Marca duplicatas
                txsParsed.forEach(t => { t._dup = _isDuplicata(t); });

                _renderRevisao(txsParsed, revisaoWrap);
                const sel = txsParsed.filter(t => t._incluir).length;
                const dupCount = txsParsed.filter(t => t._dup).length;
                btnConfirmar.textContent = `Lançar ${sel} transação(ões)`;
                acoes.style.display = 'flex';

                const textoPrincipal = `✅ ${nomeSeguro} — ${txsParsed.length} transações`;
                const textoSecundario = dupCount > 0 ? ` · ${dupCount} possível(is) duplicata(s)` : '';
                dropZone.querySelector('.imp-drop-text').textContent = textoPrincipal + textoSecundario;
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
                _ctx.mostrarNotificacao(`${lancadas} transaç${lancadas === 1 ? 'ão lançada' : 'ões lançadas'} com sucesso!`, 'success');
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
