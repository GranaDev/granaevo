// db-relatorios.js — Seção de Relatórios (lazy-loaded)
let _ctx = null;

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

// ========== RELATÓRIOS ==========
function popularFiltrosRelatorio() {
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
    anoSelect.appendChild(_criarPlaceholder('Selecione o ano'));
    perfilSelect.appendChild(_criarPlaceholder('Selecione o perfil'));

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

    const periodosDisponiveis = new Set();

    if (_ctx.tipoRelatorioAtivo === 'individual') {
        if (Array.isArray(_ctx.transacoes)) {
            _ctx.transacoes.forEach(t => {
                const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
                if (dataISO) {
                    periodosDisponiveis.add(dataISO.slice(0, 7));
                }
            });
        }
    } else {
        if (Array.isArray(_ctx.usuarioLogado?.perfis)) {
            _ctx.usuarioLogado.perfis.forEach(perfil => {
                const chave = `granaevo_perfil_${sanitizeHTML(String(perfil.id))}`;
                try {
                    const raw = localStorage.getItem(chave);
                    if (!raw) return;

                    const dados = JSON.parse(raw);

                    // ✅ Validação de estrutura (já existia)
                    if (!dados || !Array.isArray(dados.transacoes)) return;

                    dados.transacoes.forEach(t => {
                        if (!t || typeof t !== 'object') return;

                        // ✅ NOVO: valida cada transação com o mesmo validator do save
                        //    Impede que dados envenenados no localStorage causem
                        //    comportamento inesperado no preenchimento dos filtros
                        if (!_ctx._validators.transacao(t)) return;

                        const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
                        if (dataISO) {
                            periodosDisponiveis.add(dataISO.slice(0, 7));
                        }
                    });
                } catch (e) {
                    // ✅ CORRIGIDO: não expõe perfil.id no console em produção
                    _ctx._log.warn('RELATORIO_LS_001', 'Erro ao ler dados históricos de período');
                }
            });
        }
    }

    if (periodosDisponiveis.size === 0) {
        const hoje    = new Date();
        const anoAtual = hoje.getFullYear();
        const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
        periodosDisponiveis.add(`${anoAtual}-${mesAtual}`);
    }

    const meses = new Set();
    const anos  = new Set();

    periodosDisponiveis.forEach(periodo => {
        const partes = periodo.split('-');
        if (partes.length === 2) {
            meses.add(partes[1]);
            anos.add(partes[0]);
        }
    });

    const mesesNomes = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março',    '04': 'Abril',
        '05': 'Maio',    '06': 'Junho',     '07': 'Julho',    '08': 'Agosto',
        '09': 'Setembro','10': 'Outubro',   '11': 'Novembro', '12': 'Dezembro'
    };

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

    setupBotoesRelatorio();
    // ✅ CORRIGIDO: log operacional sem dados sensíveis
    _ctx._log.info('[popularFiltrosRelatorio] Filtros populados. Tipo ativo:', _ctx.tipoRelatorioAtivo);
}

function setupBotoesRelatorio() {
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
            alert('Você precisa ter pelo menos 2 perfis cadastrados para gerar relatório de casal!');
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
            alert('Você precisa ter pelo menos 2 perfis para gerar relatório da família!');
            return;
        }
        _ctx.tipoRelatorioAtivo = 'familia';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.add('active');
        perfilSelector.classList.remove('show');
        const resultado = document.getElementById('relatorioResultado');
        if (resultado) resultado.classList.add('js-hidden');
        _ctx.popularFiltrosRelatorio();
    });
}

// _gerandoRelatorio é estado de dashboard.js, acessível via _ctx.

async function gerarRelatorio() {
    if (_ctx._gerandoRelatorio) return; // CORREÇÃO: Debounce de segurança
    
    const mesEl = document.getElementById('mesRelatorio');
    const anoEl = document.getElementById('anoRelatorio');
    
    if (!mesEl || !anoEl) return;
    
    const mes = mesEl.value;
    const ano = anoEl.value;
    
    // CORREÇÃO: Validar formato de mês e ano antes de processar
    if (!mes || !ano) {
        return alert('Por favor, selecione o mês e o ano.');
    }
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) {
        return alert('Mês inválido.');
    }
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) {
        return alert('Ano inválido.');
    }
    
    _ctx._gerandoRelatorio = true;
    try {
        if (_ctx.tipoRelatorioAtivo === 'individual') {
            const perfilEl = document.getElementById('selectPerfilRelatorio');
            if (!perfilEl) return;
            const perfilId = perfilEl.value;
            if (!perfilId) return alert('Por favor, selecione um perfil.');
            // CORREÇÃO: Validar que perfilId realmente existe nos perfis do usuário
            const perfilExiste = _ctx.usuarioLogado?.perfis?.some(p => String(p.id) === String(perfilId));
            if (!perfilExiste) return alert('Perfil inválido.');
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
    if (!/^\d{2}$/.test(mes) || !/^\d{4}$/.test(ano)) return;

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
    if (!/^\d{2}$/.test(mes) || !/^\d{4}$/.test(ano)) return;

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
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) return;
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) return;
    if (!Array.isArray(perfisIds) || perfisIds.length !== 2) return;

    const periodoSelecionado = `${ano}-${mes}`;

    const perfisAtivos = _ctx.usuarioLogado.perfis.filter(p =>
        perfisIds.includes(String(p.id))
    );

    if (perfisAtivos.length !== 2) {
        alert('Erro: É necessário selecionar exatamente 2 perfis.');
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

    if (!validarUserData(userData)) {
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
        resultado.innerHTML = `
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas para os perfis selecionados em ${sanitizeHTML(getMesNome(mes))} de ${sanitizeHTML(ano)}</p>
                <p style="margin-top:12px; color: var(--text-muted);">
                    Perfis: ${perfisAtivos.map(p => sanitizeHTML(String(p.nome || ''))).join(', ')}
                </p>
            </div>
        `;
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
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) return;
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) return;
    if (!perfilId) return;

    const userData = await dataManager.loadUserData();

    if (!validarUserData(userData)) {
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

    const periodoSelecionado  = `${ano}-${mes}`;
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

    if (Object.keys(categorias).length > 0) {
        const categoriasOrdenadas    = Object.entries(categorias).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const totalGastoCategorias   = Object.values(categorias).reduce((a, b) => a + b, 0);
        const coresCategorias        = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];

        html += `<div class="rel-section"><div class="rel-section-header"><i class="fas fa-chart-bar"></i><span>Top 5 Categorias</span></div><div class="rel-cat-list">`;

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
        html += `</div></div>`;
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
            <div class="rel-section">
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
            <div class="rel-section">
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
        <div class="rel-section">
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
        html += `<div class="rel-section"><div class="rel-section-header"><i class="fas fa-list"></i><span>Todas as Transações (${transacoesPeriodo.length})</span></div><div class="rel-tx-list">`;

        transacoesPeriodo.sort((a, b) => {
            const dataHoraA = `${sanitizeDate(dataParaISO(a.data)) || ''} ${String(a.hora || '')}`;
            const dataHoraB = `${sanitizeDate(dataParaISO(b.data)) || ''} ${String(b.hora || '')}`;
            return dataHoraB.localeCompare(dataHoraA);
        });

        transacoesPeriodo.forEach(t => {
            if (!t || typeof t !== 'object') return;
            let dotClass, sinal;
            if (t.categoria === 'entrada') { dotClass = 'entrada'; sinal = '+'; }
            else { dotClass = t.categoria === 'saida' ? 'saida' : 'reserva'; sinal = '-'; }

            html += `
                <div class="rel-tx-item">
                    <div class="rel-tx-dot rel-tx-dot--${dotClass}"></div>
                    <div class="rel-tx-info">
                        <span class="rel-tx-tipo">${sanitizeHTML(String(t.tipo || '').slice(0, 100))}</span>
                        <span class="rel-tx-desc">${sanitizeHTML(String(t.descricao || '').slice(0, 200))}</span>
                        <span class="rel-tx-date">${sanitizeHTML(String(t.data || ''))} · ${sanitizeHTML(String(t.hora || ''))}</span>
                    </div>
                    <div class="rel-tx-value rel-tx-value--${dotClass}">${sinal}${formatBRL(sanitizeNumber(t.valor))}</div>
                </div>`;
        });
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
    if (!/^\d{2}$/.test(mes) || parseInt(mes, 10) < 1 || parseInt(mes, 10) > 12) return;
    if (!/^\d{4}$/.test(ano) || parseInt(ano, 10) < 2000 || parseInt(ano, 10) > 2100) return;
    
    // CORREÇÃO: Limitar numPerfis a um máximo razoável
    const numPerfisSeguro = Math.min(Math.max(parseInt(numPerfis, 10) || 0, 0), 20);
    
    const periodoSelecionado = `${ano}-${mes}`;
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
    if (!validarUserData(userData)) {
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
}

// ========== GERAR ANÁLISE "ONDE FOI MEU DINHEIRO?" ==========
function gerarAnaliseOndeForDinheiro(mes, ano) {
    if (!mes || !ano) {
        return { temDados: false, mensagem: 'Selecione mês e ano para analisar.' };
    }

    const periodoSelecionado = `${ano}-${mes}`;

    const transacoesPeriodo = _ctx.transacoes.filter(t => {
        if (!t || typeof t !== 'object') return false;
        const dataISO = _ctx.sanitizeDate(_ctx.dataParaISO(t.data));
        if (!dataISO) return false;
        return dataISO.startsWith(periodoSelecionado) && t.categoria === 'saida';
    });

    if (transacoesPeriodo.length === 0) {
        return {
            temDados: false,
            mensagem: `Não há gastos registrados em ${getMesNome(mes)} de ${ano}.`
        };
    }

    const categorias = safeCategorias();
    transacoesPeriodo.forEach(t => {
        if (t.tipo && typeof t.tipo === 'string' && t.tipo.length < 100) {
            const tipoKey = t.tipo.trim();
            categorias[tipoKey] = (categorias[tipoKey] || 0) + _ctx.sanitizeNumber(t.valor);
        }
    });

    const totalGastos         = Object.values(categorias).reduce((sum, v) => sum + v, 0);
    const categoriasOrdenadas = Object.entries(categorias).sort((a, b) => b[1] - a[1]);
    const top3                = categoriasOrdenadas.slice(0, 3);

    // ✅ CORREÇÃO: retorna partes estruturadas em vez de HTML concatenado.
    //    O caller monta o DOM via textContent, sem risco de double-escaping.
    const narrativaPartes = [];

    narrativaPartes.push({
        tipo:  'texto',
        texto: `Em ${getMesNome(mes)} de ${ano}, você realizou ${transacoesPeriodo.length} transação(ões) de saída. `
    });

    if (top3[0]) {
        const percTop = ((top3[0][1] / totalGastos) * 100).toFixed(0);
        narrativaPartes.push({
            tipo:       'destaque',
            prefixo:    'Seu maior gasto foi em ',
            destaque:   top3[0][0],
            sufixo:     `, representando ${percTop}% do total. `
        });
    }
    if (top3[1]) {
        narrativaPartes.push({
            tipo:     'destaque',
            prefixo:  'Em segundo lugar, gastos com ',
            destaque: top3[1][0],
            sufixo:   '. '
        });
    }
    if (top3[2]) {
        narrativaPartes.push({
            tipo:     'destaque',
            prefixo:  'E em terceiro, ',
            destaque: top3[2][0],
            sufixo:   '.'
        });
    }

    return {
        temDados:        true,
        totalGastos,
        totalTransacoes: transacoesPeriodo.length,
        categorias:      categoriasOrdenadas,
        top3,
        narrativaPartes  // ✅ estruturado — sem HTML misturado com dados
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
        wrapper.style.cssText = 'max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:4px;';

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
        wrapper.appendChild(rowFiltros);
        wrapper.appendChild(btnAnalisar);
        wrapper.appendChild(resultadoDiv);

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
    const parcelasPendentesMes = comprasMes.filter(c => Number(c.parcelaAtual) <= Number(c.totalParcelas)).length;

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
            const pago     = Number(compra.parcelaAtual) > Number(compra.totalParcelas);
            const cor      = pago ? '#00ff99' : '#ffd166';
            const falta    = pago ? '—' : _ctx.formatBRL(compra.valorParcela * (compra.totalParcelas - compra.parcelaAtual + 1));
            const parcTxt  = pago ? 'Quitado' : `Parcela ${sanitizeHTML(String(compra.parcelaAtual))}/${sanitizeHTML(String(compra.totalParcelas))}`;
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
        <div style="max-height:82vh; overflow-y:auto; overflow-x:hidden; padding-right:6px;">
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

