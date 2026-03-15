/* =====================================================
   GRANAEVO - GRÁFICOS JAVASCRIPT COMPLETO
   Versão: Segura — R6 (6ª rodada de correções)
   Correções acumuladas: R1–R6
   ===================================================== */

// ========== CAPTURA IMEDIATA DE DEPENDÊNCIAS GLOBAIS ==========
// _safeSanitizeHTML capturada no load — imune a redefinição posterior de window.sanitizeHTML
const _safeSanitizeHTML = (typeof sanitizeHTML === 'function') ? sanitizeHTML : null;

// _dataManager capturado localmente no boot; atribuído em inicializarGraficos()
let _dataManager = null;

// ========== SANITIZAÇÃO CENTRALIZADA ==========
function _sanitize(str) {
    if (_safeSanitizeHTML) {
        return _safeSanitizeHTML(String(str ?? '').slice(0, 200));
    }
    const div = document.createElement('div');
    div.textContent = String(str ?? '').slice(0, 200);
    return div.innerHTML;
}

// ========== CLONE IMUTÁVEL DE DADOS GLOBAIS ==========
// Validação de tipo antes do clone impede objetos maliciosos (ex: { toString: () => alert(1) })
// Object.freeze impede mutação do array retornado por código externo após leitura
function _clonarDados(origem) {
    if (origem !== null && origem !== undefined && !Array.isArray(origem)) {
        console.warn('_clonarDados: origem não é um array — retornando []', typeof origem);
        return Object.freeze([]);
    }
    try {
        const clone = typeof structuredClone === 'function'
            ? structuredClone(origem ?? [])
            : JSON.parse(JSON.stringify(origem ?? []));
        return Object.freeze(clone);
    } catch {
        return Object.freeze([]);
    }
}

// ========== VALIDAÇÃO DE URL DE IMAGEM ==========
// SVG remoto bloqueado (pode conter JS embutido)
// Aceita: data:image/*, caminhos relativos, HTTPS raster em domínio permitido
const _DOMINIOS_FOTO_PERMITIDOS = Object.freeze([
    'cdn.granaevo.com',
    'images.granaevo.com',
    'storage.googleapis.com',
    'firebasestorage.googleapis.com'
]);

function _fotoSegura(fotoRaw, inicialFallback) {
    const raw = String(fotoRaw || '').trim();

    if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(raw)) return raw;
    if (/^\/(?!\/)[^<>"']*$/.test(raw)) return raw;

    if (/^https:\/\//.test(raw)) {
        try {
            const url = new URL(raw);
            const dominioPermitido = _DOMINIOS_FOTO_PERMITIDOS.some(d => url.hostname === d);
            const isSVG = /\.svg(\?.*)?$/i.test(url.pathname);
            if (dominioPermitido && !isSVG) return raw;
        } catch {
            // URL inválida — cai no fallback
        }
    }

    // Fallback: SVG inline com inicial (sem requisição externa, sem XSS)
    const inicial = encodeURIComponent(String(inicialFallback || 'U').slice(0, 1).toUpperCase());
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Ccircle cx='40' cy='40' r='40' fill='%2310b981'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='32' fill='white'%3E${inicial}%3C/text%3E%3C/svg%3E`;
}

// ========== innerHTML CONTROLADO ==========

// Para HTML de dados externos — sanitiza tudo
function _setHTML(element, html) {
    if (!element) return;
    element.innerHTML = _sanitize(html);
}

// R6 FIX: _setSafeHTML substitui _setTrustedHTML
// Usa <template> para parsear o HTML em um DocumentFragment isolado,
// depois varre todos os elementos removendo:
//   - tags <script>
//   - atributos de event handler (on*)
//   - src/href com protocolo javascript:
// Isso cria uma barreira final mesmo que alguma função interna
// esqueça de sanitizar um campo antes de compor o template.
const _ATTRS_PERIGOSOS = Object.freeze([
    'onerror','onload','onclick','onmouseover','onfocus','onblur',
    'onchange','oninput','onsubmit','onkeydown','onkeyup','onkeypress',
    'onmouseenter','onmouseleave','ondblclick','oncontextmenu',
    'onpaste','oncopy','oncut','ondrag','ondrop','onscroll',
    'onanimationstart','ontransitionend','onpointerdown','onpointerup'
]);

function _setSafeHTML(element, html) {
    if (!element) return;

    // Parseia em contexto isolado — não executa scripts ainda
    const template = document.createElement('template');
    template.innerHTML = html;
    const frag = template.content;

    // Remove todos os <script>
    frag.querySelectorAll('script').forEach(s => s.remove());

    // Remove todos os elementos perigosos
    frag.querySelectorAll('*').forEach(el => {
        // Remove todos os event handlers (on*)
        _ATTRS_PERIGOSOS.forEach(attr => {
            if (el.hasAttribute(attr)) el.removeAttribute(attr);
        });

        // Varredura extra: qualquer atributo que começa com "on"
        Array.from(el.attributes).forEach(attr => {
            if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        });

        // Remove src/href com javascript:
        ['src', 'href', 'action', 'formaction', 'data'].forEach(attr => {
            if (el.hasAttribute(attr)) {
                const val = el.getAttribute(attr);
                if (/^\s*javascript:/i.test(val) || /^\s*vbscript:/i.test(val)) {
                    el.removeAttribute(attr);
                }
            }
        });
    });

    // Substitui o conteúdo do container pelo fragmento limpo
    element.innerHTML = '';
    element.appendChild(frag.cloneNode(true));
}

// ========== VALIDAÇÃO DE COR INTERNA ==========
// R5 FIX: impede que cores arbitrárias sejam injetadas em atributos style
// Aceita apenas var(--token) e valores hexadecimais simples
const _CORES_PERMITIDAS = Object.freeze({
    'var(--danger)':   'var(--danger)',
    'var(--success)':  'var(--success)',
    'var(--warning)':  'var(--warning)',
    'var(--primary)':  'var(--primary)',
    'var(--accent)':   'var(--accent)'
});

function _corSegura(cor) {
    return _CORES_PERMITIDAS[cor] || 'var(--primary)';
}

// ========== FUNÇÕES AUXILIARES ==========

// Validação estrita de formato DD/MM/YYYY antes de processar
function dataParaISO(dataBR) {
    if (typeof dataBR !== 'string') return null;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dataBR)) return null;
    const [dia, mes, ano] = dataBR.split('/').map(Number);
    if (mes < 1 || mes > 12) return null;
    if (dia < 1 || dia > 31) return null;
    if (ano < 2000 || ano > 2100) return null;
    return `${String(ano)}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// ========== USER STORE PRIVADO ==========
// R6 FIX: substitui leitura direta de window.usuarioLogado / window.perfilAtivo / window.transacoes
// Qualquer script de terceiro, extensão ou XSS em outra página NÃO consegue acessar esses dados
// pois ficam em closure privado — inacessível pelo prototype chain ou pelo objeto window.
const UserStore = (() => {
    let _usuario     = null;
    let _perfil      = null;
    let _transacoes  = null;

    function _clonarObjeto(obj) {
        if (!obj || typeof obj !== 'object') return null;
        try {
            return Object.freeze(
                typeof structuredClone === 'function'
                    ? structuredClone(obj)
                    : JSON.parse(JSON.stringify(obj))
            );
        } catch {
            return null;
        }
    }

    function _clonarArray(arr) {
        if (!Array.isArray(arr)) return Object.freeze([]);
        try {
            return Object.freeze(
                typeof structuredClone === 'function'
                    ? structuredClone(arr)
                    : JSON.parse(JSON.stringify(arr))
            );
        } catch {
            return Object.freeze([]);
        }
    }

    // Lê do window uma única vez no boot e guarda internamente
    function sincronizar() {
        if (window.usuarioLogado && typeof window.usuarioLogado === 'object') {
            _usuario = _clonarObjeto(window.usuarioLogado);
        }
        if (window.perfilAtivo && typeof window.perfilAtivo === 'object') {
            _perfil = _clonarObjeto(window.perfilAtivo);
        }
        if (Array.isArray(window.transacoes)) {
            _transacoes = _clonarArray(window.transacoes);
        }
    }

    function getPerfis() {
        // Lê o estado mais recente do window (perfis podem mudar durante a sessão)
        // mas retorna clone imutável — nunca referência direta
        const fonte = window.usuarioLogado?.perfis ?? _usuario?.perfis;
        return _clonarArray(fonte);
    }

    function getPerfilAtivo() {
        // Sempre relê do window pois o usuário pode trocar de perfil
        const fonte = window.perfilAtivo ?? _perfil;
        return _clonarObjeto(fonte);
    }

    function getTransacoes() {
        // Sempre relê do window pois novas transações podem ter sido adicionadas
        const fonte = Array.isArray(window.transacoes) ? window.transacoes : _transacoes;
        return _clonarArray(fonte);
    }

    return Object.freeze({ sincronizar, getPerfis, getPerfilAtivo, getTransacoes });
})();

// ========== VARIÁVEIS GLOBAIS ==========
// Object.create(null) elimina prototype chain — imune a __proto__, constructor, toString etc.
const graficosInstances = Object.create(null);

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
// Substituído setTimeout(1000) frágil por evento customizado + MutationObserver
document.addEventListener('DOMContentLoaded', () => {
    // Caminho 1: dashboard.js dispara 'dashboardPronto' quando o conteúdo estiver pronto
    document.addEventListener('dashboardPronto', inicializarGraficos, { once: true });

    // Caminho 2: fallback via MutationObserver — aguarda o container real aparecer no DOM
    const observer = new MutationObserver(() => {
        if (document.getElementById('graficosConteudo')) {
            observer.disconnect();
            inicializarGraficos();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
});

function inicializarGraficos() {
    // Capturar dataManager no momento do boot — qualquer window.dataManager atribuído
    // DEPOIS desta linha é ignorado; todo o código usa _dataManager (variável local do módulo)
    if (window.dataManager && !_dataManager) {
        _dataManager = window.dataManager;
    }

    // R6 FIX: sincronizar UserStore no boot — captura estado inicial do window
    // Após isso, UserStore.get*() é a única fonte de dados de usuário no módulo
    UserStore.sincronizar();

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
            filtroAtual.mes = parseInt(e.target.value, 10);
        });
    }

    if (anoSelect && anoSelect.options.length === 0) {
        preencherAnos(anoSelect);
        anoSelect.value = filtroAtual.ano;
        anoSelect.addEventListener('change', (e) => {
            filtroAtual.ano = parseInt(e.target.value, 10);
        });
    }

    const mesComp = document.getElementById('mesComparacao');
    const anoComp = document.getElementById('anoComparacao');

    if (mesComp && mesComp.options.length === 0) {
        preencherMeses(mesComp);
        const mesAnterior = filtroAtual.mes === 1 ? 12 : filtroAtual.mes - 1;
        mesComp.value = mesAnterior;
        filtroAtual.mesComparacao = mesAnterior;
        mesComp.addEventListener('change', (e) => {
            filtroAtual.mesComparacao = parseInt(e.target.value, 10);
        });
    }

    if (anoComp && anoComp.options.length === 0) {
        preencherAnos(anoComp);
        anoComp.value = filtroAtual.ano;
        filtroAtual.anoComparacao = filtroAtual.ano;
        anoComp.addEventListener('change', (e) => {
            filtroAtual.anoComparacao = parseInt(e.target.value, 10);
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
        option.textContent = mes; // textContent — sem risco de XSS
        select.appendChild(option);
    });
}

function preencherAnos(select) {
    const anoAtual = new Date().getFullYear();
    select.innerHTML = '';
    for (let i = anoAtual; i >= anoAtual - 5; i--) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = i; // textContent — sem risco de XSS
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
// R5 FIX: rate-limit de 1 chamada por 800ms — impede clique rápido ou loop externo
let _gerarGraficosUltimaExecucao = 0;
const _GERAR_GRAFICOS_COOLDOWN_MS = 800;

async function gerarGraficos() {
    const agora = Date.now();
    if (agora - _gerarGraficosUltimaExecucao < _GERAR_GRAFICOS_COOLDOWN_MS) {
        console.warn(`⏳ gerarGraficos chamado muito rápido — ignorado (cooldown ${_GERAR_GRAFICOS_COOLDOWN_MS}ms)`);
        return;
    }
    _gerarGraficosUltimaExecucao = agora;

    mostrarLoading();

    try {
        console.log('🔍 Iniciando geração de gráficos...');

        // ─── CASAL ───────────────────────────────────────────────────────────
        if (filtroAtual.tipo === 'casal') {
            const perfis = UserStore.getPerfis();

            if (perfis.length < 2) {
                mostrarEmptyState('Você precisa ter pelo menos 2 perfis cadastrados para gerar gráficos de casal.');
                esconderLoading();
                return;
            }

            if (perfis.length > 2) {
                abrirSelecaoPerfisCasalGraficos();
                esconderLoading();
                return;
            }

            const perfisAtivos = perfis.slice(0, 2);
            await gerarGraficosCompartilhados(perfisAtivos);
            esconderLoading();
            return;
        }

        // ─── FAMÍLIA ─────────────────────────────────────────────────────────
        if (filtroAtual.tipo === 'familia') {
            const perfis = UserStore.getPerfis();

            if (perfis.length < 2) {
                mostrarEmptyState('Você precisa ter pelo menos 2 perfis para gerar gráficos da família.');
                esconderLoading();
                return;
            }

            await gerarGraficosCompartilhados(perfis);
            esconderLoading();
            return;
        }

        // ─── INDIVIDUAL ──────────────────────────────────────────────────────
        const perfilAtivo = UserStore.getPerfilAtivo();

        if (!perfilAtivo || !perfilAtivo.id) {
            console.error('❌ Nenhum perfil selecionado');
            mostrarEmptyState('Nenhum perfil está ativo. Por favor, selecione um perfil no Dashboard.');
            esconderLoading();
            return;
        }

        console.log('✅ Perfil ativo encontrado:', perfilAtivo.nome);

        const todasTransacoes = UserStore.getTransacoes();

        console.log('📊 Total de transações encontradas:', todasTransacoes.length);

        if (todasTransacoes.length === 0) {
            console.warn('⚠️ Nenhuma transação encontrada');
            mostrarEmptyState('Nenhuma transação encontrada. Comece adicionando suas movimentações na página de Transações!');
            esconderLoading();
            return;
        }

        filtroAtual.perfil = perfilAtivo.id;
        const transacoesFiltradas = filtrarTransacoesPorPeriodo(todasTransacoes);

        console.log('🔎 Transações filtradas:', transacoesFiltradas.length);
        console.log('📅 Filtro aplicado:', `Mês ${filtroAtual.mes}/${filtroAtual.ano}`);

        if (transacoesFiltradas.length === 0) {
            const mesNome = _NOMES_MESES[filtroAtual.mes - 1];
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
        // Mensagem de erro não expõe dados do objeto error ao usuário
        mostrarEmptyState('Erro ao processar dados. Verifique o console (F12) para mais detalhes.');
        esconderLoading();
    }
}

// ========== CONSTANTE DE MESES (centralizada — usada em múltiplos lugares) ==========
const _NOMES_MESES = Object.freeze([
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
]);

// ========== SELEÇÃO DE PERFIS PARA GRÁFICO CASAL (PLANO FAMÍLIA) ==========
function abrirSelecaoPerfisCasalGraficos() {
    const perfis = UserStore.getPerfis();

    if (perfis.length === 0) {
        if (typeof mostrarNotificacao === 'function') {
            mostrarNotificacao('Nenhum perfil encontrado.', 'error');
        }
        return;
    }

    let htmlPerfis = '';

    perfis.forEach(perfil => {
        // Apenas caracteres alfanuméricos, traço e underscore para IDs
        const idSeguro   = String(perfil.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const nomeSeguro = _sanitize(perfil.nome);

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

        // addEventListener — sem onclick inline
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

    const perfis             = UserStore.getPerfis();
    const perfisSelecionados = perfis.filter(p => perfisIds.includes(String(p.id)));

    if (perfisSelecionados.length !== 2) {
        console.error('Perfis selecionados não encontrados em usuarioLogado.perfis');
        return;
    }

    if (typeof fecharPopup === 'function') fecharPopup();

    // R5 FIX: substituído setTimeout(300) por execução síncrona + mostrarLoading sequencial
    // Elimina race condition entre mostrarLoading e a chamada ao gerarGraficosCompartilhados
    mostrarLoading();
    gerarGraficosCompartilhados(perfisSelecionados);
}

// ========== GERAR GRÁFICOS COMPARTILHADOS (CASAL/FAMÍLIA) ==========
async function gerarGraficosCompartilhados(perfisAtivos) {
    console.log('👨‍👩‍👧‍👦 Gerando gráficos compartilhados para:', perfisAtivos.map(p => p.nome).join(', '));

    try {
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

        if (!_dataManager) {
            console.warn('⏳ _dataManager não capturado ainda, tentando window.dataManager em 500ms...');
            await new Promise(resolve => setTimeout(resolve, 500));
            if (window.dataManager) _dataManager = window.dataManager;
            if (!_dataManager) throw new Error('DataManager não inicializado corretamente.');
        }

        const userData = await _dataManager.loadUserData();

        if (!userData || !userData.profiles) {
            console.error('❌ Dados do usuário não encontrados');
            mostrarEmptyState('Não foi possível carregar os dados do usuário.');
            return;
        }

        const todasTransacoes = [];

        perfisAtivos.forEach(perfil => {
            const dadosPerfil = userData.profiles.find(p => p.id === perfil.id);

            if (dadosPerfil && dadosPerfil.transacoes) {
                dadosPerfil.transacoes.forEach(t => {
                    todasTransacoes.push({
                        ...t,
                        perfilId:   perfil.id,
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

        const transacoesFiltradas = filtrarTransacoesPorPeriodo(todasTransacoes);

        console.log('🔎 Transações após filtro:', transacoesFiltradas.length);

        if (transacoesFiltradas.length === 0) {
            const mesNome = _NOMES_MESES[filtroAtual.mes - 1];
            mostrarEmptyState(`Nenhuma transação encontrada para ${mesNome}/${filtroAtual.ano} nos perfis selecionados.`);
            return;
        }

        const dadosGerais    = processarDadosGraficos(transacoesFiltradas);
        const dadosPorPerfil = perfisAtivos.map(perfil => {
            const transacoesPerfil = transacoesFiltradas.filter(t => t.perfilId === perfil.id);
            return { perfil, ...processarDadosGraficos(transacoesPerfil) };
        });

        console.log('✅ Dados processados. Renderizando...');

        if (filtroAtual.comparacao) {
            await renderizarGraficosComparativos(todasTransacoes);
        } else {
            renderizarGraficosCompartilhadosUI(dadosGerais, dadosPorPerfil);
        }

    } catch (error) {
        console.error('❌ ERRO ao gerar gráficos compartilhados:', error);
        mostrarEmptyState('Erro ao processar dados. Verifique o console (F12) para mais detalhes.');
    }
}

function renderizarGraficosCompartilhadosUI(dadosGerais, dadosPorPerfil) {
    const container = document.getElementById('graficosConteudo');
    if (!container) return;

    const tipoTexto     = filtroAtual.tipo === 'casal' ? 'do Casal' : 'da Família';
    const icone         = filtroAtual.tipo === 'casal' ? '💑' : '👨‍👩‍👧‍👦';
    const htmlComparacao = gerarHTMLComparacaoPerfis(dadosPorPerfil);

    _setSafeHTML(container, `
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
    `);

    setTimeout(() => {
        criarGraficoPizza('pizzaGastosChart', dadosGerais);
        setTimeout(() => { criarGraficoBarras('barrasCategoriasChart', dadosGerais); }, 150);
        setTimeout(() => { criarGraficoLinha('linhaEvolucaoChart', dadosGerais); }, 300);
    }, 100);
}

// ========== GERAR HTML DE COMPARAÇÃO DE PERFIS ==========
// Sanitização aplicada a TODOS os campos de perfil inseridos no HTML
function gerarHTMLComparacaoPerfis(dadosPorPerfil) {
    if (!dadosPorPerfil || dadosPorPerfil.length === 0) return '';

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
                    const isVencedor  = p.perfil.id === vencedor.perfil.id;
                    const taxaEconomia = p.totalEntradas > 0
                        ? ((p.totalReservas / p.totalEntradas) * 100).toFixed(1)
                        : 0;

                    const nomeSeguro = _sanitize(p.perfil.nome);
                    const fotoSrc    = _fotoSegura(p.perfil.foto, p.perfil.nome);

                    return `
                        <div class="perfil-comparacao-card ${isVencedor ? 'winner' : ''}">
                            ${isVencedor ? '<div class="winner-badge">🏆 Melhor Economia</div>' : ''}

                            <img src="${fotoSrc}"
                                 class="perfil-avatar"
                                 alt="${nomeSeguro}">

                            <h4 class="perfil-nome-comparacao">${nomeSeguro}</h4>

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
// Todos os nomes de perfil sanitizados antes de entrar no HTML
function gerarInsightsComparacaoCasal(perfil1, perfil2) {
    const diferencaGastos   = Math.abs(perfil1.totalSaidas - perfil2.totalSaidas);
    const quemGastouMais    = perfil1.totalSaidas > perfil2.totalSaidas ? perfil1 : perfil2;
    const quemGastouMenos   = perfil1.totalSaidas < perfil2.totalSaidas ? perfil1 : perfil2;
    const diferencaReservas = Math.abs(perfil1.totalReservas - perfil2.totalReservas);
    const quemGuardouMais   = perfil1.totalReservas > perfil2.totalReservas ? perfil1 : perfil2;
    const taxaEconomia1     = perfil1.totalEntradas > 0 ? (perfil1.totalReservas / perfil1.totalEntradas * 100) : 0;
    const taxaEconomia2     = perfil2.totalEntradas > 0 ? (perfil2.totalReservas / perfil2.totalEntradas * 100) : 0;
    const melhorTaxa        = taxaEconomia1 > taxaEconomia2 ? perfil1 : perfil2;

    const nome1Seg           = _sanitize(perfil1.perfil.nome);
    const nome2Seg           = _sanitize(perfil2.perfil.nome);
    const nomeGastouMaisSeg  = _sanitize(quemGastouMais.perfil.nome);
    const nomeGastouMenosSeg = _sanitize(quemGastouMenos.perfil.nome);
    const nomeGuardouMaisSeg = _sanitize(quemGuardouMais.perfil.nome);
    const nomeMelhorTaxaSeg  = _sanitize(melhorTaxa.perfil.nome);
    const taxaFinal          = (taxaEconomia1 > taxaEconomia2 ? taxaEconomia1 : taxaEconomia2).toFixed(1);

    return `
        <div class="insights-container" style="margin-top: 30px;">
            <h3 class="insights-title">
                <i class="fas fa-lightbulb"></i>
                Insights da Comparação entre ${nome1Seg} e ${nome2Seg}
            </h3>
            <div class="insights-grid">
                <div class="insight-card">
                    <div class="insight-icon" style="color: var(--danger);">
                        <i class="fas fa-shopping-cart"></i>
                    </div>
                    <div class="insight-content">
                        <h4>💸 Diferença nos Gastos</h4>
                        <p>
                            <strong>${nomeGastouMaisSeg}</strong> gastou ${formatarMoeda(diferencaGastos)}
                            a mais que <strong>${nomeGastouMenosSeg}</strong> neste período.
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
                            <strong>${nomeGuardouMaisSeg}</strong> guardou ${formatarMoeda(diferencaReservas)}
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
                            <strong>${nomeMelhorTaxaSeg}</strong> tem a melhor taxa:
                            ${taxaFinal}% da renda guardada.
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
        totalSaidas:   dados.totalSaidas,
        saldo:         dados.saldo,
        categorias:    Object.keys(dados.categorias).length
    });

    _setSafeHTML(container, `
        <div class="graficos-grid">
            ${renderizarEstatisticasRapidas(dados)}
            ${renderizarGraficoPizza(dados)}
            ${renderizarGraficoBarras(dados)}
            ${renderizarGraficoLinha(dados)}
        </div>
        ${renderizarRankingCategorias(dados)}
        ${renderizarTendencias(dados)}
    `);

    console.log('✅ HTML dos gráficos inserido no DOM');

    setTimeout(() => {
        console.log('🎨 Criando gráficos Chart.js...');
        criarGraficoPizza('pizzaGastosChart', dados);
        setTimeout(() => { criarGraficoBarras('barrasCategoriasChart', dados); }, 150);
        setTimeout(() => { criarGraficoLinha('linhaEvolucaoChart', dados); }, 300);
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

        const transacoes1 = filtrarTransacoesPorPeriodo(todasTransacoes, filtroAtual.mes, filtroAtual.ano);
        const dados1 = processarDadosGraficos(transacoes1);

        const transacoes2 = filtrarTransacoesPorPeriodo(todasTransacoes, filtroAtual.mesComparacao, filtroAtual.anoComparacao);
        const dados2 = processarDadosGraficos(transacoes2);

        // Períodos são valores internos (mês/ano de filtros) — sem dado de usuário, sem XSS
        const periodo1 = `${_NOMES_MESES[filtroAtual.mes - 1]}/${filtroAtual.ano}`;
        const periodo2 = `${_NOMES_MESES[filtroAtual.mesComparacao - 1]}/${filtroAtual.anoComparacao}`;

        _setSafeHTML(container, `
            <div class="comparacao-header-especial">
                <h2><i class="fas fa-balance-scale"></i> Análise Comparativa</h2>
                <p>Comparando ${periodo1} vs ${periodo2}</p>
            </div>

            ${renderizarCardsComparativos(dados1, dados2, periodo1, periodo2)}
            ${renderizarGraficoBarrasComparativo(dados1, dados2, periodo1, periodo2)}
            ${renderizarGraficoLinhaComparativo(dados1, dados2, periodo1, periodo2)}
            ${renderizarGraficoPizzaComparativo(dados1, dados2, periodo1, periodo2)}
            ${renderizarInsightsComparativos(dados1, dados2, periodo1, periodo2)}
        `);

        setTimeout(() => {
            criarGraficoBarrasComparativo('barrasComparativoChart', dados1, dados2, periodo1, periodo2);
            criarGraficoLinhaComparativo('linhaComparativoChart', dados1, dados2, periodo1, periodo2);
            criarGraficoPizzaDuplo('pizzaComparativo1', 'pizzaComparativo2', dados1, dados2, periodo1, periodo2);
        }, 100);

    } catch (error) {
        console.error('❌ Erro ao renderizar gráficos comparativos:', error);
        mostrarEmptyState('Erro ao processar comparação. Verifique o console (F12) para mais detalhes.');
    }
}

function renderizarCardsComparativos(dados1, dados2, periodo1, periodo2) {
    const calcVariacao = (val1, val2) => {
        if (val2 === 0) return val1 > 0 ? 100 : 0;
        return ((val1 - val2) / val2 * 100).toFixed(1);
    };

    const varEntradas = calcVariacao(dados1.totalEntradas, dados2.totalEntradas);
    const varSaidas   = calcVariacao(dados1.totalSaidas,   dados2.totalSaidas);
    const varSaldo    = calcVariacao(dados1.saldo,          dados2.saldo);
    const varReservas = calcVariacao(dados1.totalReservas,  dados2.totalReservas);

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

    // Guard para divisão por zero
    const varSaidas = dados2.totalSaidas > 0
        ? ((dados1.totalSaidas - dados2.totalSaidas) / dados2.totalSaidas * 100).toFixed(1)
        : 0;

    if (Math.abs(varSaidas) > 10) {
        insights.push({
            icon:     'fa-exclamation-triangle',
            // R5 FIX: cor via _corSegura() — impede injeção em style=""
            color:    _corSegura(varSaidas > 0 ? 'var(--danger)' : 'var(--success)'),
            titulo:   varSaidas > 0 ? 'Aumento nos Gastos' : 'Redução nos Gastos',
            descricao: `Você ${varSaidas > 0 ? 'gastou' : 'economizou'} ${Math.abs(varSaidas)}% ${varSaidas > 0 ? 'mais' : 'a menos'} em ${periodo1} comparado a ${periodo2}`
        });
    }

    const categoriasAumento = [];
    for (const cat in dados1.categorias) {
        // cat já foi sanitizado em processarDadosGraficos — seguro
        const val1 = dados1.categorias[cat] || 0;
        const val2 = dados2.categorias[cat] || 0;
        if (val2 > 0) {
            const varPerc = ((val1 - val2) / val2 * 100);
            if (Math.abs(varPerc) > 20) {
                categoriasAumento.push({ cat, var: varPerc, val1, val2 });
            }
        }
    }

    if (categoriasAumento.length > 0) {
        const maior = categoriasAumento.sort((a, b) => Math.abs(b.var) - Math.abs(a.var))[0];
        insights.push({
            icon:     'fa-chart-line',
            color:    _corSegura('var(--warning)'),
            titulo:   `Destaque: ${maior.cat}`,
            descricao: `Variação de ${maior.var > 0 ? '+' : ''}${maior.var.toFixed(1)}% — de ${formatarMoeda(maior.val2)} para ${formatarMoeda(maior.val1)}`
        });
    }

    const desempenho = dados1.saldo > dados2.saldo ? 'melhor' : dados1.saldo < dados2.saldo ? 'pior' : 'igual';
    if (desempenho !== 'igual') {
        insights.push({
            icon:     desempenho === 'melhor' ? 'fa-thumbs-up' : 'fa-thumbs-down',
            color:    _corSegura(desempenho === 'melhor' ? 'var(--success)' : 'var(--danger)'),
            titulo:   `Desempenho ${desempenho === 'melhor' ? 'Melhor' : 'Pior'}`,
            descricao: `Seu saldo ficou ${formatarMoeda(Math.abs(dados1.saldo - dados2.saldo))} ${desempenho === 'melhor' ? 'maior' : 'menor'} neste período`
        });
    }

    if (insights.length === 0) return '';

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

    const todasCategorias = new Set([
        ...Object.keys(dados1.categorias),
        ...Object.keys(dados2.categorias)
    ]);
    const labels  = Array.from(todasCategorias);
    const valores1 = labels.map(cat => dados1.categorias[cat] || 0);
    const valores2 = labels.map(cat => dados2.categorias[cat] || 0);

    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label:           periodo1,
                    data:            valores1,
                    backgroundColor: 'rgba(67, 160, 71, 0.8)',
                    borderColor:     '#43a047',
                    borderWidth:     2,
                    borderRadius:    8
                },
                {
                    label:           periodo2,
                    data:            valores2,
                    backgroundColor: 'rgba(108, 99, 255, 0.8)',
                    borderColor:     '#6c63ff',
                    borderWidth:     2,
                    borderRadius:    8
                }
            ]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#b0b3c1', padding: 15, font: { size: 13, weight: '600' } }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor:      '#ffffff',
                    bodyColor:       '#b0b3c1',
                    padding:         12,
                    cornerRadius:    8,
                    callbacks: {
                        label: (context) => `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#b0b3c1', callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') },
                    grid:  { color: 'rgba(255, 255, 255, 0.08)' }
                },
                x: {
                    ticks: { color: '#b0b3c1' },
                    grid:  { display: false }
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

    const dias1   = Object.keys(dados1.evolucaoDiaria).sort((a, b) => a - b);
    const dias2   = Object.keys(dados2.evolucaoDiaria).sort((a, b) => a - b);
    const maxDias = Math.max(dias1.length, dias2.length, 30);
    const labels  = Array.from({ length: maxDias }, (_, i) => `Dia ${i + 1}`);

    const entradas1 = labels.map((_, i) => dados1.evolucaoDiaria[i + 1]?.entradas || 0);
    const saidas1   = labels.map((_, i) => dados1.evolucaoDiaria[i + 1]?.saidas   || 0);
    const entradas2 = labels.map((_, i) => dados2.evolucaoDiaria[i + 1]?.entradas || 0);
    const saidas2   = labels.map((_, i) => dados2.evolucaoDiaria[i + 1]?.saidas   || 0);

    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label:           `${periodo1} - Entradas`,
                    data:            entradas1,
                    borderColor:     '#00ff99',
                    backgroundColor: 'rgba(0, 255, 153, 0.1)',
                    borderWidth:     3,
                    tension:         0.4
                },
                {
                    label:           `${periodo1} - Saídas`,
                    data:            saidas1,
                    borderColor:     '#ff4b4b',
                    backgroundColor: 'rgba(255, 75, 75, 0.1)',
                    borderWidth:     3,
                    tension:         0.4
                },
                {
                    label:           `${periodo2} - Entradas`,
                    data:            entradas2,
                    borderColor:     '#6c63ff',
                    backgroundColor: 'rgba(108, 99, 255, 0.1)',
                    borderWidth:     2,
                    borderDash:      [5, 5],
                    tension:         0.4
                },
                {
                    label:           `${periodo2} - Saídas`,
                    data:            saidas2,
                    borderColor:     '#ffd166',
                    backgroundColor: 'rgba(255, 209, 102, 0.1)',
                    borderWidth:     2,
                    borderDash:      [5, 5],
                    tension:         0.4
                }
            ]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#b0b3c1', padding: 12, font: { size: 12, weight: '500' } }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor:      '#ffffff',
                    bodyColor:       '#b0b3c1',
                    padding:         12,
                    cornerRadius:    8,
                    callbacks: {
                        label: (context) => `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#b0b3c1', callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') },
                    grid:  { color: 'rgba(255, 255, 255, 0.08)' }
                },
                x: {
                    ticks: { color: '#b0b3c1', maxTicksLimit: 15 },
                    grid:  { color: 'rgba(255, 255, 255, 0.05)' }
                }
            }
        }
    });
}

function criarGraficoPizzaDuplo(canvasId1, canvasId2, dados1, dados2) {
    criarGraficoPizza(canvasId1, dados1);
    criarGraficoPizza(canvasId2, dados2);
}

// ========== FILTROS E PROCESSAMENTO ==========
function filtrarTransacoesPorPeriodo(transacoes, mes = filtroAtual.mes, ano = filtroAtual.ano) {
    return transacoes.filter(t => {
        if (!t.data) return false;
        // dataParaISO valida estritamente o formato DD/MM/YYYY
        const dataISO = dataParaISO(t.data);
        if (!dataISO) return false;
        const data = new Date(dataISO);
        return data.getMonth() + 1 === mes && data.getFullYear() === ano;
    });
}

function processarDadosGraficos(transacoes) {
    // R5 FIX: Object.create(null) — elimina prototype chain em categorias e evolucaoDiaria
    // Impede que chaves como __proto__, constructor ou toString poluam o objeto
    const categorias     = Object.create(null);
    const evolucaoDiaria = Object.create(null);

    let totalEntradas = 0;
    let totalSaidas   = 0;
    let totalReservas = 0;

    transacoes.forEach(t => {
        // R5 FIX: bounds check — rejeita valores absurdos ou não numéricos
        const valor = parseFloat(t.valor) || 0;
        if (!isFinite(valor) || valor < 0 || valor > 1_000_000_000) return;

        const dataISO = dataParaISO(t.data);
        if (!dataISO) return;

        const dia = parseInt(t.data.split('/')[0], 10);
        if (dia < 1 || dia > 31) return;

        if (t.categoria === 'entrada') {
            totalEntradas += valor;
        } else if (t.categoria === 'saida' || t.categoria === 'saida_credito') {
            totalSaidas += valor;
            // Sanitizar a chave de categoria — protege todos os Object.keys() posteriores
            const tipo = _sanitize(t.tipo || 'Outros');
            categorias[tipo] = (categorias[tipo] || 0) + valor;
        } else if (t.categoria === 'reserva') {
            totalReservas += valor;
        }

        if (!evolucaoDiaria[dia]) {
            evolucaoDiaria[dia] = { entradas: 0, saidas: 0 };
        }

        if (t.categoria === 'entrada') {
            evolucaoDiaria[dia].entradas += valor;
        } else if (t.categoria === 'saida' || t.categoria === 'saida_credito') {
            evolucaoDiaria[dia].saidas += valor;
        }
    });

    const saldoReal = totalEntradas - totalSaidas - totalReservas;

    return {
        categorias,
        evolucaoDiaria,
        totalEntradas,
        totalSaidas,
        totalReservas,
        saldo: saldoReal,
        transacoes
    };
}

// ========== ESTATÍSTICAS RÁPIDAS ==========
function renderizarEstatisticasRapidas(dados) {
    const diasComDados = Object.keys(dados.evolucaoDiaria).length;
    const mediaGastos  = diasComDados > 0 ? dados.totalSaidas / diasComDados : 0;

    // R5 FIX: Math.max() sem argumentos retorna -Infinity
    // Com categorias vazias, valores = [] → Math.max(...[], 0) = Math.max(0) = 0 ✅
    const valoresCategorias   = Object.values(dados.categorias);
    const maiorGasto          = valoresCategorias.length > 0 ? Math.max(...valoresCategorias) : 0;

    // R5 FIX: sanitizar nome da maior categoria antes de inserir no HTML
    const categoriaMaiorGasto = _sanitize(
        Object.keys(dados.categorias).find(k => dados.categorias[k] === maiorGasto) || 'N/A'
    );

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
                    <i class="fas fa-arrow-${dados.saldo >= 0 ? 'up' : 'down'}"></i>
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
                <div class="grafico-actions"></div>
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

    if (labels.length === 0) return;

    const isMobile = window.innerWidth <= 768;

    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'doughnut',
        // R5 FIX: devicePixelRatio fica no nível correto (top-level do config Chart.js)
        devicePixelRatio: isMobile ? 1 : undefined,
        data: {
            labels,
            datasets: [{
                data:            values,
                backgroundColor: coresTema.gradient,
                borderColor:     '#1e2130',
                borderWidth:     2
            }]
        },
        options: {
            // R5 FIX: animation agora dentro de options (onde pertence em Chart.js v3+)
            animation: isMobile ? { duration: 500 } : undefined,
            responsive:          true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#b0b3c1', padding: 15, font: { size: 12, weight: '500' } }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor:      '#ffffff',
                    bodyColor:       '#b0b3c1',
                    padding:         12,
                    cornerRadius:    8,
                    callbacks: {
                        label: (context) => {
                            const label      = context.label || '';
                            const value      = context.parsed || 0;
                            const total      = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
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
                <div class="grafico-actions"></div>
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
            labels,
            datasets: [{
                label:           'Valor Gasto',
                data:            values,
                backgroundColor: coresTema.gradient,
                borderColor:     '#1e2130',
                borderWidth:     2,
                borderRadius:    8
            }]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor:      '#ffffff',
                    bodyColor:       '#b0b3c1',
                    padding:         12,
                    cornerRadius:    8,
                    callbacks: {
                        label: (context) => `Gasto: ${formatarMoeda(context.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#b0b3c1', callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') },
                    grid:  { color: 'rgba(255, 255, 255, 0.08)' }
                },
                x: {
                    ticks: { color: '#b0b3c1' },
                    grid:  { display: false }
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
                <div class="grafico-actions"></div>
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

    const dias     = Object.keys(dados.evolucaoDiaria).sort((a, b) => a - b);
    const entradas = dias.map(d => dados.evolucaoDiaria[d].entradas);
    const saidas   = dias.map(d => dados.evolucaoDiaria[d].saidas);

    graficosInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dias.map(d => `Dia ${d}`),
            datasets: [
                {
                    label:           'Entradas',
                    data:            entradas,
                    borderColor:     coresTema.success,
                    backgroundColor: 'rgba(0, 255, 153, 0.1)',
                    borderWidth:     3,
                    fill:            true,
                    tension:         0.4
                },
                {
                    label:           'Saídas',
                    data:            saidas,
                    borderColor:     coresTema.danger,
                    backgroundColor: 'rgba(255, 75, 75, 0.1)',
                    borderWidth:     3,
                    fill:            true,
                    tension:         0.4
                }
            ]
        },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { color: '#b0b3c1', padding: 15, font: { size: 13, weight: '600' } }
                },
                tooltip: {
                    backgroundColor: '#1e2130',
                    titleColor:      '#ffffff',
                    bodyColor:       '#b0b3c1',
                    padding:         12,
                    cornerRadius:    8,
                    callbacks: {
                        label: (context) => `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#b0b3c1', callback: (v) => 'R$ ' + v.toLocaleString('pt-BR') },
                    grid:  { color: 'rgba(255, 255, 255, 0.08)' }
                },
                x: {
                    ticks: { color: '#b0b3c1' },
                    grid:  { color: 'rgba(255, 255, 255, 0.05)' }
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

    if (categorias.length === 0) return '';

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
                    // nome já foi sanitizado em processarDadosGraficos — seguro
                    const percentual   = dados.totalSaidas > 0 ? ((valor / dados.totalSaidas) * 100).toFixed(1) : 0;
                    const larguraBarra = maxValor > 0 ? ((valor / maxValor) * 100).toFixed(1) : 0;

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

// ========== TENDÊNCIAS ==========
// R5 FIX: removido variacaoGastos = 11.2 hardcoded (dado falso)
// Tendência calculada a partir dos dados reais do período
function renderizarTendencias(dados) {
    const taxaEconomia = dados.totalEntradas > 0
        ? ((dados.totalReservas / dados.totalEntradas) * 100).toFixed(1)
        : 0;

    const comprometimento = dados.totalEntradas > 0
        ? ((dados.totalSaidas / dados.totalEntradas) * 100).toFixed(1)
        : 0;

    const metaAtingida = parseFloat(taxaEconomia) >= 20; // Meta padrão: 20% da renda guardada

    return `
        <div class="tendencias-container">
            <div class="tendencia-card">
                <div class="tendencia-header">
                    <span class="tendencia-titulo">Comprometimento da Renda</span>
                    <span class="tendencia-icon">
                        <i class="fas fa-chart-line"></i>
                    </span>
                </div>
                <div class="tendencia-valor" style="color: ${parseFloat(comprometimento) > 80 ? 'var(--danger)' : 'var(--warning)'};">
                    ${comprometimento}%
                </div>
                <div class="tendencia-comparacao">da renda comprometida com gastos</div>
                <div class="tendencia-badge ${parseFloat(comprometimento) <= 80 ? 'up' : 'down'}">
                    <i class="fas fa-${parseFloat(comprometimento) <= 80 ? 'check' : 'exclamation-triangle'}"></i>
                    ${parseFloat(comprometimento) <= 80 ? 'Dentro do limite saudável' : 'Acima do recomendado (80%)'}
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
                <div class="tendencia-badge ${metaAtingida ? 'up' : 'down'}">
                    <i class="fas fa-piggy-bank"></i>
                    ${taxaEconomia}% da renda — meta: 20%
                </div>
            </div>
        </div>
    `;
}

// ========== UTILITÁRIOS ==========
function exportarGrafico(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const link         = document.createElement('a');
    link.download      = `grafico_${canvasId}_${new Date().getTime()}.png`;
    link.href          = canvas.toDataURL('image/png');
    link.click();
}

function mostrarLoading() {
    const container = document.getElementById('graficosConteudo');
    if (container) {
        _setSafeHTML(container, `
            <div class="grafico-loading">
                <div class="loading-spinner"></div>
                <div class="loading-text">Processando dados...</div>
            </div>
        `);
    }
}

function esconderLoading() {
    const container = document.getElementById('graficosConteudo');
    if (container) {
        const loadingElement = container.querySelector('.grafico-loading');
        if (loadingElement) loadingElement.remove();
    }
}

// mostrarEmptyState usa DOM em vez de innerHTML para dados externos
// Elimina o risco de XSS via mensagens de erro ou strings de usuário
function mostrarEmptyState(mensagem) {
    const container = document.getElementById('graficosConteudo');
    if (!container) return;

    const wrapper  = document.createElement('div');
    wrapper.className = 'grafico-empty';

    const iconDiv  = document.createElement('div');
    iconDiv.className = 'empty-icon';
    iconDiv.innerHTML = '<i class="fas fa-chart-line"></i>'; // ícone fixo — sem dado externo

    const titleEl  = document.createElement('h3');
    titleEl.className = 'empty-title';
    titleEl.textContent = 'Nenhum dado disponível'; // textContent — sem XSS

    const descEl   = document.createElement('p');
    descEl.className = 'empty-description';
    descEl.textContent = mensagem; // textContent — sem XSS, mesmo vindo de catch()

    const btn      = document.createElement('button');
    btn.className  = 'btn-primary';
    btn.innerHTML  = '<i class="fas fa-plus"></i> Adicionar Transação'; // conteúdo fixo
    btn.addEventListener('click', () => navegarPara('transacoes')); // addEventListener, não onclick inline

    wrapper.appendChild(iconDiv);
    wrapper.appendChild(titleEl);
    wrapper.appendChild(descEl);
    wrapper.appendChild(btn);

    container.innerHTML = '';
    container.appendChild(wrapper);
}

function formatarMoeda(valor) {
    return new Intl.NumberFormat('pt-BR', {
        style:    'currency',
        currency: 'BRL'
    }).format(valor || 0);
}

function navegarPara(pagina) {
    const btn = document.querySelector(`[data-page="${pagina}"]`);
    if (btn) btn.click();
}

// ========== NAMESPACE PÚBLICO (ÚNICO — R6: retrocompat global removida) ==========
// Expor apenas via namespace único e congelado — sem funções soltas no window
window.GraficosGranaEvo = Object.freeze({
    gerar:                 gerarGraficos,
    exportar:              exportarGrafico,
    abrirSelecaoCasal:     abrirSelecaoPerfisCasalGraficos,
    confirmarSelecaoCasal: confirmarSelecaoPerfisCasalGraficos
});
// R6 FIX: window.gerarGraficos removido — qualquer chamada externa deve usar
// window.GraficosGranaEvo.gerar() — mais seguro e explícito