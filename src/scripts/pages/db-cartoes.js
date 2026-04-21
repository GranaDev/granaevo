// db-cartoes.js — Seção de Cartões de Crédito (lazy-loaded)
let _ctx = null;

export function init(ctx) {
    _ctx = ctx;
    window._dbCartoes = { atualizarTelaCartoes };
    window.abrirCartaoForm         = _ctx._requerPerfilAtivo((id) => abrirCartaoForm(id));
    window.congelarCartao          = _ctx._requerPerfilAtivo((id) => congelarCartao(id));
    window.abrirVisualizacaoFatura = _ctx._requerPerfilAtivo((id) => abrirVisualizacaoFatura(id));
    window.pagarCompraIndividual   = _ctx._requerPerfilAtivo((cid, coid) => pagarCompraIndividual(cid, coid));
    window.editarCompraFatura      = _ctx._requerPerfilAtivo((cid, coid) => editarCompraFatura(cid, coid));
    window.excluirCompraFatura     = _ctx._requerPerfilAtivo((cid, coid) => excluirCompraFatura(cid, coid));
    atualizarTelaCartoes();
}

// ========== CARTÕES DE CRÉDITO ==========
function atualizarTelaCartoes() {
    const grid = document.getElementById('cartoesGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!_ctx.cartaoSelecionadoId && _ctx.cartoesCredito.length > 0) {
        _ctx.cartaoSelecionadoId = _ctx.cartoesCredito[0].id;
    }

    const cartaoAtivo = _ctx.cartoesCredito.find(c => c.id === _ctx.cartaoSelecionadoId) || _ctx.cartoesCredito[0] || null;

    const coresCartao = {
        'Nubank':          'linear-gradient(135deg, #5b0d8c 0%, #9b19d1 100%)',
        'Bradesco':        'linear-gradient(135deg, #c00000 0%, #e83232 100%)',
        'Mercado Pago':    'linear-gradient(135deg, #006bb3 0%, #009ee3 100%)',
        'C6 Bank':         'linear-gradient(135deg, #111114 0%, #2c2c30 100%)',
        'Itaú':            'linear-gradient(135deg, #d46000 0%, #f07800 100%)',
        'Santander':       'linear-gradient(135deg, #a80000 0%, #d40000 100%)',
        'Banco do Brasil': 'linear-gradient(135deg, #003070 0%, #005cc5 100%)',
        'Caixa':           'linear-gradient(135deg, #004f96 0%, #0074cc 100%)',
    };

    // ── HEADER ──────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'cartoes-novo-header';

    const titulo = document.createElement('div');
    titulo.className = 'cartoes-novo-titulo';
    const icTit = document.createElement('i');
    icTit.className = 'fas fa-credit-card';
    icTit.setAttribute('aria-hidden', 'true');
    const spanTit = document.createElement('span');
    spanTit.textContent = 'Cartões';
    titulo.appendChild(icTit);
    titulo.appendChild(spanTit);

    const btnAdd = document.createElement('button');
    btnAdd.className = 'cartoes-novo-btn-add';
    btnAdd.type = 'button';
    const icAdd = document.createElement('i');
    icAdd.className = 'fas fa-plus';
    icAdd.setAttribute('aria-hidden', 'true');
    btnAdd.appendChild(icAdd);
    btnAdd.appendChild(document.createTextNode(' Adicionar Cartão'));
    btnAdd.addEventListener('click', () => abrirCartaoForm());

    header.appendChild(titulo);
    header.appendChild(btnAdd);
    grid.appendChild(header);

    // ── EMPTY STATE ──────────────────────────────────────────
    if (!cartaoAtivo) {
        const empty = document.createElement('div');
        empty.className = 'cartoes-empty-state';
        const emptyIcon = document.createElement('div');
        emptyIcon.style.fontSize = '3.5rem';
        emptyIcon.textContent = '💳';
        const emptyTxt = document.createElement('p');
        emptyTxt.textContent = 'Nenhum cartão cadastrado. Adicione seu primeiro cartão!';
        empty.appendChild(emptyIcon);
        empty.appendChild(emptyTxt);
        grid.appendChild(empty);
        return;
    }

    // ── FEATURED CARD ────────────────────────────────────────────────
    const featuredWrapper = document.createElement('div');
    featuredWrapper.className = 'cartao-featured-wrapper';

    const featured = document.createElement('div');
    featured.className = 'cartao-featured-card';
    const corGrad = coresCartao[cartaoAtivo.nomeBanco] || 'linear-gradient(135deg, #1a1d2e 0%, #2a2d3e 100%)';
    featured.style.background = corGrad;
    if (cartaoAtivo.congelado) featured.classList.add('cartao-congelado');

    // ── TOPO: ícone do banco + nome (esquerda) | contactless (direita)
    const topoDiv = document.createElement('div');
    topoDiv.className = 'cartao-featured-top';

    const nameRow = document.createElement('div');
    nameRow.className = 'cartao-featured-name-row';

    const bankIconWrap = document.createElement('div');
    bankIconWrap.className = 'cartao-featured-bank-icon';
    const featuredIconPath = _ctx.BANCO_ICON[cartaoAtivo.nomeBanco];
    if (featuredIconPath) {
        const featuredImg = document.createElement('img');
        featuredImg.src = featuredIconPath;
        featuredImg.alt = '';
        featuredImg.setAttribute('aria-hidden', 'true');
        featuredImg.className = 'cartao-featured-bank-img';
        bankIconWrap.appendChild(featuredImg);
    } else {
        bankIconWrap.textContent = _ctx.BANCO_ABREV[cartaoAtivo.nomeBanco]
            || _ctx._sanitizeText(cartaoAtivo.nomeBanco).substring(0, 2).toUpperCase();
    }
    nameRow.appendChild(bankIconWrap);

    const nomeDiv = document.createElement('div');
    nomeDiv.className = 'cartao-featured-nome';
    nomeDiv.textContent = _ctx._sanitizeText(cartaoAtivo.nomeBanco);
    nameRow.appendChild(nomeDiv);

    const contactless = document.createElement('div');
    contactless.className = 'cartao-featured-contactless';
    const icContactless = document.createElement('i');
    icContactless.className = 'fas fa-wifi';
    icContactless.setAttribute('aria-hidden', 'true');
    contactless.appendChild(icContactless);

    topoDiv.appendChild(nameRow);
    topoDiv.appendChild(contactless);
    featured.appendChild(topoDiv);

    // ── MEIO: chip centralizado à esquerda
    const middleDiv = document.createElement('div');
    middleDiv.className = 'cartao-featured-middle';

    const chip = document.createElement('div');
    chip.className = 'cartao-featured-chip';
    middleDiv.appendChild(chip);
    featured.appendChild(middleDiv);

    // ── RODAPÉ: disponível (esquerda) + limite (direita)
    const disponivel = Math.max(0, cartaoAtivo.limite - (cartaoAtivo.usado || 0));

    const bottomDiv = document.createElement('div');
    bottomDiv.className = 'cartao-featured-bottom';

    // Disponível — esquerda
    const dispDiv = document.createElement('div');
    dispDiv.className = 'cartao-featured-disponivel';
    const dispLbl = document.createElement('span');
    dispLbl.className = 'cartao-featured-label';
    dispLbl.textContent = 'Disponível';
    const dispVal = document.createElement('span');
    dispVal.className = 'cartao-featured-value cartao-featured-value--green';
    dispVal.textContent = _ctx.formatBRL(disponivel);
    dispDiv.appendChild(dispLbl);
    dispDiv.appendChild(dispVal);

    // Limite — direita
    const limiteDiv = document.createElement('div');
    limiteDiv.className = 'cartao-featured-limite';
    limiteDiv.style.textAlign = 'right';
    const limiteLbl = document.createElement('span');
    limiteLbl.className = 'cartao-featured-label';
    limiteLbl.textContent = 'Limite';
    const limiteVal = document.createElement('span');
    limiteVal.className = 'cartao-featured-value';
    limiteVal.textContent = _ctx.formatBRL(cartaoAtivo.limite);
    limiteDiv.appendChild(limiteLbl);
    limiteDiv.appendChild(limiteVal);

    bottomDiv.appendChild(dispDiv);
    bottomDiv.appendChild(limiteDiv);
    featured.appendChild(bottomDiv);

    // ── BARRA de uso (abaixo do bottom)
    const percUsado = cartaoAtivo.limite > 0
        ? Math.min(100, ((cartaoAtivo.usado || 0) / cartaoAtivo.limite) * 100)
        : 0;
    const corBarra = percUsado > 80 ? '#ff4b4b' : percUsado > 50 ? '#ffd166' : '#00ff99';

    const barWrapper = document.createElement('div');
    barWrapper.className = 'cartao-featured-bar-wrapper';
    const bar = document.createElement('div');
    bar.className = 'cartao-featured-bar';
    const barFill = document.createElement('div');
    barFill.className = 'cartao-featured-bar-fill';
    barFill.style.width = `${percUsado.toFixed(1)}%`;
    barFill.style.background = corBarra;
    bar.appendChild(barFill);
    const barLabel = document.createElement('span');
    barLabel.className = 'cartao-featured-bar-label';
    barLabel.textContent = `${percUsado.toFixed(0)}% usado`;
    barWrapper.appendChild(bar);
    barWrapper.appendChild(barLabel);
    featured.appendChild(barWrapper);

    // Frozen overlay
    if (cartaoAtivo.congelado) {
        const frozenOverlay = document.createElement('div');
        frozenOverlay.className = 'cartao-frozen-overlay';
        const frozenIc = document.createElement('i');
        frozenIc.className = 'fas fa-snowflake';
        frozenIc.setAttribute('aria-hidden', 'true');
        const frozenTxt = document.createElement('span');
        frozenTxt.textContent = 'Cartão Congelado';
        frozenOverlay.appendChild(frozenIc);
        frozenOverlay.appendChild(frozenTxt);
        featured.appendChild(frozenOverlay);
    }

    featuredWrapper.appendChild(featured);

    // ── ACTION BUTTONS ────────────────────────────────────────
    const actionsRow = document.createElement('div');
    actionsRow.className = 'cartao-actions-row';

    const acoesDef = [
        {
            icon:   'fa-file-invoice-dollar',
            label:  'Pagar Fatura',
            action: () => {
                const fatura = _ctx.contasFixas.find(c =>
                    c.cartaoId === cartaoAtivo.id && c.tipoContaFixa === 'fatura_cartao' && !c.pago
                );
                if (fatura) abrirPopupPagarContaFixa(fatura.id);
                else _ctx.mostrarNotificacao('Nenhuma fatura em aberto neste cartão.', 'info');
            }
        },
        {
            icon:        cartaoAtivo.congelado ? 'fa-fire' : 'fa-snowflake',
            label:       cartaoAtivo.congelado ? 'Descongelar' : 'Congelar',
            extraClass:  cartaoAtivo.congelado
                             ? 'cartao-action-btn--freeze cartao-action-btn--frozen'
                             : 'cartao-action-btn--freeze',
            action: () => congelarCartao(cartaoAtivo.id)
        },
        {
            icon:   'fa-circle-info',
            label:  'Detalhes',
            action: () => abrirDetalhesCartaoCompleto(cartaoAtivo.id)
        }
    ];

    acoesDef.forEach(def => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cartao-action-btn' + (def.extraClass ? ' ' + def.extraClass : '');
        const ic = document.createElement('i');
        ic.className = `fas ${def.icon}`;
        ic.setAttribute('aria-hidden', 'true');
        const lbl = document.createElement('span');
        lbl.textContent = def.label;
        btn.appendChild(ic);
        btn.appendChild(lbl);
        btn.addEventListener('click', def.action);
        actionsRow.appendChild(btn);
    });

    featuredWrapper.appendChild(actionsRow);
    grid.appendChild(featuredWrapper);

    // ── MEUS CARTÕES ─────────────────────────────────────────
    const meusSection = document.createElement('div');
    meusSection.className = 'meus-cartoes-section';

    const meusHeader = document.createElement('div');
    meusHeader.className = 'meus-cartoes-header';
    const meusTit = document.createElement('span');
    meusTit.textContent = 'Meus Cartões';
    const meusCountSpan = document.createElement('span');
    meusCountSpan.className = 'meus-cartoes-count';
    if (_ctx.cartoesCredito.length > 3) {
        meusCountSpan.textContent = `${cartoesCredito.length - 3} oculto(s) >`;
    }
    meusHeader.appendChild(meusTit);
    meusHeader.appendChild(meusCountSpan);
    meusSection.appendChild(meusHeader);

    const meusLista = document.createElement('div');
    meusLista.className = 'meus-cartoes-lista';

    _ctx.cartoesCredito.forEach(c => {
        const miniCard = document.createElement('div');
        miniCard.className = 'meus-cartoes-mini' + (c.id === _ctx.cartaoSelecionadoId ? ' meus-cartoes-mini--ativo' : '');
        const corMini = coresCartao[c.nomeBanco] || 'linear-gradient(135deg, #1a1d2e 0%, #2a2d3e 100%)';
        miniCard.style.background = corMini;

        if (c.congelado) {
            const frozenBadge = document.createElement('div');
            frozenBadge.className = 'mini-frozen-badge';
            const fIc = document.createElement('i');
            fIc.className = 'fas fa-snowflake';
            fIc.setAttribute('aria-hidden', 'true');
            frozenBadge.appendChild(fIc);
            miniCard.appendChild(frozenBadge);
        }

        const miniIconPath = _ctx.BANCO_ICON[c.nomeBanco];
        if (miniIconPath) {
            const miniImg = document.createElement('img');
            miniImg.className = 'meus-cartoes-mini-icon';
            miniImg.src = miniIconPath;
            miniImg.alt = '';
            miniImg.setAttribute('aria-hidden', 'true');
            miniCard.appendChild(miniImg);
        } else {
            const miniAbrevEl = document.createElement('div');
            miniAbrevEl.className = 'meus-cartoes-mini-abrev';
            miniAbrevEl.textContent = _ctx.BANCO_ABREV[c.nomeBanco]
                || _ctx._sanitizeText(c.nomeBanco).substring(0, 2).toUpperCase();
            miniCard.appendChild(miniAbrevEl);
        }

        const miniNome = document.createElement('div');
        miniNome.className = 'meus-cartoes-mini-nome';
        miniNome.textContent = _ctx._sanitizeText(c.nomeBanco);
        miniCard.appendChild(miniNome);

        const miniDisp = document.createElement('div');
        miniDisp.className = 'meus-cartoes-mini-disp';
        miniDisp.textContent = _ctx.formatBRL(Math.max(0, c.limite - (c.usado || 0)));
        miniCard.appendChild(miniDisp);

        miniCard.addEventListener('click', () => {
            _ctx.cartaoSelecionadoId = c.id;
            _ctx.atualizarTelaCartoes();
        });

        meusLista.appendChild(miniCard);
    });

    // Mini card "Adicionar"
    const addMini = document.createElement('div');
    addMini.className = 'meus-cartoes-mini meus-cartoes-mini--add';
    const addIc = document.createElement('i');
    addIc.className = 'fas fa-plus';
    addIc.setAttribute('aria-hidden', 'true');
    const addTxt = document.createElement('span');
    addTxt.textContent = 'Novo';
    addMini.appendChild(addIc);
    addMini.appendChild(addTxt);
    addMini.addEventListener('click', () => abrirCartaoForm());
    meusLista.appendChild(addMini);

    meusSection.appendChild(meusLista);
    grid.appendChild(meusSection);
}

// ========== CONGELAR / DESCONGELAR CARTÃO ==========
function congelarCartao(cartaoId) {
    const cartao = _ctx.cartoesCredito.find(c => c.id === cartaoId);
    if (!cartao) return;

    const msg = cartao.congelado
        ? 'Descongelar este cartão? Ele voltará a aceitar novos lançamentos normalmente.'
        : 'Congelar este cartão? Nenhum novo lançamento poderá ser realizado enquanto estiver congelado.';

    _ctx.confirmarAcao(msg, () => {
        cartao.congelado = !cartao.congelado;
        _ctx.salvarDados();
        _ctx.atualizarTelaCartoes();
        _ctx.mostrarNotificacao(
            cartao.congelado ? 'Cartão congelado com sucesso!' : 'Cartão descongelado!',
            cartao.congelado ? 'warning' : 'success'
        );
    });
}

function abrirCartaoForm(editId = null) {
    const bancos = [
        { nome: 'Nubank' },
        { nome: 'Bradesco' },
        { nome: 'Mercado Pago' },
        { nome: 'C6 Bank' },
        { nome: 'Itaú' },
        { nome: 'Santander' },
        { nome: 'Banco do Brasil' },
        { nome: 'Caixa' },
        { nome: 'Alelo' },
        { nome: 'Outro' },
    ];

    // ✅ Constrói o <select> de bancos via DOM — nunca interpolação de string
    function _criarSelectBancos(idSelect, valorSelecionado) {
        const select = document.createElement('select');
        select.id        = idSelect;
        select.className = 'form-input';

        bancos.forEach(b => {
            const opt = document.createElement('option');
            opt.value       = b.nome;          // ✅ atribuição direta — não interpolado
            opt.textContent = b.nome;          // ✅ textContent — nunca innerHTML
            if (b.nome === valorSelecionado) opt.selected = true;
            select.appendChild(opt);
        });
        return select;
    }

    // ✅ Constrói o <select> de dias via DOM
    function _criarSelectDias(idSelect, valorSelecionado) {
        const select = document.createElement('select');
        select.id        = idSelect;
        select.className = 'form-input';

        const placeholder       = document.createElement('option');
        placeholder.value       = '';
        placeholder.textContent = 'Selecione o dia';
        select.appendChild(placeholder);

        for (let i = 1; i <= 28; i++) {
            const opt = document.createElement('option');
            opt.value       = String(i);
            opt.textContent = String(i).padStart(2, '0');
            if (Number(valorSelecionado) === i) opt.selected = true;
            select.appendChild(opt);
        }
        return select;
    }

    // ✅ Configura listener do select de banco (sem duplicação)
    function _configurarSelectBanco(selectBanco, campoOutro, inputOutro) {
        selectBanco.addEventListener('change', function () {
            if (this.value === 'Outro') {
                campoOutro.style.display = 'block';
                inputOutro.required      = true;
                if (!inputOutro.value) inputOutro.focus();
            } else {
                campoOutro.style.display = 'none';
                inputOutro.required      = false;
                inputOutro.value         = '';
            }
        });
    }

    // ── Lógica de salvar/editar compartilhada entre os dois modos
    function _executarSalvar(selectBanco, inputOutro, inputLimite, selectFechamento, selectDia, cartaoExistente) {
        let nomeBanco = selectBanco.value;

        if (nomeBanco === 'Outro') {
            const nomeDigitado = inputOutro.value.trim();
            if (!nomeDigitado)           { alert('Digite o nome do cartão!'); return; }
            if (nomeDigitado.length > 50) { alert('Nome do cartão muito longo (máx. 50 caracteres).'); return; }
            nomeBanco = nomeDigitado;
        }

        const limiteStr     = inputLimite.value;
        const fechamentoDia = selectFechamento.value;
        const vencimentoDia = selectDia.value;

        if (!nomeBanco || !limiteStr || !fechamentoDia || !vencimentoDia) { alert('Preencha todos os campos!'); return; }

        const limite = parseFloat(parseFloat(limiteStr).toFixed(2));
        if (isNaN(limite) || limite <= 0) { alert('Informe um limite válido e positivo.'); return; }
        if (limite > 9999999)              { alert('Limite máximo permitido: R$ 9.999.999,00.'); return; }

        if (Number(fechamentoDia) === Number(vencimentoDia)) {
            alert('O dia de fechamento e o dia de vencimento não podem ser iguais.');
            return;
        }

        const bandeiraImg = bancos.find(b => b.nome === nomeBanco)?.img || '';

        if (cartaoExistente) {
            // Modo edição
            cartaoExistente.nomeBanco     = nomeBanco;
            cartaoExistente.limite        = limite;
            cartaoExistente.fechamentoDia = Number(fechamentoDia);
            cartaoExistente.vencimentoDia = Number(vencimentoDia);
            cartaoExistente.bandeiraImg   = bandeiraImg;
        } else {
            // Modo criação
            _ctx.cartoesCredito.push({
                id:             _ctx.nextCartaoId++,
                nomeBanco,
                limite,
                fechamentoDia:  Number(fechamentoDia),
                vencimentoDia:  Number(vencimentoDia),
                bandeiraImg,
                usado:          0,
            });
        }

        _ctx.salvarDados();
        _ctx.atualizarTelaCartoes();
        _ctx.fecharPopup();
        _ctx.mostrarNotificacao(
            cartaoExistente ? 'Cartão atualizado com sucesso!' : 'Cartão cadastrado com sucesso!',
            'success'
        );
    }

    if (!editId) {
        // ── MODO: NOVO CARTÃO ─────────────────────────────────────────────
        _ctx.criarPopupDOM((popup) => {
            const titulo = document.createElement('h3');
            titulo.textContent = 'Novo Cartão';

            // Label + Select banco
            const labelBanco       = document.createElement('label');
            labelBanco.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelBanco.textContent = 'Banco:';

            const selectBanco = _criarSelectBancos('novoBanco', '');

            // Campo "Outro" (oculto por padrão)
            const campoOutro       = document.createElement('div');
            campoOutro.id          = 'campoOutroCartao';
            campoOutro.style.cssText = 'display:none; margin-top:10px;';

            const labelOutro       = document.createElement('label');
            labelOutro.style.cssText = 'display:block; text-align:left; color: var(--text-secondary);';
            labelOutro.textContent = 'Nome do Cartão:';

            const inputOutro       = document.createElement('input');
            inputOutro.type        = 'text';
            inputOutro.id          = 'nomeOutroCartao';
            inputOutro.className   = 'form-input';
            inputOutro.placeholder = 'Digite o nome do cartão';
            inputOutro.maxLength   = 50;

            campoOutro.appendChild(labelOutro);
            campoOutro.appendChild(inputOutro);

            // Label + Input limite
            const labelLimite       = document.createElement('label');
            labelLimite.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelLimite.textContent = 'Limite Total:';

            const inputLimite       = document.createElement('input');
            inputLimite.type        = 'number';
            inputLimite.id          = 'novoLimite';
            inputLimite.className   = 'form-input';
            inputLimite.placeholder = 'Limite (R$)';
            inputLimite.step        = '0.01';
            inputLimite.min         = '1';
            inputLimite.max         = '9999999';

            // Label + Select fechamento
            const labelFechamento       = document.createElement('label');
            labelFechamento.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelFechamento.textContent = 'Dia do Fechamento da Fatura:';

            const selectFechamento = _criarSelectDias('novoFechamentoDia', '');

            // Label + Select vencimento
            const labelDia       = document.createElement('label');
            labelDia.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelDia.textContent = 'Dia do Vencimento da Fatura:';

            const selectDia = _criarSelectDias('novoVencimentoDia', '');

            // Botões
            const btnSalvar     = document.createElement('button');
            btnSalvar.className = 'btn-primary';
            btnSalvar.type      = 'button';
            btnSalvar.textContent = 'Salvar';

            const btnCancelar     = document.createElement('button');
            btnCancelar.className = 'btn-cancelar';
            btnCancelar.type      = 'button';
            btnCancelar.textContent = 'Cancelar';

            btnCancelar.addEventListener('click', _ctx.fecharPopup);
            btnSalvar.addEventListener('click', () => _executarSalvar(selectBanco, inputOutro, inputLimite, selectFechamento, selectDia, null));

            _configurarSelectBanco(selectBanco, campoOutro, inputOutro);

            popup.appendChild(titulo);
            popup.appendChild(labelBanco);
            popup.appendChild(selectBanco);
            popup.appendChild(campoOutro);
            popup.appendChild(labelLimite);
            popup.appendChild(inputLimite);
            popup.appendChild(labelFechamento);
            popup.appendChild(selectFechamento);
            popup.appendChild(labelDia);
            popup.appendChild(selectDia);
            popup.appendChild(btnSalvar);
            popup.appendChild(btnCancelar);
        });

    } else {
        // ── MODO: EDITAR CARTÃO ───────────────────────────────────────────
        const c = _ctx.cartoesCredito.find(x => x.id === editId);
        if (!c) return;

        _ctx.criarPopupDOM((popup) => {
            const titulo = document.createElement('h3');
            titulo.textContent = 'Editar Cartão';

            // Label + Select banco (pré-selecionado)
            const labelBanco       = document.createElement('label');
            labelBanco.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelBanco.textContent = 'Banco:';

            const bancoExisteNaLista = bancos.find(b => b.nome === c.nomeBanco && b.nome !== 'Outro');
            const selectBanco = _criarSelectBancos('novoBanco', bancoExisteNaLista ? c.nomeBanco : 'Outro');

            // Campo "Outro"
            const campoOutro       = document.createElement('div');
            campoOutro.id          = 'campoOutroCartao';
            campoOutro.style.cssText = bancoExisteNaLista ? 'display:none; margin-top:10px;' : 'display:block; margin-top:10px;';

            const labelOutro       = document.createElement('label');
            labelOutro.style.cssText = 'display:block; text-align:left; color: var(--text-secondary);';
            labelOutro.textContent = 'Nome do Cartão:';

            const inputOutro       = document.createElement('input');
            inputOutro.type        = 'text';
            inputOutro.id          = 'nomeOutroCartao';
            inputOutro.className   = 'form-input';
            inputOutro.placeholder = 'Digite o nome do cartão';
            inputOutro.maxLength   = 50;
            // ✅ Pré-preenche via .value — nunca via atributo HTML
            if (!bancoExisteNaLista) inputOutro.value = c.nomeBanco;

            campoOutro.appendChild(labelOutro);
            campoOutro.appendChild(inputOutro);

            // Label + Input limite
            const labelLimite       = document.createElement('label');
            labelLimite.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelLimite.textContent = 'Limite Total:';

            const inputLimite       = document.createElement('input');
            inputLimite.type        = 'number';
            inputLimite.id          = 'novoLimite';
            inputLimite.className   = 'form-input';
            inputLimite.step        = '0.01';
            inputLimite.min         = '1';
            inputLimite.max         = '9999999';
            inputLimite.value       = parseFloat(c.limite); // ✅ .value — não atributo HTML

            // Label + Select fechamento (pré-selecionado)
            const labelFechamento       = document.createElement('label');
            labelFechamento.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelFechamento.textContent = 'Dia do Fechamento da Fatura:';

            const selectFechamento = _criarSelectDias('novoFechamentoDia', c.fechamentoDia ?? '');

            // Label + Select vencimento (pré-selecionado)
            const labelDia       = document.createElement('label');
            labelDia.style.cssText = 'display:block; text-align:left; margin-top:10px; color: var(--text-secondary);';
            labelDia.textContent = 'Dia do Vencimento da Fatura:';

            const selectDia = _criarSelectDias('novoVencimentoDia', c.vencimentoDia);

            // Botões
            const btnSalvar     = document.createElement('button');
            btnSalvar.className = 'btn-primary';
            btnSalvar.type      = 'button';
            btnSalvar.textContent = 'Salvar';

            const btnCancelar     = document.createElement('button');
            btnCancelar.className = 'btn-cancelar';
            btnCancelar.type      = 'button';
            btnCancelar.textContent = 'Cancelar';

            const btnExcluir     = document.createElement('button');
            btnExcluir.className = 'btn-excluir';
            btnExcluir.type      = 'button';
            btnExcluir.textContent = 'Excluir';

            btnCancelar.addEventListener('click', _ctx.fecharPopup);
            btnSalvar.addEventListener('click', () => _executarSalvar(selectBanco, inputOutro, inputLimite, selectFechamento, selectDia, c));
            btnExcluir.addEventListener('click', () => {
                if (confirm('Excluir cartão? Todas as compras futuras vinculadas a ele serão removidas.')) {
                    _ctx.cartoesCredito = _ctx.cartoesCredito.filter(x => x.id !== editId);
                    if (_ctx.cartaoSelecionadoId === editId) _ctx.cartaoSelecionadoId = null;
                    _ctx.contasFixas    = _ctx.contasFixas.filter(x => x.cartaoId !== editId);
                    _ctx.salvarDados();
                    _ctx.atualizarTelaCartoes();
                    _ctx.atualizarListaContasFixas();
                    _ctx.fecharPopup();
                    _ctx.mostrarNotificacao('Cartão excluído com sucesso!', 'success');
                }
            });

            _configurarSelectBanco(selectBanco, campoOutro, inputOutro);

            popup.appendChild(titulo);
            popup.appendChild(labelBanco);
            popup.appendChild(selectBanco);
            popup.appendChild(campoOutro);
            popup.appendChild(labelLimite);
            popup.appendChild(inputLimite);
            popup.appendChild(labelFechamento);
            popup.appendChild(selectFechamento);
            popup.appendChild(labelDia);
            popup.appendChild(selectDia);
            popup.appendChild(btnSalvar);
            popup.appendChild(btnCancelar);
            popup.appendChild(btnExcluir);
        });
    }
}

// ========== DETALHES COMPLETOS DO CARTÃO ==========
function abrirDetalhesCartaoCompleto(cartaoId) {
    const cartao = _ctx.cartoesCredito.find(c => c.id === cartaoId);
    if (!cartao) return;

    const usado     = cartao.usado || 0;
    const disponivel = Math.max(0, cartao.limite - usado);
    const percUsado  = cartao.limite > 0
        ? Math.min(100, (usado / cartao.limite) * 100)
        : 0;

    const faturas = _ctx.contasFixas.filter(c =>
        c.cartaoId === cartaoId && c.tipoContaFixa === 'fatura_cartao'
    );
    const totalFatura     = faturas.reduce((sum, f) => sum + (f.valor || 0), 0);
    const parcelasAtivas  = _ctx.contasFixas.filter(fx => fx.cartaoId === cartaoId && fx.totalParcelas);

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width: 460px; width: 95%;';

        const scroll = document.createElement('div');
        scroll.style.cssText = 'max-height: 70vh; overflow-y: auto; overflow-x: hidden; padding-right: 6px;';

        // ── Título
        const titulo = document.createElement('h3');
        titulo.style.cssText = 'text-align: center; margin-bottom: 20px; display: flex; align-items: center; justify-content: center; gap: 10px;';
        const tituloIcon = document.createElement('i');
        tituloIcon.className = 'fas fa-credit-card';
        tituloIcon.style.color = 'var(--primary)';
        const tituloText = document.createElement('span');
        tituloText.textContent = _ctx._sanitizeText(cartao.nomeBanco);
        titulo.appendChild(tituloIcon);
        titulo.appendChild(tituloText);
        scroll.appendChild(titulo);

        // Status frozen
        if (cartao.congelado) {
            const frozenBanner = document.createElement('div');
            frozenBanner.style.cssText = 'background: rgba(96,212,255,0.12); border: 1px solid rgba(96,212,255,0.3); border-radius: 10px; padding: 10px 14px; text-align: center; color: #60d4ff; font-weight: 600; font-size: 0.9rem; margin-bottom: 16px; display: flex; align-items: center; justify-content: center; gap: 8px;';
            const frozenIcon = document.createElement('i');
            frozenIcon.className = 'fas fa-snowflake';
            const frozenText = document.createElement('span');
            frozenText.textContent = 'Cartão congelado — nenhum novo lançamento permitido';
            frozenBanner.appendChild(frozenIcon);
            frozenBanner.appendChild(frozenText);
            scroll.appendChild(frozenBanner);
        }

        // ── Stats grid
        const statsGrid = document.createElement('div');
        statsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px;';

        const statsData = [
            { iconCls: 'fas fa-wallet',          label: 'Limite Total',      value: _ctx.formatBRL(cartao.limite),            color: 'var(--text-primary)' },
            { iconCls: 'fas fa-arrow-trend-up',  label: 'Valor Usado',       value: _ctx.formatBRL(usado),                    color: '#ff4b4b' },
            { iconCls: 'fas fa-circle-check',    label: 'Disponível',         value: _ctx.formatBRL(disponivel),               color: '#00ff99' },
            { iconCls: 'fas fa-chart-pie',       label: '% Utilizado',        value: `${percUsado.toFixed(1)}%`,          color: percUsado > 80 ? '#ff4b4b' : '#00ff99' },
            { iconCls: 'fas fa-file-invoice',    label: 'Fatura em Aberto',   value: _ctx.formatBRL(totalFatura),                                                                   color: '#ffd166' },
            { iconCls: 'fas fa-calendar-xmark',  label: 'Fechamento',          value: cartao.fechamentoDia ? `Todo dia ${cartao.fechamentoDia}` : '— (edite o cartão)',         color: '#ff9f43' },
            { iconCls: 'fas fa-calendar-day',    label: 'Vencimento',          value: `Todo dia ${cartao.vencimentoDia}`,                                                        color: 'var(--primary)' },
        ];

        statsData.forEach(s => {
            const card = document.createElement('div');
            card.style.cssText = 'background: rgba(255,255,255,0.05); padding: 14px; border-radius: 12px; text-align: center;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 6px; display: flex; align-items: center; justify-content: center; gap: 6px;';
            const lblIcon = document.createElement('i');
            lblIcon.className = s.iconCls;
            const lblText = document.createElement('span');
            lblText.textContent = s.label;
            lbl.appendChild(lblIcon);
            lbl.appendChild(lblText);
            const val = document.createElement('div');
            val.style.cssText = `font-size: 1.05rem; font-weight: 700; color: ${s.color};`;
            val.textContent = s.value;
            card.appendChild(lbl);
            card.appendChild(val);
            statsGrid.appendChild(card);
        });
        scroll.appendChild(statsGrid);

        // ── Barra de utilização
        const barSection = document.createElement('div');
        barSection.style.marginBottom = '20px';

        const barRow = document.createElement('div');
        barRow.style.cssText = 'display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 0.85rem;';
        const barLblL = document.createElement('span');
        barLblL.style.color = 'var(--text-secondary)';
        barLblL.textContent = 'Utilização do Limite';
        const barLblR = document.createElement('span');
        barLblR.style.cssText = `font-weight: 700; color: ${percUsado > 80 ? '#ff4b4b' : '#00ff99'};`;
        barLblR.textContent = `${percUsado.toFixed(1)}%`;
        barRow.appendChild(barLblL);
        barRow.appendChild(barLblR);

        const barBg = document.createElement('div');
        barBg.style.cssText = 'width: 100%; height: 14px; background: rgba(255,255,255,0.1); border-radius: 7px; overflow: hidden;';
        const barFill = document.createElement('div');
        const corFill = percUsado > 80 ? '#ff4b4b' : percUsado > 50 ? '#ffd166' : '#00ff99';
        barFill.style.cssText = `width: ${percUsado.toFixed(1)}%; height: 100%; background: ${corFill}; border-radius: 7px; transition: width 0.5s;`;
        barBg.appendChild(barFill);

        barSection.appendChild(barRow);
        barSection.appendChild(barBg);
        scroll.appendChild(barSection);

        // ── Faturas em aberto
        if (faturas.length > 0) {
            const fTitle = document.createElement('h4');
            fTitle.style.cssText = 'color: var(--text-primary); margin-bottom: 12px; display: flex; align-items: center; gap: 8px;';
            const fTitleIcon = document.createElement('i');
            fTitleIcon.className = 'fas fa-receipt';
            fTitleIcon.style.color = '#ffd166';
            const fTitleText = document.createElement('span');
            fTitleText.textContent = 'Faturas em Aberto';
            fTitle.appendChild(fTitleIcon);
            fTitle.appendChild(fTitleText);
            scroll.appendChild(fTitle);

            faturas.forEach(f => {
                const fItem = document.createElement('div');
                fItem.style.cssText = 'background: rgba(255,209,102,0.1); padding: 14px; border-radius: 12px; border-left: 3px solid #ffd166; cursor: pointer; margin-bottom: 8px; transition: background 0.2s;';

                const fRow = document.createElement('div');
                fRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
                const fDesc = document.createElement('div');
                fDesc.style.cssText = 'font-weight: 600; font-size: 0.9rem; color: var(--text-primary);';
                fDesc.textContent = `Vence ${formatarDataBR(f.vencimento)}`;
                const fVal = document.createElement('div');
                fVal.style.cssText = 'font-weight: 700; color: #ffd166;';
                fVal.textContent = _ctx.formatBRL(f.valor);
                fRow.appendChild(fDesc);
                fRow.appendChild(fVal);

                const fSub = document.createElement('div');
                fSub.style.cssText = 'font-size: 0.78rem; color: var(--text-secondary); margin-top: 5px;';
                fSub.textContent = `${f.compras?.length || 0} compra(s) — toque para ver detalhes`;

                fItem.appendChild(fRow);
                fItem.appendChild(fSub);
                fItem.addEventListener('mouseover', () => { fItem.style.background = 'rgba(255,209,102,0.18)'; });
                fItem.addEventListener('mouseout',  () => { fItem.style.background = 'rgba(255,209,102,0.1)'; });
                fItem.addEventListener('click', () => {
                    _ctx.fecharPopup();
                    setTimeout(() => abrirVisualizacaoFatura(f.id), 200);
                });
                scroll.appendChild(fItem);
            });
        }

        // ── Parcelas ativas
        if (parcelasAtivas.length > 0) {
            const instDiv = document.createElement('div');
            instDiv.style.cssText = 'background: rgba(108,99,255,0.1); padding: 14px; border-radius: 12px; border-left: 3px solid #6c63ff; margin-top: 12px;';
            const instLbl = document.createElement('div');
            instLbl.style.cssText = 'font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 5px; display: flex; align-items: center; gap: 6px;';
            const instLblIcon = document.createElement('i');
            instLblIcon.className = 'fas fa-rotate';
            instLblIcon.style.color = '#6c63ff';
            const instLblText = document.createElement('span');
            instLblText.textContent = 'Compras Parceladas Ativas';
            instLbl.appendChild(instLblIcon);
            instLbl.appendChild(instLblText);
            const instVal = document.createElement('div');
            instVal.style.cssText = 'font-size: 1.1rem; font-weight: 700; color: #6c63ff;';
            instVal.textContent = `${parcelasAtivas.length} compra(s)`;
            instDiv.appendChild(instLbl);
            instDiv.appendChild(instVal);
            scroll.appendChild(instDiv);
        }

        popup.appendChild(scroll);

        // ── Botões fora do scroll (sem gap de scroll)
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 10px; margin-top: 16px;';

        const btnEditar = document.createElement('button');
        btnEditar.className = 'btn-primary';
        btnEditar.type = 'button';
        btnEditar.style.cssText = 'flex: 1; padding: 12px; display: flex; align-items: center; justify-content: center; gap: 8px;';
        const btnEditarIcon = document.createElement('i');
        btnEditarIcon.className = 'fas fa-pen';
        const btnEditarText = document.createElement('span');
        btnEditarText.textContent = 'Editar Cartão';
        btnEditar.appendChild(btnEditarIcon);
        btnEditar.appendChild(btnEditarText);
        btnEditar.addEventListener('click', () => {
            _ctx.fecharPopup();
            setTimeout(() => abrirCartaoForm(cartaoId), 200);
        });

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'flex: 1; padding: 12px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', _ctx.fecharPopup);

        btnRow.appendChild(btnEditar);
        btnRow.appendChild(btnFechar);
        popup.appendChild(btnRow);
    });
}


// ========== VISUALIZAÇÃO DETALHADA DE FATURA DE CARTÃO ==========
function abrirVisualizacaoFatura(faturaId) {
    const fatura = _ctx.contasFixas.find(c => c.id === faturaId);
    if (!fatura || !fatura.compras) return;

    const cartao     = _ctx.cartoesCredito.find(c => c.id === fatura.cartaoId);
    const nomeCartao = cartao ? _ctx._sanitizeText(cartao.nomeBanco) : 'Cartão';

    const totalCompras    = fatura.compras.length;
    const comprasPagas    = fatura.compras.filter(c => Number(c.parcelaAtual) > Number(c.totalParcelas)).length;
    const comprasPendentes = totalCompras - comprasPagas;
    const hojeISO         = new Date().toISOString().slice(0, 10);
    const vencida         = fatura.vencimento && fatura.vencimento < hojeISO && !fatura.pago;
    const corStatus       = fatura.pago ? '#00ff99' : vencida ? '#ff4b4b' : '#ffd166';

    _ctx.criarPopupDOM((popup) => {
        popup.style.cssText = 'max-width:480px; width:95%; padding:0; border-radius:18px; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.07);';

        // ── Cabeçalho glassmorphism
        const header = document.createElement('div');
        header.style.cssText = `
            background: linear-gradient(135deg, rgba(108,99,255,0.85), rgba(76,166,255,0.85));
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            padding: 22px 22px 18px;
            position: relative;
        `;

        const btnFecharHeader = document.createElement('button');
        btnFecharHeader.style.cssText = 'position:absolute; top:14px; right:14px; background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.25); color:#fff; width:30px; height:30px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:0.85rem; transition:background .15s;';
        btnFecharHeader.addEventListener('click', _ctx.fecharPopup);
        const xIcon = document.createElement('i'); xIcon.className = 'fas fa-xmark';
        btnFecharHeader.appendChild(xIcon);

        const headerIcon = document.createElement('i');
        headerIcon.className = 'fas fa-credit-card';
        headerIcon.style.cssText = 'font-size:2rem; color:rgba(255,255,255,0.9); display:block; margin-bottom:10px;';

        const headerNome = document.createElement('div');
        headerNome.style.cssText = 'font-size:1.25rem; font-weight:700; color:#fff; margin-bottom:6px;';
        headerNome.textContent = nomeCartao;

        const headerMeta = document.createElement('div');
        headerMeta.style.cssText = 'display:flex; align-items:center; gap:16px; flex-wrap:wrap;';

        function _metaItem(iconCls, texto) {
            const d = document.createElement('div');
            d.style.cssText = 'display:flex; align-items:center; gap:6px; color:rgba(255,255,255,0.8); font-size:0.85rem;';
            const i = document.createElement('i'); i.className = iconCls;
            d.appendChild(i); d.appendChild(document.createTextNode(texto));
            return d;
        }

        headerMeta.appendChild(_metaItem('fas fa-calendar-day', `Vence: ${formatarDataBR(fatura.vencimento)}`));

        const statusBadge = document.createElement('span');
        statusBadge.style.cssText = `background:${corStatus}22; color:${corStatus}; border:1px solid ${corStatus}44; font-size:0.75rem; font-weight:700; padding:3px 10px; border-radius:20px;`;
        const statusIcon = document.createElement('i');
        statusIcon.className = fatura.pago ? 'fas fa-circle-check' : vencida ? 'fas fa-triangle-exclamation' : 'fas fa-clock';
        statusIcon.style.marginRight = '5px';
        statusBadge.appendChild(statusIcon);
        statusBadge.appendChild(document.createTextNode(fatura.pago ? 'Paga' : vencida ? 'Vencida' : 'Pendente'));
        headerMeta.appendChild(statusBadge);

        header.appendChild(btnFecharHeader);
        header.appendChild(headerIcon);
        header.appendChild(headerNome);
        header.appendChild(headerMeta);

        // ── Valor total em destaque
        const totalBlock = document.createElement('div');
        totalBlock.style.cssText = `
            background: ${corStatus}15;
            border-bottom: 1px solid ${corStatus}30;
            padding: 14px 22px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        const totalLabel = document.createElement('div');
        totalLabel.style.cssText = 'font-size:0.82rem; color:var(--text-secondary); display:flex; align-items:center; gap:6px;';
        const tlIcon = document.createElement('i'); tlIcon.className = 'fas fa-file-invoice-dollar'; tlIcon.style.color = corStatus;
        totalLabel.appendChild(tlIcon); totalLabel.appendChild(document.createTextNode('Total da Fatura'));
        const totalValor = document.createElement('div');
        totalValor.style.cssText = `font-size:1.5rem; font-weight:800; color:${corStatus};`;
        totalValor.textContent = _ctx.formatBRL(fatura.valor);
        totalBlock.appendChild(totalLabel);
        totalBlock.appendChild(totalValor);

        // ── Mini-stats (compras / pagas / pendentes)
        const statsRow = document.createElement('div');
        statsRow.style.cssText = 'display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:rgba(255,255,255,0.06); border-bottom:1px solid rgba(255,255,255,0.06);';

        function _statCell(iconCls, label, valor, cor) {
            const cell = document.createElement('div');
            cell.style.cssText = 'background:var(--surface, #1a1a2e); padding:12px; text-align:center;';
            const icon = document.createElement('i'); icon.className = iconCls; icon.style.cssText = `color:${cor}; font-size:1rem; display:block; margin-bottom:4px;`;
            const lbl  = document.createElement('div'); lbl.style.cssText = 'font-size:0.7rem; color:var(--text-muted); margin-bottom:2px;'; lbl.textContent = label;
            const val  = document.createElement('div'); val.style.cssText = `font-size:1.1rem; font-weight:700; color:${cor};`; val.textContent = String(valor);
            cell.appendChild(icon); cell.appendChild(lbl); cell.appendChild(val);
            return cell;
        }

        statsRow.appendChild(_statCell('fas fa-bag-shopping',  'Total',     totalCompras,     '#6c63ff'));
        statsRow.appendChild(_statCell('fas fa-circle-check',  'Pagas',     comprasPagas,     '#00ff99'));
        statsRow.appendChild(_statCell('fas fa-hourglass-half','Pendentes', comprasPendentes, '#ffd166'));

        // ── Lista de compras com scroll
        const scrollWrap = document.createElement('div');
        scrollWrap.style.cssText = 'max-height:52vh; overflow-y:auto; padding:16px 18px 4px;';

        const secTitle = document.createElement('div');
        secTitle.style.cssText = 'font-size:0.82rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; display:flex; align-items:center; gap:6px;';
        const secIcon = document.createElement('i'); secIcon.className = 'fas fa-list';
        secTitle.appendChild(secIcon); secTitle.appendChild(document.createTextNode('Compras nesta fatura'));
        scrollWrap.appendChild(secTitle);

        if (fatura.compras.length === 0) {
            const vazio = document.createElement('div');
            vazio.style.cssText = 'text-align:center; padding:30px; color:var(--text-muted);';
            const vzIcon = document.createElement('i'); vzIcon.className = 'fas fa-cart-shopping'; vzIcon.style.cssText = 'font-size:2rem; opacity:0.35; display:block; margin-bottom:10px;';
            const vzTxt = document.createElement('div'); vzTxt.textContent = 'Nenhuma compra nesta fatura';
            vazio.appendChild(vzIcon); vazio.appendChild(vzTxt);
            scrollWrap.appendChild(vazio);
        }

        fatura.compras.forEach(compra => {
            if (!compra || typeof compra !== 'object') return;
            const parcelaAtual  = Number(compra.parcelaAtual);
            const totalParcelas = Number(compra.totalParcelas);
            const valorParcela  = Number(compra.valorParcela);
            const valorTotal    = Number(compra.valorTotal);
            if (!isFinite(parcelaAtual) || !isFinite(totalParcelas) || !isFinite(valorParcela) || valorParcela <= 0) return;

            const isPaga = parcelaAtual > totalParcelas;
            const cor    = isPaga ? '#00ff99' : '#ffd166';
            const falta  = isPaga ? null : valorParcela * (totalParcelas - parcelaAtual + 1);

            const card = document.createElement('div');
            card.style.cssText = `
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.07);
                border-left: 3px solid ${cor};
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 10px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            `;

            // Linha principal
            const mainRow = document.createElement('div');
            mainRow.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px;';

            const info = document.createElement('div'); info.style.flex = '1';

            const tipo = document.createElement('div');
            tipo.style.cssText = 'font-weight:700; color:var(--text-primary); font-size:0.95rem; margin-bottom:3px;';
            tipo.textContent = String(compra.tipo || '');

            const desc = document.createElement('div');
            desc.style.cssText = 'color:var(--text-secondary); font-size:0.83rem; margin-bottom:4px;';
            desc.textContent = String(compra.descricao || '');

            const dataRow = document.createElement('div');
            dataRow.style.cssText = 'display:flex; align-items:center; gap:5px; color:var(--text-muted); font-size:0.78rem;';
            const dataIcon = document.createElement('i'); dataIcon.className = 'fas fa-calendar-alt'; dataIcon.style.fontSize = '0.72rem';
            dataRow.appendChild(dataIcon);
            dataRow.appendChild(document.createTextNode(String(compra.dataCompra || '')));

            info.appendChild(tipo); info.appendChild(desc); info.appendChild(dataRow);

            const rightCol = document.createElement('div'); rightCol.style.textAlign = 'right';
            const valEl = document.createElement('div');
            valEl.style.cssText = 'font-weight:800; color:var(--text-primary); font-size:1.1rem;';
            valEl.textContent = _ctx.formatBRL(valorParcela);

            const statusEl = document.createElement('div');
            statusEl.style.cssText = `font-size:0.78rem; font-weight:700; color:${cor}; margin-top:4px; display:flex; align-items:center; justify-content:flex-end; gap:4px;`;
            const stIcon = document.createElement('i');
            stIcon.className = isPaga ? 'fas fa-circle-check' : 'fas fa-rotate';
            statusEl.appendChild(stIcon);
            statusEl.appendChild(document.createTextNode(isPaga ? 'Quitada' : `${parcelaAtual}/${totalParcelas}x`));

            rightCol.appendChild(valEl); rightCol.appendChild(statusEl);
            mainRow.appendChild(info); mainRow.appendChild(rightCol);

            // Rodapé: total e falta pagar
            const footRow = document.createElement('div');
            footRow.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:8px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06);';

            function _footCell(label, texto, cor2) {
                const cell = document.createElement('div');
                const lbl  = document.createElement('div'); lbl.style.cssText = 'font-size:0.7rem; color:var(--text-muted); margin-bottom:2px; display:flex; align-items:center; gap:4px;';
                const lIcon = document.createElement('i'); lIcon.className = label === 'Valor total' ? 'fas fa-wallet' : 'fas fa-hourglass-end'; lIcon.style.fontSize = '0.65rem';
                lbl.appendChild(lIcon); lbl.appendChild(document.createTextNode(label));
                const val  = document.createElement('div'); val.style.cssText = `font-size:0.85rem; font-weight:700; color:${cor2};`; val.textContent = texto;
                cell.appendChild(lbl); cell.appendChild(val);
                return cell;
            }

            footRow.appendChild(_footCell('Valor total',  _ctx.formatBRL(valorTotal),       'var(--text-secondary)'));
            footRow.appendChild(_footCell('Falta pagar',  falta ? _ctx.formatBRL(falta) : '—', isPaga ? '#00ff99' : '#ff4b4b'));

            // Botões de ação
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex; gap:7px; flex-wrap:wrap; margin-top:10px;';

            function _btn(txt, iconCls, cssExtra, handler) {
                const b = document.createElement('button');
                b.className = 'btn-primary';
                b.style.cssText = `flex:1; min-width:75px; padding:7px 10px; font-size:0.8rem; ${cssExtra}`;
                const ic = document.createElement('i'); ic.className = iconCls; ic.style.marginRight = '5px';
                b.appendChild(ic); b.appendChild(document.createTextNode(txt));
                b.addEventListener('click', handler);
                return b;
            }

            btnRow.appendChild(_btn('Pagar',   'fas fa-check-circle',  '',                                   () => pagarCompraIndividual(faturaId, compra.id)));
            btnRow.appendChild(_btn('Editar',  'fas fa-pen',           'background:var(--accent, #4ca6ff);', () => editarCompraFatura(faturaId, compra.id)));
            btnRow.appendChild(_btn('Excluir', 'fas fa-trash-alt',     '',                                   () => excluirCompraFatura(faturaId, compra.id)));
            btnRow.children[2].className = 'btn-excluir';
            btnRow.children[2].style.flex = '1';
            btnRow.children[2].style.minWidth = '75px';
            btnRow.children[2].style.padding = '7px 10px';
            btnRow.children[2].style.fontSize = '0.8rem';

            card.appendChild(mainRow); card.appendChild(footRow); card.appendChild(btnRow);
            scrollWrap.appendChild(card);
        });

        // ── Botão fechar inferior
        const footerArea = document.createElement('div');
        footerArea.style.cssText = 'padding:12px 18px 18px;';
        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-primary';
        btnFechar.style.width = '100%';
        const fcIcon = document.createElement('i'); fcIcon.className = 'fas fa-xmark'; fcIcon.style.marginRight = '7px';
        btnFechar.appendChild(fcIcon); btnFechar.appendChild(document.createTextNode('Fechar'));
        btnFechar.addEventListener('click', _ctx.fecharPopup);
        footerArea.appendChild(btnFechar);

        popup.appendChild(header);
        popup.appendChild(totalBlock);
        popup.appendChild(statsRow);
        popup.appendChild(scrollWrap);
        popup.appendChild(footerArea);
    });
}

window.abrirVisualizacaoFatura = abrirVisualizacaoFatura;


// ========== PAGAR COMPRA INDIVIDUAL ==========
function pagarCompraIndividual(faturaId, compraId) {
    const fatura = _ctx.contasFixas.find(c => c.id === faturaId);
    if (!fatura) return;

    const compra = fatura.compras.find(c => String(c.id) === String(compraId));
    if (!compra) return;

    _ctx.fecharPopup();

    setTimeout(() => {
        // ✅ CORREÇÃO: HTML do popup sem dados do usuário interpolados diretamente.
        //    O valor do input é preenchido via .value após criação do DOM,
        //    garantindo consistência com o padrão de sanitização do restante do código
        //    e eliminando qualquer risco de malformação de atributo HTML.
        _ctx.criarPopup(`
            <h3>💰 Pagar Parcela</h3>
            <div style="text-align: left; margin: 20px 0; color: var(--text-secondary);">
                <div id="popupCompTipo"    style="margin-bottom: 8px;"></div>
                <div id="popupCompDesc"   style="margin-bottom: 8px;"></div>
                <div id="popupCompParc"   style="margin-bottom: 8px;"></div>
                <div id="popupCompValor"  style="margin-bottom: 16px;"></div>
            </div>
            <div style="color: var(--warning); margin-bottom: 16px; font-weight: 600;">⚠️ O valor está correto?</div>
            <button class="btn-primary"  id="simValorCompra"></button>
            <button class="btn-warning"  id="naoValorCompra">Não, alterar valor</button>
            <button class="btn-cancelar" id="cancelarPagamentoCompra">Cancelar</button>
            <div id="ajusteValorCompraDiv" style="display:none; margin-top:14px;">
                <input type="number" id="novoValorCompra" class="form-input"
                       step="0.01" min="0">
                <button class="btn-primary" id="confirmNovoValorCompra" style="margin-top:8px;">
                    Confirmar pagamento
                </button>
            </div>
        `);

        // ✅ Preenchimento seguro via textContent / .value — nunca via atributo HTML
        document.getElementById('popupCompTipo').innerHTML   = `<strong>Compra:</strong> <span></span>`;
        document.getElementById('popupCompTipo').querySelector('span').textContent = compra.tipo;

        document.getElementById('popupCompDesc').innerHTML   = `<strong>Descrição:</strong> <span></span>`;
        document.getElementById('popupCompDesc').querySelector('span').textContent = compra.descricao;

        document.getElementById('popupCompParc').innerHTML   = `<strong>Parcela:</strong> <span></span>`;
        document.getElementById('popupCompParc').querySelector('span').textContent =
            `${compra.parcelaAtual}/${compra.totalParcelas}`;

        document.getElementById('popupCompValor').innerHTML  = `<strong>Valor:</strong> <span></span>`;
        document.getElementById('popupCompValor').querySelector('span').textContent = _ctx.formatBRL(compra.valorParcela);

        // ✅ Texto do botão via textContent — sem interpolação
        document.getElementById('simValorCompra').textContent = `Sim, pagar ${formatBRL(compra.valorParcela)}`;

        // ✅ Valor numérico atribuído via .value — tipo number, não interpretado como HTML
        document.getElementById('novoValorCompra').value = _ctx.sanitizeHTML(String(compra.valorParcela));

        document.getElementById('simValorCompra').addEventListener('click', () => {
            processarPagamentoCompra(faturaId, compraId, compra.valorParcela);
        });

        document.getElementById('naoValorCompra').addEventListener('click', () => {
            document.getElementById('ajusteValorCompraDiv').style.display = 'block';
            document.getElementById('simValorCompra').disabled  = true;
            document.getElementById('naoValorCompra').disabled  = true;
        });

        document.getElementById('cancelarPagamentoCompra').addEventListener('click', () => {
            _ctx.fecharPopup();
            abrirVisualizacaoFatura(faturaId);
        });

        document.getElementById('confirmNovoValorCompra').addEventListener('click', () => {
            const novoValor = parseFloat(document.getElementById('novoValorCompra').value);
            if (!novoValor || novoValor <= 0) {
                _ctx.mostrarNotificacao('Digite um valor válido!', 'error');
                return;
            }
            processarPagamentoCompra(faturaId, compraId, novoValor);
        });

    }, 300);
}

// ========== PROCESSAR PAGAMENTO DE COMPRA ==========
function processarPagamentoCompra(faturaId, compraId, valorPago) {
    const fatura = _ctx.contasFixas.find(c => c.id === faturaId);
    if (!fatura) return;

    const compra = fatura.compras.find(c => String(c.id) === String(compraId));
    if (!compra) return;

    // ✅ CORREÇÃO: Anti-replay lock — impede pagamento duplo por cliques rápidos
    if (compra._processando) {
        _ctx.mostrarNotificacao('Aguarde, pagamento em andamento...', 'warning');
        return;
    }
    compra._processando = true;

    // ✅ CORREÇÃO: Validação do valor pago antes de qualquer operação
    const valorSeguro = parseFloat(valorPago);
    if (!isFinite(valorSeguro) || valorSeguro <= 0 || valorSeguro > 9_999_999) {
        _ctx.mostrarNotificacao('Valor de pagamento inválido.', 'error');
        compra._processando = false;
        return;
    }

    const cartao = _ctx.cartoesCredito.find(c => c.id === fatura.cartaoId);

    // ✅ CORREÇÃO: Snapshots para rollback em caso de erro
    let snapshotTransacoes  = [];
    let snapshotContasFixas = [];
    let snapshotCartoes     = [];

    try {
        snapshotTransacoes  = structuredClone(_ctx.transacoes);
        snapshotContasFixas = structuredClone(_ctx.contasFixas);
        snapshotCartoes     = structuredClone(_ctx.cartoesCredito);

        const dh = _ctx.agoraDataHora();
        const descricaoSegura = `${String(compra.tipo || '').slice(0, 100)} - ${String(compra.descricao || '').slice(0, 100)} (${compra.parcelaAtual}/${compra.totalParcelas})`;

        _ctx.transacoes.push({
            categoria:  'saida',
            tipo:       'Pagamento Cartão',
            descricao:  descricaoSegura,
            valor:      parseFloat(valorSeguro.toFixed(2)),
            data:       dh.data,
            hora:       dh.hora,
            faturaId:   faturaId,
            compraId:   compraId
        });

        if (cartao) {
            cartao.usado = Math.max(0, (cartao.usado || 0) - valorSeguro);
        }

        compra.parcelaAtual++;

        if (compra.parcelaAtual > compra.totalParcelas) {
            fatura.compras = fatura.compras.filter(c => String(c.id) !== String(compraId));
        }

        fatura.valor = fatura.compras.reduce((sum, c) => {
            const p = parseFloat(c.valorParcela);
            return sum + (isFinite(p) && p > 0 ? p : 0);
        }, 0);

        if (fatura.compras.length === 0) {
            _ctx.contasFixas = _ctx.contasFixas.filter(c => c.id !== faturaId);
            compra._processando = false;
            _ctx.fecharPopup();
            _ctx.salvarDados();
            _ctx.atualizarTudo();
            alert('✅ Última parcela paga! Fatura quitada.');
            return;
        }

        compra._processando = false;
        _ctx.salvarDados();
        _ctx.atualizarTudo();
        _ctx.fecharPopup();

        setTimeout(() => {
            abrirVisualizacaoFatura(faturaId);
            const restantes = compra.totalParcelas - compra.parcelaAtual + 1;
            _ctx.mostrarNotificacao(`Parcela paga! ${restantes} restante(s)`, 'success');
        }, 200);

    } catch (erro) {
        _ctx._log.error('PAG_COMPRA_001', erro);

        rollbackArray(_ctx.transacoes,     snapshotTransacoes);
        rollbackArray(_ctx.contasFixas,    snapshotContasFixas);
        rollbackArray(_ctx.cartoesCredito, snapshotCartoes);

        compra._processando = false;
        _ctx.mostrarNotificacao('Erro ao processar pagamento. Nenhuma alteração foi salva.', 'error');
    }
}

// ========== EDITAR COMPRA DA FATURA ==========
function editarCompraFatura(faturaId, compraId) {
    const fatura = _ctx.contasFixas.find(c => c.id === faturaId);
    if (!fatura) return;

    const compra = fatura.compras.find(c => String(c.id) === String(compraId));
    if (!compra) return;

    _ctx.fecharPopup();

    setTimeout(() => {
        // ✅ CORREÇÃO: HTML do popup com campos VAZIOS
        //    Dados do usuário (tipo, descricao, valorParcela) são inseridos
        //    exclusivamente via .value após criação do DOM — nunca via atributo HTML
        _ctx.criarPopup(`
            <h3>✏️ Editar Compra</h3>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Tipo:</label>
            <input type="text" id="editTipoCompra" class="form-input" maxlength="100">

            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Descrição:</label>
            <input type="text" id="editDescCompra" class="form-input" maxlength="200">

            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Valor da Parcela:</label>
            <input type="number" id="editValorCompra" class="form-input" step="0.01" min="0.01" max="9999999">

            <button class="btn-primary"  id="salvarEdicaoCompra">Salvar</button>
            <button class="btn-cancelar" id="cancelarEdicaoCompra">Cancelar</button>
        `);

        // ✅ CORREÇÃO: preenchimento seguro via .value — padrão consistente com
        //    abrirContaFixaForm, abrirMetaForm e todos os outros formulários de edição
        //    Nenhum dado do usuário passa por innerHTML ou atributo HTML
        const inputTipo  = document.getElementById('editTipoCompra');
        const inputDesc  = document.getElementById('editDescCompra');
        const inputValor = document.getElementById('editValorCompra');

        if (inputTipo)  inputTipo.value  = String(compra.tipo      || '');
        if (inputDesc)  inputDesc.value  = String(compra.descricao || '');
        if (inputValor) {
            // ✅ parseFloat garante que valorParcela é número antes de atribuir ao input
            const vp = parseFloat(compra.valorParcela);
            inputValor.value = isFinite(vp) && vp > 0 ? vp : '';
        }

        document.getElementById('cancelarEdicaoCompra').addEventListener('click', () => {
            _ctx.fecharPopup();
            abrirVisualizacaoFatura(faturaId);
        });

        document.getElementById('salvarEdicaoCompra').addEventListener('click', () => {
            const novoTipo  = document.getElementById('editTipoCompra').value.trim();
            const novaDesc  = document.getElementById('editDescCompra').value.trim();
            const novoValor = parseFloat(document.getElementById('editValorCompra').value);

            if (!novoTipo) {
                _ctx.mostrarNotificacao('O tipo da compra não pode estar vazio.', 'error');
                return;
            }
            if (novoTipo.length > 100) {
                _ctx.mostrarNotificacao('Tipo muito longo (máx. 100 caracteres).', 'error');
                return;
            }
            if (novaDesc.length > 200) {
                _ctx.mostrarNotificacao('Descrição muito longa (máx. 200 caracteres).', 'error');
                return;
            }
            if (isNaN(novoValor) || novoValor <= 0 || novoValor > 9_999_999) {
                _ctx.mostrarNotificacao('Digite um valor válido (entre R$ 0,01 e R$ 9.999.999).', 'error');
                return;
            }

            compra.tipo         = novoTipo;
            compra.descricao    = novaDesc;
            compra.valorParcela = parseFloat(novoValor.toFixed(2));

            // ✅ Recalcular com parseFloat para evitar acúmulo de imprecisão de ponto flutuante
            fatura.valor = parseFloat(
                fatura.compras.reduce((sum, c) => {
                    const p = parseFloat(c.valorParcela);
                    return sum + (isFinite(p) && p > 0 ? p : 0);
                }, 0).toFixed(2)
            );

            _ctx.salvarDados();
            _ctx.atualizarTudo();
            _ctx.fecharPopup();
            setTimeout(() => {
                abrirVisualizacaoFatura(faturaId);
                _ctx.mostrarNotificacao('Compra atualizada com sucesso!', 'success');
            }, 200);
        });

    }, 300);
}

window.editarCompraFatura = editarCompraFatura;

// ========== EXCLUIR COMPRA DA FATURA ==========
function excluirCompraFatura(faturaId, compraId) {
    _ctx.confirmarAcao('Tem certeza que deseja excluir esta compra da fatura?', () => {
        const fatura = _ctx.contasFixas.find(c => c.id === faturaId);
        if (!fatura) return;

        const compra = fatura.compras.find(c => String(c.id) === String(compraId));
        if (!compra) return;

        const cartao = _ctx.cartoesCredito.find(c => c.id === fatura.cartaoId);

        // Atualizar valor usado do cartão
        if (cartao) {
            const valorRestante = compra.valorTotal - (compra.valorParcela * (compra.parcelaAtual - 1));
            cartao.usado = Math.max(0, (cartao.usado || 0) - valorRestante);
        }

        // Remover compra
        fatura.compras = fatura.compras.filter(c => String(c.id) !== String(compraId));

        // Recalcular valor da fatura
        fatura.valor = fatura.compras.reduce((sum, c) => sum + c.valorParcela, 0);

        // Se não há mais compras, remover fatura
        if (fatura.compras.length === 0) {
            _ctx.contasFixas = _ctx.contasFixas.filter(c => c.id !== faturaId);
            _ctx.fecharPopup();
            _ctx.salvarDados();
            _ctx.atualizarTudo();
            _ctx.mostrarNotificacao('✅ Fatura excluída — não há mais compras.', 'success');
            return;
        }

        _ctx.salvarDados();
        _ctx.atualizarTudo();
        _ctx.fecharPopup();
        setTimeout(() => {
            abrirVisualizacaoFatura(faturaId);
            _ctx.mostrarNotificacao('Compra excluída com sucesso!', 'success');
        }, 200);
    });
}

window.excluirCompraFatura = excluirCompraFatura;



