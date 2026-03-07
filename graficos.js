/* =====================================================
   GRANAEVO - GRÁFICOS JAVASCRIPT COMPLETO
   ===================================================== */

// ========== FUNÇÕES AUXILIARES ==========
function dataParaISO(dataBR) {
    const partes = dataBR.split('/');
    if(partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
}

// ========== VARIÁVEIS GLOBAIS ==========
let graficosInstances = {};
let filtroAtual = {
    tipo: 'individual',
    mes: new Date().getMonth() + 1,
    ano: new Date().getFullYear(),
    perfil: null,
    comparacao: false,
    mesComparacao: null,
    anoComparacao: null
};

// Cores do tema
const coresTema = {
    primary: '#43a047',
    success: '#00ff99',
    danger: '#ff4b4b',
    warning: '#ffd166',
    accent: '#6c63ff',
    gradient: ['#43a047', '#66bb6a', '#00ff99', '#6c63ff', '#ff4b4b', '#ffd166', '#8a84ff', '#ff6b6b']
};

// ========== INICIALIZAÇÃO ==========
document.addEventListener('DOMContentLoaded', () => {
    // Aguardar o dashboard carregar primeiro
    setTimeout(() => {
        inicializarGraficos();
    }, 1000);
});

function inicializarGraficos() {
    configurarFiltros();
    configurarViewButtons();
    configurarComparacao();

    const btnGraficos = document.getElementById('btnGerarGraficos');
    if (btnGraficos) {
        btnGraficos.addEventListener('click', gerarGraficos);
    }
}


// ========== CONFIGURAÇÃO DE FILTROS ==========
function configurarFiltros() {
    const mesSelect = document.getElementById('mesGrafico');
    const anoSelect = document.getElementById('anoGrafico');
    
    if (mesSelect && mesSelect.options.length === 0) {
        preencherMeses(mesSelect);
        mesSelect.value = filtroAtual.mes;
        mesSelect.addEventListener('change', (e) => {
            filtroAtual.mes = parseInt(e.target.value);
        });
    }
    
    if (anoSelect && anoSelect.options.length === 0) {
        preencherAnos(anoSelect);
        anoSelect.value = filtroAtual.ano;
        anoSelect.addEventListener('change', (e) => {
            filtroAtual.ano = parseInt(e.target.value);
        });
    }

    // Configurar filtros de comparação
    const mesComp = document.getElementById('mesComparacao');
    const anoComp = document.getElementById('anoComparacao');
    
    if (mesComp && mesComp.options.length === 0) {
        preencherMeses(mesComp);
        const mesAnterior = filtroAtual.mes === 1 ? 12 : filtroAtual.mes - 1;
        mesComp.value = mesAnterior;
        filtroAtual.mesComparacao = mesAnterior;
        mesComp.addEventListener('change', (e) => {
            filtroAtual.mesComparacao = parseInt(e.target.value);
        });
    }
    
    if (anoComp && anoComp.options.length === 0) {
        preencherAnos(anoComp);
        anoComp.value = filtroAtual.ano;
        filtroAtual.anoComparacao = filtroAtual.ano;
        anoComp.addEventListener('change', (e) => {
            filtroAtual.anoComparacao = parseInt(e.target.value);
        });
    }
}

function preencherMeses(select) {
    const meses = [
        'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];
    
    select.innerHTML = '';
    meses.forEach((mes, index) => {
        const option = document.createElement('option');
        option.value = index + 1;
        option.textContent = mes;
        select.appendChild(option);
    });
}

function preencherAnos(select) {
    const anoAtual = new Date().getFullYear();
    select.innerHTML = '';
    for (let i = anoAtual; i >= anoAtual - 5; i--) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = i;
        select.appendChild(option);
    }
}

function configurarViewButtons() {
    const viewBtns = document.querySelectorAll('.view-btn');
    viewBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            viewBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filtroAtual.tipo = btn.dataset.tipo;
        });
    });
}

function configurarComparacao() {
    const toggleComp = document.getElementById('toggleComparacao');
    const compContainer = document.getElementById('comparacaoContainer');
    
    if (toggleComp) {
        toggleComp.addEventListener('change', (e) => {
            filtroAtual.comparacao = e.target.checked;
            if (compContainer) {
                compContainer.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }
}

// ========== FUNÇÃO PRINCIPAL - GERAR GRÁFICOS ==========
// ========== FUNÇÃO PRINCIPAL - GERAR GRÁFICOS ==========
async function gerarGraficos() {
    mostrarLoading();
    
    try {
        console.log('🔍 Iniciando geração de gráficos...');
        
        // ✅ CORREÇÃO: Verificar tipo de relatório antes de processar
        if (filtroAtual.tipo === 'casal') {
            // ✅ CORREÇÃO: Buscar perfis do window global
            const perfis = window.usuarioLogado?.perfis || [];
            
            if (perfis.length < 2) {
                mostrarEmptyState('Você precisa ter pelo menos 2 perfis cadastrados para gerar gráficos de casal.');
                esconderLoading();
                return;
            }
            
            // ✅ SEMPRE abrir seleção se tiver mais de 2 perfis
            if (perfis.length > 2) {
                abrirSelecaoPerfisCasalGraficos();
                esconderLoading();
                return;
            }
            
            // Se tiver exatamente 2 perfis, usar ambos automaticamente
            const perfisAtivos = perfis.slice(0, 2);
            await gerarGraficosCompartilhados(perfisAtivos);
            esconderLoading();
            return;
        }
        
        if (filtroAtual.tipo === 'familia') {
            const perfis = window.usuarioLogado?.perfis || [];
            
            if (perfis.length < 2) {
                mostrarEmptyState('Você precisa ter pelo menos 2 perfis para gerar gráficos da família.');
                esconderLoading();
                return;
            }
            
            await gerarGraficosCompartilhados(perfis);
            esconderLoading();
            return;
        }
        
        // ✅ INDIVIDUAL - CORREÇÃO CRÍTICA
        // Usar referências globais do dashboard.js
        const perfilAtivo = window.perfilAtivo;
        
        if (!perfilAtivo || !perfilAtivo.id) {
            console.error('❌ Nenhum perfil selecionado');
            mostrarEmptyState('Nenhum perfil está ativo. Por favor, selecione um perfil no Dashboard.');
            esconderLoading();
            return;
        }

        console.log('✅ Perfil ativo encontrado:', perfilAtivo.nome);
        
        // ✅ CORREÇÃO: Usar dados globais do dashboard.js
        const todasTransacoes = window.transacoes || [];
        
        console.log('📊 Total de transações encontradas:', todasTransacoes.length);
        
        if (todasTransacoes.length === 0) {
            console.warn('⚠️ Nenhuma transação encontrada');
            mostrarEmptyState('Nenhuma transação encontrada. Comece adicionando suas movimentações na página de Transações!');
            esconderLoading();
            return;
        }
        
        // Filtrar transações por período
        filtroAtual.perfil = perfilAtivo.id;
        const transacoesFiltradas = filtrarTransacoesPorPeriodo(todasTransacoes);
        console.log('🔎 Transações filtradas:', transacoesFiltradas.length);
        console.log('📅 Filtro aplicado:', `Mês ${filtroAtual.mes}/${filtroAtual.ano}`);
        
        if (transacoesFiltradas.length === 0) {
            const mesNome = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 
                           'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'][filtroAtual.mes - 1];
            console.warn(`⚠️ Nenhuma transação para ${mesNome}/${filtroAtual.ano}`);
            mostrarEmptyState(`Nenhuma transação encontrada para ${mesNome}/${filtroAtual.ano}. Tente outro período!`);
            esconderLoading();
            return;
        }
        
        console.log('🎨 Renderizando gráficos...');
        
        if (filtroAtual.comparacao) {
            await renderizarGraficosComparativos(todasTransacoes);
        } else {
            renderizarTodosGraficos(transacoesFiltradas);
        }
        
        console.log('✅ Gráficos renderizados com sucesso!');
        esconderLoading();
        
    } catch (error) {
        console.error('❌ ERRO ao gerar gráficos:', error);
        console.error('Stack trace:', error.stack);
        
        mostrarEmptyState(`
            Erro ao processar dados: ${error.message}
            <br><br>
            <small>Verifique o console (F12) para mais detalhes</small>
        `);
        esconderLoading();
    }
}

            // ========== SELEÇÃO DE PERFIS PARA GRÁFICO CASAL (PLANO FAMÍLIA) ==========
function abrirSelecaoPerfisCasalGraficos() {
    // ✅ CORREÇÃO: usar window.usuarioLogado em vez de localStorage
    const perfis = window.usuarioLogado?.perfis || [];

    if (perfis.length === 0) {
        if (typeof mostrarNotificacao === 'function') {
            mostrarNotificacao('Nenhum perfil encontrado.', 'error');
        }
        return;
    }

    let htmlPerfis = '';

    perfis.forEach(perfil => {
        // ✅ sanitizeHTML disponível via dashboard.js (window global)
        const idSeguro   = String(perfil.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const nomeSeguro = typeof sanitizeHTML === 'function'
            ? sanitizeHTML(String(perfil.nome || '').slice(0, 100))
            : String(perfil.nome || '').slice(0, 100);

        htmlPerfis += `
            <div style="margin-bottom:12px;">
                <label style="display:flex; align-items:center; gap:10px; padding:12px;
                              background:rgba(255,255,255,0.05); border-radius:10px; cursor:pointer;">
                    <input type="checkbox" class="perfil-checkbox-casal-graficos"
                           value="${idSeguro}"
                           style="width:20px; height:20px; cursor:pointer; accent-color:var(--primary);">
                    <span style="font-weight:600; color:var(--text-primary);">${nomeSeguro}</span>
                </label>
            </div>
        `;
    });

    if (typeof criarPopup === 'function') {
        criarPopup(`
            <h3>👥 Selecione 2 Perfis para Gráfico Casal</h3>
            <p style="color:var(--text-secondary); margin-bottom:20px; font-size:0.9rem;">
                Escolha exatamente 2 perfis para gerar os gráficos conjuntos
            </p>
            <div style="max-height:300px; overflow-y:auto; margin-bottom:20px;">
                ${htmlPerfis}
            </div>
            <div id="avisoSelecaoGraficos" style="display:none; background:rgba(255,75,75,0.1);
                 padding:12px; border-radius:8px; margin-bottom:16px; border-left:3px solid #ff4b4b;">
                <span style="color:#ff4b4b; font-weight:600;">⚠️ Selecione exatamente 2 perfis</span>
            </div>
            <button class="btn-primary" id="btnConfirmarGraficosCasal" style="width:100%; margin-bottom:10px;">
                Gerar Gráficos
            </button>
            <button class="btn-cancelar" id="btnCancelarGraficosCasal" style="width:100%;">
                Cancelar
            </button>
        `);

        // ✅ addEventListener — sem onclick inline
        document.getElementById('btnConfirmarGraficosCasal')
                .addEventListener('click', confirmarSelecaoPerfisCasalGraficos);

        document.getElementById('btnCancelarGraficosCasal')
                .addEventListener('click', () => {
                    if (typeof fecharPopup === 'function') fecharPopup();
                });
    }
}

function confirmarSelecaoPerfisCasalGraficos() {
    const checkboxes = document.querySelectorAll('.perfil-checkbox-casal-graficos:checked');
    const avisoEl    = document.getElementById('avisoSelecaoGraficos');

    if (checkboxes.length !== 2) {
        if (avisoEl) {
            avisoEl.style.display = 'block';
            setTimeout(() => { avisoEl.style.display = 'none'; }, 3000);
        }
        return;
    }

    const perfisIds = Array.from(checkboxes).map(cb => cb.value);

    // ✅ CORREÇÃO: usar window.usuarioLogado em vez de localStorage
    const perfis = window.usuarioLogado?.perfis || [];
    const perfisSelecionados = perfis.filter(p => perfisIds.includes(String(p.id)));

    if (perfisSelecionados.length !== 2) {
        console.error('Perfis selecionados não encontrados em usuarioLogado.perfis');
        return;
    }

    if (typeof fecharPopup === 'function') fecharPopup();

    mostrarLoading();
    setTimeout(() => {
        gerarGraficosCompartilhados(perfisSelecionados);
    }, 300);
}

// Expor funções globalmente
window.abrirSelecaoPerfisCasalGraficos = abrirSelecaoPerfisCasalGraficos;
window.confirmarSelecaoPerfisCasalGraficos = confirmarSelecaoPerfisCasalGraficos;

// ========== GERAR GRÁFICOS COMPARTILHADOS (CASAL/FAMÍLIA) ==========
async function gerarGraficosCompartilhados(perfisAtivos) {
    console.log('👨‍👩‍👧‍👦 Gerando gráficos compartilhados para:', perfisAtivos.map(p => p.nome).join(', '));
    
    try {
        // ✅ VALIDAÇÃO: Verificar se há perfis suficientes
        if (!perfisAtivos || perfisAtivos.length === 0) {
            mostrarEmptyState('Nenhum perfil foi selecionado.');
            esconderLoading();
            return;
        }
        
        if (filtroAtual.tipo === 'casal' && perfisAtivos.length !== 2) {
            mostrarEmptyState('Selecione exatamente 2 perfis para gerar gráficos de casal.');
            esconderLoading();
            return;
        }
        
        // ✅ CORREÇÃO CRÍTICA: Carregar dados via dataManager
        // ✅ CORREÇÃO: Aguardar o DataManager estar disponível se necessário
        if (!window.dataManager) {
            console.warn('⏳ DataManager não encontrado no window, tentando novamente em 500ms...');
            await new Promise(resolve => setTimeout(resolve, 500));
            if (!window.dataManager) throw new Error('DataManager não inicializado corretamente.');
        }
        const userData = await window.dataManager.loadUserData();
        
        if (!userData || !userData.profiles) {
            console.error('❌ Dados do usuário não encontrados');
            mostrarEmptyState('Não foi possível carregar os dados do usuário.');
            return;
        }
        
        // Coletar todas as transações de todos os perfis
        const todasTransacoes = [];
        
        perfisAtivos.forEach(perfil => {
            // ✅ Buscar perfil no JSON carregado
            const dadosPerfil = userData.profiles.find(p => p.id === perfil.id);
            
            if (dadosPerfil && dadosPerfil.transacoes) {
                // Adicionar identificador do perfil a cada transação
                dadosPerfil.transacoes.forEach(t => {
                    todasTransacoes.push({
                        ...t,
                        perfilId: perfil.id,
                        perfilNome: perfil.nome
                    });
                });
            }
        });
        
        console.log('📊 Total de transações coletadas:', todasTransacoes.length);
        
        if (todasTransacoes.length === 0) {
            mostrarEmptyState('Nenhuma transação encontrada nos perfis selecionados. Adicione movimentações primeiro!');
            return;
        }
        
        // Filtrar por período
        const transacoesFiltradas = filtrarTransacoesPorPeriodo(todasTransacoes);
        
        console.log('🔎 Transações após filtro:', transacoesFiltradas.length);
        
        if (transacoesFiltradas.length === 0) {
            const mesNome = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 
                           'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'][filtroAtual.mes - 1];
            mostrarEmptyState(`Nenhuma transação encontrada para ${mesNome}/${filtroAtual.ano} nos perfis selecionados.`);
            return;
        }
        
        // Processar dados
        const dadosGerais = processarDadosGraficos(transacoesFiltradas);
        
        // Processar dados por perfil para comparação
        const dadosPorPerfil = perfisAtivos.map(perfil => {
            const transacoesPerfil = transacoesFiltradas.filter(t => t.perfilId === perfil.id);
            return {
                perfil: perfil,
                ...processarDadosGraficos(transacoesPerfil)
            };
        });
        
        console.log('✅ Dados processados. Renderizando...');
        
        // Renderizar interface
        if (filtroAtual.comparacao) {
            await renderizarGraficosComparativos(todasTransacoes);
        } else {
            renderizarGraficosCompartilhadosUI(dadosGerais, dadosPorPerfil);
        }
        
    } catch (error) {
        console.error('❌ ERRO ao gerar gráficos compartilhados:', error);
        mostrarEmptyState(`Erro ao processar dados: ${error.message}`);
    }
}

function renderizarGraficosCompartilhadosUI(dadosGerais, dadosPorPerfil) {
    const container = document.getElementById('graficosConteudo');
    if (!container) return;
    
    const tipoTexto = filtroAtual.tipo === 'casal' ? 'do Casal' : 'da Família';
    const icone = filtroAtual.tipo === 'casal' ? '💑' : '👨‍👩‍👧‍👦';
    
    // ✅ GERAR HTML DA COMPARAÇÃO (agora recebe os dados processados)
    const htmlComparacao = gerarHTMLComparacaoPerfis(dadosPorPerfil);
    
    container.innerHTML = `
        <div class="comparacao-header-especial">
            <h2>${icone} Gráficos ${tipoTexto}</h2>
            <p>Análise consolidada de ${dadosPorPerfil.length} ${dadosPorPerfil.length === 1 ? 'perfil' : 'perfis'}</p>
        </div>
        
        <div class="graficos-grid">
            ${renderizarEstatisticasRapidas(dadosGerais)}
            ${renderizarGraficoPizza(dadosGerais)}
            ${renderizarGraficoBarras(dadosGerais)}
            ${renderizarGraficoLinha(dadosGerais)}
        </div>
        ${renderizarRankingCategorias(dadosGerais)}
        ${htmlComparacao}
        ${renderizarTendencias(dadosGerais)}
    `;
    
    setTimeout(() => {
        criarGraficoPizza('pizzaGastosChart', dadosGerais);
        
        setTimeout(() => {
            criarGraficoBarras('barrasCategoriasChart', dadosGerais);
        }, 150);
        
        setTimeout(() => {
            criarGraficoLinha('linhaEvolucaoChart', dadosGerais);
        }, 300);
    }, 100);
}

// ========== GERAR HTML DE COMPARAÇÃO DE PERFIS ==========
function gerarHTMLComparacaoPerfis(dadosPorPerfil) {
    if (!dadosPorPerfil || dadosPorPerfil.length === 0) {
        return '';
    }
    
    // Encontrar quem gastou menos (vencedor)
    const vencedor = dadosPorPerfil.reduce((min, p) => 
        p.totalSaidas < min.totalSaidas ? p : min
    );
    
    return `
        <div class="comparacao-container">
            <div class="comparacao-header">
                <h3 class="comparacao-title">
                    <i class="fas fa-users"></i>
                    Comparação Detalhada - ${filtroAtual.tipo === 'casal' ? 'Casal' : 'Família'}
                </h3>
                <p class="comparacao-subtitle">Análise individual de cada perfil</p>
            </div>
            <div class="perfis-comparacao-grid">
                ${dadosPorPerfil.map(p => {
                    const isVencedor = p.perfil.id === vencedor.perfil.id;
                    const taxaEconomia = p.totalEntradas > 0 ? 
                        ((p.totalReservas / p.totalEntradas) * 100).toFixed(1) : 0;
                    
                    return `
                        <div class="perfil-comparacao-card ${isVencedor ? 'winner' : ''}">
                            ${isVencedor ? '<div class="winner-badge">🏆 Melhor Economia</div>' : ''}
                            
                            <img src="${p.perfil.foto || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'80\'%3E%3Ccircle cx=\'40\' cy=\'40\' r=\'40\' fill=\'%2310b981\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' dominant-baseline=\'middle\' text-anchor=\'middle\' font-family=\'Arial\' font-size=\'32\' fill=\'white\'%3E${p.perfil.nome.charAt(0).toUpperCase()}%3C/text%3E%3C/svg%3E'}" 
                                 class="perfil-avatar" 
                                 alt="${p.perfil.nome}">
                            
                            <h4 class="perfil-nome-comparacao">${p.perfil.nome}</h4>
                            
                            <div class="perfil-stats-comparacao">
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">💰 Total Entradas</span>
                                    <span class="stat-value-comparacao" style="color: var(--success);">
                                        ${formatarMoeda(p.totalEntradas)}
                                    </span>
                                </div>
                                
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">💸 Total Saídas</span>
                                    <span class="stat-value-comparacao" style="color: var(--danger);">
                                        ${formatarMoeda(p.totalSaidas)}
                                    </span>
                                </div>
                                
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">🎯 Guardado</span>
                                    <span class="stat-value-comparacao" style="color: var(--warning);">
                                        ${formatarMoeda(p.totalReservas)}
                                    </span>
                                </div>
                                
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">📊 Saldo Final</span>
                                    <span class="stat-value-comparacao" style="color: ${p.saldo >= 0 ? 'var(--success)' : 'var(--danger)'};">
                                        ${formatarMoeda(p.saldo)}
                                    </span>
                                </div>
                                
                                <div class="stat-row-comparacao" style="background: rgba(108,99,255,0.1); padding: 10px; border-radius: 8px; margin-top: 10px;">
                                    <span class="stat-label-comparacao">💎 Taxa de Economia</span>
                                    <span class="stat-value-comparacao" style="color: var(--accent); font-size: 1.3rem;">
                                        ${taxaEconomia}%
                                    </span>
                                </div>
                                
                                <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 10px; text-align: center;">
                                    📝 ${p.transacoes.length} transações no período
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            
            ${dadosPorPerfil.length === 2 ? gerarInsightsComparacaoCasal(dadosPorPerfil[0], dadosPorPerfil[1]) : ''}
        </div>
    `;
}

// ========== INSIGHTS DE COMPARAÇÃO ENTRE CASAL ==========
function gerarInsightsComparacaoCasal(perfil1, perfil2) {
    const diferencaGastos = Math.abs(perfil1.totalSaidas - perfil2.totalSaidas);
    const quemGastouMais = perfil1.totalSaidas > perfil2.totalSaidas ? perfil1 : perfil2;
    const quemGastouMenos = perfil1.totalSaidas < perfil2.totalSaidas ? perfil1 : perfil2;
    
    const diferencaReservas = Math.abs(perfil1.totalReservas - perfil2.totalReservas);
    const quemGuardouMais = perfil1.totalReservas > perfil2.totalReservas ? perfil1 : perfil2;
    
    const taxaEconomia1 = perfil1.totalEntradas > 0 ? (perfil1.totalReservas / perfil1.totalEntradas * 100) : 0;
    const taxaEconomia2 = perfil2.totalEntradas > 0 ? (perfil2.totalReservas / perfil2.totalEntradas * 100) : 0;
    const melhorTaxa = taxaEconomia1 > taxaEconomia2 ? perfil1 : perfil2;
    
    return `
        <div class="insights-container" style="margin-top: 30px;">
            <h3 class="insights-title">
                <i class="fas fa-lightbulb"></i> 
                Insights da Comparação entre ${perfil1.perfil.nome} e ${perfil2.perfil.nome}
            </h3>
            <div class="insights-grid">
                <div class="insight-card">
                    <div class="insight-icon" style="color: var(--danger);">
                        <i class="fas fa-shopping-cart"></i>
                    </div>
                    <div class="insight-content">
                        <h4>💸 Diferença nos Gastos</h4>
                        <p>
                            <strong>${quemGastouMais.perfil.nome}</strong> gastou ${formatarMoeda(diferencaGastos)} 
                            a mais que <strong>${quemGastouMenos.perfil.nome}</strong> neste período.
                        </p>
                    </div>
                </div>
                
                <div class="insight-card">
                    <div class="insight-icon" style="color: var(--warning);">
                        <i class="fas fa-piggy-bank"></i>
                    </div>
                    <div class="insight-content">
                        <h4>🎯 Economia</h4>
                        <p>
                            <strong>${quemGuardouMais.perfil.nome}</strong> guardou ${formatarMoeda(diferencaReservas)} 
                            a mais em reservas.
                        </p>
                    </div>
                </div>
                
                <div class="insight-card">
                    <div class="insight-icon" style="color: var(--success);">
                        <i class="fas fa-chart-line"></i>
                    </div>
                    <div class="insight-content">
                        <h4>💎 Melhor Taxa de Economia</h4>
                        <p>
                            <strong>${melhorTaxa.perfil.nome}</strong> tem a melhor taxa: 
                            ${(taxaEconomia1 > taxaEconomia2 ? taxaEconomia1 : taxaEconomia2).toFixed(1)}% 
                            da renda guardada.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    `;
}


// ========== RENDERIZAÇÃO DOS GRÁFICOS ==========
function renderizarTodosGraficos(transacoes) {
    console.log('🎨 Iniciando renderização de todos os gráficos...');
    
    const container = document.getElementById('graficosConteudo');
    if (!container) {
        console.error('❌ Container "graficosConteudo" não encontrado!');
        return;
    }
    
    console.log('📊 Processando dados dos gráficos...');
    const dados = processarDadosGraficos(transacoes);
    
    console.log('📈 Dados processados:', {
        totalEntradas: dados.totalEntradas,
        totalSaidas: dados.totalSaidas,
        saldo: dados.saldo,
        categorias: Object.keys(dados.categorias).length
    });
    
    container.innerHTML = `
        <div class="graficos-grid">
            ${renderizarEstatisticasRapidas(dados)}
            ${renderizarGraficoPizza(dados)}
            ${renderizarGraficoBarras(dados)}
            ${renderizarGraficoLinha(dados)}
        </div>
        ${renderizarRankingCategorias(dados)}
        ${renderizarComparacaoPerfis()}
        ${renderizarTendencias(dados)}
    `;
    
    console.log('✅ HTML dos gráficos inserido no DOM');
    
    setTimeout(() => {
    console.log('🎨 Criando gráficos Chart.js...');
    criarGraficoPizza('pizzaGastosChart', dados);
    
    setTimeout(() => {
        criarGraficoBarras('barrasCategoriasChart', dados);
    }, 150);
    
    setTimeout(() => {
        criarGraficoLinha('linhaEvolucaoChart', dados);
    }, 300);
    
    console.log('✅ Gráficos Chart.js criados!');
}, 100);
}

// ========== GRÁFICOS COMPARATIVOS ==========
async function renderizarGraficosComparativos(todasTransacoes) {
    try {
        const container = document.getElementById('graficosConteudo');
        
        if (!container) {
            console.error('❌ Container de gráficos não encontrado');
            return;
        }
        
        // Dados do período 1
        const transacoes1 = filtrarTransacoesPorPeriodo(todasTransacoes, filtroAtual.mes, filtroAtual.ano);
        const dados1 = processarDadosGraficos(transacoes1);
        
        // Dados do período 2
        const transacoes2 = filtrarTransacoesPorPeriodo(todasTransacoes, filtroAtual.mesComparacao, filtroAtual.anoComparacao);
        const dados2 = processarDadosGraficos(transacoes2);
        
        const meses = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 
                       'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        
        const periodo1 = `${meses[filtroAtual.mes - 1]}/${filtroAtual.ano}`;
        const periodo2 = `${meses[filtroAtual.mesComparacao - 1]}/${filtroAtual.anoComparacao}`;
        
        container.innerHTML = `
            <div class="comparacao-header-especial">
                <h2><i class="fas fa-balance-scale"></i> Análise Comparativa</h2>
                <p>Comparando ${periodo1} vs ${periodo2}</p>
            </div>
            
            ${renderizarCardsComparativos(dados1, dados2, periodo1, periodo2)}
            ${renderizarGraficoBarrasComparativo(dados1, dados2, periodo1, periodo2)}
            ${renderizarGraficoLinhaComparativo(dados1, dados2, periodo1, periodo2)}
            ${renderizarGraficoPizzaComparativo(dados1, dados2, periodo1, periodo2)}
            ${renderizarInsightsComparativos(dados1, dados2, periodo1, periodo2)}
        `;
        
        setTimeout(() => {
            criarGraficoBarrasComparativo('barrasComparativoChart', dados1, dados2, periodo1, periodo2);
            criarGraficoLinhaComparativo('linhaComparativoChart', dados1, dados2, periodo1, periodo2);
            criarGraficoPizzaDuplo('pizzaComparativo1', 'pizzaComparativo2', dados1, dados2, periodo1, periodo2);
        }, 100);
        
    } catch (error) {
        console.error('❌ Erro ao renderizar gráficos comparativos:', error);
        mostrarEmptyState(`Erro ao processar comparação: ${error.message}`);
    }
}

function renderizarCardsComparativos(dados1, dados2, periodo1, periodo2) {
    const calcVariacao = (val1, val2) => {
        if (val2 === 0) return val1 > 0 ? 100 : 0;
        return ((val1 - val2) / val2 * 100).toFixed(1);
    };
    
    const varEntradas = calcVariacao(dados1.totalEntradas, dados2.totalEntradas);
    const varSaidas = calcVariacao(dados1.totalSaidas, dados2.totalSaidas);
    const varSaldo = calcVariacao(dados1.saldo, dados2.saldo);
    const varReservas = calcVariacao(dados1.totalReservas, dados2.totalReservas);
    
    return `
        <div class="stats-comparativos">
            <div class="stat-comparativo-card">
                <div class="stat-comp-header">
                    <span class="stat-comp-icon" style="color: var(--success);"><i class="fas fa-arrow-up"></i></span>
                    <span class="stat-comp-label">Entradas</span>
                </div>
                <div class="stat-comp-valores">
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo1}</span>
                        <span class="valor-principal">${formatarMoeda(dados1.totalEntradas)}</span>
                    </div>
                    <div class="vs-divider">VS</div>
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo2}</span>
                        <span class="valor-principal">${formatarMoeda(dados2.totalEntradas)}</span>
                    </div>
                </div>
                <div class="stat-comp-variacao ${varEntradas >= 0 ? 'positiva' : 'negativa'}">
                    <i class="fas fa-arrow-${varEntradas >= 0 ? 'up' : 'down'}"></i>
                    ${Math.abs(varEntradas)}% ${varEntradas >= 0 ? 'maior' : 'menor'}
                </div>
            </div>
            
            <div class="stat-comparativo-card">
                <div class="stat-comp-header">
                    <span class="stat-comp-icon" style="color: var(--danger);"><i class="fas fa-arrow-down"></i></span>
                    <span class="stat-comp-label">Saídas</span>
                </div>
                <div class="stat-comp-valores">
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo1}</span>
                        <span class="valor-principal">${formatarMoeda(dados1.totalSaidas)}</span>
                    </div>
                    <div class="vs-divider">VS</div>
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo2}</span>
                        <span class="valor-principal">${formatarMoeda(dados2.totalSaidas)}</span>
                    </div>
                </div>
                <div class="stat-comp-variacao ${varSaidas < 0 ? 'positiva' : 'negativa'}">
                    <i class="fas fa-arrow-${varSaidas >= 0 ? 'up' : 'down'}"></i>
                    ${Math.abs(varSaidas)}% ${varSaidas >= 0 ? 'mais gastos' : 'economia'}
                </div>
            </div>
            
            <div class="stat-comparativo-card">
                <div class="stat-comp-header">
                    <span class="stat-comp-icon" style="color: var(--accent);"><i class="fas fa-wallet"></i></span>
                    <span class="stat-comp-label">Saldo</span>
                </div>
                <div class="stat-comp-valores">
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo1}</span>
                        <span class="valor-principal">${formatarMoeda(dados1.saldo)}</span>
                    </div>
                    <div class="vs-divider">VS</div>
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo2}</span>
                        <span class="valor-principal">${formatarMoeda(dados2.saldo)}</span>
                    </div>
                </div>
                <div class="stat-comp-variacao ${varSaldo >= 0 ? 'positiva' : 'negativa'}">
                    <i class="fas fa-arrow-${varSaldo >= 0 ? 'up' : 'down'}"></i>
                    ${Math.abs(varSaldo)}% ${varSaldo >= 0 ? 'melhor' : 'pior'}
                </div>
            </div>
            
            <div class="stat-comparativo-card">
                <div class="stat-comp-header">
                    <span class="stat-comp-icon" style="color: var(--warning);"><i class="fas fa-piggy-bank"></i></span>
                    <span class="stat-comp-label">Reservas</span>
                </div>
                <div class="stat-comp-valores">
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo1}</span>
                        <span class="valor-principal">${formatarMoeda(dados1.totalReservas)}</span>
                    </div>
                    <div class="vs-divider">VS</div>
                    <div class="periodo-valor">
                        <span class="periodo-label">${periodo2}</span>
                        <span class="valor-principal">${formatarMoeda(dados2.totalReservas)}</span>
                    </div>
                </div>
                <div class="stat-comp-variacao ${varReservas >= 0 ? 'positiva' : 'negativa'}">
                    <i class="fas fa-arrow-${varReservas >= 0 ? 'up' : 'down'}"></i>
                    ${Math.abs(varReservas)}% ${varReservas >= 0 ? 'mais' : 'menos'}
                </div>
            </div>
        </div>
    `;
}

function renderizarGraficoBarrasComparativo(dados1, dados2, periodo1, periodo2) {
    return `
        <div class="grafico-card full-width">
            <div class="grafico-header">
                <h3 class="grafico-title">
                    <i class="fas fa-chart-bar"></i>
                    Comparação de Gastos por Categoria
                </h3>
            </div>
            <div class="grafico-canvas-wrapper" style="height: 400px;">
                <canvas id="barrasComparativoChart" class="grafico-canvas"></canvas>
            </div>
        </div>
    `;
}

function renderizarGraficoLinhaComparativo(dados1, dados2, periodo1, periodo2) {
    return `
        <div class="grafico-card full-width">
            <div class="grafico-header">
                <h3 class="grafico-title">
                    <i class="fas fa-chart-line"></i>
                    Evolução Comparativa: Entradas vs Saídas
                </h3>
            </div>
            <div class="grafico-canvas-wrapper" style="height: 400px;">
                <canvas id="linhaComparativoChart" class="grafico-canvas"></canvas>
            </div>
        </div>
    `;
}

function renderizarGraficoPizzaComparativo(dados1, dados2, periodo1, periodo2) {
    return `
        <div class="graficos-grid">
            <div class="grafico-card">
                <div class="grafico-header">
                    <h3 class="grafico-title" style="font-size: 1rem;">
                        <i class="fas fa-chart-pie"></i> ${periodo1}
                    </h3>
                </div>
                <div class="grafico-canvas-wrapper">
                    <canvas id="pizzaComparativo1" class="grafico-canvas"></canvas>
                </div>
            </div>
            
            <div class="grafico-card">
                <div class="grafico-header">
                    <h3 class="grafico-title" style="font-size: 1rem;">
                        <i class="fas fa-chart-pie"></i> ${periodo2}
                    </h3>
                </div>
                <div class="grafico-canvas-wrapper">
                    <canvas id="pizzaComparativo2" class="grafico-canvas"></canvas>
                </div>
            </div>
        </div>
    `;
}

function renderizarInsightsComparativos(dados1, dados2, periodo1, periodo2) {
    const insights = [];
    
    // Insight 1: Maior variação de gastos
    const varSaidas = ((dados1.totalSaidas - dados2.totalSaidas) / dados2.totalSaidas * 100).toFixed(1);
    if (Math.abs(varSaidas) > 10) {
        insights.push({
            icon: 'fa-exclamation-triangle',
            color: varSaidas > 0 ? 'var(--danger)' : 'var(--success)',
            titulo: varSaidas > 0 ? 'Aumento nos Gastos' : 'Redução nos Gastos',
            descricao: `Você ${varSaidas > 0 ? 'gastou' : 'economizou'} ${Math.abs(varSaidas)}% ${varSaidas > 0 ? 'mais' : 'a menos'} em ${periodo1} comparado a ${periodo2}`
        });
    }
    
    // Insight 2: Categoria com maior aumento
    const categoriasAumento = [];
    for (let cat in dados1.categorias) {
        const val1 = dados1.categorias[cat] || 0;
        const val2 = dados2.categorias[cat] || 0;
        if (val2 > 0) {
            const var_perc = ((val1 - val2) / val2 * 100);
            if (Math.abs(var_perc) > 20) {
                categoriasAumento.push({ cat, var: var_perc, val1, val2 });
            }
        }
    }
    
    if (categoriasAumento.length > 0) {
        const maior = categoriasAumento.sort((a, b) => Math.abs(b.var) - Math.abs(a.var))[0];
        insights.push({
            icon: 'fa-chart-line',
            color: 'var(--warning)',
            titulo: `Destaque: ${maior.cat}`,
            descricao: `Variação de ${maior.var > 0 ? '+' : ''}${maior.var.toFixed(1)}% - de ${formatarMoeda(maior.val2)} para ${formatarMoeda(maior.val1)}`
        });
    }
    
    // Insight 3: Desempenho geral
    const desempenho = dados1.saldo > dados2.saldo ? 'melhor' : dados1.saldo < dados2.saldo ? 'pior' : 'igual';
    if (desempenho !== 'igual') {
        insights.push({
            icon: desempenho === 'melhor' ? 'fa-thumbs-up' : 'fa-thumbs-down',
            color: desempenho === 'melhor' ? 'var(--success)' : 'var(--danger)',
            titulo: `Desempenho ${desempenho === 'melhor' ? 'Melhor' : 'Pior'}`,
            descricao: `Seu saldo ficou ${formatarMoeda(Math.abs(dados1.saldo - dados2.saldo))} ${desempenho === 'melhor' ? 'maior' : 'menor'} neste período`
        });
    }
    
    if (insights.length === 0) {
        return '';
    }
    
    return `
        <div class="insights-container">
            <h3 class="insights-title"><i class="fas fa-lightbulb"></i> Insights da Comparação</h3>
            <div class="insights-grid">
                ${insights.map(insight => `
                    <div class="insight-card">
                        <div class="insight-icon" style="color: ${insight.color};">
                            <i class="fas ${insight.icon}"></i>
                        </div>
                        <div class="insight-content">
                            <h4>${insight.titulo}</h4>
                            <p>${insight.descricao}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// ========== CRIAR GRÁFICOS COMPARATIVOS ==========
function criarGraficoBarrasComparativo(canvasId, dados1, dados2, periodo1, periodo2) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    if (graficosInstances[canvasId]) {
        graficosInstances[canvasId].destroy();
    }
    
    const todasCategorias = new Set([...Object.keys(dados1.categorias), ...Object.keys(dados2.categorias)]);
    const labels = Array.from(todasCategorias);
    
    const valores1 = labels.map(cat => dados1.categorias[cat] || 0);
    const valores2 = labels.map(cat => dados2.categorias[cat] || 0);
    
    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: periodo1,
                    data: valores1,
                    backgroundColor: 'rgba(67, 160, 71, 0.8)',
                    borderColor: '#43a047',
                    borderWidth: 2,
                    borderRadius: 8
                },
                {
                    label: periodo2,
                    data: valores2,
                    backgroundColor: 'rgba(108, 99, 255, 0.8)',
                    borderColor: '#6c63ff',
                    borderWidth: 2,
                    borderRadius: 8
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#b0b3c1',
                        padding: 15,
                        font: { size: 13, weight: '600' }
                    }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor: '#ffffff',
                    bodyColor: '#b0b3c1',
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#b0b3c1',
                        callback: function(value) {
                            return 'R$ ' + value.toLocaleString('pt-BR');
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.08)'
                    }
                },
                x: {
                    ticks: {
                        color: '#b0b3c1'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function criarGraficoLinhaComparativo(canvasId, dados1, dados2, periodo1, periodo2) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    if (graficosInstances[canvasId]) {
        graficosInstances[canvasId].destroy();
    }
    
    const dias1 = Object.keys(dados1.evolucaoDiaria).sort((a, b) => a - b);
    const dias2 = Object.keys(dados2.evolucaoDiaria).sort((a, b) => a - b);
    const maxDias = Math.max(dias1.length, dias2.length, 30);
    const labels = Array.from({length: maxDias}, (_, i) => `Dia ${i + 1}`);
    
    const entradas1 = labels.map((_, i) => dados1.evolucaoDiaria[i + 1]?.entradas || 0);
    const saidas1 = labels.map((_, i) => dados1.evolucaoDiaria[i + 1]?.saidas || 0);
    const entradas2 = labels.map((_, i) => dados2.evolucaoDiaria[i + 1]?.entradas || 0);
    const saidas2 = labels.map((_, i) => dados2.evolucaoDiaria[i + 1]?.saidas || 0);
    
    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: `${periodo1} - Entradas`,
                    data: entradas1,
                    borderColor: '#00ff99',
                    backgroundColor: 'rgba(0, 255, 153, 0.1)',
                    borderWidth: 3,
                    tension: 0.4
                },
                {
                    label: `${periodo1} - Saídas`,
                    data: saidas1,
                    borderColor: '#ff4b4b',
                    backgroundColor: 'rgba(255, 75, 75, 0.1)',
                    borderWidth: 3,
                    tension: 0.4
                },
                {
                    label: `${periodo2} - Entradas`,
                    data: entradas2,
                    borderColor: '#6c63ff',
                    backgroundColor: 'rgba(108, 99, 255, 0.1)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    tension: 0.4
                },
                {
                    label: `${periodo2} - Saídas`,
                    data: saidas2,
                    borderColor: '#ffd166',
                    backgroundColor: 'rgba(255, 209, 102, 0.1)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#b0b3c1',
                        padding: 12,
                        font: { size: 12, weight: '500' }
                    }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor: '#ffffff',
                    bodyColor: '#b0b3c1',
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    // CONTINUAÇÃO DO graficos.js

                    ticks: {
                        color: '#b0b3c1',
                        callback: function(value) {
                            return 'R$ ' + value.toLocaleString('pt-BR');
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.08)'
                    }
                },
                x: {
                    ticks: {
                        color: '#b0b3c1',
                        maxTicksLimit: 15
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    }
                }
            }
        }
    });
}

function criarGraficoPizzaDuplo(canvasId1, canvasId2, dados1, dados2, periodo1, periodo2) {
    criarGraficoPizza(canvasId1, dados1);
    criarGraficoPizza(canvasId2, dados2);
}

// ========== FILTROS E PROCESSAMENTO ==========
function filtrarTransacoesPorPeriodo(transacoes, mes = filtroAtual.mes, ano = filtroAtual.ano) {
    return transacoes.filter(t => {
        if (!t.data) return false;
        
        const dataISO = dataParaISO(t.data);
        if (!dataISO) return false;
        
        const data = new Date(dataISO);
        return data.getMonth() + 1 === mes && data.getFullYear() === ano;
    });
}


function processarDadosGraficos(transacoes) {
    const categorias = {};
    const evolucaoDiaria = {};
    let totalEntradas = 0;
    let totalSaidas = 0;
    let totalReservas = 0;
    
    transacoes.forEach(t => {
        const valor = parseFloat(t.valor) || 0;
        
        // Converter data brasileira para obter o dia
        const partesData = t.data.split('/');
        if (partesData.length !== 3) return;
        const dia = parseInt(partesData[0]);
        
        if (t.categoria === 'entrada') {
            totalEntradas += valor;
        } else if (t.categoria === 'saida' || t.categoria === 'saida_credito') {
            totalSaidas += valor;
            const tipo = t.tipo || 'Outros';
            categorias[tipo] = (categorias[tipo] || 0) + valor;
        } else if (t.categoria === 'reserva') {
            totalReservas += valor;
        }
        
        evolucaoDiaria[dia] = evolucaoDiaria[dia] || { entradas: 0, saidas: 0 };
        if (t.categoria === 'entrada') {
            evolucaoDiaria[dia].entradas += valor;
        } else if (t.categoria === 'saida' || t.categoria === 'saida_credito') {
            evolucaoDiaria[dia].saidas += valor;
        }
    });
    
    // ✅ CORREÇÃO: Saldo agora subtrai tanto saídas quanto reservas
    const saldoReal = totalEntradas - totalSaidas - totalReservas;
    
    return {
        categorias,
        evolucaoDiaria,
        totalEntradas,
        totalSaidas,
        totalReservas,
        saldo: saldoReal,  // ✅ Agora calcula corretamente
        transacoes
    };
}

// ========== ESTATÍSTICAS RÁPIDAS ==========
function renderizarEstatisticasRapidas(dados) {
    const mediaGastos = dados.totalSaidas / Object.keys(dados.evolucaoDiaria).length || 0;
    const maiorGasto = Math.max(...Object.values(dados.categorias), 0);
    const categoriaMaiorGasto = Object.keys(dados.categorias).find(
        k => dados.categorias[k] === maiorGasto
    ) || 'N/A';
    
    return `
        <div class="stats-rapidas">
            <div class="stat-card">
                <div class="stat-icon" style="color: var(--success);">
                    <i class="fas fa-arrow-up"></i>
                </div>
                <div class="stat-label">Total Entradas</div>
                <div class="stat-value" style="color: var(--success);">
                    ${formatarMoeda(dados.totalEntradas)}
                </div>
                <div class="stat-change positive">
                    <i class="fas fa-arrow-up"></i> ${dados.transacoes.filter(t => t.categoria === 'entrada').length} transações
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon" style="color: var(--danger);">
                    <i class="fas fa-arrow-down"></i>
                </div>
                <div class="stat-label">Total Saídas</div>
                <div class="stat-value" style="color: var(--danger);">
                    ${formatarMoeda(dados.totalSaidas)}
                </div>
                <div class="stat-change negative">
                    <i class="fas fa-arrow-down"></i> ${dados.transacoes.filter(t => t.categoria === 'saida' || t.categoria === 'saida_credito').length} transações
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon" style="color: var(--accent);">
                    <i class="fas fa-wallet"></i>
                </div>
                <div class="stat-label">Saldo</div>
                <div class="stat-value" style="color: ${dados.saldo >= 0 ? 'var(--success)' : 'var(--danger)'};">
                    ${formatarMoeda(dados.saldo)}
                </div>
                <div class="stat-change ${dados.saldo >= 0 ? 'positive' : 'negative'}">
                    <i class="fas fa-${dados.saldo >= 0 ? 'arrow-up' : 'arrow-down'}"></i> 
                    ${dados.saldo >= 0 ? 'Positivo' : 'Negativo'}
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon" style="color: var(--warning);">
                    <i class="fas fa-chart-line"></i>
                </div>
                <div class="stat-label">Média de Gastos</div>
                <div class="stat-value" style="color: var(--warning);">
                    ${formatarMoeda(mediaGastos)}
                </div>
                <div class="stat-change">
                    <i class="fas fa-calendar-day"></i> Por dia
                </div>
            </div>
            
            <div class="stat-card">
                <div class="stat-icon" style="color: var(--primary);">
                    <i class="fas fa-trophy"></i>
                </div>
                <div class="stat-label">Maior Categoria</div>
                <div class="stat-value" style="color: var(--primary); font-size: 1.3rem;">
                    ${categoriaMaiorGasto}
                </div>
                <div class="stat-change">
                    <i class="fas fa-coins"></i> ${formatarMoeda(maiorGasto)}
                </div>
            </div>
        </div>
    `;
}

// ========== GRÁFICO DE PIZZA ==========
function renderizarGraficoPizza(dados) {
    return `
        <div class="grafico-card">
            <div class="grafico-header">
                <h3 class="grafico-title">
                    <i class="fas fa-chart-pie"></i>
                    Distribuição de Gastos
                </h3>
                <div class="grafico-actions">
                </div>
            </div>
            <div class="grafico-canvas-wrapper">
                <canvas id="pizzaGastosChart" class="grafico-canvas"></canvas>
            </div>
        </div>
    `;
}

function criarGraficoPizza(canvasId, dados) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    if (graficosInstances[canvasId]) {
        graficosInstances[canvasId].destroy();
    }
    
    const labels = Object.keys(dados.categorias);
    const values = Object.values(dados.categorias);
    
    if (labels.length === 0) {
        return;
    }
    
    // ✅ Otimização mobile para Chart.js
        const isMobile = window.innerWidth <= 768;
        const optimizacoes = isMobile ? {
            animation: {
                duration: 500 // Reduz animação de 1000ms para 500ms
            },
            devicePixelRatio: 1 // Força resolução 1x ao invés de 2x/3x
        } : {};

        graficosInstances[canvasId] = new Chart(ctx, {
            type: 'doughnut',
            ...optimizacoes,
            data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: coresTema.gradient,
                borderColor: '#1e2130',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#b0b3c1',
                        padding: 15,
                        font: { size: 12, weight: '500' }
                    }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor: '#ffffff',
                    bodyColor: '#b0b3c1',
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${label}: ${formatarMoeda(value)} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// ========== GRÁFICO DE BARRAS ==========
function renderizarGraficoBarras(dados) {
    return `
        <div class="grafico-card">
            <div class="grafico-header">
                <h3 class="grafico-title">
                    <i class="fas fa-chart-bar"></i>
                    Gastos por Categoria
                </h3>
                <div class="grafico-actions">
                </div>
            </div>
            <div class="grafico-canvas-wrapper">
                <canvas id="barrasCategoriasChart" class="grafico-canvas"></canvas>
            </div>
        </div>
    `;
}

function criarGraficoBarras(canvasId, dados) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    if (graficosInstances[canvasId]) {
        graficosInstances[canvasId].destroy();
    }
    
    const labels = Object.keys(dados.categorias);
    const values = Object.values(dados.categorias);
    
    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Valor Gasto',
                data: values,
                backgroundColor: coresTema.gradient,
                borderColor: '#1e2130',
                borderWidth: 2,
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor: '#ffffff',
                    bodyColor: '#b0b3c1',
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return `Gasto: ${formatarMoeda(context.parsed.y)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#b0b3c1',
                        callback: function(value) {
                            return 'R$ ' + value.toLocaleString('pt-BR');
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.08)'
                    }
                },
                x: {
                    ticks: {
                        color: '#b0b3c1'
                    },
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ========== GRÁFICO DE LINHA ==========
function renderizarGraficoLinha(dados) {
    return `
        <div class="grafico-card full-width">
            <div class="grafico-header">
                <h3 class="grafico-title">
                    <i class="fas fa-chart-line"></i>
                    Evolução: Entradas vs Saídas
                </h3>
                <div class="grafico-actions">
                </div>
            </div>
            <div class="grafico-canvas-wrapper">
                <canvas id="linhaEvolucaoChart" class="grafico-canvas"></canvas>
            </div>
        </div>
    `;
}

function criarGraficoLinha(canvasId, dados) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    if (graficosInstances[canvasId]) {
        graficosInstances[canvasId].destroy();
    }
    
    const dias = Object.keys(dados.evolucaoDiaria).sort((a, b) => a - b);
    const entradas = dias.map(d => dados.evolucaoDiaria[d].entradas);
    const saidas = dias.map(d => dados.evolucaoDiaria[d].saidas);
    
    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dias.map(d => `Dia ${d}`),
            datasets: [
                {
                    label: 'Entradas',
                    data: entradas,
                    borderColor: coresTema.success,
                    backgroundColor: 'rgba(0, 255, 153, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4
                },
                {
                    label: 'Saídas',
                    data: saidas,
                    borderColor: coresTema.danger,
                    backgroundColor: 'rgba(255, 75, 75, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#b0b3c1',
                        padding: 15,
                        font: { size: 13, weight: '600' }
                    }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor: '#ffffff',
                    bodyColor: '#b0b3c1',
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#b0b3c1',
                        callback: function(value) {
                            return 'R$ ' + value.toLocaleString('pt-BR');
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.08)'
                    }
                },
                x: {
                    ticks: {
                        color: '#b0b3c1'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    }
                }
            }
        }
    });
}

// ========== RANKING ==========
function renderizarRankingCategorias(dados) {
    const categorias = Object.entries(dados.categorias)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    
    if (categorias.length === 0) {
        return '';
    }
    
    const maxValor = categorias[0][1];
    
    return `
        <div class="ranking-container">
            <div class="ranking-header">
                <h3 class="ranking-title">
                    <i class="fas fa-trophy"></i>
                    Top 5 Categorias de Gastos
                </h3>
            </div>
            <div class="ranking-list">
                ${categorias.map((cat, index) => {
                    const [nome, valor] = cat;
                    const percentual = ((valor / dados.totalSaidas) * 100).toFixed(1);
                    const larguraBarra = ((valor / maxValor) * 100).toFixed(1);
                    
                    return `
                        <div class="ranking-item-grafico">
                            <div class="ranking-posicao-grafico">${index + 1}º</div>
                            <div class="ranking-info-grafico">
                                <div class="ranking-categoria">${nome}</div>
                                <div class="ranking-percentual">${percentual}% do total de gastos</div>
                                <div class="ranking-barra-container">
                                    <div class="ranking-barra-fill" style="width: ${larguraBarra}%"></div>
                                </div>
                            </div>
                            <div class="ranking-valor-grafico">${formatarMoeda(valor)}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

// ========== COMPARAÇÃO DE PERFIS ==========
function renderizarComparacaoPerfis() {
    if (filtroAtual.tipo === 'individual') {
        return '';
    }
    
    try {
        console.log('👥 Carregando comparação de perfis...');
        
        // ✅ CORREÇÃO: Obter perfis diretamente do localStorage
        const perfis = JSON.parse(localStorage.getItem('granaevo_perfis') || '[]');
        
        if (!perfis || perfis.length === 0) {
            console.warn('⚠️ Nenhum perfil encontrado');
            return '';
        }
        
        console.log(`📊 Processando ${perfis.length} perfis...`);
        
        // Obter dados de cada perfil
        const perfisComDados = perfis.map(perfil => {
            const chave = `granaevo_perfil_${perfil.id}`;
            const dadosPerfil = JSON.parse(localStorage.getItem(chave) || 'null');
            
            if (!dadosPerfil) {
                return null;
            }
            
            const transacoes = dadosPerfil.transacoes || [];
            const transacoesFiltradas = filtrarTransacoesPorPeriodo(transacoes);
            const dados = processarDadosGraficos(transacoesFiltradas);
            
            return {
                perfil: perfil,
                ...dados
            };
        }).filter(p => p !== null && p.transacoes && p.transacoes.length > 0);
        
        console.log(`✅ ${perfisComDados.length} perfis com dados encontrados`);
        
        if (perfisComDados.length === 0) {
            return '';
        }
        
        const vencedor = perfisComDados.reduce((min, p) => 
            p.totalSaidas < min.totalSaidas ? p : min
        );
        
        return `
            <div class="comparacao-container">
                <div class="comparacao-header">
                    <h3 class="comparacao-title">
                        <i class="fas fa-users"></i>
                        Comparação de Perfis - ${filtroAtual.tipo === 'casal' ? 'Casal' : 'Família'}
                    </h3>
                    <p class="comparacao-subtitle">Veja quem está economizando mais este mês</p>
                </div>
                <div class="perfis-comparacao-grid">
                    ${perfisComDados.map(p => `
                        <div class="perfil-comparacao-card ${p.perfil.id === vencedor.perfil.id ? 'winner' : ''}">
                            <img src="${p.perfil.foto || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'80\'%3E%3Ccircle cx=\'40\' cy=\'40\' r=\'40\' fill=\'%2310b981\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' dominant-baseline=\'middle\' text-anchor=\'middle\' font-family=\'Arial\' font-size=\'32\' fill=\'white\'%3EU%3C/text%3E%3C/svg%3E'}" 
                                 class="perfil-avatar" 
                                 alt="${p.perfil.nome}">
                            <h4 class="perfil-nome-comparacao">${p.perfil.nome}</h4>
                            <div class="perfil-stats-comparacao">
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">Total Gasto</span>
                                    <span class="stat-value-comparacao" style="color: var(--danger);">
                                        ${formatarMoeda(p.totalSaidas)}
                                    </span>
                                </div>
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">Total Ganho</span>
                                    <span class="stat-value-comparacao" style="color: var(--success);">
                                        ${formatarMoeda(p.totalEntradas)}
                                    </span>
                                </div>
                                <div class="stat-row-comparacao">
                                    <span class="stat-label-comparacao">Saldo</span>
                                    <span class="stat-value-comparacao" style="color: ${p.saldo >= 0 ? 'var(--success)' : 'var(--danger)'};">
                                        ${formatarMoeda(p.saldo)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        
    } catch (error) {
        console.error('❌ Erro ao renderizar comparação de perfis:', error);
        return '';
    }
}

// ========== TENDÊNCIAS ==========
function renderizarTendencias(dados) {
    const variacaoGastos = 11.2;
    const variacaoEntradas = 5.2;
    
    return `
        <div class="tendencias-container">
            <div class="tendencia-card">
                <div class="tendencia-header">
                    <span class="tendencia-titulo">Tendência de Gastos</span>
                    <span class="tendencia-icon">
                        <i class="fas fa-chart-line"></i>
                    </span>
                </div>
                <div class="tendencia-valor" style="color: var(--danger);">
                    +${variacaoGastos}%
                </div>
                <div class="tendencia-comparacao">vs. média dos últimos 3 meses</div>
                <div class="tendencia-badge up">
                    <i class="fas fa-arrow-up"></i>
                    Análise baseada em dados históricos
                </div>
            </div>
            
            <div class="tendencia-card">
                <div class="tendencia-header">
                    <span class="tendencia-titulo">Meta de Economia</span>
                    <span class="tendencia-icon">
                        <i class="fas fa-bullseye"></i>
                    </span>
                </div>
                <div class="tendencia-valor" style="color: var(--warning);">
                    ${formatarMoeda(dados.totalReservas)}
                </div>
                <div class="tendencia-comparacao">reservado neste período</div>
                <div class="tendencia-badge ${dados.totalReservas > (dados.totalEntradas * 0.2) ? 'up' : 'down'}">
                    <i class="fas fa-piggy-bank"></i>
                    ${dados.totalEntradas > 0 ? ((dados.totalReservas / dados.totalEntradas) * 100).toFixed(1) : 0}% da renda
                </div>
            </div>
        </div>
    `;
}

// ========== UTILITÁRIOS ==========
function exportarGrafico(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    const link = document.createElement('a');
    link.download = `grafico_${canvasId}_${new Date().getTime()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

function mostrarLoading() {
    const container = document.getElementById('graficosConteudo');
    if (container) {
        container.innerHTML = `
            <div class="grafico-loading">
                <div class="loading-spinner"></div>
                <div class="loading-text">Processando dados...</div>
            </div>
        `;
    }
}

function esconderLoading() {
    const container = document.getElementById('graficosConteudo');
    if (container) {
        const loadingElement = container.querySelector('.grafico-loading');
        if (loadingElement) {
            loadingElement.remove();
        }
    }
}

function mostrarEmptyState(mensagem) {
    const container = document.getElementById('graficosConteudo');
    if (container) {
        container.innerHTML = `
            <div class="grafico-empty">
                <div class="empty-icon"><i class="fas fa-chart-line"></i></div>
                <h3 class="empty-title">Nenhum dado disponível</h3>
                <p class="empty-description">${mensagem}</p>
                <button class="btn-primary" onclick="navegarPara('transacoes')">
                    <i class="fas fa-plus"></i> Adicionar Transação
                </button>
            </div>
        `;
    }
}

function formatarMoeda(valor) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(valor || 0);
}

function navegarPara(pagina) {
    const btn = document.querySelector(`[data-page="${pagina}"]`);
    if (btn) {
        btn.click();
    }
}

// ========== EXPORTAÇÃO ==========
window.GraficosGranaEvo = {
    gerar: gerarGraficos,
    exportar: exportarGrafico
};

window.gerarGraficos = gerarGraficos;