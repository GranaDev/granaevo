/* ==============================================
   GRANAEVO - DASHBOARD.JS COMPLETO
   Todas as funcionalidades separadas do HTML
   ============================================== */

// ========== ESTADO GLOBAL E PERSISTÊNCIA ==========
let usuarioAtual = { 
    usuario: 'Admin', 
    senha: '1234', 
    email: 'admin@granaevo.com', 
    foto: null 
};

let usuarioLogado = {
    nome: "Fulano",
    plano: "Casal",
    perfis: []
};

let perfilAtivo = null;
let cartoesCredito = [];
let nextCartaoId = 1;
let transacoes = [];
let metas = [];
let contasFixas = [];
let nextTransId = 1;
let nextMetaId = 1;
let nextContaFixaId = 1;
let metaSelecionadaId = null;
let tipoRelatorioAtivo = 'individual';

// Limites por plano
const limitesPlano = {
    "Individual": 1,
    "Casal": 2,
    "Família": 4
};

// ========== FUNÇÕES DE FORMATAÇÃO ==========
function formatBRL(v) { 
    return 'R$ ' + Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: 2, 
        maximumFractionDigits: 2
    }); 
}

function agoraDataHora() {
    const d = new Date();
    const data = d.toLocaleDateString('pt-BR');
    const hora = d.toLocaleTimeString('pt-BR', {hour12: false});
    return {data, hora};
}

function isoDate() { 
    return new Date().toISOString().slice(0, 10); 
}

function yearMonthKey(dateObjOrYYYYMM) {
    if(typeof dateObjOrYYYYMM === 'string') {
        if(dateObjOrYYYYMM.length === 7) return dateObjOrYYYYMM;
        return dateObjOrYYYYMM.slice(0, 7);
    }
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function dataParaISO(dataBR) {
    const partes = dataBR.split('/');
    if(partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
}

function formatarDataBR(dataISO) {
    if(!dataISO) return '';
    const [y, m, d] = dataISO.split('-');
    return `${d}/${m}/${y}`;
}

function getMesNome(mes) {
    const meses = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março', '04': 'Abril',
        '05': 'Maio', '06': 'Junho', '07': 'Julho', '08': 'Agosto',
        '09': 'Setembro', '10': 'Outubro', '11': 'Novembro', '12': 'Dezembro'
    };
    return meses[mes] || mes;
}

// ========== CARREGAR E SALVAR DADOS ==========
function carregarDados() {
    try {
        const u = JSON.parse(localStorage.getItem('granaevo_usuario') || 'null');
        if(u) usuarioAtual = u;
    } catch(e) {
        console.error('Erro carregarDados', e);
    }
}

function carregarPerfis() {
    try {
        const perfis = JSON.parse(localStorage.getItem('granaevo_perfis') || '[]');
        if(perfis.length > 0) {
            perfis.forEach((p, i) => {
                if (!p.id) p.id = i + 1;
            });
            usuarioLogado.perfis = perfis;
        } else {
            usuarioLogado.perfis = [{
                id: 1, 
                nome: usuarioAtual.usuario, 
                foto: usuarioAtual.foto
            }];
            localStorage.setItem('granaevo_perfis', JSON.stringify(usuarioLogado.perfis));
        }
    } catch(e) {
        console.error('Erro ao carregar perfis', e);
        usuarioLogado.perfis = [{
            id: 1, 
            nome: usuarioAtual.usuario, 
            foto: usuarioAtual.foto
        }];
    }
}

function carregarDadosPerfil(perfilId) {
    try {
        const chave = `granaevo_perfil_${perfilId}`;
        const dados = JSON.parse(localStorage.getItem(chave) || 'null');
        
        if(dados) {
            transacoes = dados.transacoes || [];
            metas = dados.metas || [];
            contasFixas = dados.contasFixas || [];
            cartoesCredito = dados.cartoesCredito || [];
            nextTransId = transacoes.reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
            nextMetaId = metas.reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
            nextContaFixaId = contasFixas.reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
            nextCartaoId = cartoesCredito.reduce((max, x) => Math.max(max, x.id || 0), 0) + 1;
        } else {
            transacoes = [];
            metas = [];
            contasFixas = [];
            cartoesCredito = [];
            nextTransId = 1;
            nextMetaId = 1;
            nextContaFixaId = 1;
            nextCartaoId = 1;
        }
    } catch(e) {
        console.error('Erro carregarDadosPerfil', e);
    }
}

function salvarDados() {
    localStorage.setItem('granaevo_usuario', JSON.stringify(usuarioAtual));
    localStorage.setItem('granaevo_perfis', JSON.stringify(usuarioLogado.perfis));
    if(perfilAtivo) {
        const chave = `granaevo_perfil_${perfilAtivo.id}`;
        const dados = {
            transacoes: transacoes,
            metas: metas,
            contasFixas: contasFixas,
            cartoesCredito: cartoesCredito
        };
        localStorage.setItem(chave, JSON.stringify(dados));
    }
}

// ========== VERIFICAÇÃO DE LOGIN ==========
function verificarLogin() {
    const session = AuthGuard.getUserData();
    const authLoading = document.getElementById('authLoading');
    
    if (!session) {
        if(authLoading) authLoading.style.display = 'none';
        window.location.href = 'login.html';
        return;
    }
    usuarioLogado.nome = session.name;
    usuarioLogado.plano = session.plan;  // ❌ Busca do sessionStorage temporário

    carregarPerfis();
    localStorage.removeItem('perfilAtivo');
    
    if(authLoading) authLoading.style.display = 'none';
    mostrarSelecaoPerfis();
}


// ========== SELEÇÃO DE PERFIS ==========
function mostrarSelecaoPerfis() {
    document.getElementById('selecaoPerfis').style.display = 'flex';
    document.getElementById('sidebar').style.display = 'none';
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    atualizarTelaPerfis();
    // Dentro de verificarLogin(), após atualizarTelaPerfis()
solicitarPermissaoNotificacoes();
}

function atualizarTelaPerfis() {
    const saudacao = document.getElementById('saudacaoPerfis');
    saudacao.innerHTML = `Olá <b>${usuarioLogado.nome}</b> - Plano <b>${usuarioLogado.plano}</b>`;
    
    const lista = document.getElementById('listaPerfis');
    lista.innerHTML = '';
    
    usuarioLogado.perfis.forEach((perfil, idx) => {
        const card = document.createElement('button');
        card.className = 'perfil-card';
        card.innerHTML = `
            <div class="perfil-foto">
                ${perfil.foto ? 
                    `<img src="${perfil.foto}" alt="${perfil.nome}">` : 
                    `<svg width="80" height="80" viewBox="0 0 24 24"><circle cx="12" cy="8" r="5" fill="#6c7a89"/><ellipse cx="12" cy="18" rx="7" ry="4" fill="#6c7a89"/></svg>`
                }
            </div>
            <div class="perfil-nome">${perfil.nome}</div>
        `;
        card.onclick = () => entrarNoPerfil(idx);
        lista.appendChild(card);
    });
    
    if(usuarioLogado.perfis.length < limitesPlano[usuarioLogado.plano]) {
        const addCard = document.createElement('button');
        addCard.className = 'perfil-card';
        addCard.innerHTML = `
            <div class="perfil-foto perfil-add">+</div>
            <div class="perfil-nome">Adicionar novo usuário</div>
        `;
        addCard.onclick = adicionarNovoPerfil;
        lista.appendChild(addCard);
    } else {
        const addCard = document.createElement('button');
        addCard.className = 'perfil-card';
        addCard.innerHTML = `
            <div class="perfil-foto perfil-add">+</div>
            <div class="perfil-nome">Adicionar novo usuário</div>
        `;
        addCard.onclick = () => mostrarPopupLimite();
        lista.appendChild(addCard);
    }
}

function entrarNoPerfil(idx) {
    perfilAtivo = usuarioLogado.perfis[idx];
    localStorage.setItem('perfilAtivo', JSON.stringify(perfilAtivo));
    carregarDadosPerfil(perfilAtivo.id);
    atualizarNomeUsuario();
    atualizarTudo();
    document.getElementById('selecaoPerfis').style.display = 'none';
    document.getElementById('sidebar').style.display = 'flex';
    
    // Força scroll para o topo ANTES de mostrar a tela
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    
    mostrarTela('dashboard');
}

function adicionarNovoPerfil() {
    const plano = usuarioLogado.plano;
    if(plano === "Individual") {
        mostrarPopupLimite("Seu plano é Individual e só permite um perfil. Atualize seu plano para adicionar mais perfis.");
        return;
    }
    if(plano === "Casal" && usuarioLogado.perfis.length >= 2) {
        mostrarPopupLimite("Seu plano Casal permite apenas dois perfis. Atualize seu plano para adicionar mais perfis.");
        return;
    }
    if(plano === "Família" && usuarioLogado.perfis.length >= 4) {
        mostrarPopupLimite("Você atingiu a quantidade máxima de usuários do plano Família.");
        return;
    }
    
    const popup = criarPopup(`
        <h3>Novo Perfil</h3>
        <input type="text" id="novoPerfilNome" class="form-input" placeholder="Nome do usuário (obrigatório)">
        <input type="file" id="novoPerfilFoto" class="form-input" accept="image/*" style="padding:10px;"><br>
        <button class="btn-primary" id="criarPerfilBtn">Criar Perfil</button>
        <button class="btn-cancelar" id="cancelarPerfilBtn">Cancelar</button>
    `);
    
    document.getElementById('cancelarPerfilBtn').onclick = () => fecharPopup();
    document.getElementById('criarPerfilBtn').onclick = () => {
        const nome = document.getElementById('novoPerfilNome').value.trim();
        const fotoInput = document.getElementById('novoPerfilFoto');
        if(!nome) return alert("Digite o nome do usuário!");
        if(usuarioLogado.perfis.length >= limitesPlano[plano]) {
            mostrarPopupLimite();
            fecharPopup();
            return;
        }
        
        const novoId = usuarioLogado.perfis.length > 0 ? 
            Math.max(...usuarioLogado.perfis.map(p => p.id || 0)) + 1 : 1;
        
        if(fotoInput.files && fotoInput.files[0]) {
            const reader = new FileReader();
            reader.onload = function(e) {
                usuarioLogado.perfis.push({id: novoId, nome, foto: e.target.result});
                localStorage.setItem('granaevo_perfis', JSON.stringify(usuarioLogado.perfis));
                fecharPopup();
                atualizarTelaPerfis();
            };
            reader.readAsDataURL(fotoInput.files[0]);
        } else {
            usuarioLogado.perfis.push({id: novoId, nome, foto: null});
            localStorage.setItem('granaevo_perfis', JSON.stringify(usuarioLogado.perfis));
            fecharPopup();
            atualizarTelaPerfis();
        }
    };
}

function mostrarPopupLimite(msgCustom) {
    let msg = msgCustom || "";
    if(!msg) {
        if(usuarioLogado.plano === "Individual") 
            msg = "Infelizmente seu plano é Individual e só permite um perfil. Atualize seu plano para adicionar mais perfis.";
        else if(usuarioLogado.plano === "Casal") 
            msg = "Seu plano Casal permite apenas dois perfis. Atualize seu plano para adicionar mais perfis.";
        else 
            msg = "Você atingiu a quantidade máxima de usuários do seu plano.";
    }
    
    criarPopup(`
        <h3>🔒 Limite do Plano</h3>
        <p style="margin-bottom:24px; color: var(--text-secondary); line-height:1.6;">${msg}</p>
        
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
            <button class="btn-primary" onclick="irParaAtualizarPlano()" style="flex:1; min-width:150px; background:linear-gradient(135deg, #6c63ff, #5a52d5); box-shadow: 0 4px 15px rgba(108,99,255,0.4);">
                <span style="display:flex; align-items:center; justify-content:center; gap:8px;">
                    ⬆️ Atualizar Plano
                </span>
            </button>
            <button class="btn-cancelar" onclick="fecharPopup()" style="flex:1; min-width:120px;">
                Fechar
            </button>
        </div>
    `);
}

// ✅ NOVA FUNÇÃO: Redireciona para página de upgrade
function irParaAtualizarPlano() {
    fecharPopup();
    window.location.href = 'atualizarplano.html';
}

// Expor globalmente
window.irParaAtualizarPlano = irParaAtualizarPlano;

// ========== FUNÇÕES DE POPUP ==========
function criarPopup(html) {
    const overlay = document.getElementById('modalOverlay');
    const container = document.getElementById('modalContainer');
    
    overlay.classList.add('active');
    container.innerHTML = `<div class="popup">${html}</div>`;
    
    return container;
}

function fecharPopup() {
    const overlay = document.getElementById('modalOverlay');
    const container = document.getElementById('modalContainer');
    
    overlay.classList.remove('active');
    container.innerHTML = '';
}

// ========== NAVEGAÇÃO ENTRE TELAS ==========
function mostrarTela(tela) {
    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
    });
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const pageEl = document.getElementById(tela + 'Page');
    if(pageEl) {
        pageEl.style.display = 'block';
        pageEl.classList.add('active');
    }
    
    const navBtn = document.querySelector(`[data-page="${tela}"]`);
    if(navBtn) navBtn.classList.add('active');
    
    if(tela === 'reservas') renderMetasList();
    if(tela === 'relatorios') popularFiltrosRelatorio();
    if(tela === 'graficos') inicializarGraficos();
    if(tela === 'cartoes') atualizarTelaCartoes();
}

// ========== ATUALIZAR NOME E FOTO DO USUÁRIO ==========
function atualizarNomeUsuario() {
    const nome = perfilAtivo ? perfilAtivo.nome : usuarioAtual.usuario;
    
    const userNameEl = document.getElementById('userName');
    const welcomeNameEl = document.getElementById('welcomeName');
    
    if(userNameEl) userNameEl.textContent = nome;
    if(welcomeNameEl) welcomeNameEl.textContent = nome;
    
    const userPhotoEl = document.getElementById('userPhoto');
    if(userPhotoEl) {
        if(perfilAtivo && perfilAtivo.foto) {
            userPhotoEl.src = perfilAtivo.foto;
        } else if(usuarioAtual.foto) {
            userPhotoEl.src = usuarioAtual.foto;
        }
    }
}

function alterarFoto(event) {
    const file = event.target.files[0];
    if(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            if(perfilAtivo) {
                perfilAtivo.foto = e.target.result;
                const idx = usuarioLogado.perfis.findIndex(p => p.id === perfilAtivo.id);
                if(idx !== -1) {
                    usuarioLogado.perfis[idx].foto = e.target.result;
                }
                document.getElementById('userPhoto').src = e.target.result;
                localStorage.setItem('perfilAtivo', JSON.stringify(perfilAtivo));
                localStorage.setItem('granaevo_perfis', JSON.stringify(usuarioLogado.perfis));
            }
        };
        reader.readAsDataURL(file);
    }
}

// ========== DASHBOARD - RESUMO E CONTAS FIXAS ==========
function atualizarDashboardResumo() {
    let totalEntradas = 0, totalSaidas = 0, totalReservas = 0;
    
    transacoes.forEach(t => {
        if(t.categoria === 'entrada') {
            totalEntradas += Number(t.valor);
        }
        else if(t.categoria === 'saida') {
            totalSaidas += Number(t.valor);
        }
        else if(t.categoria === 'reserva') {
            // ✅ CORREÇÃO: Reserva APENAS remove do saldo, NÃO conta como saída
            totalReservas += Number(t.valor);
        }
        else if(t.categoria === 'retirada_reserva') {
            // ✅ Retirada DEVOLVE o dinheiro ao saldo
            totalReservas -= Number(t.valor);
        }
    });
    
    // ✅ Cálculo correto:
    // Saldo = Entradas - Saídas - Reservas (porque reserva tira do saldo disponível)
    const saldo = totalEntradas - totalSaidas - totalReservas;
    
    // ✅ Total de reservas acumulado (das metas)
    const totalReservasCalc = metas.reduce((s, m) => s + Number(m.saved || 0), 0);
    
    const entradasEl = document.getElementById('totalEntradas');
    const saidasEl = document.getElementById('totalSaidas');
    const saldoEl = document.getElementById('totalSaldo');
    const reservasEl = document.getElementById('totalReservas');
    
    if(entradasEl) entradasEl.textContent = formatBRL(totalEntradas);
    if(saidasEl) saidasEl.textContent = formatBRL(totalSaidas);
    if(saldoEl) saldoEl.textContent = formatBRL(saldo);
    if(reservasEl) reservasEl.textContent = formatBRL(totalReservasCalc);
}

// ========== SISTEMA DE NOTIFICAÇÕES DE VENCIMENTO ==========

// Solicitar permissão para notificações (executar ao carregar)
function solicitarPermissaoNotificacoes() {
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                sistemaLog.adicionar('INFO', 'Permissão de notificações concedida');
            }
        });
    }
}

// Enviar notificação nativa
function enviarNotificacaoNativa(titulo, mensagem, tipo = 'info') {
    if ("Notification" in window && Notification.permission === "granted") {
        const icone = tipo === 'urgente' ? '🚨' : tipo === 'alerta' ? '⚠️' : '💰';
        
        const notification = new Notification(`${icone} ${titulo}`, {
            body: mensagem,
            icon: 'https://cdn-icons-png.flaticon.com/512/4256/4256888.png',
            badge: 'https://cdn-icons-png.flaticon.com/512/4256/4256888.png',
            vibrate: [200, 100, 200],
            requireInteraction: tipo === 'urgente',
            tag: 'granaevo-' + Date.now()
        });

        notification.onclick = () => {
            window.focus();
            mostrarTela('dashboard');
            notification.close();
        };

        // Fecha automaticamente após 10 segundos
        setTimeout(() => notification.close(), 10000);
    }
}

// Verificar contas a vencer e vencidas
function verificarVencimentos() {
    if(!perfilAtivo || contasFixas.length === 0) return;
    
    const hoje = new Date();
    const hojeISO = hoje.toISOString().slice(0, 10);
    
    // Data daqui a 5 dias
    const em5Dias = new Date();
    em5Dias.setDate(hoje.getDate() + 5);
    const em5DiasISO = em5Dias.toISOString().slice(0, 10);
    
    let contasVencidas = [];
    let contasAVencer = [];
    
    contasFixas.forEach(conta => {
        if(conta.pago) return; // Ignora contas já pagas
        
        if(conta.vencimento < hojeISO) {
            contasVencidas.push(conta);
        } else if(conta.vencimento <= em5DiasISO && conta.vencimento >= hojeISO) {
            contasAVencer.push(conta);
        }
    });
    
    return {
        vencidas: contasVencidas,
        aVencer: contasAVencer,
        total: contasVencidas.length + contasAVencer.length
    };
}

// Exibir badge de alertas
function atualizarBadgeVencimentos() {
    const alertas = verificarVencimentos();
    if(!alertas) return;
    
    // Criar ou atualizar badge no botão de dashboard
    const dashboardBtn = document.querySelector('[data-page="dashboard"]');
    if(!dashboardBtn) return;
    
    // Remove badge existente
    const badgeExistente = dashboardBtn.querySelector('.badge-alerta');
    if(badgeExistente) badgeExistente.remove();
    
    if(alertas.total > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge-alerta';
        badge.textContent = alertas.total;
        badge.style.cssText = `
            position: absolute;
            top: 8px;
            right: 8px;
            background: ${alertas.vencidas.length > 0 ? '#ff4b4b' : '#ffd166'};
            color: white;
            font-size: 0.7rem;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 10px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            animation: pulseAlert 2s infinite;
        `;
        dashboardBtn.style.position = 'relative';
        dashboardBtn.appendChild(badge);
    }
}

// Mostrar painel de alertas na dashboard
function renderizarPainelAlertas() {
    const alertas = verificarVencimentos();
    if(!alertas || alertas.total === 0) return '';
    
    let html = `
        <div class="alertas-vencimento">
            <div class="alertas-header">
                <div class="alertas-icon">${alertas.vencidas.length > 0 ? '🚨' : '⚠️'}</div>
                <div class="alertas-title-group">
                    <h3>${alertas.vencidas.length > 0 ? 'Atenção! Contas Vencidas' : 'Contas Próximas do Vencimento'}</h3>
                    <p>${alertas.vencidas.length > 0 
                        ? `Você tem ${alertas.vencidas.length} conta(s) vencida(s)` 
                        : `${alertas.aVencer.length} conta(s) vencem nos próximos 5 dias`}
                    </p>
                </div>
            </div>
            
            <div class="alertas-grid">
    `;
    
    // Contas vencidas
    alertas.vencidas.forEach(conta => {
        const diasVencidos = Math.floor((new Date() - new Date(conta.vencimento)) / (1000 * 60 * 60 * 24));
        html += `
            <div class="alerta-card" onclick="abrirPopupPagarContaFixa(${conta.id})">
                <div class="alerta-header">
                    <div class="alerta-title">${conta.descricao}</div>
                    <span class="alerta-status vencido">❌ Vencida</span>
                </div>
                <div class="alerta-info">
                    <div><strong>Valor:</strong> ${formatBRL(conta.valor)}</div>
                    <div><strong>Vencimento:</strong> ${formatarDataBR(conta.vencimento)}</div>
                    <div style="color: #ff4b4b; font-weight: 600; margin-top: 6px;">
                        ⏰ Vencida há ${diasVencidos} dia(s)
                    </div>
                </div>
                <button class="alerta-btn" onclick="event.stopPropagation(); abrirPopupPagarContaFixa(${conta.id})">
                    💰 Pagar Agora
                </button>
            </div>
        `;
    });
    
    // Contas a vencer
    alertas.aVencer.forEach(conta => {
        const diasRestantes = Math.floor((new Date(conta.vencimento) - new Date()) / (1000 * 60 * 60 * 24));
        html += `
            <div class="alerta-card pendente" onclick="abrirContaFixaForm(${conta.id})">
                <div class="alerta-header">
                    <div class="alerta-title">${conta.descricao}</div>
                    <span class="alerta-status a-vencer">⏳ A Vencer</span>
                </div>
                <div class="alerta-info">
                    <div><strong>Valor:</strong> ${formatBRL(conta.valor)}</div>
                    <div><strong>Vencimento:</strong> ${formatarDataBR(conta.vencimento)}</div>
                    <div style="color: #ffd166; font-weight: 600; margin-top: 6px;">
                        ⏰ Vence em ${diasRestantes} dia(s)
                    </div>
                </div>
            </div>
        `;
    });
    
    html += `
            </div>
        </div>
    `;
    
    return html;
}

// Verificação automática e notificação
function verificacaoAutomaticaVencimentos() {
    const alertas = verificarVencimentos();
    if(!alertas) return;
    
    // Atualizar badge
    atualizarBadgeVencimentos();
    
    // Enviar notificações se houver contas
    if(alertas.vencidas.length > 0) {
        enviarNotificacaoNativa(
            `${alertas.vencidas.length} Conta(s) Vencida(s)!`,
            `Você tem contas vencidas que precisam de atenção urgente.`,
            'urgente'
        );
    } else if(alertas.aVencer.length > 0) {
        enviarNotificacaoNativa(
            `${alertas.aVencer.length} Conta(s) Vencendo em Breve`,
            `Algumas contas vencem nos próximos 5 dias. Prepare-se!`,
            'alerta'
        );
    }
}

// Adicionar animação de pulso
const styleAlertas = document.createElement('style');
styleAlertas.textContent = `
    @keyframes pulseAlert {
        0%, 100% {
            transform: scale(1);
            opacity: 1;
        }
        50% {
            transform: scale(1.1);
            opacity: 0.8;
        }
    }
`;
document.head.appendChild(styleAlertas);

function atualizarListaContasFixas() {
    const lista = document.getElementById('listaContasFixas');
    if(!lista) return;
    
    // Adicionar painel de alertas ANTES da lista
    const painelAlertas = renderizarPainelAlertas();
    
    lista.innerHTML = painelAlertas;
    
    if(contasFixas.length === 0) {
        lista.innerHTML += '<p class="empty-state">Nenhuma conta fixa cadastrada.</p>';
        return;
    }
    
    const hojeISO = new Date().toISOString().slice(0, 10);
    
    // Container para as contas
    const containerContas = document.createElement('div');
    containerContas.className = 'contas-grid';
    
    contasFixas.forEach(c => {
        let status = 'Pendente';
        let statusClass = 'status-pendente';
        
        if(c.pago) {
            status = 'Pago';
            statusClass = 'status-pago';
        } else if(c.vencimento < hojeISO) {
            status = 'Vencido';
            statusClass = 'status-vencido';
        }
        
        const div = document.createElement('div');
        div.className = 'conta-card';
        
        // Verificar se é fatura de cartão
        if(c.tipoContaFixa === 'fatura_cartao' && c.compras && c.compras.length > 0) {
            const totalCompras = c.compras.length;
            div.innerHTML = `
                <div class="conta-header">
                    <div class="conta-title">💳 ${c.descricao}</div>
                    <span class="conta-status ${statusClass}">${status}</span>
                </div>
                <div class="conta-info">
                    <div style="font-weight: 600; font-size: 1.1rem; color: var(--text-primary);">Valor: ${formatBRL(c.valor)}</div>
                    <div>Vencimento: ${formatarDataBR(c.vencimento)}</div>
                    <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 6px;">
                        📦 ${totalCompras} compra${totalCompras > 1 ? 's' : ''} nesta fatura
                    </div>
                </div>
                ${status !== 'Pago' ? `
                    <div class="conta-actions">
                        <button class="conta-btn" onclick="event.stopPropagation(); abrirPopupPagarContaFixa(${c.id})">Pagar Fatura</button>
                    </div>
                ` : ''}
            `;
        } else {
            // Conta fixa normal
            let parcelasInfo = '';
            if(c.totalParcelas && c.parcelaAtual) {
                parcelasInfo = `<div style="color: var(--warning); font-size: 0.85rem; margin-top: 4px;">Parcela: ${c.parcelaAtual}/${c.totalParcelas}</div>`;
            }
            
            div.innerHTML = `
                <div class="conta-header">
                    <div class="conta-title">${c.descricao}</div>
                    <span class="conta-status ${statusClass}">${status}</span>
                </div>
                <div class="conta-info">
                    <div>Valor: ${formatBRL(c.valor)}</div>
                    <div>Vencimento: ${formatarDataBR(c.vencimento)}</div>
                    ${parcelasInfo}
                </div>
                ${status !== 'Pago' ? `
                    <div class="conta-actions">
                        <button class="conta-btn" onclick="abrirPopupPagarContaFixa(${c.id})">Pagar</button>
                    </div>
                ` : ''}
            `;
        }
        
        div.onclick = (e) => {
            if(e.target.tagName === 'BUTTON') return;
            
            // Se for fatura de cartão, abrir visualização detalhada
            if(c.tipoContaFixa === 'fatura_cartao') {
                abrirVisualizacaoFatura(c.id);
            } else {
                abrirContaFixaForm(c.id);
            }
        };
        
        containerContas.appendChild(div);
    });
    
    lista.appendChild(containerContas);
}

function abrirContaFixaForm(editId = null) {
    if(editId === null) {
        criarPopup(`
            <h3>Nova Conta Fixa</h3>
            <input type="text" id="descContaFixa" class="form-input" placeholder="Descrição"><br>
            <input type="number" id="valorContaFixa" class="form-input" placeholder="Valor (R$)" step="0.01" min="0"><br>
            <label style="display:block; text-align:left; margin-top:10px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">📅 Data de Vencimento:</label>
            <input type="date" id="vencContaFixa" class="form-input"><br>
            <button class="btn-primary" id="okContaFixa">Salvar</button>
            <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
        `);
        
        document.getElementById('okContaFixa').onclick = () => {
            const desc = document.getElementById('descContaFixa').value.trim();
            const valorStr = document.getElementById('valorContaFixa').value;
            const venc = document.getElementById('vencContaFixa').value;
            
            if(!desc || !valorStr || !venc) return alert('Preencha todos os campos.');
            
            const valor = parseFloat(parseFloat(valorStr).toFixed(2));
            const id = nextContaFixaId++;
            
            contasFixas.push({ id, descricao: desc, valor, vencimento: venc, pago: false });
            salvarDados();
            atualizarListaContasFixas();
            fecharPopup();
        };
    } else {
        const conta = contasFixas.find(c => c.id === editId);
        if(!conta) return;
        
        criarPopup(`
            <h3>Editar Conta Fixa</h3>
            <input type="text" id="descContaFixa" class="form-input" value="${conta.descricao}"><br>
            <input type="number" id="valorContaFixa" class="form-input" value="${conta.valor}" step="0.01" min="0"><br>
            <input type="date" id="vencContaFixa" class="form-input" value="${conta.vencimento}"><br>
            <button class="btn-primary" id="salvarEditContaFixa">Salvar</button>
            <button class="btn-excluir" id="excluirContaFixa">Excluir</button>
            <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
        `);
        
        document.getElementById('salvarEditContaFixa').onclick = () => {
            const desc = document.getElementById('descContaFixa').value.trim();
            const valorStr = document.getElementById('valorContaFixa').value;
            const venc = document.getElementById('vencContaFixa').value;
            
            if(!desc || !valorStr || !venc) return alert('Preencha todos os campos.');
            
            conta.descricao = desc;
            conta.valor = parseFloat(parseFloat(valorStr).toFixed(2));
            conta.vencimento = venc;
            salvarDados();
            atualizarListaContasFixas();
            fecharPopup();
        };
        
        document.getElementById('excluirContaFixa').onclick = () => {
            if(confirm("Tem certeza que deseja excluir esta conta fixa?")) {
                contasFixas = contasFixas.filter(c => c.id !== editId);
                salvarDados();
                atualizarListaContasFixas();
                fecharPopup();
            }
        };
    }
}

function abrirPopupPagarContaFixa(id) {
    const conta = contasFixas.find(c => c.id === id);
    if(!conta) return;
    
    let valorDigitado = conta.valor;
    
    criarPopup(`
        <h3>Pagar Conta Fixa</h3>
        <div style="color: var(--text-secondary);">${conta.descricao}</div>
        <div style="margin-bottom:12px;">Valor: ${formatBRL(conta.valor)}</div>
        <div style="margin-bottom:12px;">Vencimento: ${formatarDataBR(conta.vencimento)}</div>
        <div style="color: var(--warning); margin-bottom:8px;">O valor está correto?</div>
        <button class="btn-primary" id="simValorCorreto">Sim</button>
        <button class="btn-warning" id="naoValorCorreto">Não</button>
        <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
        <div id="ajusteValorDiv" style="display:none; margin-top:14px;">
            <input type="number" id="novoValorContaFixa" class="form-input" value="${conta.valor}" step="0.01" min="0"><br>
            <button class="btn-primary" id="confirmNovoValor" style="margin-top:8px;">Confirmar novo valor</button>
        </div>
    `);
    
    document.getElementById('simValorCorreto').onclick = () => {
        pagarContaFixa(id, conta.valor);
        fecharPopup();
    };
    
    document.getElementById('naoValorCorreto').onclick = () => {
        document.getElementById('ajusteValorDiv').style.display = 'block';
        document.getElementById('simValorCorreto').disabled = true;
        document.getElementById('naoValorCorreto').disabled = true;
        
        document.getElementById('confirmNovoValor').onclick = () => {
            const valStr = document.getElementById('novoValorContaFixa').value;
            if(!valStr || isNaN(valStr) || Number(valStr) <= 0) return alert("Digite um valor válido!");
            valorDigitado = parseFloat(parseFloat(valStr).toFixed(2));
            
            if(confirm(`Confirma o pagamento de ${formatBRL(valorDigitado)}?`)) {
                pagarContaFixa(id, valorDigitado);
                fecharPopup();
            }
        };
    };
}

function pagarContaFixa(id, valorPago) {
    const conta = contasFixas.find(c => c.id === id);
    if(!conta) return;
    
    const dh = agoraDataHora();
    const idTrans = nextTransId++;
    
    transacoes.push({
        id: idTrans,
        categoria: 'saida',
        tipo: 'Conta Fixa',
        descricao: `${conta.descricao} (pagamento mensal)`,
        valor: valorPago,
        data: dh.data,
        hora: dh.hora,
        contaFixaId: id
    });
    
    // ✅ VERIFICAR SE É FATURA DE CARTÃO
    if(conta.tipoContaFixa === 'fatura_cartao' && conta.compras && conta.compras.length > 0) {
        let cartaoRef = cartoesCredito.find(c => c.id === conta.cartaoId);
        
        // ✅ ATUALIZAR PARCELAS DE TODAS AS COMPRAS DA FATURA
        conta.compras.forEach(compra => {
            if(compra.parcelaAtual <= compra.totalParcelas) {
                compra.parcelaAtual++;
                
                // ✅ REDUZIR VALOR USADO DO CARTÃO
                if(cartaoRef) {
                    cartaoRef.usado = (cartaoRef.usado || 0) - compra.valorParcela;
                    if(cartaoRef.usado < 0) cartaoRef.usado = 0;
                }
            }
        });
        
        // ✅ REMOVER COMPRAS QUE JÁ FORAM TOTALMENTE PAGAS
        conta.compras = conta.compras.filter(c => c.parcelaAtual <= c.totalParcelas);
        
        // ✅ SE NÃO HÁ MAIS COMPRAS, REMOVER FATURA
        if(conta.compras.length === 0) {
            contasFixas = contasFixas.filter(c => c.id !== id);
            salvarDados();
            atualizarTudo();
            alert("✅ Todas as parcelas pagas! Fatura quitada.");
            return;
        }
        
        // ✅ RECALCULAR VALOR TOTAL DA PRÓXIMA FATURA
        conta.valor = conta.compras.reduce((sum, c) => sum + c.valorParcela, 0);
        
        // ✅ ATUALIZAR VENCIMENTO PARA PRÓXIMO MÊS
        let [y, m, d] = conta.vencimento.split('-').map(Number);
        m++;
        if(m > 12) { m = 1; y++; }
        conta.vencimento = [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
        conta.pago = false;
        
        salvarDados();
        atualizarTudo();
        alert(`✅ Fatura paga! Próxima fatura: ${formatBRL(conta.valor)} em ${formatarDataBR(conta.vencimento)}`);
        return;
    }
    
    // ✅ CONTA FIXA NORMAL (NÃO É FATURA DE CARTÃO)
    if(conta.cartaoId && conta.totalParcelas && conta.parcelaAtual) {
        let cartaoRef = cartoesCredito.find(c => c.id === conta.cartaoId);
        if(cartaoRef) {
            cartaoRef.usado = (cartaoRef.usado || 0) - valorPago;
            if(cartaoRef.usado < 0) cartaoRef.usado = 0;
        }
        
        if(conta.parcelaAtual < conta.totalParcelas) {
            conta.parcelaAtual++;
            let [y, m, d] = conta.vencimento.split('-').map(Number);
            m++;
            if(m > 12) { m = 1; y++; }
            conta.vencimento = [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
            conta.pago = false;
        } else {
            contasFixas = contasFixas.filter(c => c.id !== conta.id);
        }
        
        salvarDados();
        atualizarTudo();
        alert("✅ Parcela paga! O lembrete foi atualizado.");
        return;
    }
    
    // ✅ CONTA FIXA RECORRENTE (SEM PARCELAS)
let [y, m, d] = conta.vencimento.split('-').map(Number);
m++;
if(m > 12) { m = 1; y++; }
conta.vencimento = [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
conta.pago = false; // ❌ PROBLEMA: sempre marca como não pago

salvarDados();
atualizarTudo();
alert("✅ Pagamento realizado e vencimento atualizado para o próximo mês!");
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
        const metasExistentes = metas.filter(m => m.id !== 'emergency');
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
    const creditDiv = document.getElementById('creditoFields');
    const parcelasSelect = document.getElementById('selectParcelas');
    const cartaoSelect = document.getElementById('selectCartao');
    const catVal = document.getElementById('selectCategoria').value;
    
    if(parcelasSelect) {
        parcelasSelect.innerHTML = '';
        for(let i = 1; i <= 24; i++) {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `${String(i).padStart(2, '0')}x`;
            parcelasSelect.appendChild(opt);
        }
    }
    
    if(catVal === 'saida_credito') {
        creditDiv.style.display = 'flex';
        if(cartoesCredito.length === 0) {
            cartaoSelect.innerHTML = '<option value="">Cadastre um cartão no menu "Cartões"</option>';
            cartaoSelect.disabled = true;
        } else {
            cartaoSelect.innerHTML = '<option value="">Selecione o cartão</option>' +
                cartoesCredito.map(c => `<option value="${c.id}">${c.nomeBanco}</option>`).join('');
            cartaoSelect.disabled = false;
        }
    } else {
        creditDiv.style.display = 'none';
    }
}

function lancarTransacao() {
    const categoria = document.getElementById('selectCategoria').value;
    const tipo = document.getElementById('selectTipo').value;
    const descricao = document.getElementById('inputDescricao').value.trim();
    const valorStr = document.getElementById('inputValor').value;
    
    if(!categoria) return alert('Escolha Entrada, Saída ou Reserva.');
    if(categoria === 'reserva' && metas.filter(m => m.id !== 'emergency').length === 0) {
        return alert('Você ainda não criou nenhuma meta ou reserva, crie no menu "Reservas"');
    }
    if(!tipo && categoria !== 'saida_credito') return alert('Escolha o tipo.');
    if(!descricao) return alert('Digite a descrição.');
    if(!valorStr || isNaN(valorStr) || Number(valorStr) <= 0) return alert('Digite um valor válido.');
    
    const valor = parseFloat(parseFloat(valorStr).toFixed(2));
    const dh = agoraDataHora();
    
    if(categoria === 'saida_credito') {
    const cartaoSel = document.getElementById('selectCartao').value;
    const parcelasSel = Number(document.getElementById('selectParcelas').value);
    
    if(!cartaoSel) return alert("Selecione o cartão!");
    if(!parcelasSel) return alert("Selecione a quantidade de parcelas!");
    
    const cartao = cartoesCredito.find(c => String(c.id) === String(cartaoSel));
    if(!cartao) return alert("Cartão não encontrado!");
    
    let confirmMsg = `Compra de ${formatBRL(valor)} no cartão ${cartao.nomeBanco}, em ${parcelasSel}x de ${formatBRL(valor/parcelasSel)}.\nProsseguir?`;
    if(!confirm(confirmMsg)) return;
    
    // Calcular data da fatura
    let hoje = new Date();
    let anoAtual = hoje.getFullYear();
    let mesAtual = hoje.getMonth() + 1;
    let diaHoje = hoje.getDate();
    let diaFatura = cartao.vencimentoDia;
    
    let proxMes, proxAno;
    if(diaHoje >= diaFatura) {
        proxMes = mesAtual + 1;
        proxAno = anoAtual;
        if(proxMes > 12) { proxMes = 1; proxAno++; }
    } else {
        proxMes = mesAtual;
        proxAno = anoAtual;
    }
    
    let dataFaturaISO = `${proxAno}-${String(proxMes).padStart(2, '0')}-${String(diaFatura).padStart(2, '0')}`;
    
    // Verificar se já existe uma fatura para este cartão neste mês
    let faturaExistente = contasFixas.find(c => 
        c.cartaoId === cartao.id && 
        c.vencimento === dataFaturaISO &&
        c.tipoContaFixa === 'fatura_cartao'
    );
    
    // Criar objeto da compra
    const novaCompra = {
        id: Date.now(), // ID único para a compra
        tipo: tipo,
        descricao: descricao,
        valorTotal: valor,
        valorParcela: Number((valor/parcelasSel).toFixed(2)),
        totalParcelas: parcelasSel,
        parcelaAtual: 1,
        dataCompra: dh.data
    };
    
    if(faturaExistente) {
        // Adicionar compra à fatura existente
        if(!faturaExistente.compras) faturaExistente.compras = [];
        faturaExistente.compras.push(novaCompra);
        
        // Atualizar valor total da fatura
        faturaExistente.valor = faturaExistente.compras.reduce((sum, compra) => {
            return sum + compra.valorParcela;
        }, 0);
    } else {
        // Criar nova fatura para o cartão
        contasFixas.push({
            id: nextContaFixaId++,
            descricao: `Fatura ${cartao.nomeBanco}`,
            valor: Number((valor/parcelasSel).toFixed(2)),
            vencimento: dataFaturaISO,
            pago: false,
            cartaoId: cartao.id,
            tipoContaFixa: 'fatura_cartao',
            compras: [novaCompra]
        });
    }
    
    cartao.usado = (cartao.usado || 0) + valor;
    
    salvarDados();
    atualizarTudo();
    
    document.getElementById('selectCategoria').value = '';
    atualizarTiposDinamicos();
    document.getElementById('inputDescricao').value = '';
    document.getElementById('inputValor').value = '';
    
    alert("Compra lançada! A fatura do cartão foi atualizada.");
    return;
}
    
    let showTipo = tipo;
    let metaId = null;
    if(categoria === 'reserva') {
        if(tipo.startsWith('meta_')) {
            metaId = tipo.split('_')[1];
            showTipo = 'Reserva';
        }
    }
    
    criarPopup(`
        <h3>Comprovante</h3>
        <div class="small">Confirme antes de lançar</div>
        <div style="text-align:left; margin:20px 0; color: var(--text-secondary);">
            <b>Categoria:</b> ${categoria}<br>
            <b>Tipo:</b> ${showTipo}<br>
            <b>Descrição:</b> ${descricao}<br>
            <b>Valor:</b> ${formatBRL(valor)}<br>
            <b>Data:</b> ${dh.data}<br>
            <b>Hora:</b> ${dh.hora}
        </div>
        <button class="btn-primary" id="confirmBtn">Confirmar</button>
        <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
    `);
    
    document.getElementById('confirmBtn').onclick = () => {
        let metaIdInner = null;
        let tipoSalvo = tipo;
        if(categoria === 'reserva') {
            if(tipo.startsWith('meta_')) {
                metaIdInner = tipo.split('_')[1];
                tipoSalvo = 'Reserva';
            }
        }
        
        const id = nextTransId++;
        const t = {
            id,
            categoria,
            tipo: tipoSalvo,
            descricao,
            valor,
            data: dh.data,
            hora: dh.hora,
            metaId: metaIdInner
        };
        transacoes.push(t);
        
        if(categoria === 'reserva' && metaIdInner) {
            let meta = metas.find(m => String(m.id) === String(metaIdInner));
            if(meta) {
                meta.saved = Number((Number(meta.saved || 0) + Number(valor)).toFixed(2));
                const ym = yearMonthKey(isoDate());
                meta.monthly = meta.monthly || {};
                meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + Number(valor)).toFixed(2));
            }
        }
        
        salvarDados();
        atualizarTudo();
        fecharPopup();
        
        document.getElementById('selectCategoria').value = '';
        document.getElementById('selectTipo').innerHTML = '<option value="">Tipo</option>';
        document.getElementById('inputDescricao').value = '';
        document.getElementById('inputValor').value = '';
    };
}

function atualizarMovimentacoesUI() {
    const lista = document.getElementById('listaMovimentacoes');
    if(!lista) return;
    
    lista.innerHTML = '';
    
    if(transacoes.length === 0) {
        lista.innerHTML = '<p class="empty-state">Nenhuma movimentação registrada.</p>';
        return;
    }
    
    const arr = transacoes.slice().reverse();
    
    arr.forEach(t => {
        const div = document.createElement('div');
        div.className = 'mov-item';
        
        const left = document.createElement('div');
        left.className = 'mov-left';
        
        const styleClass = 
            t.categoria === 'entrada' ? 'entrada' : 
            t.categoria === 'saida' ? 'saida' : 
            t.categoria === 'reserva' ? 'reserva' : 
            'retirada_reserva'; // nova categoria
        
        left.innerHTML = `
            <div class="mov-tipo">${t.tipo}</div>
            <div class="mov-desc">${t.descricao}</div>
            <div class="mov-data">${t.data} ${t.hora}</div>
        `;
        
        const right = document.createElement('div');
        right.className = 'mov-right';
        right.innerHTML = `<div class="${styleClass}">${
            t.categoria === 'entrada' ? '+' : 
            t.categoria === 'retirada_reserva' ? '+' : 
            '-'
        } ${formatBRL(t.valor)}</div>`;
        
        div.appendChild(left);
        div.appendChild(right);
        div.onclick = () => abrirDetalhesTransacao(t.id);
        
        lista.appendChild(div);
    });
}

function abrirDetalhesTransacao(id) {
    const t = transacoes.find(x => x.id === id);
    if(!t) return;
    
    criarPopup(`
        <h3>Detalhes da Transação</h3>
        <div class="small">ID: ${t.id}</div>
        <div style="text-align:left; margin:20px 0; color: var(--text-secondary);">
            <b>Categoria:</b> ${t.categoria}<br>
            <b>Tipo:</b> ${t.tipo}<br>
            <b>Descrição:</b> ${t.descricao}<br>
            <b>Valor:</b> ${formatBRL(t.valor)}<br>
            <b>Data:</b> ${t.data}<br>
            <b>Hora:</b> ${t.hora}
        </div>
        <button class="btn-excluir" id="delTransBtn">Excluir</button>
        <button class="btn-primary" onclick="fecharPopup()">Fechar</button>
    `);
    
     document.getElementById('delTransBtn').onclick = () => {
        transacoes = transacoes.filter(x => x.id !== t.id);
        
        if(t.categoria === 'reserva' && t.metaId) {
            const meta = metas.find(m => String(m.id) === String(t.metaId));
            if(meta) {
                meta.saved = Number((Number(meta.saved || 0) - Number(t.valor)).toFixed(2));
                const ym = yearMonthKey(t.data);
                if(meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym]) - Number(t.valor)).toFixed(2));
                }
            }
        } else if(t.categoria === 'retirada_reserva' && t.metaId) {
            const meta = metas.find(m => String(m.id) === String(t.metaId));
            if(meta) {
                meta.saved = Number((Number(meta.saved || 0) + Number(t.valor)).toFixed(2));
                const ym = yearMonthKey(t.data);
                if(meta.monthly && meta.monthly[ym]) {
                    meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) + Number(t.valor)).toFixed(2));
                }
            }
        }
        
        salvarDados();
        atualizarTudo();
        fecharPopup();
    };
}

// ========== METAS/RESERVAS ==========
function abrirMetaForm(editId = null) {
    if(editId === null) {
        criarPopup(`
            <h3>Adicionar Meta</h3>
            <input id="metaDesc" class="form-input" placeholder="Descrição"><br>
            <input id="metaObj" class="form-input" placeholder="Valor objetivo (R$)" type="number" step="0.01" min="0"><br>
            <button class="btn-primary" id="okMeta">Concluir</button>
            <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
        `);
        
        document.getElementById('okMeta').onclick = () => {
            const desc = document.getElementById('metaDesc').value.trim();
            const objStr = document.getElementById('metaObj').value;
            if(!desc) return alert('Digite descrição da meta.');
            if(!objStr || isNaN(objStr) || Number(objStr) <= 0) return alert('Digite objetivo válido.');
            
            const objetivo = parseFloat(parseFloat(objStr).toFixed(2));
            const id = nextMetaId++;
            metas.push({ id, descricao: desc, objetivo, saved: 0, monthly: {} });
            salvarDados();
            renderMetasList();
            atualizarTudo();
            fecharPopup();
        };
    } else {
        const meta = metas.find(m => m.id === editId);
        if(!meta) return;
        
        criarPopup(`
            <h3>Editar Meta</h3>
            <input id="metaDesc" class="form-input" value="${meta.descricao}"><br>
            <input id="metaObj" class="form-input" value="${meta.objetivo}" type="number" step="0.01" min="0"><br>
            <button class="btn-primary" id="okMeta">Salvar</button>
            <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
        `);
        
        document.getElementById('okMeta').onclick = () => {
            const desc = document.getElementById('metaDesc').value.trim();
            const objStr = document.getElementById('metaObj').value;
            if(!desc) return alert('Digite descrição da meta.');
            if(!objStr || isNaN(objStr) || Number(objStr) <= 0) return alert('Digite objetivo válido.');
            
            meta.descricao = desc;
            meta.objetivo = parseFloat(parseFloat(objStr).toFixed(2));
            salvarDados();
            renderMetasList();
            atualizarTudo();
            fecharPopup();
        };
    }
}

function renderMetasList() {
    const cont = document.getElementById('listaMetas');
    if(!cont) return;
    
    cont.innerHTML = '';
    
    if(metas.length === 0) {
        cont.innerHTML = '<p class="empty-state">Nenhuma meta criada.</p>';
        return;
    }
    
    metas.forEach(m => {
    const div = document.createElement('div');
    div.className = 'meta-item';
    div.dataset.id = m.id;
    
    // Calcular progresso
    const saved = Number(m.saved || 0);
    const objetivo = Number(m.objetivo || 0);
    const percentual = objetivo > 0 ? Math.min(100, ((saved / objetivo) * 100).toFixed(1)) : 0;
    
    // Definir cor baseada no progresso
    let corProgresso = '#ff4b4b'; // Vermelho (0-30%)
    if(percentual >= 70) corProgresso = '#00ff99'; // Verde (70-100%)
    else if(percentual >= 40) corProgresso = '#ffd166'; // Amarelo (40-70%)
    
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
            <div style="flex:1;">
                <strong>${m.descricao}</strong>
                <div style="font-size:12px; color: var(--text-muted); margin-top:4px;">
                    ${formatBRL(saved)} de ${formatBRL(objetivo)}
                </div>
            </div>
            <div style="background:rgba(${percentual >= 70 ? '0,255,153' : percentual >= 40 ? '255,209,102' : '255,75,75'},0.2); 
                        padding:6px 12px; border-radius:20px; font-size:0.85rem; font-weight:700; 
                        color:${corProgresso}; white-space:nowrap;">
                ${percentual}%
            </div>
        </div>
        
        <!-- Barra de progresso inline -->
        <div style="width:100%; height:6px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden; margin-bottom:12px;">
            <div style="width:${percentual}%; height:100%; background:${corProgresso}; border-radius:10px; 
                        transition:width 0.5s ease; box-shadow:0 0 10px ${corProgresso};"></div>
        </div>
        
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="btn-primary" style="padding:6px 12px; font-size:0.85rem;" 
                            onclick="abrirMetaForm(${m.id}); event.stopPropagation();">✏️ Editar</button>
                    ${m.historicoRetiradas && m.historicoRetiradas.length > 0 ? `
                        <button class="btn-primary" style="padding:6px 12px; font-size:0.85rem; background: var(--accent);" 
                                onclick="abrirAnaliseDisciplina(${m.id}); event.stopPropagation();">📊 Análise</button>
                    ` : ''}
                    <button class="btn-excluir" style="padding:6px 12px; font-size:0.85rem;" 
                            onclick="removerMeta(${m.id}); event.stopPropagation();">🗑️ Excluir</button>
                </div>
            </div>
        `;
        
        div.onclick = () => {
            document.querySelectorAll('.meta-item').forEach(x => x.classList.remove('selected'));
            div.classList.add('selected');
            selecionarMeta(m.id);
        };
        
        cont.appendChild(div);
    });
}

function removerMeta(id) {
    if(!confirm('Remover meta? Isso também removerá os valores mensais associados.')) return;
    
    metas = metas.filter(m => m.id !== id);
    transacoes = transacoes.map(t => {
        if(t.metaId && String(t.metaId) === String(id)) {
            return Object.assign({}, t, { metaId: null });
        }
        return t;
    });
    
    salvarDados();
    renderMetasList();
    atualizarTudo();
    atualizarHeaderReservas();
}

function selecionarMeta(id) {
    metaSelecionadaId = id;
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
    
    if(!metaSelecionadaId) {
        details.innerHTML = '<div style="color: var(--text-secondary);">Selecione uma meta para ver detalhes e gráficos</div>';
        const progressEl = document.getElementById('metaProgress');
        if(progressEl) progressEl.textContent = 'Selecione uma meta';
        const btnRetirar = document.getElementById('btnRetirar');
        if(btnRetirar) btnRetirar.style.display = 'none';
        return;
    }
    
    const meta = metas.find(m => String(m.id) === String(metaSelecionadaId));
    if(!meta) {
        details.innerHTML = '<div style="color: var(--text-secondary);">Meta não encontrada</div>';
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
    
    // ✅ NOVO: Exibir detalhes com projeção
    details.innerHTML = `
        <div><strong>${meta.descricao}</strong></div>
        <div style="color: var(--text-secondary); margin-top:8px;">
            Objetivo: ${formatBRL(meta.objetivo)} • 
            Guardado: ${formatBRL(meta.saved)} • 
            Falta: ${formatBRL(Math.max(0, meta.objetivo - meta.saved))}
        </div>
        
        ${projecao.temHistorico ? `
            <div style="background: rgba(108,99,255,0.1); padding: 14px; border-radius: 12px; margin-top: 16px; border-left: 3px solid #6c63ff;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                    <div style="font-size: 1.8rem;">📊</div>
                    <div>
                        <div style="font-weight: 700; color: var(--text-primary); font-size: 1rem;">Projeção de Conclusão</div>
                        <div style="font-size: 0.85rem; color: var(--text-secondary);">Baseado no seu histórico de ${projecao.mesesComDados} ${projecao.mesesComDados === 1 ? 'mês' : 'meses'}</div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px;">
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px;">Média Mensal</div>
                        <div style="font-size: 1.1rem; font-weight: 700; color: #00ff99;">${formatBRL(projecao.mediaMensal)}</div>
                    </div>
                    
                    <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px;">Meses Restantes</div>
                        <div style="font-size: 1.1rem; font-weight: 700; color: #ffd166;">${projecao.mesesRestantes}</div>
                    </div>
                </div>
                
                <div style="background: rgba(108,99,255,0.2); padding: 12px; border-radius: 10px; margin-top: 12px; text-align: center;">
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 6px;">🎯 Data Estimada de Conclusão</div>
                    <div style="font-size: 1.3rem; font-weight: 700; color: #6c63ff;">${projecao.dataEstimada}</div>
                    ${projecao.avisoAjuste ? `
                        <div style="font-size: 0.8rem; color: #ffd166; margin-top: 8px; padding: 8px; background: rgba(255,209,102,0.1); border-radius: 6px;">
                            ⚠️ ${projecao.avisoAjuste}
                        </div>
                    ` : ''}
                </div>
                
                ${projecao.sugestao ? `
                    <div style="margin-top: 12px; padding: 10px; background: rgba(0,255,153,0.1); border-radius: 8px; border-left: 3px solid #00ff99;">
                        <div style="font-size: 0.85rem; color: var(--text-primary);">
                            <strong>💡 Sugestão:</strong> ${projecao.sugestao}
                        </div>
                    </div>
                ` : ''}
            </div>
        ` : `
            <div style="background: rgba(255,209,102,0.1); padding: 14px; border-radius: 12px; margin-top: 16px; border-left: 3px solid #ffd166;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="font-size: 1.5rem;">📊</div>
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Histórico Insuficiente</div>
                        <div style="font-size: 0.85rem; color: var(--text-secondary);">
                            Continue guardando por mais alguns meses para calcular a projeção de conclusão.
                        </div>
                    </div>
                </div>
            </div>
        `}
    `;
    
    line.onclick = function(ev){
        const rect = line.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        
        const ponto = (line._points || []).find(p => {
            const dx = p.x - mx, dy = p.y - my;
            return Math.sqrt(dx*dx + dy*dy) <= 8;
        });
        
        if(ponto) {
            alert(`Mês: ${ponto.month}\nValor guardado: ${formatBRL(ponto.v)}`);
        }
    };
}

function abrirRetiradaForm() {
    if(!metaSelecionadaId) return alert('Selecione uma meta primeiro.');
    
    const meta = metas.find(m => String(m.id) === String(metaSelecionadaId));
    if(!meta) return alert('Meta não encontrada.');
    
    const saldoDisponivel = Number(meta.saved || 0);
    if(saldoDisponivel <= 0) return alert('Não há saldo disponível nesta reserva para retirar.');
    
    criarPopup(`
        <h3>💸 Retirar Dinheiro</h3>
        <div class="small">Meta: ${meta.descricao}</div>
        <div style="margin-bottom:12px; color: var(--text-secondary);">
            Saldo disponível: ${formatBRL(saldoDisponivel)}
        </div>
        
        <label style="display:block; text-align:left; margin-top:12px; margin-bottom:6px; color: var(--text-secondary); font-weight:600;">
            💰 Valor a Retirar:
        </label>
        <input type="number" id="valorRetirada" class="form-input" 
               placeholder="Valor a retirar (R$)" step="0.01" min="0.01" max="${saldoDisponivel}"><br>
        
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
        <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
    `);
    
    // Listener para mostrar campo "Outro motivo"
    const selectMotivo = document.getElementById('motivoRetirada');
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
    
    document.getElementById('confirmarRetirada').onclick = () => {
        const valorStr = document.getElementById('valorRetirada').value;
        const motivoSelect = document.getElementById('motivoRetirada').value;
        const outroMotivoTexto = document.getElementById('outroMotivoTexto').value.trim();
        
        // Validações
        if(!valorStr || isNaN(valorStr) || Number(valorStr) <= 0) {
            return alert('Digite um valor válido.');
        }
        
        if(!motivoSelect) {
            return alert('⚠️ Por favor, selecione o motivo da retirada.');
        }
        
        if(motivoSelect === 'Outro' && !outroMotivoTexto) {
            return alert('⚠️ Por favor, descreva o motivo da retirada.');
        }
        
        const valorRetirar = parseFloat(parseFloat(valorStr).toFixed(2));
        
        if(valorRetirar > saldoDisponivel) {
            return alert('Valor maior que o saldo disponível!');
        }
        
        // Determinar motivo final
        const motivoFinal = motivoSelect === 'Outro' ? outroMotivoTexto : motivoSelect;
        
        // Processar retirada
        const dh = agoraDataHora();
        const id = nextTransId++;
        const tipoDesc = `Retirada: ${meta.descricao}`;
        
        const t = {
            id,
            categoria: 'retirada_reserva',
            tipo: 'Retirada de Reserva',
            descricao: tipoDesc,
            valor: valorRetirar,
            data: dh.data,
            hora: dh.hora,
            metaId: meta.id,
            motivoRetirada: motivoFinal // ✅ NOVO: Salvar motivo
        };
        transacoes.push(t);
        
        meta.saved = Number((Number(meta.saved || 0) - valorRetirar).toFixed(2));
        
        const ym = yearMonthKey(isoDate());
        meta.monthly = meta.monthly || {};
        meta.monthly[ym] = Number((Number(meta.monthly[ym] || 0) - valorRetirar).toFixed(2));
        if(meta.monthly[ym] < 0) meta.monthly[ym] = 0;
        
        // ✅ NOVO: Registrar estatística de retirada
        if(!meta.historicoRetiradas) meta.historicoRetiradas = [];
        meta.historicoRetiradas.push({
            data: dh.data,
            valor: valorRetirar,
            motivo: motivoFinal,
            saldoAnterior: saldoDisponivel,
            saldoPosterior: meta.saved
        });
        
        salvarDados();
        atualizarTudo();
        renderMetaVisual();
        fecharPopup();
        
        // Mensagem personalizada baseada no motivo
        let mensagemFinal = `Retirada de ${formatBRL(valorRetirar)} realizada com sucesso!\nO valor foi devolvido ao seu saldo.`;
        
        if(motivoFinal.includes('Emergência')) {
            mensagemFinal += '\n\n💙 Esperamos que tudo se resolva bem.';
        } else if(motivoFinal.includes('Investimento')) {
            mensagemFinal += '\n\n📈 Ótima escolha! Investir é construir seu futuro.';
        } else if(motivoFinal.includes('Dívida')) {
            mensagemFinal += '\n\n💪 Parabéns por priorizar a quitação de dívidas!';
        }
        
        alert(mensagemFinal);
    };
}

// ========== ANÁLISE DE DISCIPLINA FINANCEIRA NAS RETIRADAS ==========
function analisarDisciplinaRetiradas(metaId) {
    const meta = metas.find(m => String(m.id) === String(metaId));
    if(!meta || !meta.historicoRetiradas || meta.historicoRetiradas.length === 0) {
        return {
            temDados: false,
            mensagem: 'Nenhuma retirada registrada ainda.'
        };
    }
    
    const retiradas = meta.historicoRetiradas;
    const totalRetiradas = retiradas.length;
    const valorTotalRetirado = retiradas.reduce((sum, r) => sum + Number(r.valor), 0);
    
    // Contar por tipo de motivo
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
        const motivo = r.motivo;
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
    
    
    // Calcular porcentagens
    const percEmergencia = ((countEmergencia / totalRetiradas) * 100).toFixed(1);
    const percPlanejado = ((countPlanejado / totalRetiradas) * 100).toFixed(1);
    const percInvestimento = ((countInvestimento / totalRetiradas) * 100).toFixed(1);
    const percOutros = ((countOutros / totalRetiradas) * 100).toFixed(1);
    
    // Análise de disciplina
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
    const meta = metas.find(m => String(m.id) === String(metaId));
    if(!meta) return;
    
    const analise = analisarDisciplinaRetiradas(metaId);
    
    if(!analise.temDados) {
        criarPopup(`
            <h3>📊 Análise de Disciplina</h3>
            <div style="text-align:center; padding:40px;">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">📭</div>
                <div style="color: var(--text-secondary);">${analise.mensagem}</div>
            </div>
            <button class="btn-primary" onclick="fecharPopup()">Fechar</button>
        `);
        return;
    }
    
    criarPopup(`
        <div style="max-height:70vh; overflow-y:auto; padding-right:10px;">
            <h3 style="text-align:center; margin-bottom:8px;">📊 Análise de Disciplina Financeira</h3>
            <div style="text-align:center; color: var(--text-secondary); margin-bottom:20px; font-size:0.9rem;">
                Meta: ${meta.descricao}
            </div>
            
            <!-- Nível de Disciplina -->
            <div style="background: linear-gradient(135deg, ${analise.corDisciplina}20, ${analise.corDisciplina}10); 
                        padding: 20px; border-radius: 12px; margin-bottom: 20px; 
                        border-left: 4px solid ${analise.corDisciplina}; text-align: center;">
                <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px;">Nível de Disciplina</div>
                <div style="font-size: 1.8rem; font-weight: 700; color: ${analise.corDisciplina}; margin-bottom: 12px;">
                    ${analise.nivelDisciplina}
                </div>
                <div style="font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5;">
                    ${analise.mensagemDisciplina}
                </div>
            </div>
            
            <!-- Estatísticas Gerais -->
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px;">
                <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 6px;">Total de Retiradas</div>
                    <div style="font-size: 1.5rem; font-weight: 700; color: var(--text-primary);">${analise.totalRetiradas}</div>
                </div>
                
                <div style="background: rgba(255,255,255,0.05); padding: 14px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 6px;">Valor Total Retirado</div>
                    <div style="font-size: 1.5rem; font-weight: 700; color: #ff4b4b;">${formatBRL(analise.valorTotalRetirado)}</div>
                </div>
            </div>
            
            <!-- Distribuição por Motivo -->
            <div style="margin-bottom: 20px;">
                <h4 style="margin-bottom: 12px; color: var(--text-primary);">📋 Distribuição por Motivo</h4>
                
                ${analise.distribuicao.emergencia.count > 0 ? `
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <span style="color: var(--text-primary);">🚨 Emergências</span>
                        <span style="color: var(--text-secondary);">${analise.distribuicao.emergencia.count} (${analise.distribuicao.emergencia.perc}%)</span>
                    </div>
                    <div style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden;">
                        <div style="width: ${analise.distribuicao.emergencia.perc}%; height: 100%; background: #ff4b4b; transition: width 0.5s;"></div>
                    </div>
                </div>
                ` : ''}
                
                ${analise.distribuicao.planejado.count > 0 ? `
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <span style="color: var(--text-primary);">🎯 Compras Planejadas</span>
                        <span style="color: var(--text-secondary);">${analise.distribuicao.planejado.count} (${analise.distribuicao.planejado.perc}%)</span>
                    </div>
                    <div style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden;">
                        <div style="width: ${analise.distribuicao.planejado.perc}%; height: 100%; background: #00ff99; transition: width 0.5s;"></div>
                    </div>
                </div>
                ` : ''}
                
                ${analise.distribuicao.investimento.count > 0 ? `
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <span style="color: var(--text-primary);">📈 Investimentos</span>
                        <span style="color: var(--text-secondary);">${analise.distribuicao.investimento.count} (${analise.distribuicao.investimento.perc}%)</span>
                    </div>
                    <div style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden;">
                        <div style="width: ${analise.distribuicao.investimento.perc}%; height: 100%; background: #6c63ff; transition: width 0.5s;"></div>
                    </div>
                </div>
                ` : ''}
                
                ${analise.distribuicao.outros.count > 0 ? `
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                        <span style="color: var(--text-primary);">📄 Outros</span>
                        <span style="color: var(--text-secondary);">${analise.distribuicao.outros.count} (${analise.distribuicao.outros.perc}%)</span>
                    </div>
                    <div style="width: 100%; height: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; overflow: hidden;">
                        <div style="width: ${analise.distribuicao.outros.perc}%; height: 100%; background: #ffd166; transition: width 0.5s;"></div>
                    </div>
                </div>
                ` : ''}
            </div>
            
            <!-- Última Retirada -->
            <div style="background: rgba(108,99,255,0.1); padding: 14px; border-radius: 12px; border-left: 3px solid #6c63ff;">
                <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">🕐 Última Retirada</div>
                <div style="display: grid; gap: 6px; font-size: 0.9rem; color: var(--text-secondary);">
                    <div><strong>Data:</strong> ${analise.ultimaRetirada.data}</div>
                    <div><strong>Valor:</strong> ${formatBRL(analise.ultimaRetirada.valor)}</div>
                    <div><strong>Motivo:</strong> ${analise.ultimaRetirada.motivo}</div>
                </div>
            </div>
            
            <!-- Histórico Completo de Retiradas -->
            <div style="margin-top: 20px;">
                <h4 style="margin-bottom: 12px; color: var(--text-primary);">📜 Histórico Completo</h4>
                <div style="max-height: 200px; overflow-y: auto;">
                    ${meta.historicoRetiradas.slice().reverse().map(r => `
                        <div style="background: rgba(255,255,255,0.03); padding: 10px; border-radius: 8px; margin-bottom: 8px; border-left: 2px solid var(--border);">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <span style="font-size: 0.85rem; color: var(--text-secondary);">${r.data}</span>
                                <span style="font-size: 0.9rem; font-weight: 600; color: #ff4b4b;">${formatBRL(r.valor)}</span>
                            </div>
                            <div style="font-size: 0.85rem; color: var(--text-primary);">
                                <strong>Motivo:</strong> ${r.motivo}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
        
        <button class="btn-primary" onclick="fecharPopup()" style="width:100%; margin-top:16px;">Fechar</button>
    `);
}

// Expor função globalmente
window.abrirAnaliseDisciplina = abrirAnaliseDisciplina;

// ========== CARTÕES DE CRÉDITO ==========
function atualizarTelaCartoes() {
    const grid = document.getElementById('cartoesGrid');
    if(!grid) return;
    
    grid.innerHTML = '';
    
    cartoesCredito.forEach(c => {
        let disponivel = c.limite - (c.usado||0);
        let parcelasAtivas = contasFixas.filter(fx => fx.cartaoId === c.id && fx.totalParcelas);
        let parcelasRestantes = parcelasAtivas.reduce((sum,fx)=> 
            fx.totalParcelas ? sum + (fx.totalParcelas - fx.parcelaAtual + 1) : sum, 0);
        
        let card = document.createElement('div');
        card.className = 'cartao-cc';
        card.innerHTML = `
            ${c.bandeiraImg ? `<img src="${c.bandeiraImg}" class="cartao-bandeira" alt="${c.nomeBanco}">` : ''}
            <div class="cartao-cc-nome">${c.nomeBanco}</div>
            <div class="cartao-cc-limite">Limite: ${formatBRL(c.limite)}</div>
            <div class="cartao-cc-disponivel">Disponível: ${formatBRL(disponivel)}</div>
            ${parcelasRestantes > 0 ? `<div class="cartao-cc-parcelas">Parcelas a pagar: ${parcelasRestantes}</div>` : ''}
        `;
        card.onclick = () => abrirCartaoForm(c.id);
        grid.appendChild(card);
    });
    
    // Adiciona até 6 slots (cartões + botões adicionar)
    for(let i = cartoesCredito.length; i < 6; i++) {
        let btn = document.createElement('div');
        btn.className = 'cartao-cc-add';
        btn.innerHTML = '+';
        btn.onclick = () => abrirCartaoForm();
        grid.appendChild(btn);
    }
}

function abrirCartaoForm(editId = null) {
    const bancos = [
        {nome: 'Nubank', img: 'https://logospng.org/download/nubank/logo-roxo-nubank-icone.png'},
        {nome: 'Bradesco', img: 'https://logospng.org/download/bradesco/logo-bradesco-icon-256.png'},
        {nome: 'Mercado Pago', img: 'https://logospng.org/download/mercado-pago/logo-mercado-pago-icon.png'},
        {nome: 'C6 Bank', img: 'https://logospng.org/download/c6-bank/logo-c6-bank-icon.png'},
        {nome: 'Itaú', img: 'https://logospng.org/download/itau/logo-itau-icon.png'},
        {nome: 'Santander', img: 'https://logospng.org/download/santander/logo-santander-icon.png'},
        {nome: 'Banco do Brasil', img: 'https://logospng.org/download/banco-do-brasil/logo-banco-do-brasil-icon.png'},
        {nome: 'Caixa', img: 'https://logospng.org/download/caixa/logo-caixa-icon.png'},
        {nome: 'Outro', img: ''}
    ];
    
    let options = bancos.map(b => `<option value="${b.nome}">${b.nome}</option>`).join('');
    
    function diaOptions(selected) {
        let opts = '<option value="">Selecione o dia</option>';
        for(let i = 1; i <= 28; i++) {
            opts += `<option value="${i}" ${selected == i ? 'selected' : ''}>${i.toString().padStart(2, '0')}</option>`;
        }
        return opts;
    }
    
    if(!editId) {
        criarPopup(`
            <h3>Novo Cartão</h3>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Banco:</label>
            <select id="novoBanco" class="form-input">${options}</select><br>
            <div id="campoOutroCartao" style="display:none; margin-top:10px;">
                <label style="display:block; text-align:left; color: var(--text-secondary);">Nome do Cartão:</label>
                <input type="text" id="nomeOutroCartao" class="form-input" placeholder="Digite o nome do cartão"><br>
            </div>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Limite Total:</label>
            <input type="number" id="novoLimite" class="form-input" placeholder="Limite (R$)" step="0.01" min="1"><br>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Dia da Fatura:</label>
            <select id="novoVencimentoDia" class="form-input">${diaOptions()}</select><br>
            <button class="btn-primary" id="salvarNovoCartao">Salvar</button>
            <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
        `);
        
        // Listener para mostrar/ocultar campo "Outro"
        const selectBanco = document.getElementById('novoBanco');
        const campoOutro = document.getElementById('campoOutroCartao');
        const inputOutro = document.getElementById('nomeOutroCartao');
        
        selectBanco.addEventListener('change', function() {
            if(this.value === 'Outro') {
                campoOutro.style.display = 'block';
                inputOutro.required = true;
                inputOutro.focus();
            } else {
                campoOutro.style.display = 'none';
                inputOutro.required = false;
                inputOutro.value = '';
            }
        });
        
        document.getElementById('salvarNovoCartao').onclick = () => {
            let nomeBanco = document.getElementById('novoBanco').value;
            const limiteStr = document.getElementById('novoLimite').value;
            const vencimentoDia = document.getElementById('novoVencimentoDia').value;
            
            // Se selecionou "Outro", pega o nome digitado
            if(nomeBanco === 'Outro') {
                const nomeDigitado = document.getElementById('nomeOutroCartao').value.trim();
                if(!nomeDigitado) return alert("Digite o nome do cartão!");
                nomeBanco = nomeDigitado;
            }
            
            if(!nomeBanco || !limiteStr || !vencimentoDia) return alert("Preencha todos os campos!");
            
            const limite = parseFloat(limiteStr);
            const bandeiraImg = bancos.find(b => b.nome === nomeBanco)?.img || '';
            
            cartoesCredito.push({
                id: nextCartaoId++,
                nomeBanco,
                limite,
                vencimentoDia: Number(vencimentoDia),
                bandeiraImg,
                usado: 0
            });
            
            salvarDados();
            atualizarTelaCartoes();
            fecharPopup();
            if(typeof mostrarNotificacao === 'function') {
                mostrarNotificacao('Cartão cadastrado com sucesso!', 'success');
            } else {
                alert('Cartão cadastrado com sucesso!');
            }
        };
    } else {
        const c = cartoesCredito.find(x => x.id === editId);
        if(!c) return;
        
        criarPopup(`
            <h3>Editar Cartão</h3>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Banco:</label>
            <select id="novoBanco" class="form-input">${options}</select><br>
            <div id="campoOutroCartao" style="display:none; margin-top:10px;">
                <label style="display:block; text-align:left; color: var(--text-secondary);">Nome do Cartão:</label>
                <input type="text" id="nomeOutroCartao" class="form-input" placeholder="Digite o nome do cartão"><br>
            </div>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Limite Total:</label>
            <input type="number" id="novoLimite" class="form-input" value="${c.limite}" step="0.01" min="1"><br>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Dia da Fatura:</label>
            <select id="novoVencimentoDia" class="form-input">${diaOptions(c.vencimentoDia)}</select><br>
            <button class="btn-primary" id="salvarNovoCartao">Salvar</button>
            <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
            <button class="btn-excluir" id="excluirCartao">Excluir</button>
        `);
        
        // Verifica se o cartão atual é customizado
        const selectBanco = document.getElementById('novoBanco');
        const campoOutro = document.getElementById('campoOutroCartao');
        const inputOutro = document.getElementById('nomeOutroCartao');
        
        const bancoExiste = bancos.find(b => b.nome === c.nomeBanco && b.nome !== 'Outro');
        
        if(bancoExiste) {
            selectBanco.value = c.nomeBanco;
        } else {
            selectBanco.value = 'Outro';
            campoOutro.style.display = 'block';
            inputOutro.value = c.nomeBanco;
        }
        
        selectBanco.addEventListener('change', function() {
            if(this.value === 'Outro') {
                campoOutro.style.display = 'block';
                inputOutro.required = true;
                if(!inputOutro.value) inputOutro.focus();
            } else {
                campoOutro.style.display = 'none';
                inputOutro.required = false;
                inputOutro.value = '';
            }
        });
        
        document.getElementById('salvarNovoCartao').onclick = () => {
            let nomeBanco = document.getElementById('novoBanco').value;
            
            if(nomeBanco === 'Outro') {
                const nomeDigitado = document.getElementById('nomeOutroCartao').value.trim();
                if(!nomeDigitado) return alert("Digite o nome do cartão!");
                nomeBanco = nomeDigitado;
            }
            
            c.nomeBanco = nomeBanco;
            c.limite = parseFloat(document.getElementById('novoLimite').value);
            c.vencimentoDia = Number(document.getElementById('novoVencimentoDia').value);
            c.bandeiraImg = bancos.find(b => b.nome === nomeBanco)?.img || '';
            
            salvarDados();
            atualizarTelaCartoes();
            fecharPopup();
            if(typeof mostrarNotificacao === 'function') {
                mostrarNotificacao('Cartão atualizado com sucesso!', 'success');
            } else {
                alert('Cartão atualizado com sucesso!');
            }
        };
        
        document.getElementById('excluirCartao').onclick = () => {
            if(confirm("Excluir cartão? Todas as compras futuras vinculadas a ele serão removidas.")) {
                cartoesCredito = cartoesCredito.filter(x => x.id !== editId);
                contasFixas = contasFixas.filter(x => x.cartaoId !== editId);
                salvarDados();
                atualizarTelaCartoes();
                atualizarListaContasFixas();
                fecharPopup();
                if(typeof mostrarNotificacao === 'function') {
                    mostrarNotificacao('Cartão excluído com sucesso!', 'success');
                } else {
                    alert('Cartão excluído com sucesso!');
                }
            }
        };
    }
}

// ========== GRÁFICOS - ÁREA VAZIA PARA RECONSTRUÇÃO ==========

function inicializarGraficos() {
    console.log('📊 Menu de gráficos inicializado (vazio)');
}

function atualizarGraficos() {
    console.log('📊 Função atualizarGraficos() - Aguardando reconstrução');
}

function exportarGraficos() {
    mostrarNotificacao('Função de exportação será reconstruída', 'info');
}


// ========== RELATÓRIOS ==========
function popularFiltrosRelatorio() {
    const mesSelect = document.getElementById('mesRelatorio');
    const anoSelect = document.getElementById('anoRelatorio');
    const perfilSelect = document.getElementById('selectPerfilRelatorio');
    
    if(!mesSelect || !anoSelect || !perfilSelect) {
        console.error('Elementos de filtro não encontrados!');
        return;
    }
    
    // Limpar selects
    mesSelect.innerHTML = '<option value="">Selecione o mês</option>';
    anoSelect.innerHTML = '<option value="">Selecione o ano</option>';
    perfilSelect.innerHTML = '<option value="">Selecione o perfil</option>';
    
    // Popula seletor de perfis
    usuarioLogado.perfis.forEach(perfil => {
        const option = document.createElement('option');
        option.value = perfil.id;
        option.textContent = perfil.nome;
        if(perfilAtivo && perfil.id === perfilAtivo.id) {
            option.selected = true;
        }
        perfilSelect.appendChild(option);
    });
    
    // Coleta todos os períodos disponíveis
    const periodosDisponiveis = new Set();
    
    if(tipoRelatorioAtivo === 'individual') {
        transacoes.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(dataISO) {
                const anoMes = dataISO.slice(0, 7);
                periodosDisponiveis.add(anoMes);
            }
        });
    } else {
        usuarioLogado.perfis.forEach(perfil => {
            const chave = `granaevo_perfil_${perfil.id}`;
            const dados = JSON.parse(localStorage.getItem(chave) || 'null');
            if(dados && dados.transacoes) {
                dados.transacoes.forEach(t => {
                    const dataISO = dataParaISO(t.data);
                    if(dataISO) {
                        const anoMes = dataISO.slice(0, 7);
                        periodosDisponiveis.add(anoMes);
                    }
                });
            }
        });
    }
    
    if(periodosDisponiveis.size === 0) {
        const hoje = new Date();
        const anoAtual = hoje.getFullYear();
        const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
        periodosDisponiveis.add(`${anoAtual}-${mesAtual}`);
    }
    
    const meses = new Set();
    const anos = new Set();
    
    periodosDisponiveis.forEach(periodo => {
        const [ano, mes] = periodo.split('-');
        meses.add(mes);
        anos.add(ano);
    });
    
    const mesesNomes = {
        '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março', '04': 'Abril',
        '05': 'Maio', '06': 'Junho', '07': 'Julho', '08': 'Agosto',
        '09': 'Setembro', '10': 'Outubro', '11': 'Novembro', '12': 'Dezembro'
    };
    
    Array.from(meses).sort().forEach(mes => {
        const option = document.createElement('option');
        option.value = mes;
        option.textContent = mesesNomes[mes];
        mesSelect.appendChild(option);
    });
    
    Array.from(anos).sort().reverse().forEach(ano => {
        const option = document.createElement('option');
        option.value = ano;
        option.textContent = ano;
        anoSelect.appendChild(option);
    });
    
    // IMPORTANTE: Configurar os botões após popular os filtros
    setupBotoesRelatorio();
    
    console.log('Filtros de relatório populados. Tipo ativo:', tipoRelatorioAtivo);
}

function setupBotoesRelatorio() {
    const btnIndividual = document.querySelector('.tipo-relatorio-btns [data-tipo="individual"]');
    const btnCasal = document.querySelector('.tipo-relatorio-btns [data-tipo="casal"]');
    const btnFamilia = document.querySelector('.tipo-relatorio-btns [data-tipo="familia"]');
    const perfilSelector = document.getElementById('perfilSelectorDiv');
    
    if(!btnIndividual || !btnCasal || !btnFamilia || !perfilSelector) {
        console.error('Botões de relatório não encontrados!');
        return;
    }
    
    // CORREÇÃO: Remover listeners antigos antes de adicionar novos
    const newBtnIndividual = btnIndividual.cloneNode(true);
    const newBtnCasal = btnCasal.cloneNode(true);
    const newBtnFamilia = btnFamilia.cloneNode(true);
    
    btnIndividual.parentNode.replaceChild(newBtnIndividual, btnIndividual);
    btnCasal.parentNode.replaceChild(newBtnCasal, btnCasal);
    btnFamilia.parentNode.replaceChild(newBtnFamilia, btnFamilia);
    
    // Event listener para Individual
    newBtnIndividual.addEventListener('click', function() {
        console.log('Botão Individual clicado');
        tipoRelatorioAtivo = 'individual';
        newBtnIndividual.classList.add('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.remove('active');
        perfilSelector.classList.add('show');
        const resultado = document.getElementById('relatorioResultado');
        if(resultado) resultado.style.display = 'none';
        popularFiltrosRelatorio();
    });
    
    // Event listener para Casal
    newBtnCasal.addEventListener('click', function() {
        console.log('Botão Casal clicado');
        
        // Verificar se há pelo menos 2 perfis
        if(usuarioLogado.perfis.length < 2) {
            alert('Você precisa ter pelo menos 2 perfis cadastrados para gerar relatório de casal!');
            return;
        }
        
        tipoRelatorioAtivo = 'casal';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.add('active');
        newBtnFamilia.classList.remove('active');
        perfilSelector.classList.remove('show');
        
        const resultado = document.getElementById('relatorioResultado');
        if(resultado) resultado.style.display = 'none';
        
        popularFiltrosRelatorio();
    });
    
    // Event listener para Família
    newBtnFamilia.addEventListener('click', function() {
        console.log('Botão Família clicado');
        
        // Verificar se há pelo menos 2 perfis
        if(usuarioLogado.perfis.length < 2) {
            alert('Você precisa ter pelo menos 2 perfis para gerar relatório da família!');
            return;
        }
        
        tipoRelatorioAtivo = 'familia';
        newBtnIndividual.classList.remove('active');
        newBtnCasal.classList.remove('active');
        newBtnFamilia.classList.add('active');
        perfilSelector.classList.remove('show');
        
        const resultado = document.getElementById('relatorioResultado');
        if(resultado) resultado.style.display = 'none';
        
        popularFiltrosRelatorio();
    });
    
    console.log('Botões de relatório configurados com sucesso!');
}

function gerarRelatorio() {
    const mesEl = document.getElementById('mesRelatorio');
    const anoEl = document.getElementById('anoRelatorio');
    
    if(!mesEl || !anoEl) return;
    
    const mes = mesEl.value;
    const ano = anoEl.value;
    
    if(!mes || !ano) {
        return alert('Por favor, selecione o mês e o ano.');
    }
    
    if(tipoRelatorioAtivo === 'individual') {
        const perfilEl = document.getElementById('selectPerfilRelatorio');
        if(!perfilEl) return;
        
        const perfilId = perfilEl.value;
        if(!perfilId) {
            return alert('Por favor, selecione um perfil.');
        }
        gerarRelatorioIndividual(mes, ano, perfilId);
    } 
    else if(tipoRelatorioAtivo === 'casal') {
        // ✅ NOVO: Se for Família, permitir escolher os 2 perfis
        if(usuarioLogado.plano === 'Família' && usuarioLogado.perfis.length > 2) {
            abrirSelecaoPerfisCasal(mes, ano);
        } else {
            gerarRelatorioCompartilhado(mes, ano, 2);
        }
    } 
    else {
        gerarRelatorioCompartilhado(mes, ano, usuarioLogado.perfis.length);
    }
}

    // ========== SELEÇÃO DE PERFIS PARA RELATÓRIO CASAL (PLANO FAMÍLIA) ==========
function abrirSelecaoPerfisCasal(mes, ano) {
    let htmlPerfis = '';
    
    usuarioLogado.perfis.forEach(perfil => {
        htmlPerfis += `
            <div style="margin-bottom:12px;">
                <label style="display:flex; align-items:center; gap:10px; padding:12px; background:rgba(255,255,255,0.05); border-radius:10px; cursor:pointer; transition:all 0.3s;"
                       onmouseover="this.style.background='rgba(67,160,71,0.1)'" 
                       onmouseout="this.style.background='rgba(255,255,255,0.05)'">
                    <input type="checkbox" class="perfil-checkbox-casal" value="${perfil.id}" 
                           style="width:20px; height:20px; cursor:pointer; accent-color:var(--primary);">
                    <span style="font-weight:600; color: var(--text-primary);">${perfil.nome}</span>
                </label>
            </div>
        `;
    });
    
    criarPopup(`
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
        
        <button class="btn-primary" onclick="confirmarSelecaoPerfisCasal('${mes}', '${ano}')" style="width:100%; margin-bottom:10px;">
            Gerar Relatório
        </button>
        <button class="btn-cancelar" onclick="fecharPopup()" style="width:100%;">
            Cancelar
        </button>
    `);
}

function confirmarSelecaoPerfisCasal(mes, ano) {
    const checkboxes = document.querySelectorAll('.perfil-checkbox-casal:checked');
    const avisoEl = document.getElementById('avisoSelecao');
    
    if(checkboxes.length !== 2) {
        avisoEl.style.display = 'block';
        setTimeout(() => {
            avisoEl.style.display = 'none';
        }, 3000);
        return;
    }
    
    const perfisIds = Array.from(checkboxes).map(cb => cb.value);
    fecharPopup();
    
    // Gerar relatório APENAS com os 2 perfis selecionados
    gerarRelatorioCompartilhadoPersonalizado(mes, ano, perfisIds);
}

// Expor funções globalmente
window.abrirSelecaoPerfisCasal = abrirSelecaoPerfisCasal;
window.confirmarSelecaoPerfisCasal = confirmarSelecaoPerfisCasal;

// ========== GERAR RELATÓRIO CASAL PERSONALIZADO ==========
function gerarRelatorioCompartilhadoPersonalizado(mes, ano, perfisIds) {
    const periodoSelecionado = `${ano}-${mes}`;
    
    // Filtrar apenas os perfis selecionados
    const perfisAtivos = usuarioLogado.perfis.filter(p => perfisIds.includes(String(p.id)));
    
    if(perfisAtivos.length !== 2) {
        alert('Erro: É necessário selecionar exatamente 2 perfis.');
        return;
    }
    
    // Mesma lógica do gerarRelatorioCompartilhado, mas com perfis filtrados
    let mesAnterior, anoAnterior;
    if(mes === '01') {
        mesAnterior = '12';
        anoAnterior = String(Number(ano) - 1);
    } else {
        mesAnterior = String(Number(mes) - 1).padStart(2, '0');
        anoAnterior = ano;
    }
    const periodoAnterior = `${anoAnterior}-${mesAnterior}`;
    
    const dadosPorPerfil = perfisAtivos.map(perfil => {
        const chave = `granaevo_perfil_${perfil.id}`;
        const dadosPerfil = JSON.parse(localStorage.getItem(chave) || 'null');
        const transacoesPerfil = dadosPerfil ? dadosPerfil.transacoes || [] : [];
        const metasPerfil = dadosPerfil ? dadosPerfil.metas || [] : [];
        const cartoesPerfil = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
        
        const transacoesPeriodo = transacoesPerfil.filter(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO) return false;
            return dataISO.startsWith(periodoSelecionado);
        });
        
        const transacoesPeriodoAnterior = transacoesPerfil.filter(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO) return false;
            return dataISO.startsWith(periodoAnterior);
        });
        
        let saldoInicial = 0;
        transacoesPerfil.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO) return;
            
            if(dataISO < periodoSelecionado) {
                if(t.categoria === 'entrada') {
                    saldoInicial += Number(t.valor);
                }
                else if(t.categoria === 'saida') {
                    saldoInicial -= Number(t.valor);
                }
                else if(t.categoria === 'reserva') {
                    saldoInicial -= Number(t.valor);
                }
                else if(t.categoria === 'retirada_reserva') {
                    saldoInicial += Number(t.valor);
                }
            }
        });
        
        let entradas = 0, saidas = 0, totalGuardado = 0, totalRetirado = 0;
        const categorias = {};
        
        transacoesPerfil.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
            
            if(t.categoria === 'entrada') {
                entradas += Number(t.valor);
            } 
            else if(t.categoria === 'saida') {
                saidas += Number(t.valor);
                categorias[t.tipo] = (categorias[t.tipo] || 0) + Number(t.valor);
            } 
            else if(t.categoria === 'reserva') {
                totalGuardado += Number(t.valor);
                saidas += Number(t.valor);
            }
            else if(t.categoria === 'retirada_reserva') {
                totalRetirado += Number(t.valor);
                saidas -= Number(t.valor);
            }
        });
        
        const saldoDoMes = entradas - saidas;
        const saldoFinal = saldoInicial + saldoDoMes;
        
        let entradasAnt = 0, saidasAnt = 0, guardadoAnt = 0, retiradoAnt = 0;
        
        transacoesPerfil.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO || !dataISO.startsWith(periodoAnterior)) return;
            
            if(t.categoria === 'entrada') entradasAnt += Number(t.valor);
            else if(t.categoria === 'saida') saidasAnt += Number(t.valor);
            else if(t.categoria === 'reserva') {
                guardadoAnt += Number(t.valor);
                saidasAnt += Number(t.valor);
            }
            else if(t.categoria === 'retirada_reserva') {
                retiradoAnt += Number(t.valor);
                saidasAnt -= Number(t.valor);
            }
        });
        
        const reservasLiquido = totalGuardado - totalRetirado;
        const reservasLiquidoAnt = guardadoAnt - retiradoAnt;
        const taxaEconomia = entradas > 0 ? ((reservasLiquido / entradas) * 100) : 0;
        const taxaEconomiaAnt = entradasAnt > 0 ? ((reservasLiquidoAnt / entradasAnt) * 100) : 0;
        
        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            totalLimiteCartoes += Number(c.limite || 0);
            totalUsadoCartoes += Number(c.usado || 0);
        });
        
        return {
            perfil: perfil,
            entradas: entradas,
            saidas: saidas,
            reservas: reservasLiquido,
            totalGuardado: totalGuardado,
            totalRetirado: totalRetirado,
            saldoInicial: saldoInicial,
            saldoDoMes: saldoDoMes,
            saldo: saldoFinal,
            categorias: categorias,
            transacoes: transacoesPeriodo,
            metas: metasPerfil,
            cartoes: cartoesPerfil,
            totalLimiteCartoes: totalLimiteCartoes,
            totalUsadoCartoes: totalUsadoCartoes,
            mesAnterior: {
                entradas: entradasAnt,
                saidas: saidasAnt,
                reservas: reservasLiquidoAnt,
                saldo: entradasAnt - saidasAnt
            },
            taxaEconomia: taxaEconomia,
            taxaEconomiaAnterior: taxaEconomiaAnt,
            evolucaoEconomia: taxaEconomia - taxaEconomiaAnt
        };
    });
    
    const temDados = dadosPorPerfil.some(d => d.transacoes.length > 0);
    
    const resultado = document.getElementById('relatorioResultado');
    if(!resultado) return;
    
    if(!temDados) {
        resultado.innerHTML = `
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas para os perfis selecionados em ${getMesNome(mes)} de ${ano}</p>
                <p style="margin-top:12px; color: var(--text-muted);">
                    Perfis: ${perfisAtivos.map(p => p.nome).join(', ')}
                </p>
            </div>
        `;
        resultado.style.display = 'block';
        return;
    }
    
    // Renderizar usando a mesma função
    renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior);
}

// Expor globalmente
window.gerarRelatorioCompartilhadoPersonalizado = gerarRelatorioCompartilhadoPersonalizado;

function gerarRelatorioIndividual(mes, ano, perfilId) {
    const chave = `granaevo_perfil_${perfilId}`;
    const dadosPerfil = JSON.parse(localStorage.getItem(chave) || 'null');
    const transacoesPerfil = dadosPerfil ? dadosPerfil.transacoes || [] : [];
    const metasPerfil = dadosPerfil ? dadosPerfil.metas || [] : [];
    const cartoesPerfil = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
    const contasFixasPerfil = dadosPerfil ? dadosPerfil.contasFixas || [] : [];
    
    const periodoSelecionado = `${ano}-${mes}`;
    
    // ✅ DECLARAÇÃO ÚNICA DE hojeISO NO INÍCIO
    const hojeISO = new Date().toISOString().slice(0, 10);
    
    // Filtrar transações E excluir retiradas de reserva
    const transacoesPeriodo = transacoesPerfil.filter(t => {
        const dataISO = dataParaISO(t.data);
        if(!dataISO) return false;
        if(t.categoria === 'retirada_reserva') return false;
        return dataISO.startsWith(periodoSelecionado);
    });
    
    // ✅ CALCULAR SALDO INICIAL (até o mês anterior)
    let saldoInicial = 0;

    transacoesPerfil.forEach(t => {
        const dataISO = dataParaISO(t.data);
        if(!dataISO) return;
        
        if(dataISO < periodoSelecionado) {
            if(t.categoria === 'entrada') {
                saldoInicial += Number(t.valor);
            }
            else if(t.categoria === 'saida') {
                saldoInicial -= Number(t.valor);
            }
            else if(t.categoria === 'reserva') {
                saldoInicial -= Number(t.valor);
            }
            else if(t.categoria === 'retirada_reserva') {
                saldoInicial += Number(t.valor);
            }
        }
    });

    // ✅ CÁLCULOS DO MÊS ATUAL
    let totalEntradas = 0;
    let totalSaidas = 0;
    let totalGuardado = 0;
    let totalRetirado = 0;
    const categorias = {};
    const comprasCredito = [];

    transacoesPerfil.forEach(t => {
        const dataISO = dataParaISO(t.data);
        if(!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
        
        if(t.categoria === 'entrada') {
            totalEntradas += Number(t.valor);
        } 
        else if(t.categoria === 'saida') {
            totalSaidas += Number(t.valor);
            categorias[t.tipo] = (categorias[t.tipo] || 0) + Number(t.valor);
        } 
        else if(t.categoria === 'reserva') {
            totalGuardado += Number(t.valor);
        }
        else if(t.categoria === 'retirada_reserva') {
            totalRetirado += Number(t.valor);
        }
    });

    // ✅ CALCULAR SALDOS
    const valorReservadoLiquido = totalGuardado - totalRetirado;
    const saldoDoMes = totalEntradas - totalSaidas;
    const saldoFinal = saldoInicial + saldoDoMes - valorReservadoLiquido;

    // ✅ FILTRAR CONTAS FIXAS - VERSÃO CORRIGIDA COMPLETA
    const [anoAtual, mesAtual] = hojeISO.split('-').slice(0, 2);
    const periodoAtualCompleto = `${anoAtual}-${mesAtual}`;

    // ✅ NOVA LÓGICA: Buscar contas do mês + contas pagas no mês
    const contasFixasMes = contasFixasPerfil.filter(c => {
        if(!c.vencimento) return false;
        
        // 1️⃣ Contas com vencimento no mês selecionado
        if(c.vencimento.startsWith(periodoSelecionado)) return true;
        
        // 2️⃣ Contas pagas NESTE mês (mesmo com vencimento anterior)
        // Buscar transações de pagamento desta conta no período
        const pagamentoNoMes = transacoesPerfil.find(t => {
            const dataISO = dataParaISO(t.data);
            return dataISO && 
                   dataISO.startsWith(periodoSelecionado) && 
                   t.contaFixaId === c.id &&
                   t.tipo === 'Conta Fixa';
        });
        
        if(pagamentoNoMes) return true;
        
        // 3️⃣ Se estamos vendo o mês atual, incluir contas vencidas de meses anteriores (pendentes)
        if(periodoSelecionado === periodoAtualCompleto && c.vencimento < periodoSelecionado && !c.pago) {
            return true;
        }
        
        return false;
    });

    const taxaEconomia = totalEntradas > 0 ? ((valorReservadoLiquido / totalEntradas) * 100).toFixed(1) : 0;

    // Dias no mês
    const diasNoMes = new Date(ano, mes, 0).getDate();
    const mediaGastoDiario = totalSaidas / diasNoMes;
    
    const resultado = document.getElementById('relatorioResultado');
    if(!resultado) return;
    
    const perfilNome = usuarioLogado.perfis.find(p => p.id == perfilId)?.nome || 'Perfil';
    
    if(transacoesPeriodo.length === 0 && contasFixasMes.length === 0) {
        resultado.innerHTML = `
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações ou contas registradas para ${perfilNome} em ${getMesNome(mes)} de ${ano}</p>
            </div>
        `;
        resultado.style.display = 'block';
        return;
    }
    
    let html = `
    <h2 style="text-align:center; margin-bottom:30px;">
        Relatório Completo de ${perfilNome}<br>
        <span style="font-size:1.2rem; color: var(--text-secondary);">${getMesNome(mes)} de ${ano}</span>
    </h2>
    
    <!-- RESUMO PRINCIPAL COM ESTILO KPI -->
    <div class="relatorio-kpis-container">
        <div class="relatorio-kpis-scroll">
            <div class="relatorio-kpi-card relatorio-kpi-entradas">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💰</span>
                    <span class="relatorio-kpi-label">Entradas</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalEntradas)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Total do período</span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-saidas">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💸</span>
                    <span class="relatorio-kpi-label">Saídas</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalSaidas)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Total do período</span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-guardado">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">🎯</span>
                    <span class="relatorio-kpi-label">Guardado Líquido</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(valorReservadoLiquido)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period" style="font-size:10px;">
                        Guardou: ${formatBRL(totalGuardado)} | Retirou: ${formatBRL(totalRetirado)}
                    </span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-saldo">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">📈</span>
                    <span class="relatorio-kpi-label">Saldo Total</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(saldoFinal)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period" style="font-size:10px;">
                        Saldo inicial: ${formatBRL(saldoInicial)} | Saldo do mês: ${formatBRL(saldoDoMes)}
                    </span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-economia">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💎</span>
                    <span class="relatorio-kpi-label">Taxa de Economia</span>
                </div>
                <div class="relatorio-kpi-value">${taxaEconomia}%</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Do que ganhou foi guardado</span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-media">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">📅</span>
                    <span class="relatorio-kpi-label">Gasto Médio/Dia</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(mediaGastoDiario)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Média diária de gastos</span>
                </div>
            </div>
        </div>
    </div>
    `;
    
    // RANKING DE CATEGORIAS
    if(Object.keys(categorias).length > 0) {
        const categoriasOrdenadas = Object.entries(categorias)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        const totalGastoCategorias = Object.values(categorias).reduce((a, b) => a + b, 0);
        
        html += `
            <div class="section-box" style="margin-top:30px;">
                <h3 style="margin-bottom:20px; color: var(--text-primary);">🏆 Top 5 Categorias que Mais Gastou</h3>
                <div style="display:flex; flex-direction:column; gap:12px;">
        `;
        
        const coresCategorias = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];
        
        categoriasOrdenadas.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            const larguraBarra = percentual;
            
            html += `
                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                        <span style="font-weight:600; color: var(--text-primary);">${i+1}. ${cat}</span>
                        <span style="color: var(--text-secondary);">${formatBRL(valor)} (${percentual}%)</span>
                    </div>
                    <div style="width:100%; height:12px; background: rgba(255,255,255,0.1); border-radius:6px; overflow:hidden;">
                        <div style="width:${larguraBarra}%; height:100%; background:${coresCategorias[i]}; border-radius:6px; transition:width 0.5s;"></div>
                    </div>
                </div>
            `;
        });
        
        html += `</div></div>`;
    }
    
    // ANÁLISE DE CARTÕES
    if(cartoesPerfil.length > 0) {
        let totalLimiteCartoes = 0;
        let totalUsadoCartoes = 0;
        
        cartoesPerfil.forEach(c => {
            totalLimiteCartoes += Number(c.limite || 0);
            totalUsadoCartoes += Number(c.usado || 0);
        });
        
        const disponivelCartoes = totalLimiteCartoes - totalUsadoCartoes;
        const percUsado = totalLimiteCartoes > 0 ? ((totalUsadoCartoes / totalLimiteCartoes) * 100).toFixed(1) : 0;
        
        html += `
            <div class="section-box" style="margin-top:30px;">
                <h3 style="margin-bottom:20px; color: var(--text-primary);">💳 Análise de Cartões de Crédito</h3>
                
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:20px;">
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">Limite Total</div>
                        <div style="font-size:1.3rem; font-weight:700; color: var(--text-primary);">${formatBRL(totalLimiteCartoes)}</div>
                    </div>
                    
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">Usado no Mês</div>
                        <div style="font-size:1.3rem; font-weight:700; color: #ff4b4b;">${formatBRL(totalUsadoCartoes)}</div>
                    </div>
                    
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">Disponível</div>
                        <div style="font-size:1.3rem; font-weight:700; color: #00ff99;">${formatBRL(disponivelCartoes)}</div>
                    </div>
                    
                    <div style="background:rgba(255,255,255,0.05); padding:16px; border-radius:12px;">
                        <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">% Utilizado</div>
                        <div style="font-size:1.3rem; font-weight:700; color: ${percUsado > 80 ? '#ff4b4b' : '#00ff99'};">${percUsado}%</div>
                    </div>
                </div>
                
                <div style="margin-top:16px;">
                    <div style="font-weight:600; margin-bottom:12px; color: var(--text-primary);">Detalhes por Cartão:</div>
        `;
        
        cartoesPerfil.forEach(c => {
            const usado = Number(c.usado || 0);
            const limite = Number(c.limite || 0);
            const disponivel = limite - usado;
            const percCartao = limite > 0 ? ((usado / limite) * 100).toFixed(1) : 0;
            
            html += `
                <div style="background:rgba(255,255,255,0.03); padding:14px; border-radius:10px; margin-bottom:10px; border-left:3px solid ${percCartao > 80 ? '#ff4b4b' : '#00ff99'}; cursor:pointer; transition: all 0.3s;" 
                    onmouseover="this.style.background='rgba(255,255,255,0.08)'" 
                    onmouseout="this.style.background='rgba(255,255,255,0.03)'"
                    onclick="abrirDetalhesCartaoRelatorio(${c.id}, '${mes}', '${ano}', ${perfilId})">
                    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px;">
                        <div>
                            <div style="font-weight:600; color: var(--text-primary);">💳 ${c.nomeBanco}</div>
                            <div style="font-size:0.85rem; color: var(--text-secondary);">Limite: ${formatBRL(limite)}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:0.85rem; color: var(--text-secondary);">Usado: ${formatBRL(usado)}</div>
                            <div style="font-size:0.9rem; font-weight:600; color: ${percCartao > 80 ? '#ff4b4b' : '#00ff99'};">${percCartao}% utilizado</div>
                        </div>
                    </div>
                    <div style="text-align:center; margin-top:8px; font-size:0.75rem; color: var(--text-muted);">
                        👆 Clique para ver detalhes
                    </div>
                </div>
            `;
        });
        
        html += `</div></div>`;
    }
    
    // ANÁLISE DE METAS
    if(metasPerfil.length > 0) {
        html += `
            <div class="section-box" style="margin-top:30px;">
                <h3 style="margin-bottom:20px; color: var(--text-primary);">🎯 Progresso das Metas</h3>
                
                <div style="margin-bottom:16px;">
                    <label style="display:block; margin-bottom:8px; font-weight:600; color: var(--text-secondary);">Selecione uma meta para ver detalhes:</label>
                    <select id="selectMetaRelatorio" class="form-input" style="max-width:400px;">
                        <option value="">Escolha uma meta...</option>
        `;
        
        metasPerfil.forEach(m => {
            html += `<option value="${m.id}">${m.descricao}</option>`;
        });
        
        html += `
                    </select>
                </div>
                
                <div id="detalhesMetaRelatorio" style="display:none; margin-top:20px;">
                    <!-- Conteúdo será inserido dinamicamente -->
                </div>
            </div>
        `;
    }
    
    // ✅ CONTAS FIXAS DO MÊS - VERSÃO CORRIGIDA E SEMPRE VISÍVEL
    // Calcular status de cada conta considerando pagamentos
    const contasComStatus = contasFixasMes.map(c => {
        let status = 'Pendente';
        let corStatus = '#ffd166';
        let corFundo = 'rgba(255,209,102,0.1)';
        
        // Verificar se foi paga NESTE mês (mesmo com vencimento anterior)
        const pagamentoNoMes = transacoesPerfil.find(t => {
            const dataISO = dataParaISO(t.data);
            return dataISO && 
                   dataISO.startsWith(periodoSelecionado) && 
                   t.contaFixaId === c.id &&
                   t.tipo === 'Conta Fixa';
        });
        
        if(pagamentoNoMes || c.pago) {
            status = 'Paga';
            corStatus = '#00ff99';
            corFundo = 'rgba(0,255,153,0.1)';
        } else if(c.vencimento < hojeISO) {
            status = 'Vencida';
            corStatus = '#ff4b4b';
            corFundo = 'rgba(255,75,75,0.1)';
        }
        
        return { ...c, status, corStatus, corFundo };
    });

    // Contar por status
    const contasPagas = contasComStatus.filter(c => c.status === 'Paga').length;
    const contasPendentes = contasComStatus.filter(c => c.status === 'Pendente').length;
    const contasVencidas = contasComStatus.filter(c => c.status === 'Vencida').length;
    const totalContasValor = contasComStatus.reduce((sum, c) => sum + Number(c.valor), 0);

    // ✅ SEMPRE MOSTRAR O PAINEL (mesmo sem contas)
    html += `
        <div class="section-box" style="margin-top:30px;">
            <h3 style="margin-bottom:20px; color: var(--text-primary);">📋 Contas Fixas do Mês</h3>
            
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin-bottom:20px;">
                <div style="background:rgba(0,255,153,0.1); padding:12px; border-radius:10px; border-left:3px solid #00ff99;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">✅ Pagas</div>
                    <div style="font-size:1.5rem; font-weight:700; color: #00ff99;">${contasPagas}</div>
                </div>
                
                <div style="background:rgba(255,209,102,0.1); padding:12px; border-radius:10px; border-left:3px solid #ffd166;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">⏳ Pendentes</div>
                    <div style="font-size:1.5rem; font-weight:700; color: #ffd166;">${contasPendentes}</div>
                </div>
                
                <div style="background:rgba(255,75,75,0.1); padding:12px; border-radius:10px; border-left:3px solid #ff4b4b;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">❌ Vencidas</div>
                    <div style="font-size:1.5rem; font-weight:700; color: #ff4b4b;">${contasVencidas}</div>
                </div>
                
                <div style="background:rgba(255,255,255,0.05); padding:12px; border-radius:10px;">
                    <div style="font-size:0.85rem; color: var(--text-secondary);">💰 Valor Total</div>
                    <div style="font-size:1.5rem; font-weight:700; color: var(--text-primary);">${formatBRL(totalContasValor)}</div>
                </div>
            </div>
    `;

// ✅ NOVO: Mostrar contas SEPARADAS por status em colunas
if(contasComStatus.length > 0) {
    // Separar contas por status
    const pagas = contasComStatus.filter(c => c.status === 'Paga');
    const pendentes = contasComStatus.filter(c => c.status === 'Pendente');
    const vencidas = contasComStatus.filter(c => c.status === 'Vencida');
    
    html += `
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; align-items:start;">
            
            <!-- Coluna PAGAS -->
            <div style="display:flex; flex-direction:column; gap:12px;">
                ${pagas.length > 0 ? pagas.map(c => `
                    <div style="background:${c.corFundo}; padding:14px; border-radius:10px; border-left:3px solid ${c.corStatus};">
                        <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
                            <div style="font-weight:600; color: var(--text-primary); font-size:0.9rem;">${c.descricao}</div>
                        </div>
                        <div style="font-size:0.85rem; color: var(--text-secondary);">
                            Valor: <span style="font-weight:600; color: var(--text-primary);">${formatBRL(c.valor)}</span><br>
                            Vencimento: <span style="font-weight:600;">${formatarDataBR(c.vencimento)}</span>
                        </div>
                    </div>
                `).join('') : '<div style="text-align:center; padding:20px; color: var(--text-muted); font-size:0.85rem;">Nenhuma conta paga</div>'}
            </div>
            
            <!-- Coluna PENDENTES -->
            <div style="display:flex; flex-direction:column; gap:12px;">
                ${pendentes.length > 0 ? pendentes.map(c => `
                    <div style="background:${c.corFundo}; padding:14px; border-radius:10px; border-left:3px solid ${c.corStatus};">
                        <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
                            <div style="font-weight:600; color: var(--text-primary); font-size:0.9rem;">${c.descricao}</div>
                        </div>
                        <div style="font-size:0.85rem; color: var(--text-secondary);">
                            Valor: <span style="font-weight:600; color: var(--text-primary);">${formatBRL(c.valor)}</span><br>
                            Vencimento: <span style="font-weight:600;">${formatarDataBR(c.vencimento)}</span>
                        </div>
                    </div>
                `).join('') : '<div style="text-align:center; padding:20px; color: var(--text-muted); font-size:0.85rem;">Nenhuma conta pendente</div>'}
            </div>
            
            <!-- Coluna VENCIDAS -->
            <div style="display:flex; flex-direction:column; gap:12px;">
                ${vencidas.length > 0 ? vencidas.map(c => `
                    <div style="background:${c.corFundo}; padding:14px; border-radius:10px; border-left:3px solid ${c.corStatus};">
                        <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
                            <div style="font-weight:600; color: var(--text-primary); font-size:0.9rem;">${c.descricao}</div>
                        </div>
                        <div style="font-size:0.85rem; color: var(--text-secondary);">
                            Valor: <span style="font-weight:600; color: var(--text-primary);">${formatBRL(c.valor)}</span><br>
                            Vencimento: <span style="font-weight:600; color: #ff4b4b;">${formatarDataBR(c.vencimento)}</span><br>
                            <span style="color:#ff4b4b; font-weight:600; font-size:0.8rem;">⚠️ Atenção: Conta vencida!</span>
                        </div>
                    </div>
                `).join('') : '<div style="text-align:center; padding:20px; color: var(--text-muted); font-size:0.85rem;">Nenhuma conta vencida</div>'}
            </div>
            
            <!-- Coluna VAZIA (para manter grid 4 colunas) -->
            <div></div>
            
        </div>
    `;
} else {
    html += `
        <div style="text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px; border:2px dashed var(--border);">
            <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">🔭</div>
            <div style="font-size:1.1rem; font-weight:600; color: var(--text-primary); margin-bottom:8px;">
                Nenhuma Conta Fixa Registrada
            </div>
            <div style="font-size:0.9rem; color: var(--text-secondary);">
                ${periodoSelecionado === periodoAtualCompleto ? 
                    'Você não tem contas fixas para este mês. Cadastre no menu Dashboard!' : 
                    'Não há contas fixas registradas para este período.'}
            </div>
        </div>
    `;
}

html += `</div>`;
    
    // LISTA DE TRANSAÇÕES
    if(transacoesPeriodo.length > 0) {
        html += `
            <div class="relatorio-lista" style="margin-top:30px;">
                <h3>Todas as Transações (${transacoesPeriodo.length})</h3>
        `;
        
        transacoesPeriodo.sort((a, b) => {
            const dataHoraA = `${dataParaISO(a.data)} ${a.hora}`;
            const dataHoraB = `${dataParaISO(b.data)} ${b.hora}`;
            return dataHoraB.localeCompare(dataHoraA);
        });
        
        transacoesPeriodo.forEach(t => {
            let styleClass, sinal;
            
            if(t.categoria === 'entrada') {
                styleClass = 'entrada';
                sinal = '+';
            } else {
                styleClass = t.categoria === 'saida' ? 'saida' : 'reserva';
                sinal = '-';
            }
            
            html += `
                <div class="relatorio-item">
                    <div class="relatorio-item-info">
                        <div class="relatorio-item-tipo">${t.tipo}</div>
                        <div class="relatorio-item-desc">${t.descricao}</div>
                        <div class="relatorio-item-data">${t.data} às ${t.hora}</div>
                    </div>
                    <div class="${styleClass}" style="font-size:18px; font-weight:bold;">
                        ${sinal} ${formatBRL(t.valor)}
                    </div>
                </div>
            `;
        });
        
        html += `</div>`;
    }
    
    resultado.innerHTML = html;
    resultado.style.display = 'block';
    
    // CONFIGURAR SELETOR DE METAS
    if(metasPerfil.length > 0) {
        const selectMeta = document.getElementById('selectMetaRelatorio');
        if(selectMeta) {
            selectMeta.addEventListener('change', function() {
                const metaId = this.value;
                if(!metaId) {
                    document.getElementById('detalhesMetaRelatorio').style.display = 'none';
                    return;
                }
                
                const meta = metasPerfil.find(m => String(m.id) === String(metaId));
                if(!meta) return;
                
                const saved = Number(meta.saved || 0);
                const objetivo = Number(meta.objetivo || 0);
                const falta = Math.max(0, objetivo - saved);
                const perc = objetivo > 0 ? Math.min(100, ((saved / objetivo) * 100).toFixed(1)) : 0;
                
                // Calcular depósitos do mês
                const depositosMes = transacoesPerfil.filter(t => {
                    const dataISO = dataParaISO(t.data);
                    return dataISO && dataISO.startsWith(periodoSelecionado) && 
                           t.categoria === 'reserva' && String(t.metaId) === String(metaId);
                });

const totalDepositadoMes = depositosMes.reduce((sum, t) => sum + Number(t.valor), 0);

// Calcular retiradas do mês
const retiradasMes = transacoesPerfil.filter(t => {
    const dataISO = dataParaISO(t.data);
    return dataISO && dataISO.startsWith(periodoSelecionado) && 
           t.categoria === 'retirada_reserva' && String(t.metaId) === String(metaId);
});

const totalRetiradoMes = retiradasMes.reduce((sum, t) => sum + Number(t.valor), 0);

let corProgresso = '#ff4b4b';
if(perc >= 75) corProgresso = '#00ff99';
else if(perc >= 40) corProgresso = '#ffd166';

let htmlMeta = `
    <div style="background:rgba(255,255,255,0.05); padding:20px; border-radius:12px; border:1px solid var(--border);">
        <h4 style="margin-bottom:16px; font-size:1.2rem; color: var(--text-primary);">${meta.descricao}</h4>
        
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-bottom:20px;">
            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:4px;">Objetivo</div>
                <div style="font-size:1.2rem; font-weight:700; color: var(--text-primary);">${formatBRL(objetivo)}</div>
            </div>
            
            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:4px;">Guardado</div>
                <div style="font-size:1.2rem; font-weight:700; color: #00ff99;">${formatBRL(saved)}</div>
            </div>
            
            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:4px;">Falta</div>
                <div style="font-size:1.2rem; font-weight:700; color: #ff4b4b;">${formatBRL(falta)}</div>
            </div>
            
            <div style="text-align:center; padding:12px; background:rgba(255,255,255,0.03); border-radius:10px;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:4px;">Progresso</div>
                <div style="font-size:1.2rem; font-weight:700; color: ${corProgresso};">${perc}%</div>
            </div>
        </div>
        
        <div style="margin-bottom:20px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                <span style="font-weight:600; color: var(--text-secondary);">Barra de Progresso</span>
                <span style="font-weight:700; color: ${corProgresso};">${perc}%</span>
            </div>
            <div style="width:100%; height:20px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden;">
                <div style="width:${perc}%; height:100%; background:${corProgresso}; border-radius:10px; transition:width 0.8s; display:flex; align-items:center; justify-content:center; color:white; font-weight:700; font-size:0.85rem;">
                    ${perc > 10 ? perc + '%' : ''}
                </div>
            </div>
        </div>
        
        <!-- DEPÓSITOS DO MÊS -->
        <div style="background:rgba(255,209,102,0.1); padding:14px; border-radius:10px; border-left:3px solid #ffd166; margin-bottom:12px;">
            <div style="font-weight:600; color: var(--text-primary); margin-bottom:4px;">💰 Depositado neste mês</div>
            <div style="font-size:1.3rem; font-weight:700; color: #ffd166;">${formatBRL(totalDepositadoMes)}</div>
            <div style="font-size:0.85rem; color: var(--text-secondary); margin-top:4px;">${depositosMes.length} depósito(s) realizado(s)</div>
        </div>
        
        <!-- RETIRADAS DO MÊS (só aparece se houver retiradas) -->
        ${totalRetiradoMes > 0 ? `
        <div style="background:rgba(255,149,0,0.1); padding:14px; border-radius:10px; border-left:3px solid #ff9500;">
            <div style="font-weight:600; color: var(--text-primary); margin-bottom:4px;">💸 Retirado neste mês</div>
            <div style="font-size:1.3rem; font-weight:700; color: #ff9500;">${formatBRL(totalRetiradoMes)}</div>
            <div style="font-size:0.85rem; color: var(--text-secondary); margin-top:4px;">${retiradasMes.length} retirada(s) realizada(s)</div>
        </div>
        ` : ''}
    </div>
`;

                document.getElementById('detalhesMetaRelatorio').innerHTML = htmlMeta;
                document.getElementById('detalhesMetaRelatorio').style.display = 'block';
            });
        }
    }
}

function gerarRelatorioCompartilhado(mes, ano, numPerfis) {
    const periodoSelecionado = `${ano}-${mes}`;
    const perfisAtivos = usuarioLogado.perfis.slice(0, numPerfis);
    
    // ✅ CORREÇÃO: Validação de perfis
    if(perfisAtivos.length < 2) {
        const resultado = document.getElementById('relatorioResultado');
        if(resultado) {
            resultado.innerHTML = `
                <div class="relatorio-vazio">
                    <h3>⚠️ Perfis Insuficientes</h3>
                    <p>Você precisa ter pelo menos 2 perfis cadastrados para gerar este tipo de relatório.</p>
                    <p>Vá em Configurações > Trocar Perfil para adicionar mais usuários.</p>
                </div>
            `;
            resultado.style.display = 'block';
        }
        return;
    }
    
    // Calcula dados do mês anterior para comparação
    let mesAnterior, anoAnterior;
    if(mes === '01') {
        mesAnterior = '12';
        anoAnterior = String(Number(ano) - 1);
    } else {
        mesAnterior = String(Number(mes) - 1).padStart(2, '0');
        anoAnterior = ano;
    }
    const periodoAnterior = `${anoAnterior}-${mesAnterior}`;
    
    const dadosPorPerfil = perfisAtivos.map(perfil => {
        const chave = `granaevo_perfil_${perfil.id}`;
        const dadosPerfil = JSON.parse(localStorage.getItem(chave) || 'null');
        const transacoesPerfil = dadosPerfil ? dadosPerfil.transacoes || [] : [];
        const metasPerfil = dadosPerfil ? dadosPerfil.metas || [] : [];
        const cartoesPerfil = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
        
        // Filtrar transações do período atual
        const transacoesPeriodo = transacoesPerfil.filter(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO) return false;
            return dataISO.startsWith(periodoSelecionado);
        });
        
        // Filtrar transações do período anterior
        const transacoesPeriodoAnterior = transacoesPerfil.filter(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO) return false;
            return dataISO.startsWith(periodoAnterior);
        });
        
        // ✅ CALCULAR SALDO INICIAL (até o mês anterior)
        let saldoInicial = 0;

        transacoesPerfil.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO) return;
            
            if(dataISO < periodoSelecionado) {
                if(t.categoria === 'entrada') {
                    saldoInicial += Number(t.valor);
                }
                else if(t.categoria === 'saida') {
                    saldoInicial -= Number(t.valor);
                }
                else if(t.categoria === 'reserva') {
                    saldoInicial -= Number(t.valor);
                }
                else if(t.categoria === 'retirada_reserva') {
                    saldoInicial += Number(t.valor);
                }
            }
        });
        
        // ✅ CALCULAR DADOS DO MÊS ATUAL (CORRIGIDO)
        let entradas = 0, saidas = 0, totalGuardado = 0, totalRetirado = 0;
        const categorias = {};
        
        transacoesPerfil.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO || !dataISO.startsWith(periodoSelecionado)) return;
            
            if(t.categoria === 'entrada') {
                entradas += Number(t.valor);
            } 
            else if(t.categoria === 'saida') {
                saidas += Number(t.valor);
                categorias[t.tipo] = (categorias[t.tipo] || 0) + Number(t.valor);
            } 
            else if(t.categoria === 'reserva') {
                totalGuardado += Number(t.valor);
                saidas += Number(t.valor); // ✅ Impacta o saldo
            }
            else if(t.categoria === 'retirada_reserva') {
                totalRetirado += Number(t.valor);
                saidas -= Number(t.valor); // ✅ Compensa o impacto no saldo
            }
        });
        
        // ✅ CALCULAR SALDOS
        const saldoDoMes = entradas - saidas;
        const saldoFinal = saldoInicial + saldoDoMes;
        
        // Calcular dados do mês anterior
        let entradasAnt = 0, saidasAnt = 0, guardadoAnt = 0, retiradoAnt = 0;
        
        transacoesPerfil.forEach(t => {
            const dataISO = dataParaISO(t.data);
            if(!dataISO || !dataISO.startsWith(periodoAnterior)) return;
            
            if(t.categoria === 'entrada') entradasAnt += Number(t.valor);
            else if(t.categoria === 'saida') saidasAnt += Number(t.valor);
            else if(t.categoria === 'reserva') {
                guardadoAnt += Number(t.valor);
                saidasAnt += Number(t.valor);
            }
            else if(t.categoria === 'retirada_reserva') {
                retiradoAnt += Number(t.valor);
                saidasAnt -= Number(t.valor);
            }
        });
        
        const reservasLiquido = totalGuardado - totalRetirado;
        const reservasLiquidoAnt = guardadoAnt - retiradoAnt;
        const taxaEconomia = entradas > 0 ? ((reservasLiquido / entradas) * 100) : 0;
        const taxaEconomiaAnt = entradasAnt > 0 ? ((reservasLiquidoAnt / entradasAnt) * 100) : 0;
        
        // Calcular totais de cartões
        let totalLimiteCartoes = 0, totalUsadoCartoes = 0;
        cartoesPerfil.forEach(c => {
            totalLimiteCartoes += Number(c.limite || 0);
            totalUsadoCartoes += Number(c.usado || 0);
        });
        
        return {
            perfil: perfil,
            entradas: entradas,
            saidas: saidas,
            reservas: reservasLiquido,
            totalGuardado: totalGuardado,
            totalRetirado: totalRetirado,
            saldoInicial: saldoInicial,
            saldoDoMes: saldoDoMes,
            saldo: saldoFinal,
            categorias: categorias,
            transacoes: transacoesPeriodo,
            metas: metasPerfil,
            cartoes: cartoesPerfil,
            totalLimiteCartoes: totalLimiteCartoes,
            totalUsadoCartoes: totalUsadoCartoes,
            mesAnterior: {
                entradas: entradasAnt,
                saidas: saidasAnt,
                reservas: reservasLiquidoAnt,
                saldo: entradasAnt - saidasAnt
            },
            taxaEconomia: taxaEconomia,
            taxaEconomiaAnterior: taxaEconomiaAnt,
            evolucaoEconomia: taxaEconomia - taxaEconomiaAnt
        };
    });
    
    // ✅ VERIFICAÇÃO: Tem dados suficientes?
    const temDados = dadosPorPerfil.some(d => d.transacoes.length > 0);
    
    const resultado = document.getElementById('relatorioResultado');
    if(!resultado) return;
    
    if(!temDados) {
        const tipoTexto = tipoRelatorioAtivo === 'casal' ? 'do Casal' : 'da Família';
        resultado.innerHTML = `
            <div class="relatorio-vazio">
                <h3>📊 Nenhum relatório disponível</h3>
                <p>Não há transações registradas ${tipoTexto} em ${getMesNome(mes)} de ${ano}</p>
                <p style="margin-top:12px; color: var(--text-muted);">
                    Perfis verificados: ${perfisAtivos.map(p => p.nome).join(', ')}
                </p>
            </div>
        `;
        resultado.style.display = 'block';
        return;
    }
    
    // ✅ CHAMAR RENDERIZAÇÃO
    renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior);
}

function renderizarRelatorioCompartilhado(dadosPorPerfil, mes, ano, mesAnterior, anoAnterior) {
    const resultado = document.getElementById('relatorioResultado');
    if(!resultado) return;
    
    const tipoTexto = tipoRelatorioAtivo === 'casal' ? 'do Casal' : 'da Família';
    const icone = tipoRelatorioAtivo === 'casal' ? '💑' : '👨‍👩‍👧‍👦';
    
    let totalGeralEntradas = 0, totalGeralSaidas = 0, totalGeralReservasLiquido = 0;
    let totalGeralGuardado = 0, totalGeralRetirado = 0;
    const categoriasGerais = {};
    
    dadosPorPerfil.forEach(d => {
        totalGeralEntradas += d.entradas;
        totalGeralSaidas += d.saidas;
        totalGeralReservasLiquido += d.reservas;
        totalGeralGuardado += d.totalGuardado;
        totalGeralRetirado += d.totalRetirado;
        
        Object.keys(d.categorias).forEach(cat => {
            categoriasGerais[cat] = (categoriasGerais[cat] || 0) + d.categorias[cat];
        });
    });
    
    const saldoGeral = totalGeralEntradas - totalGeralSaidas;
    const taxaEconomiaGeral = totalGeralEntradas > 0 ? ((totalGeralReservasLiquido / totalGeralEntradas) * 100).toFixed(1) : 0;
    
    const categoriaTopArr = Object.entries(categoriasGerais).sort((a, b) => b[1] - a[1]);
    const categoriaTop = categoriaTopArr[0];
    const saldoInicialGeral = dadosPorPerfil.reduce((sum, d) => sum + (d.saldoInicial || 0), 0);
    const saldoGeralDoMes = dadosPorPerfil.reduce((sum, d) => sum + (d.saldoDoMes || 0), 0);
    
    let html = `
    <h2 style="text-align:center; margin-bottom:30px;">
        ${icone} Relatório Completo ${tipoTexto}<br>
        <span style="font-size:1.2rem; color: var(--text-secondary);">${getMesNome(mes)} de ${ano}</span>
    </h2>
    
    <!-- RESUMO GERAL COM ESTILO KPI -->
    <div class="relatorio-kpis-container">
        <div class="relatorio-kpis-scroll">
            <div class="relatorio-kpi-card relatorio-kpi-entradas">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💰</span>
                    <span class="relatorio-kpi-label">Entradas Totais</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalGeralEntradas)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Soma de todos os perfis</span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-saidas">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💸</span>
                    <span class="relatorio-kpi-label">Saídas Totais</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalGeralSaidas)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Soma de todos os perfis</span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-guardado">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">🎯</span>
                    <span class="relatorio-kpi-label">Guardado Líquido</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(totalGeralReservasLiquido)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period" style="font-size:10px;">
                        Guardou: ${formatBRL(totalGeralGuardado)} | Retirou: ${formatBRL(totalGeralRetirado)}
                    </span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-saldo">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">📈</span>
                    <span class="relatorio-kpi-label">Saldo Total</span>
                </div>
                <div class="relatorio-kpi-value">${formatBRL(saldoGeral)}</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period" style="font-size:10px;">
                        Saldo inicial: ${formatBRL(saldoInicialGeral)} | Saldo do mês: ${formatBRL(saldoGeralDoMes)}
                    </span>
                </div>
            </div>
            
            <div class="relatorio-kpi-card relatorio-kpi-economia">
                <div class="relatorio-kpi-header">
                    <span class="relatorio-kpi-icon">💎</span>
                    <span class="relatorio-kpi-label">Taxa de Economia</span>
                </div>
                <div class="relatorio-kpi-value">${taxaEconomiaGeral}%</div>
                <div class="relatorio-kpi-footer">
                    <span class="relatorio-kpi-period">Média ${tipoTexto.toLowerCase()}</span>
                </div>
            </div>
        </div>
    </div>
        
        <!-- MENU DE SELEÇÃO DE RANKINGS -->
        <div class="section-box" style="margin-top:30px;">
            <h3 style="text-align:center; margin-bottom:20px;">🏆 Rankings e Comparativos</h3>
            
            <div class="tipo-relatorio-btns" style="margin-bottom:24px;">
                <button class="tipo-btn ranking-btn active" data-ranking="gastos">
                    💸 Quem Gastou Mais
                </button>
                <button class="tipo-btn ranking-btn" data-ranking="guardou">
                    💰 Quem Guardou Mais
                </button>
                <button class="tipo-btn ranking-btn" data-ranking="economia">
                    📊 Melhor Taxa de Economia
                </button>
                <button class="tipo-btn ranking-btn" data-ranking="evolucao">
                    📈 Maior Evolução
                </button>
            </div>
            
            <div id="rankingContainer"></div>
        </div>
        
        <!-- COMPARAÇÃO DETALHADA POR PERFIL -->
        <div class="section-box" style="margin-top:30px;">
            <h3 style="text-align:center; margin-bottom:20px;">📋 Análise Individual Completa</h3>
            <div class="comparacao-perfis" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
    `;
    
    dadosPorPerfil.forEach(d => {
        const diasNoMes = new Date(ano, mes, 0).getDate();
        const mediaGastoDiario = d.saidas / diasNoMes;
        const percUsadoCartoes = d.totalLimiteCartoes > 0 ? 
            ((d.totalUsadoCartoes / d.totalLimiteCartoes) * 100).toFixed(1) : 0;
        
        // Calcular variações em relação ao mês anterior
        const variacaoEntradas = d.mesAnterior.entradas > 0 ? 
            (((d.entradas - d.mesAnterior.entradas) / d.mesAnterior.entradas) * 100).toFixed(1) : 0;
        const variacaoSaidas = d.mesAnterior.saidas > 0 ? 
            (((d.saidas - d.mesAnterior.saidas) / d.mesAnterior.saidas) * 100).toFixed(1) : 0;
        const variacaoReservas = d.mesAnterior.reservas !== 0 ? 
            (((d.reservas - d.mesAnterior.reservas) / Math.abs(d.mesAnterior.reservas)) * 100).toFixed(1) : 0;
        
        html += `
            <div class="perfil-card-relatorio" style="background: var(--gradient-dark); border: 1px solid var(--border); padding: 20px;">
                <h4 style="margin-bottom:16px; font-size:1.3rem; color: var(--primary);">${d.perfil.nome}</h4>
                
                <!-- Estatísticas Principais -->
                <div class="perfil-stats">
                    <div class="stat-row">
                        <span class="stat-label">💰 Entradas</span>
                        <span class="stat-value entrada">${formatBRL(d.entradas)}</span>
                    </div>
                    ${d.mesAnterior.entradas > 0 ? `
                    <div style="font-size:0.8rem; color: ${variacaoEntradas >= 0 ? '#00ff99' : '#ff4b4b'}; text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${variacaoEntradas >= 0 ? '↑' : '↓'} ${Math.abs(variacaoEntradas)}% vs mês anterior
                    </div>
                    ` : ''}
                    
                    <div class="stat-row">
                        <span class="stat-label">💸 Saídas</span>
                        <span class="stat-value saida">${formatBRL(d.saidas)}</span>
                    </div>
                    ${d.mesAnterior.saidas > 0 ? `
                    <div style="font-size:0.8rem; color: ${variacaoSaidas <= 0 ? '#00ff99' : '#ff4b4b'}; text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${variacaoSaidas >= 0 ? '↑' : '↓'} ${Math.abs(variacaoSaidas)}% vs mês anterior
                    </div>
                    ` : ''}
                    
                    <div class="stat-row">
                        <span class="stat-label">🎯 Guardado Líquido</span>
                        <span class="stat-value reserva">${formatBRL(d.reservas)}</span>
                    </div>
                    ${d.mesAnterior.reservas !== 0 ? `
                    <div style="font-size:0.8rem; color: ${variacaoReservas >= 0 ? '#00ff99' : '#ff4b4b'}; text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${variacaoReservas >= 0 ? '↑' : '↓'} ${Math.abs(variacaoReservas)}% vs mês anterior
                    </div>
                    ` : ''}
                    
                    <div class="stat-row">
                        <span class="stat-label">📊 Saldo</span>
                        <span class="stat-value" style="color:#6c63ff;">${formatBRL(d.saldo)}</span>
                    </div>
                    
                    <div class="stat-row">
                        <span class="stat-label">💎 Taxa de Economia</span>
                        <span class="stat-value" style="color:#00ff99;">${d.taxaEconomia.toFixed(1)}%</span>
                    </div>
                    ${d.taxaEconomiaAnterior > 0 ? `
                    <div style="font-size:0.8rem; color: ${d.evolucaoEconomia >= 0 ? '#00ff99' : '#ff4b4b'}; text-align:right; margin-top:-8px; margin-bottom:8px;">
                        ${d.evolucaoEconomia >= 0 ? '↑' : '↓'} ${Math.abs(d.evolucaoEconomia.toFixed(1))}% vs mês anterior
                    </div>
                    ` : ''}
                    
                    <div class="stat-row" style="border-top: 1px solid var(--border); padding-top:8px; margin-top:8px;">
                        <span class="stat-label">📅 Média Diária</span>
                        <span class="stat-value">${formatBRL(mediaGastoDiario)}</span>
                    </div>
                    
                    <div class="stat-row">
                        <span class="stat-label">📝 Transações</span>
                        <span class="stat-value">${d.transacoes.length}</span>
                    </div>
                    
                    ${d.cartoes.length > 0 ? `
                    <div class="stat-row" style="border-top: 1px solid var(--border); padding-top:8px; margin-top:8px;">
                        <span class="stat-label">💳 Cartões Usados</span>
                        <span class="stat-value" style="color: ${percUsadoCartoes > 80 ? '#ff4b4b' : '#00ff99'};">${percUsadoCartoes}%</span>
                    </div>
                    ` : ''}
                    
                    ${d.metas.length > 0 ? `
                    <div class="stat-row">
                        <span class="stat-label">🎯 Metas Ativas</span>
                        <span class="stat-value">${d.metas.length}</span>
                    </div>
                    ` : ''}
                </div>
                
                <!-- Botão para ver mais detalhes -->
                <button class="btn-primary" style="width:100%; margin-top:16px; padding:10px;" 
                        onclick="abrirDetalhesPerfilRelatorio('${d.perfil.id}', '${mes}', '${ano}')">
                    🔍 Ver Detalhes Completos
                </button>
            </div>
        `;
    });
    
    html += `</div></div>`;
    
    // GRÁFICO DE DISTRIBUIÇÃO DE GASTOS POR CATEGORIA (GERAL)
    if(Object.keys(categoriasGerais).length > 0) {
        const categoriasTop = Object.entries(categoriasGerais)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        const totalGastoCategorias = Object.values(categoriasGerais).reduce((a, b) => a + b, 0);
        
        html += `
            <div class="section-box" style="margin-top:30px;">
                <h3 style="margin-bottom:20px; color: var(--text-primary);">🎯 Top 5 Categorias Mais Gastas (Geral)</h3>
                <div style="display:flex; flex-direction:column; gap:12px;">
        `;
        
        const coresCategorias = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7'];
        
        categoriasTop.forEach(([cat, valor], i) => {
            const percentual = ((valor / totalGastoCategorias) * 100).toFixed(1);
            const larguraBarra = percentual;
            
            html += `
                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px; flex-wrap:wrap; gap:8px;">
                        <span style="font-weight:600; color: var(--text-primary);">${i+1}. ${cat}</span>
                        <span style="color: var(--text-secondary);">${formatBRL(valor)} (${percentual}%)</span>
                    </div>
                    <div style="width:100%; height:12px; background: rgba(255,255,255,0.1); border-radius:6px; overflow:hidden;">
                        <div style="width:${larguraBarra}%; height:100%; background:${coresCategorias[i]}; border-radius:6px; transition:width 0.5s;"></div>
                    </div>
                </div>
            `;
        });
        
        html += `</div></div>`;
    }
    
    resultado.innerHTML = html;
    resultado.style.display = 'block';
    
    // Configurar eventos dos botões de ranking
    configurarRankings(dadosPorPerfil, mes, ano);
    
    // Mostrar ranking inicial (gastos)
    mostrarRanking('gastos', dadosPorPerfil);
}

// ========== WIDGET "ONDE FOI MEU DINHEIRO?" ==========

function gerarAnaliseOndeForDinheiro(mes, ano) {
    const periodoSelecionado = `${ano}-${mes}`;
    
    // Filtrar transações do período
    const transacoesPeriodo = transacoes.filter(t => {
        const dataISO = dataParaISO(t.data);
        return dataISO && dataISO.startsWith(periodoSelecionado) && t.categoria === 'saida';
    });
    
    if(transacoesPeriodo.length === 0) {
        return {
            temDados: false,
            mensagem: `Nenhum gasto registrado em ${getMesNome(mes)} de ${ano}.`
        };
    }
    
    // Agrupar por categoria
    const porCategoria = {};
    let totalGastos = 0;
    
    transacoesPeriodo.forEach(t => {
        const tipo = t.tipo || 'Outros';
        porCategoria[tipo] = (porCategoria[tipo] || 0) + Number(t.valor);
        totalGastos += Number(t.valor);
    });
    
    // Ordenar categorias por valor
    const categoriasOrdenadas = Object.entries(porCategoria)
        .sort((a, b) => b[1] - a[1]);
    
    // Top 3 categorias
    const top3 = categoriasOrdenadas.slice(0, 3);
    const top1 = top3[0];
    const top2 = top3[1];
    const top3Item = top3[2];
    
    // Encontrar maior e segundo maior gasto individual
    const gastosIndividuais = transacoesPeriodo
        .sort((a, b) => Number(b.valor) - Number(a.valor))
        .slice(0, 2);
    
    const maiorGasto = gastosIndividuais[0];
    const segundoMaiorGasto = gastosIndividuais[1];
    
    // Gerar narrativa
    let narrativa = `Neste mês, `;
    
    if(top1) {
        const perc1 = ((top1[1] / totalGastos) * 100).toFixed(0);
        narrativa += `<strong>${perc1}%</strong> do seu dinheiro foi para <strong>${top1[0]}</strong>`;
    }
    
    if(top2) {
        const perc2 = ((top2[1] / totalGastos) * 100).toFixed(0);
        narrativa += `, <strong>${perc2}%</strong> para <strong>${top2[0]}</strong>`;
    }
    
    if(top3Item) {
        const perc3 = ((top3Item[1] / totalGastos) * 100).toFixed(0);
        narrativa += ` e <strong>${perc3}%</strong> para <strong>${top3Item[0]}</strong>`;
    }
    
    narrativa += `.`;
    
    if(maiorGasto) {
        narrativa += ` Seu <strong>maior gasto</strong> foi <strong>${maiorGasto.descricao}</strong> (<strong>${formatBRL(maiorGasto.valor)}</strong>)`;
    }
    
    if(segundoMaiorGasto) {
        narrativa += ` e o segundo foi <strong>${segundoMaiorGasto.descricao}</strong> (<strong>${formatBRL(segundoMaiorGasto.valor)}</strong>)`;
    }
    
    narrativa += `.`;
    
    return {
        temDados: true,
        narrativa: narrativa,
        totalGastos: totalGastos,
        categorias: categoriasOrdenadas,
        top3: top3,
        maiorGasto: maiorGasto,
        segundoMaiorGasto: segundoMaiorGasto,
        totalTransacoes: transacoesPeriodo.length
    };
}

function abrirWidgetOndeForDinheiro() {
    const hoje = new Date();
    const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
    const anoAtual = hoje.getFullYear();
    
    criarPopup(`
        <div style="max-height:70vh; overflow-y:auto; padding-right:10px;">
            <h3 style="text-align:center; margin-bottom:8px;">💸 Onde Foi Meu Dinheiro?</h3>
            <p style="text-align:center; color:var(--text-secondary); margin-bottom:24px; font-size:0.9rem;">
                Análise detalhada dos seus gastos
            </p>
            
            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; margin-bottom:20px;">
                <div>
                    <label style="display:block; margin-bottom:6px; font-size:0.9rem; color:var(--text-secondary);">Mês:</label>
                    <select id="mesAnalise" class="form-input" style="width:100%;">
                        <option value="01">Janeiro</option>
                        <option value="02">Fevereiro</option>
                        <option value="03">Março</option>
                        <option value="04">Abril</option>
                        <option value="05">Maio</option>
                        <option value="06">Junho</option>
                        <option value="07">Julho</option>
                        <option value="08">Agosto</option>
                        <option value="09">Setembro</option>
                        <option value="10">Outubro</option>
                        <option value="11">Novembro</option>
                        <option value="12">Dezembro</option>
                    </select>
                </div>
                
                <div>
                    <label style="display:block; margin-bottom:6px; font-size:0.9rem; color:var(--text-secondary);">Ano:</label>
                    <select id="anoAnalise" class="form-input" style="width:100%;">
                        <option value="${anoAtual}">${anoAtual}</option>
                        <option value="${anoAtual - 1}">${anoAtual - 1}</option>
                        <option value="${anoAtual - 2}">${anoAtual - 2}</option>
                    </select>
                </div>
            </div>
            
            <button class="btn-primary" style="width:100%; margin-bottom:20px;" onclick="processarAnaliseOndeForDinheiro()">
                🔍 Analisar Gastos
            </button>
            
            <div id="resultadoAnalise"></div>
        </div>
        
        <button class="btn-cancelar" onclick="fecharPopup()" style="width:100%; margin-top:16px;">Fechar</button>
    `);
    
    // Selecionar mês e ano atual por padrão
    document.getElementById('mesAnalise').value = mesAtual;
    document.getElementById('anoAnalise').value = anoAtual;
    
    // Processar automaticamente
    processarAnaliseOndeForDinheiro();
}

function processarAnaliseOndeForDinheiro() {
    const mes = document.getElementById('mesAnalise').value;
    const ano = document.getElementById('anoAnalise').value;
    const container = document.getElementById('resultadoAnalise');
    
    const analise = gerarAnaliseOndeForDinheiro(mes, ano);
    
    if(!analise.temDados) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px;">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">🔍</div>
                <div style="font-size:1.1rem; font-weight:600; color:var(--text-primary); margin-bottom:8px;">
                    Sem Dados Disponíveis
                </div>
                <div style="font-size:0.9rem; color:var(--text-secondary);">
                    ${analise.mensagem}
                </div>
            </div>
        `;
        return;
    }
    
    // Gerar HTML do resultado
    let html = `
        <!-- Narrativa Principal -->
        <div style="background:linear-gradient(135deg, rgba(67,160,71,0.2), rgba(108,99,255,0.2)); padding:24px; border-radius:16px; margin-bottom:24px; border-left:4px solid var(--primary);">
            <div style="font-size:1.1rem; line-height:1.8; color:var(--text-primary);">
                ${analise.narrativa}
            </div>
            <div style="text-align:center; margin-top:20px; padding-top:20px; border-top:1px solid var(--border);">
                <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:8px;">Total Gasto no Período</div>
                <div style="font-size:2rem; font-weight:700; color:#ff4b4b;">${formatBRL(analise.totalGastos)}</div>
                <div style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">${analise.totalTransacoes} transações registradas</div>
            </div>
        </div>
        
        <!-- Gráfico de Pizza Interativo -->
        <div style="background:rgba(255,255,255,0.03); padding:24px; border-radius:16px; margin-bottom:24px;">
            <h4 style="margin-bottom:16px; color:var(--text-primary); text-align:center;">📊 Distribuição por Categoria</h4>
            <div style="display:flex; flex-direction:column; gap:12px;">
    `;
    
    const cores = ['#ff4b4b', '#ffd166', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe', '#fd79a8'];
    
    analise.categorias.forEach(([categoria, valor], i) => {
        const percentual = ((valor / analise.totalGastos) * 100).toFixed(1);
        const cor = cores[i % cores.length];
        
        html += `
            <div style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <div style="width:16px; height:16px; background:${cor}; border-radius:4px;"></div>
                        <span style="font-weight:600; color:var(--text-primary);">${categoria}</span>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-weight:700; color:var(--text-primary);">${formatBRL(valor)}</div>
                        <div style="font-size:0.85rem; color:var(--text-secondary);">${percentual}%</div>
                    </div>
                </div>
                <div style="width:100%; height:12px; background:rgba(255,255,255,0.1); border-radius:6px; overflow:hidden;">
                    <div style="width:${percentual}%; height:100%; background:${cor}; border-radius:6px; transition:width 0.5s;"></div>
                </div>
            </div>
        `;
    });
    
    html += `
            </div>
        </div>
        
        <!-- Insights e Recomendações -->
        <div style="background:rgba(108,99,255,0.1); padding:20px; border-radius:16px; border-left:4px solid #6c63ff;">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
                <div style="font-size:2rem;">💡</div>
                <div style="font-weight:700; font-size:1.1rem; color:var(--text-primary);">Insight Inteligente</div>
            </div>
            <div style="color:var(--text-secondary); line-height:1.6; font-size:0.95rem;">
    `;
    
    // Gerar insights personalizados
    if(analise.top3[0]) {
        const categoriaTop = analise.top3[0][0];
        const percentualTop = ((analise.top3[0][1] / analise.totalGastos) * 100).toFixed(0);
        
        if(percentualTop > 50) {
            html += `⚠️ <strong>Atenção:</strong> ${percentualTop}% dos seus gastos foram com <strong>${categoriaTop}</strong>. Isso representa mais da metade do seu orçamento! Considere analisar se há oportunidades de redução nesta categoria.<br><br>`;
        } else if(percentualTop > 30) {
            html += `📊 A categoria <strong>${categoriaTop}</strong> representa ${percentualTop}% dos seus gastos. Esta é sua principal área de despesa no momento.<br><br>`;
        }
    }
    
    // Insight sobre diversificação
    if(analise.categorias.length <= 3) {
        html += `🎯 Seus gastos estão concentrados em poucas categorias (${analise.categorias.length}). Isso pode indicar um controle financeiro focado, mas fique atento a gastos ocultos.<br><br>`;
    } else if(analise.categorias.length > 8) {
        html += `🌐 Você tem gastos distribuídos em ${analise.categorias.length} categorias diferentes. Considere consolidar categorias similares para melhor análise.<br><br>`;
    }
    
    // Comparativo com média
    const ticketMedio = analise.totalGastos / analise.totalTransacoes;
    html += `💰 Seu <strong>gasto médio por transação</strong> foi de ${formatBRL(ticketMedio)}. `;
    
    if(ticketMedio > 200) {
        html += `Isso indica transações de valores significativos. Certifique-se de que cada gasto esteja alinhado com suas prioridades.`;
    } else {
        html += `Você mantém transações de valores moderados, o que pode indicar um bom controle diário.`;
    }
    
    html += `
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

// Expor globalmente
window.abrirWidgetOndeForDinheiro = abrirWidgetOndeForDinheiro;
window.processarAnaliseOndeForDinheiro = processarAnaliseOndeForDinheiro;

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
    if(!container) return;
    
    let html = '';
    const emojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    
    switch(tipo) {
        case 'gastos':
            const rankingGastos = dadosPorPerfil
                .map(d => ({nome: d.perfil.nome, valor: d.saidas, foto: d.perfil.foto}))
                .sort((a, b) => b.valor - a.valor);
            
            const totalGastos = rankingGastos.reduce((sum, r) => sum + r.valor, 0);
            
            html = '<h4 style="margin-bottom:16px; color: var(--text-primary);">💸 Ranking: Quem Gastou Mais</h4>';
            
            rankingGastos.forEach((r, i) => {
                const percentual = totalGastos > 0 ? ((r.valor / totalGastos) * 100).toFixed(1) : 0;
                html += `
                    <div class="ranking-item" style="background: rgba(255,75,75,0.1); border-left: 3px solid #ff4b4b;">
                        <div class="ranking-posicao">${emojis[i] || (i+1)}</div>
                        <div class="ranking-info">
                            <div class="ranking-nome">${r.nome}</div>
                            <div class="ranking-detalhes">${percentual}% do total de gastos</div>
                        </div>
                        <div class="ranking-valor">${formatBRL(r.valor)}</div>
                    </div>
                `;
            });
            break;
            
        case 'guardou':
            const rankingGuardou = dadosPorPerfil
                .map(d => ({nome: d.perfil.nome, valor: d.reservas, foto: d.perfil.foto}))
                .sort((a, b) => b.valor - a.valor);
            
            const totalGuardado = rankingGuardou.reduce((sum, r) => sum + r.valor, 0);
            
            html = '<h4 style="margin-bottom:16px; color: var(--text-primary);">💰 Ranking: Quem Guardou Mais</h4>';
            
            rankingGuardou.forEach((r, i) => {
                const percentual = totalGuardado > 0 ? ((r.valor / totalGuardado) * 100).toFixed(1) : 0;
                html += `
                    <div class="ranking-item" style="background: rgba(0,255,153,0.1); border-left: 3px solid #00ff99;">
                        <div class="ranking-posicao">${emojis[i] || (i+1)}</div>
                        <div class="ranking-info">
                            <div class="ranking-nome">${r.nome}</div>
                            <div class="ranking-detalhes">${percentual}% do total guardado</div>
                        </div>
                        <div class="ranking-valor" style="color:#00ff99;">${formatBRL(r.valor)}</div>
                    </div>
                `;
            });
            break;
            
        case 'economia':
            const rankingEconomia = dadosPorPerfil
                .map(d => ({
                    nome: d.perfil.nome, 
                    taxa: d.taxaEconomia, 
                    guardado: d.reservas,
                    entradas: d.entradas
                }))
                .sort((a, b) => b.taxa - a.taxa);
            
            html = '<h4 style="margin-bottom:16px; color: var(--text-primary);">📊 Ranking: Melhor Taxa de Economia</h4>';
            html += '<p style="font-size:0.9rem; color: var(--text-secondary); margin-bottom:16px;">Quanto % do que ganhou foi guardado</p>';
            
            rankingEconomia.forEach((r, i) => {
                html += `
                    <div class="ranking-item" style="background: rgba(255,209,102,0.1); border-left: 3px solid #ffd166;">
                        <div class="ranking-posicao">${emojis[i] || (i+1)}</div>
                        <div class="ranking-info">
                            <div class="ranking-nome">${r.nome}</div>
                            <div class="ranking-detalhes">
                                Guardou ${formatBRL(r.guardado)} de ${formatBRL(r.entradas)}
                            </div>
                        </div>
                        <div class="ranking-valor" style="color:#ffd166; font-size:1.5rem;">${r.taxa.toFixed(1)}%</div>
                    </div>
                `;
            });
            break;
            
        case 'evolucao':
            const rankingEvolucao = dadosPorPerfil
                .map(d => ({
                    nome: d.perfil.nome,
                    evolucao: d.evolucaoEconomia,
                    taxaAtual: d.taxaEconomia,
                    taxaAnterior: d.taxaEconomiaAnterior
                }))
                .sort((a, b) => b.evolucao - a.evolucao);
            
            html = '<h4 style="margin-bottom:16px; color: var(--text-primary);">📈 Ranking: Maior Evolução na Economia</h4>';
            html += '<p style="font-size:0.9rem; color: var(--text-secondary); margin-bottom:16px;">Comparação com o mês anterior</p>';
            
            rankingEvolucao.forEach((r, i) => {
                const corEvolucao = r.evolucao >= 0 ? '#00ff99' : '#ff4b4b';
                const simbolo = r.evolucao >= 0 ? '↑' : '↓';
                
                html += `
                    <div class="ranking-item" style="background: rgba(108,99,255,0.1); border-left: 3px solid ${corEvolucao};">
                        <div class="ranking-posicao">${emojis[i] || (i+1)}</div>
                        <div class="ranking-info">
                            <div class="ranking-nome">${r.nome}</div>
                            <div class="ranking-detalhes">
                                ${r.taxaAnterior.toFixed(1)}% → ${r.taxaAtual.toFixed(1)}%
                            </div>
                        </div>
                        <div class="ranking-valor" style="color:${corEvolucao};">
                            ${simbolo} ${Math.abs(r.evolucao).toFixed(1)}%
                        </div>
                    </div>
                `;
            });
            break;
    }
    
    container.innerHTML = html;
}

// Função para abrir detalhes completos de um perfil específico
function abrirDetalhesPerfilRelatorio(perfilId, mes, ano) {
    criarPopup(`
        <h3>🔍 Detalhes Completos</h3>
        <div class="small">Carregando dados detalhados...</div>
        <button class="btn-primary" onclick="fecharPopup()">Fechar</button>
    `);
    
    setTimeout(() => {
        gerarRelatorioIndividual(mes, ano, perfilId);
        fecharPopup();
    }, 500);
}

// Expor função globalmente
window.abrirDetalhesPerfilRelatorio = abrirDetalhesPerfilRelatorio;

// ========== DETALHES DO CARTÃO NO RELATÓRIO ==========

function abrirDetalhesCartaoRelatorio(cartaoId, mes, ano, perfilId) {
    const chave = `granaevo_perfil_${perfilId}`;
    const dadosPerfil = JSON.parse(localStorage.getItem(chave) || 'null');
    const cartoesPerfil = dadosPerfil ? dadosPerfil.cartoesCredito || [] : [];
    const contasFixasPerfil = dadosPerfil ? dadosPerfil.contasFixas || [] : [];
    
    const cartao = cartoesPerfil.find(c => c.id === cartaoId);
    if(!cartao) {
        alert('Cartão não encontrado!');
        return;
    }
    
    const periodoSelecionado = `${ano}-${mes}`;
    
    // Buscar todas as faturas deste cartão no período
    const faturasCartao = contasFixasPerfil.filter(c => 
        c.cartaoId === cartaoId && 
        c.vencimento && 
        c.vencimento.startsWith(periodoSelecionado)
    );
    
    // Coletar todas as compras
    let todasCompras = [];
    faturasCartao.forEach(fatura => {
        if(fatura.compras && fatura.compras.length > 0) {
            fatura.compras.forEach(compra => {
                todasCompras.push({
                    ...compra,
                    faturaId: fatura.id,
                    vencimentoFatura: fatura.vencimento
                });
            });
        }
    });
    
    // Calcular estatísticas
    const usado = Number(cartao.usado || 0);
    const limite = Number(cartao.limite || 0);
    const disponivel = limite - usado;
    const percUsado = limite > 0 ? ((usado / limite) * 100).toFixed(1) : 0;
    
    const totalCompras = todasCompras.reduce((sum, c) => sum + Number(c.valorParcela || 0), 0);
    const comprasPagas = todasCompras.filter(c => c.parcelaAtual > c.totalParcelas).length;
    const comprasPendentes = todasCompras.length - comprasPagas;
    
    // Obter dica aleatória
    const dica = obterDicaAleatoria();
    
    // Gerar HTML das compras
    let htmlCompras = '';
    if(todasCompras.length === 0) {
        htmlCompras = `
            <div style="text-align:center; padding:40px; background:rgba(255,255,255,0.03); border-radius:12px;">
                <div style="font-size:3rem; margin-bottom:12px; opacity:0.5;">🛍️</div>
                <div style="font-size:1.1rem; font-weight:600; color: var(--text-primary); margin-bottom:8px;">
                    Nenhuma Compra Registrada
                </div>
                <div style="font-size:0.9rem; color: var(--text-secondary);">
                    Este cartão não possui compras no período de ${getMesNome(mes)} de ${ano}
                </div>
            </div>
        `;
    } else {
        todasCompras.forEach(compra => {
            const statusParcela = compra.parcelaAtual > compra.totalParcelas ? 
                '✅ Paga' : 
                `🔄 Parcela ${compra.parcelaAtual}/${compra.totalParcelas}`;
            
            const corBorda = compra.parcelaAtual > compra.totalParcelas ? '#00ff99' : '#ffd166';
            
            htmlCompras += `
                <div style="background:rgba(255,255,255,0.03); padding:16px; border-radius:12px; margin-bottom:12px; border-left:3px solid ${corBorda};">
                    <div style="display:flex; justify-content:space-between; align-items:start; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
                        <div style="flex:1;">
                            <div style="font-weight:600; color: var(--text-primary); font-size:1rem; margin-bottom:6px;">
                                ${compra.tipo}
                            </div>
                            <div style="color: var(--text-secondary); font-size:0.9rem;">
                                ${compra.descricao}
                            </div>
                            <div style="color: var(--text-muted); font-size:0.85rem; margin-top:6px;">
                                📅 ${formatarDataBR(compra.dataCompra)}
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-weight:700; color: var(--text-primary); font-size:1.2rem;">
                                ${formatBRL(compra.valorParcela)}
                            </div>
                            <div style="font-size:0.85rem; margin-top:4px; color: ${corBorda}; font-weight:600;">
                                ${statusParcela}
                            </div>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; padding-top:10px; border-top:1px solid var(--border);">
                        <div>
                            <div style="font-size:0.75rem; color: var(--text-muted);">Valor Total</div>
                            <div style="font-weight:600; color: var(--text-secondary);">${formatBRL(compra.valorTotal)}</div>
                        </div>
                        <div>
                            <div style="font-size:0.75rem; color: var(--text-muted);">Falta Pagar</div>
                            <div style="font-weight:600; color: ${compra.parcelaAtual > compra.totalParcelas ? '#00ff99' : '#ff4b4b'};">
                                ${compra.parcelaAtual > compra.totalParcelas ? 
                                    '✅ Quitado' : 
                                    formatBRL(compra.valorParcela * (compra.totalParcelas - compra.parcelaAtual + 1))}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });
    }
    
    // Criar pop-up
    // Criar pop-up
criarPopup(`
    <div style="max-height:80vh; overflow-y:auto; overflow-x:hidden; position:relative; padding-right:10px;">
        <!-- Botão X no Topo -->
<button onclick="fecharPopup()" style="position:absolute; top:12px; right:12px; background:#ff4b4b; border:none; color:#ffffff; font-size:1.5rem; width:36px; height:36px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-weight:700; z-index:10; box-shadow:0 2px 8px rgba(255,75,75,0.3);">
    ✖
</button>
        
        <h3 style="text-align:center; margin-bottom:20px; padding-right:50px;">
            💳 Análise Detalhada do Cartão
        </h3>
        
        <!-- Cabeçalho do Cartão -->
        <div style="background:linear-gradient(135deg, var(--primary), var(--secondary)); padding:20px; border-radius:12px; margin-bottom:20px; text-align:center;">
            <div style="font-size:1.5rem; font-weight:700; color:white; margin-bottom:8px;">
                ${cartao.nomeBanco}
            </div>
            <div style="font-size:0.9rem; color:rgba(255,255,255,0.8);">
                Período: ${getMesNome(mes)} de ${ano}
            </div>
        </div>
        
        <!-- Estatísticas do Cartão -->
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; margin-bottom:20px;">
            <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">💰 Limite Total</div>
                <div style="font-size:1.3rem; font-weight:700; color: var(--text-primary);">${formatBRL(limite)}</div>
            </div>
            
            <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">💸 Usado</div>
                <div style="font-size:1.3rem; font-weight:700; color: #ff4b4b;">${formatBRL(usado)}</div>
            </div>
            
            <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">✅ Disponível</div>
                <div style="font-size:1.3rem; font-weight:700; color: #00ff99;">${formatBRL(disponivel)}</div>
            </div>
            
            <div style="background:rgba(255,255,255,0.05); padding:14px; border-radius:10px; text-align:center;">
                <div style="font-size:0.85rem; color: var(--text-secondary); margin-bottom:6px;">📊 % Utilizado</div>
                <div style="font-size:1.3rem; font-weight:700; color: ${percUsado > 80 ? '#ff4b4b' : '#00ff99'};">${percUsado}%</div>
            </div>
        </div>
        
        <!-- Barra de Progresso -->
        <div style="margin-bottom:20px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                <span style="font-size:0.9rem; color: var(--text-secondary);">Utilização do Limite</span>
                <span style="font-weight:700; color: ${percUsado > 80 ? '#ff4b4b' : '#00ff99'};">${percUsado}%</span>
            </div>
            <div style="width:100%; height:20px; background:rgba(255,255,255,0.1); border-radius:10px; overflow:hidden;">
                <div style="width:${percUsado}%; height:100%; background:${percUsado > 80 ? '#ff4b4b' : '#00ff99'}; border-radius:10px; transition:width 0.8s;"></div>
            </div>
        </div>
        
        <!-- Resumo de Compras -->
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px;">
            <div style="background:rgba(108,99,255,0.1); padding:12px; border-radius:10px; text-align:center; border-left:3px solid #6c63ff;">
                <div style="font-size:0.85rem; color: var(--text-secondary);">🛍️ Total Compras</div>
                <div style="font-size:1.4rem; font-weight:700; color: #6c63ff;">${todasCompras.length}</div>
            </div>
            
            <div style="background:rgba(0,255,153,0.1); padding:12px; border-radius:10px; text-align:center; border-left:3px solid #00ff99;">
                <div style="font-size:0.85rem; color: var(--text-secondary);">✅ Pagas</div>
                <div style="font-size:1.4rem; font-weight:700; color: #00ff99;">${comprasPagas}</div>
            </div>
            
            <div style="background:rgba(255,209,102,0.1); padding:12px; border-radius:10px; text-align:center; border-left:3px solid #ffd166;">
                <div style="font-size:0.85rem; color: var(--text-secondary);">⏳ Pendentes</div>
                <div style="font-size:1.4rem; font-weight:700; color: #ffd166;">${comprasPendentes}</div>
            </div>
        </div>
        
        <!-- Lista de Compras -->
        <div style="margin-bottom:20px;">
            <h4 style="margin-bottom:12px; color: var(--text-primary);">🛒 Compras do Mês</h4>
            ${htmlCompras}
        </div>
        
        <!-- Dica do Dia -->
        <div style="background:linear-gradient(135deg, rgba(108,99,255,0.2), rgba(76,166,255,0.2)); padding:16px; border-radius:12px; border-left:4px solid var(--primary);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
                <div style="font-size:2rem;">💡</div>
                <div style="font-weight:700; font-size:1.1rem; color: var(--text-primary);">Dica Inteligente</div>
            </div>
            <div style="color: var(--text-secondary); line-height:1.6;">
                ${dica}
            </div>
        </div>
        
        <button class="btn-primary" onclick="fecharPopup()" style="width:100%; margin-top:20px;">
            ✖️ Fechar
        </button>
    </div>
`);

// ========== BANCO DE DICAS SOBRE CARTÕES ==========

function obterDicaAleatoria() {
    const dicas = [
        "💳 <strong>Pagamento em dia:</strong> Sempre pague sua fatura no vencimento para evitar juros altíssimos e manter seu score de crédito saudável.",
        "📊 <strong>Controle de gastos:</strong> Utilize no máximo 30% do limite do seu cartão para manter um bom histórico de crédito.",
        "🎯 <strong>Organize suas compras:</strong> Faça compras grandes logo após o fechamento da fatura para ter mais tempo de pagamento.",
        "💰 <strong>Cashback inteligente:</strong> Priorize cartões com cashback em categorias que você mais gasta, como supermercado e combustível.",
        "🔒 <strong>Segurança em primeiro lugar:</strong> Nunca compartilhe sua senha ou CVV com terceiros, mesmo que pareçam ser do banco.",
        "📱 <strong>App do banco:</strong> Ative notificações de compras no app do banco para detectar fraudes rapidamente.",
        "🛡️ <strong>Cartão virtual:</strong> Use cartões virtuais para compras online - eles podem ser bloqueados sem afetar o cartão físico.",
        "💸 <strong>Evite o rotativo:</strong> Nunca pague apenas o valor mínimo - os juros do rotativo podem chegar a 400% ao ano!",
        "🎁 <strong>Programas de pontos:</strong> Acumule pontos e milhas em um único programa para maximizar benefícios e trocas.",
        "📆 <strong>Data de vencimento:</strong> Escolha a melhor data de vencimento de acordo com o dia que recebe seu salário.",
        "🏦 <strong>Anuidade zero:</strong> Negocie isenção de anuidade com seu banco ou opte por cartões sem taxa.",
        "🔄 <strong>Parcelamento consciente:</strong> Parcele apenas compras essenciais e evite acumular muitas parcelas simultâneas.",
        "💡 <strong>Limite adequado:</strong> Mantenha um limite compatível com sua renda para não cair na tentação de gastar demais.",
        "📉 <strong>Taxa de juros:</strong> Conheça as taxas do seu cartão e compare com outros bancos - você pode estar pagando mais.",
        "🚫 <strong>Compras por impulso:</strong> Espere 24 horas antes de fazer compras grandes no cartão - isso evita arrependimentos.",
        "💳 <strong>Múltiplos cartões:</strong> Ter mais de um cartão pode ser útil, mas só se você conseguir controlar todos.",
        "🎯 <strong>Planejamento financeiro:</strong> Reserve parte da sua renda mensal para pagar a fatura completa todo mês.",
        "🔍 <strong>Revise sua fatura:</strong> Confira todas as compras mensalmente para identificar cobranças indevidas.",
        "💰 <strong>Emergências:</strong> Não use o cartão como reserva de emergência - crie uma poupança separada para isso.",
        "📊 <strong>Controle de parcelas:</strong> Anote todas as parcelas e seus vencimentos para não perder o controle financeiro.",
        "🛒 <strong>Compare preços:</strong> Compras parceladas sem juros podem ser mais caras que à vista - sempre compare.",
        "💸 <strong>Antecipação de parcelas:</strong> Se possível, quite parcelas antecipadamente para reduzir o comprometimento futuro.",
        "🎁 <strong>Benefícios exclusivos:</strong> Use benefícios como seguros, descontos e acesso a salas VIP em aeroportos.",
        "📱 <strong>Pagamentos digitais:</strong> Carteiras digitais como Apple Pay e Google Pay adicionam uma camada extra de segurança.",
        "🔒 <strong>Bloqueio temporário:</strong> Bloqueie seu cartão temporariamente quando não estiver usando para evitar fraudes.",
        "💰 <strong>Negociação de dívidas:</strong> Se estiver endividado, negocie diretamente com o banco - eles têm programas especiais.",
        "📆 <strong>Fechamento da fatura:</strong> Conheça a data de fechamento para planejar melhor suas compras mensais.",
        "🎯 <strong>Metas de gastos:</strong> Estabeleça um limite mensal de gastos no cartão e respeite-o rigorosamente.",
        "💡 <strong>Educação financeira:</strong> Invista tempo aprendendo sobre finanças - isso vale mais que qualquer benefício de cartão.",
        "🏦 <strong>Portabilidade:</strong> Se encontrar melhores condições em outro banco, considere fazer a portabilidade da dívida.",
        "🔄 <strong>Refinanciamento:</strong> Evite refinanciar dívidas de cartão - as taxas são abusivas e prolongam o endividamento.",
        "💸 <strong>Saque no cartão:</strong> NUNCA faça saque no cartão de crédito - as taxas são extremamente altas.",
        "📊 <strong>Análise mensal:</strong> Reserve um tempo todo mês para analisar seus gastos e identificar padrões.",
        "🎁 <strong>Descontos exclusivos:</strong> Muitos cartões oferecem descontos em estabelecimentos parceiros - aproveite!",
        "🛡️ <strong>Seguro de compras:</strong> Verifique se seu cartão oferece seguro para compras - pode ser muito útil.",
        "💰 <strong>Programa de fidelidade:</strong> Participe de programas de fidelidade para ganhar benefícios extras.",
        "📱 <strong>Token digital:</strong> Use a função de token digital para compras online mais seguras.",
        "🔒 <strong>Autenticação de dois fatores:</strong> Sempre que possível, ative a autenticação de dois fatores.",
        "💡 <strong>Limite pré-aprovado:</strong> Não aceite aumentos de limite automáticos - avalie se realmente precisa.",
        "🎯 <strong>Categoria de gastos:</strong> Use cartões específicos para categorias diferentes e maximize benefícios.",
        "📆 <strong>Calendário financeiro:</strong> Crie um calendário com todas as datas de vencimento dos seus cartões.",
        "💸 <strong>Compras internacionais:</strong> Prefira cartões sem IOF para compras no exterior - economiza bastante.",
        "🛒 <strong>Black Friday consciente:</strong> Não compre apenas porque está em promoção - avalie se realmente precisa.",
        "💰 <strong>Reserva de emergência:</strong> Tenha pelo menos 3 meses de despesas guardadas antes de usar crédito.",
        "📊 <strong>Relatórios mensais:</strong> Use aplicativos como o GranaEvo para acompanhar seus gastos em tempo real.",
        "🎁 <strong>Programas de desconto:</strong> Cadastre-se em programas de desconto vinculados ao seu cartão.",
        "🔍 <strong>Leitura do contrato:</strong> Leia sempre o contrato do cartão para conhecer todas as taxas e condições.",
        "💡 <strong>Educação dos filhos:</strong> Ensine seus filhos sobre uso responsável de cartão desde cedo.",
        "🏦 <strong>Relacionamento bancário:</strong> Mantenha um bom relacionamento com seu banco para conseguir melhores condições.",
        "💸 <strong>Evite empréstimos:</strong> Prefira economizar e comprar à vista do que parcelar tudo no cartão."
    ];

    const indiceAleatorio = Math.floor(Math.random() * dicas.length);
    return dicas[indiceAleatorio];
}
}

// Expor função globalmente
window.abrirDetalhesCartaoRelatorio = abrirDetalhesCartaoRelatorio;

// ========== CONFIGURAÇÕES ==========
function alterarNome() {
    if(!perfilAtivo) {
        alert('Erro: Nenhum perfil ativo encontrado.');
        return;
    }
    
    criarPopup(`
        <h3>👤 Alterar Nome</h3>
        <div class="small">Digite seu novo nome ou apelido</div>
        <input type="text" id="novoNome" class="form-input" placeholder="Novo nome" value="${perfilAtivo.nome}">
        <button class="btn-primary" id="concluirNome">Concluir</button>
        <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
    `);
    
    document.getElementById('concluirNome').onclick = () => {
        const novoNome = document.getElementById('novoNome').value.trim();
        
        if(!novoNome) {
            alert('Por favor, digite um nome válido.');
            return;
        }
        
        if(novoNome.length < 2) {
            alert('O nome deve ter pelo menos 2 caracteres.');
            return;
        }
        
        perfilAtivo.nome = novoNome;
        
        const idx = usuarioLogado.perfis.findIndex(p => p.id === perfilAtivo.id);
        if(idx !== -1) {
            usuarioLogado.perfis[idx].nome = novoNome;
        }
        
        localStorage.setItem('perfilAtivo', JSON.stringify(perfilAtivo));
        localStorage.setItem('granaevo_perfis', JSON.stringify(usuarioLogado.perfis));
        
        atualizarNomeUsuario();
        fecharPopup();
        alert('✅ Nome alterado com sucesso!');
    };
}

function alterarEmail() {
    alert('Funcionalidade "Alterar Email" será implementada em breve!');
}

function abrirAlterarSenha() {
    criarPopup(`
        <h3>🔒 Alterar Senha</h3>
        <div class="small">Preencha todos os campos abaixo</div>
        <input type="password" id="senhaAtual" class="form-input" placeholder="Digite a senha atual">
        <input type="password" id="novaSenha" class="form-input" placeholder="Nova senha">
        <input type="password" id="confirmarNovaSenha" class="form-input" placeholder="Confirme a nova senha">
        <button class="btn-primary" id="concluirSenha">Concluir</button>
        <button class="btn-cancelar" onclick="fecharPopup()">Cancelar</button>
    `);
    
    document.getElementById('concluirSenha').onclick = () => {
        const senhaAtual = document.getElementById('senhaAtual').value;
        const novaSenha = document.getElementById('novaSenha').value;
        const confirmarSenha = document.getElementById('confirmarNovaSenha').value;
        
        if(!senhaAtual || !novaSenha || !confirmarSenha) {
            alert('Por favor, preencha todos os campos.');
            return;
        }
        
        if(senhaAtual !== usuarioAtual.senha) {
            alert('Erro: Senha atual incorreta!');
            return;
        }
        
        if(novaSenha !== confirmarSenha) {
            alert('Erro: As senhas não coincidem!');
            return;
        }
        
        if(novaSenha.length < 4) {
            alert('A nova senha deve ter pelo menos 4 caracteres.');
            return;
        }
        
        usuarioAtual.senha = novaSenha;
        salvarDados();
        fecharPopup();
        alert('✅ Senha alterada com sucesso!');
    };
}

function trocarPerfil() {
    salvarDados();
    mostrarSelecaoPerfis();
}

function comoUsar() {
    alert('Funcionalidade "Como usar o GranaEvo?" será implementada em breve!');
}

function confirmarLogout() {
    criarPopup(`
        <h3>Confirmar Saída</h3>
        <div style="margin: 20px 0; color: var(--text-secondary);">Quer mesmo sair?</div>
        <button class="btn-primary" id="simLogout">Sim</button>
        <button class="btn-cancelar" onclick="fecharPopup()">Não</button>
    `);

    document.getElementById('simLogout').onclick = () => {
        localStorage.removeItem('perfilAtivo');
        perfilAtivo = null;
        AuthGuard.performLogout();
    };
}

// ========== ATUALIZAR TUDO ==========
function atualizarTudo() {
    atualizarMovimentacoesUI();
    atualizarDashboardResumo();
    atualizarListaContasFixas();
    renderMetasList();
    renderMetaVisual();
    atualizarHeaderReservas();
}

function atualizarHeaderReservas() {
    const headerTotalReservas = document.getElementById('headerTotalReservas');
    const headerQtdReservas = document.getElementById('headerQtdReservas');
    
    if(!headerTotalReservas || !headerQtdReservas) return;
    
    // Calcular total reservado (soma de todas as metas)
    const totalReservado = metas.reduce((sum, meta) => {
        return sum + Number(meta.saved || 0);
    }, 0);
    
    // Contar reservas ativas (metas que ainda não atingiram o objetivo)
    const reservasAtivas = metas.filter(meta => {
        const saved = Number(meta.saved || 0);
        const objetivo = Number(meta.objetivo || 0);
        return saved < objetivo;
    }).length;
    
    // Atualizar valores no header
    headerTotalReservas.textContent = formatBRL(totalReservado);
    headerQtdReservas.textContent = reservasAtivas;
}

// ========== SIDEBAR TOGGLE (MOBILE) ==========
function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    const body = document.body;
    
    if(!toggleBtn || !sidebar) return;
    
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebar.classList.toggle('open');
        
        // Bloquear/desbloquear scroll do body no mobile
        if(window.innerWidth <= 768) {
            if(sidebar.classList.contains('open')) {
                body.classList.add('sidebar-open');
            } else {
                body.classList.remove('sidebar-open');
            }
        }
    });
    
    // Fechar ao clicar fora (mobile)
    document.addEventListener('click', (e) => {
        if(window.innerWidth <= 768) {
            if(!sidebar.contains(e.target) && !toggleBtn.contains(e.target) && sidebar.classList.contains('open')) {
                sidebar.classList.remove('open');
                body.classList.remove('sidebar-open');
            }
        }
    });
    
    // Fechar ao clicar em um item do menu (mobile)
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if(window.innerWidth <= 768) {
                sidebar.classList.remove('open');
                body.classList.remove('sidebar-open');
            }
        });
    });
    
    // Limpar classes ao redimensionar
    window.addEventListener('resize', () => {
        if(window.innerWidth > 768) {
            body.classList.remove('sidebar-open');
        }
    });
}

// ========== BINDINGS DE UI ==========
function bindEventos() {
    // Navegação
    document.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', function() {
            const page = this.getAttribute('data-page');
            mostrarTela(page);
        });
    });
    
    // Upload de foto
    const photoUpload = document.getElementById('photoUpload');
    if(photoUpload) {
        photoUpload.addEventListener('change', alterarFoto);
    }
    
    // Dashboard - Nova conta fixa
    const btnNovaContaFixa = document.getElementById('btnNovaContaFixa');
    if(btnNovaContaFixa) {
        btnNovaContaFixa.addEventListener('click', () => abrirContaFixaForm());
    }
    
    // Transações
    const selectCategoria = document.getElementById('selectCategoria');
    if(selectCategoria) {
        selectCategoria.addEventListener('change', atualizarTiposDinamicos);
    }
    
    const btnLancar = document.getElementById('btnLancar');
    if(btnLancar) {
        btnLancar.addEventListener('click', lancarTransacao);
    }
    
    // Reservas/Metas
    const btnNovaMeta = document.getElementById('btnNovaMeta');
    if(btnNovaMeta) {
        btnNovaMeta.addEventListener('click', () => abrirMetaForm());
    }
    
    const btnRetirar = document.getElementById('btnRetirar');
    if(btnRetirar) {
        btnRetirar.addEventListener('click', abrirRetiradaForm);
    }
    
    // Gráficos
    const btnAtualizarGraficos = document.getElementById('btnAtualizarGraficos');
    if(btnAtualizarGraficos) {
        btnAtualizarGraficos.addEventListener('click', atualizarGraficos);
    }
    
    // Relatórios
    const btnGerarRelatorio = document.getElementById('btnGerarRelatorio');
    if(btnGerarRelatorio) {
        btnGerarRelatorio.addEventListener('click', gerarRelatorio);
    }
    
    // Configurações
    const btnAlterarNome = document.getElementById('btnAlterarNome');
    if(btnAlterarNome) {
        btnAlterarNome.addEventListener('click', alterarNome);
    }
    
    const btnAlterarEmail = document.getElementById('btnAlterarEmail');
    if(btnAlterarEmail) {
        btnAlterarEmail.addEventListener('click', alterarEmail);
    }
    
    const btnAlterarSenha = document.getElementById('btnAlterarSenha');
    if(btnAlterarSenha) {
        btnAlterarSenha.addEventListener('click', abrirAlterarSenha);
    }
    
    const btnTrocarPerfil = document.getElementById('btnTrocarPerfil');
    if(btnTrocarPerfil) {
        btnTrocarPerfil.addEventListener('click', trocarPerfil);
    }
    
    const btnComoUsar = document.getElementById('btnComoUsar');
    if(btnComoUsar) {
        btnComoUsar.addEventListener('click', comoUsar);
    }
    
    const btnLogout = document.getElementById('btnLogout');
    if(btnLogout) {
        btnLogout.addEventListener('click', confirmarLogout);
    }
}

// ========== VISUALIZAÇÃO DETALHADA DE FATURA DE CARTÃO ==========
function abrirVisualizacaoFatura(faturaId) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if(!fatura || !fatura.compras) return;
    
    const cartao = cartoesCredito.find(c => c.id === fatura.cartaoId);
    const nomeCartao = cartao ? cartao.nomeBanco : 'Cartão';
    
    let htmlCompras = '';
    
    fatura.compras.forEach(compra => {
        const statusParcela = compra.parcelaAtual > compra.totalParcelas ? 
            '<span style="color: #00ff99;">✓ Paga</span>' : 
            `<span style="color: #ffd166;">Parcela ${compra.parcelaAtual}/${compra.totalParcelas}</span>`;
        
        htmlCompras += `
            <div style="background: rgba(255,255,255,0.03); padding: 16px; border-radius: 12px; margin-bottom: 12px; border-left: 3px solid var(--primary);">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                    <div style="flex: 1;">
                        <div style="font-weight: 600; color: var(--text-primary); font-size: 1rem;">${compra.tipo}</div>
                        <div style="color: var(--text-secondary); font-size: 0.9rem; margin-top: 4px;">${compra.descricao}</div>
                        <div style="color: var(--text-muted); font-size: 0.85rem; margin-top: 4px;">📅 Compra: ${compra.dataCompra}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 700; color: var(--text-primary); font-size: 1.1rem;">${formatBRL(compra.valorParcela)}</div>
                        <div style="font-size: 0.85rem; margin-top: 4px;">${statusParcela}</div>
                    </div>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
                    <button class="btn-primary" style="flex: 1; min-width: 80px; padding: 8px 12px; font-size: 0.85rem;" 
                            onclick="pagarCompraIndividual(${faturaId}, ${compra.id})">
                        💰 Pagar
                    </button>
                    <button class="btn-primary" style="flex: 1; min-width: 80px; padding: 8px 12px; font-size: 0.85rem; background: var(--accent);" 
                            onclick="editarCompraFatura(${faturaId}, ${compra.id})">
                        ✏️ Editar
                    </button>
                    <button class="btn-excluir" style="flex: 1; min-width: 80px; padding: 8px 12px; font-size: 0.85rem;" 
                            onclick="excluirCompraFatura(${faturaId}, ${compra.id})">
                        🗑️ Excluir
                    </button>
                </div>
            </div>
        `;
    });
    
    criarPopup(`
        <h3>💳 Detalhes da Fatura</h3>
        <div style="text-align: center; margin-bottom: 20px;">
            <div style="font-size: 1.1rem; font-weight: 600; color: var(--text-primary);">${nomeCartao}</div>
            <div style="font-size: 0.9rem; color: var(--text-secondary); margin-top: 4px;">Vencimento: ${formatarDataBR(fatura.vencimento)}</div>
            <div style="font-size: 1.4rem; font-weight: 700; color: var(--danger); margin-top: 12px;">
                Total: ${formatBRL(fatura.valor)}
            </div>
        </div>
        
        <div style="max-height: 400px; overflow-y: auto; margin-bottom: 20px;">
            <h4 style="margin-bottom: 12px; color: var(--text-primary);">📦 Compras nesta Fatura:</h4>
            ${htmlCompras}
        </div>
        
        <button class="btn-primary" onclick="fecharPopup()">Fechar</button>
    `);
}

// ========== PAGAR COMPRA INDIVIDUAL ==========
function pagarCompraIndividual(faturaId, compraId) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if(!fatura) return;
    
    const compra = fatura.compras.find(c => c.id === compraId);
    if(!compra) return;
    
    fecharPopup();
    
    setTimeout(() => {
        criarPopup(`
            <h3>💰 Pagar Parcela</h3>
            <div style="text-align: left; margin: 20px 0; color: var(--text-secondary);">
                <div style="margin-bottom: 8px;"><strong>Compra:</strong> ${compra.tipo}</div>
                <div style="margin-bottom: 8px;"><strong>Descrição:</strong> ${compra.descricao}</div>
                <div style="margin-bottom: 8px;"><strong>Parcela:</strong> ${compra.parcelaAtual}/${compra.totalParcelas}</div>
                <div style="margin-bottom: 16px;"><strong>Valor:</strong> ${formatBRL(compra.valorParcela)}</div>
            </div>
            <div style="color: var(--warning); margin-bottom: 16px; font-weight: 600;">⚠️ O valor está correto?</div>
            <button class="btn-primary" id="simValorCompra">Sim, pagar ${formatBRL(compra.valorParcela)}</button>
            <button class="btn-warning" id="naoValorCompra">Não, alterar valor</button>
            <button class="btn-cancelar" onclick="fecharPopup(); abrirVisualizacaoFatura(${faturaId})">Cancelar</button>
            <div id="ajusteValorCompraDiv" style="display:none; margin-top:14px;">
                <input type="number" id="novoValorCompra" class="form-input" value="${compra.valorParcela}" step="0.01" min="0"><br>
                <button class="btn-primary" id="confirmNovoValorCompra" style="margin-top:8px;">Confirmar pagamento</button>
            </div>
        `);
        
        document.getElementById('simValorCompra').onclick = () => {
            processarPagamentoCompra(faturaId, compraId, compra.valorParcela);
        };
        
        document.getElementById('naoValorCompra').onclick = () => {
            document.getElementById('ajusteValorCompraDiv').style.display = 'block';
            document.getElementById('simValorCompra').disabled = true;
            document.getElementById('naoValorCompra').disabled = true;
            
            document.getElementById('confirmNovoValorCompra').onclick = () => {
                const novoValor = parseFloat(document.getElementById('novoValorCompra').value);
                if(!novoValor || novoValor <= 0) return alert("Digite um valor válido!");
                processarPagamentoCompra(faturaId, compraId, novoValor);
            };
        };
    }, 300);
}

// ========== PROCESSAR PAGAMENTO DE COMPRA ==========
function processarPagamentoCompra(faturaId, compraId, valorPago) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if(!fatura) return;
    
    const compra = fatura.compras.find(c => c.id === compraId);
    if(!compra) return;
    
    const cartao = cartoesCredito.find(c => c.id === fatura.cartaoId);
    
    // Registrar transação de pagamento
    const dh = agoraDataHora();
    transacoes.push({
        id: nextTransId++,
        categoria: 'saida',
        tipo: 'Pagamento Cartão',
        descricao: `${compra.tipo} - ${compra.descricao} (${compra.parcelaAtual}/${compra.totalParcelas})`,
        valor: valorPago,
        data: dh.data,
        hora: dh.hora,
        faturaId: faturaId,
        compraId: compraId
    });
    
    // Atualizar cartão
    if(cartao) {
        cartao.usado = Math.max(0, (cartao.usado || 0) - valorPago);
    }
    
    // Atualizar parcela da compra
    compra.parcelaAtual++;
    
    // Se pagou todas as parcelas, remover compra da fatura
    if(compra.parcelaAtual > compra.totalParcelas) {
        fatura.compras = fatura.compras.filter(c => c.id !== compraId);
    }
    
    // Recalcular valor total da fatura
    fatura.valor = fatura.compras.reduce((sum, c) => sum + c.valorParcela, 0);
    
    // Se não há mais compras, remover fatura
    if(fatura.compras.length === 0) {
        contasFixas = contasFixas.filter(c => c.id !== faturaId);
        fecharPopup();
        salvarDados();
        atualizarTudo();
        alert("✅ Última parcela paga! Fatura quitada.");
        return;
    }
    
    // Salvar e atualizar
    salvarDados();
    atualizarTudo();
    fecharPopup();
    
    // Reabrir visualização da fatura
    setTimeout(() => {
        abrirVisualizacaoFatura(faturaId);
        mostrarNotificacao(`Parcela paga! ${compra.totalParcelas - compra.parcelaAtual + 1} restante(s)`, 'success');
    }, 200);
}

// ========== EDITAR COMPRA DA FATURA ==========
function editarCompraFatura(faturaId, compraId) {
    const fatura = contasFixas.find(c => c.id === faturaId);
    if(!fatura) return;
    
    const compra = fatura.compras.find(c => c.id === compraId);
    if(!compra) return;
    
    fecharPopup();
    
    setTimeout(() => {
        criarPopup(`
            <h3>✏️ Editar Compra</h3>
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Tipo:</label>
            <input type="text" id="editTipoCompra" class="form-input" value="${compra.tipo}"><br>
            
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Descrição:</label>
            <input type="text" id="editDescCompra" class="form-input" value="${compra.descricao}"><br>
            
            <label style="display:block; text-align:left; margin-top:10px; color: var(--text-secondary);">Valor da Parcela:</label>
            <input type="number" id="editValorCompra" class="form-input" value="${compra.valorParcela}" step="0.01" min="0"><br>
            
            <button class="btn-primary" id="salvarEdicaoCompra">Salvar</button>
            <button class="btn-cancelar" onclick="fecharPopup(); abrirVisualizacaoFatura(${faturaId})">Cancelar</button>
        `);
        
        document.getElementById('salvarEdicaoCompra').onclick = () => {
            compra.tipo = document.getElementById('editTipoCompra').value.trim();
            compra.descricao = document.getElementById('editDescCompra').value.trim();
            compra.valorParcela = parseFloat(document.getElementById('editValorCompra').value);
            
            // Recalcular valor total da fatura
            fatura.valor = fatura.compras.reduce((sum, c) => sum + c.valorParcela, 0);
            
            salvarDados();
            atualizarTudo();
            fecharPopup();
            setTimeout(() => {
                abrirVisualizacaoFatura(faturaId);
                mostrarNotificacao('Compra atualizada com sucesso!', 'success');
            }, 200);
        };
    }, 300);
}

// ========== EXCLUIR COMPRA DA FATURA ==========
function excluirCompraFatura(faturaId, compraId) {
    if(!confirm('⚠️ Tem certeza que deseja excluir esta compra da fatura?')) return;
    
    const fatura = contasFixas.find(c => c.id === faturaId);
    if(!fatura) return;
    
    const compra = fatura.compras.find(c => c.id === compraId);
    if(!compra) return;
    
    const cartao = cartoesCredito.find(c => c.id === fatura.cartaoId);
    
    // Atualizar valor usado do cartão
    if(cartao) {
        const valorRestante = compra.valorTotal - (compra.valorParcela * (compra.parcelaAtual - 1));
        cartao.usado = Math.max(0, (cartao.usado || 0) - valorRestante);
    }
    
    // Remover compra
    fatura.compras = fatura.compras.filter(c => c.id !== compraId);
    
    // Recalcular valor da fatura
    fatura.valor = fatura.compras.reduce((sum, c) => sum + c.valorParcela, 0);
    
    // Se não há mais compras, remover fatura
    if(fatura.compras.length === 0) {
        contasFixas = contasFixas.filter(c => c.id !== faturaId);
        fecharPopup();
        salvarDados();
        atualizarTudo();
        alert("✅ Fatura excluída - não há mais compras.");
        return;
    }
    
    salvarDados();
    atualizarTudo();
    fecharPopup();
    setTimeout(() => {
        abrirVisualizacaoFatura(faturaId);
        mostrarNotificacao('Compra excluída com sucesso!', 'success');
    }, 200);
}

// ========== INICIALIZAÇÃO ==========
document.addEventListener('DOMContentLoaded', () => {
    carregarDados();
    carregarPerfis();
    verificarLogin();
    bindEventos();
    setupSidebarToggle();
});

// ========== FUNÇÕES GLOBAIS EXPOSTAS ==========
// Estas funções precisam ser acessíveis globalmente para os event handlers inline no HTML
window.abrirContaFixaForm = abrirContaFixaForm;
window.abrirPopupPagarContaFixa = abrirPopupPagarContaFixa;
window.pagarContaFixa = pagarContaFixa;
window.abrirMetaForm = abrirMetaForm;
window.removerMeta = removerMeta;
window.selecionarMeta = selecionarMeta;
window.abrirRetiradaForm = abrirRetiradaForm;
window.abrirCartaoForm = abrirCartaoForm;
window.fecharPopup = fecharPopup;
window.atualizarGraficos = atualizarGraficos;
window.gerarRelatorio = gerarRelatorio;
window.alterarNome = alterarNome;
window.alterarEmail = alterarEmail;
window.abrirAlterarSenha = abrirAlterarSenha;
window.trocarPerfil = trocarPerfil;
window.comoUsar = comoUsar;
window.confirmarLogout = confirmarLogout;
window.mostrarTela = mostrarTela;
window.lancarTransacao = lancarTransacao;
window.abrirDetalhesTransacao = abrirDetalhesTransacao;
window.abrirVisualizacaoFatura = abrirVisualizacaoFatura;
window.pagarCompraIndividual = pagarCompraIndividual;
window.editarCompraFatura = editarCompraFatura;
window.excluirCompraFatura = excluirCompraFatura;
window.criarPopup = criarPopup;
window.fecharPopup = fecharPopup;

// ========== UTILITÁRIOS ADICIONAIS ==========

// Função para preencher seletor de parcelas dinamicamente
function preencherSelectParcelas() {
    const select = document.getElementById('selectParcelas');
    if(!select) return;
    
    select.innerHTML = '';
    for(let i = 1; i <= 24; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${String(i).padStart(2, '0')}x`;
        select.appendChild(opt);
    }
}

// Função auxiliar para debug (pode remover em produção)
function debug(msg, obj) {
    console.log(`[GranaEvo Debug] ${msg}`, obj || '');
}

// Prevenção de perda de dados ao sair da página
window.addEventListener('beforeunload', (e) => {
    // Salva dados antes de sair
    if(perfilAtivo) {
        salvarDados();
    }
});

// Auto-save a cada 30 segundos (opcional)
setInterval(() => {
    if(perfilAtivo && transacoes.length > 0) {
        salvarDados();
        debug('Auto-save executado');
    }
}, 30000);

// ========== VALIDAÇÕES ADICIONAIS ==========

// Valida formato de email
function validarEmail(email) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
}

// Valida CPF (caso queira adicionar no futuro)
function validarCPF(cpf) {
    cpf = cpf.replace(/[^\d]/g, '');
    if(cpf.length !== 11) return false;
    
    // Validação básica de CPF
    if(/^(\d)\1{10}$/.test(cpf)) return false;
    
    let soma = 0;
    let resto;
    
    for(let i = 1; i <= 9; i++) {
        soma += parseInt(cpf.substring(i-1, i)) * (11 - i);
    }
    resto = (soma * 10) % 11;
    if(resto === 10 || resto === 11) resto = 0;
    if(resto !== parseInt(cpf.substring(9, 10))) return false;
    
    soma = 0;
    for(let i = 1; i <= 10; i++) {
        soma += parseInt(cpf.substring(i-1, i)) * (12 - i);
    }
    resto = (soma * 10) % 11;
    if(resto === 10 || resto === 11) resto = 0;
    if(resto !== parseInt(cpf.substring(10, 11))) return false;
    
    return true;
}

// ========== FORMATAÇÕES ADICIONAIS ==========

// Formata número de telefone
function formatarTelefone(tel) {
    tel = tel.replace(/\D/g, '');
    if(tel.length === 11) {
        return tel.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    } else if(tel.length === 10) {
        return tel.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
    }
    return tel;
}

// Formata CPF
function formatarCPF(cpf) {
    cpf = cpf.replace(/\D/g, '');
    return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

// Converte número para extenso (útil para cheques)
function numeroParaExtenso(numero) {
    if(numero === 0) return 'zero';
    
    const unidades = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
    const especiais = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
    const dezenas = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
    const centenas = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
    
    // Implementação simplificada para números até 999
    if(numero < 10) return unidades[numero];
    if(numero < 20) return especiais[numero - 10];
    if(numero < 100) {
        const dez = Math.floor(numero / 10);
        const uni = numero % 10;
        return dezenas[dez] + (uni > 0 ? ' e ' + unidades[uni] : '');
    }
    if(numero < 1000) {
        const cen = Math.floor(numero / 100);
        const resto = numero % 100;
        if(numero === 100) return 'cem';
        return centenas[cen] + (resto > 0 ? ' e ' + numeroParaExtenso(resto) : '');
    }
    
    return numero.toString();
}

// ========== EXPORTAÇÃO DE DADOS ==========

// Exporta dados para JSON
function exportarDadosJSON() {
    if(!perfilAtivo) {
        alert('Nenhum perfil ativo!');
        return;
    }
    
    const dados = {
        perfil: perfilAtivo.nome,
        dataExportacao: new Date().toISOString(),
        transacoes: transacoes,
        metas: metas,
        contasFixas: contasFixas,
        cartoesCredito: cartoesCredito
    };
    
    const dataStr = JSON.stringify(dados, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `granaevo_${perfilAtivo.nome}_${isoDate()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert('Dados exportados com sucesso!');
}

// Exporta dados para CSV
function exportarDadosCSV() {
    if(!perfilAtivo) {
        alert('Nenhum perfil ativo!');
        return;
    }
    
    let csv = 'Data,Hora,Categoria,Tipo,Descrição,Valor\n';
    
    transacoes.forEach(t => {
        const linha = [
            t.data,
            t.hora,
            t.categoria,
            t.tipo,
            `"${t.descricao}"`,
            t.valor
        ].join(',');
        csv += linha + '\n';
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `granaevo_transacoes_${perfilAtivo.nome}_${isoDate()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    alert('Transações exportadas com sucesso!');
}

// Expõe funções de exportação
window.exportarDadosJSON = exportarDadosJSON;
window.exportarDadosCSV = exportarDadosCSV;

// ========== NOTIFICAÇÕES ==========

// Sistema simples de notificações
function mostrarNotificacao(mensagem, tipo = 'info') {
    const notif = document.createElement('div');
    notif.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 16px 24px;
        border-radius: 12px;
        color: white;
        font-weight: 600;
        z-index: 10000;
        animation: slideInRight 0.3s ease-out;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    
    switch(tipo) {
        case 'success':
            notif.style.background = 'linear-gradient(135deg, #00ff99, #00cc77)';
            break;
        case 'error':
            notif.style.background = 'linear-gradient(135deg, #ff4b4b, #cc0000)';
            break;
        case 'warning':
            notif.style.background = 'linear-gradient(135deg, #ffd166, #ffaa00)';
            break;
        default:
            notif.style.background = 'linear-gradient(135deg, #6c63ff, #4a42cc)';
    }
    
    notif.textContent = mensagem;
    document.body.appendChild(notif);
    
    setTimeout(() => {
        notif.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            document.body.removeChild(notif);
        }, 300);
    }, 3000);
}

// Adiciona animações CSS para notificações
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOutRight {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

window.mostrarNotificacao = mostrarNotificacao;

// ========== ATALHOS DE TECLADO ==========

// Adiciona suporte a atalhos de teclado
document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + S para salvar
    if((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        salvarDados();
        mostrarNotificacao('Dados salvos!', 'success');
    }
    
    // ESC para fechar popup
    if(e.key === 'Escape') {
        const overlay = document.getElementById('modalOverlay');
        if(overlay && overlay.classList.contains('active')) {
            fecharPopup();
        }
    }
    
    // Ctrl/Cmd + K para busca rápida (pode implementar no futuro)
    if((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        // Implementar busca rápida aqui
        console.log('Busca rápida (não implementado)');
    }
});

// ========== VERIFICAÇÃO DE ATUALIZAÇÕES ==========

// Verifica se há nova versão (simulado - adapte conforme sua necessidade)
function verificarAtualizacoes() {
    const versaoAtual = '1.0.0';
    const ultimaVerificacao = localStorage.getItem('granaevo_ultima_verificacao');
    const hoje = isoDate();
    
    if(ultimaVerificacao !== hoje) {
        localStorage.setItem('granaevo_ultima_verificacao', hoje);
        // Aqui você pode fazer uma chamada API para verificar versão
        debug('Verificação de atualizações', versaoAtual);
    }
}

// Executa verificação ao carregar
setTimeout(verificarAtualizacoes, 3000);

// ========== ESTATÍSTICAS DO SISTEMA ==========

// Retorna estatísticas gerais do perfil
function obterEstatisticas() {
    if(!perfilAtivo) return null;
    
    const hoje = new Date();
    const mesAtual = yearMonthKey();
    const mesPassado = yearMonthKey(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));
    
    const transacoesMesAtual = transacoes.filter(t => {
        const dataISO = dataParaISO(t.data);
        return dataISO && dataISO.startsWith(mesAtual);
    });
    
    const transacoesMesPassado = transacoes.filter(t => {
        const dataISO = dataParaISO(t.data);
        return dataISO && dataISO.startsWith(mesPassado);
    });
    
    const calcularTotal = (arr, categoria) => {
        return arr.filter(t => t.categoria === categoria)
                 .reduce((sum, t) => sum + Number(t.valor), 0);
    };
    
    return {
        totalTransacoes: transacoes.length,
        totalMetas: metas.length,
        totalContasFixas: contasFixas.length,
        totalCartoes: cartoesCredito.length,
        mesAtual: {
            entradas: calcularTotal(transacoesMesAtual, 'entrada'),
            saidas: calcularTotal(transacoesMesAtual, 'saida'),
            reservas: calcularTotal(transacoesMesAtual, 'reserva')
        },
        mesPassado: {
            entradas: calcularTotal(transacoesMesPassado, 'entrada'),
            saidas: calcularTotal(transacoesMesPassado, 'saida'),
            reservas: calcularTotal(transacoesMesPassado, 'reserva')
        },
        metasRealizadas: metas.filter(m => m.saved >= m.objetivo).length,
        ticketMedio: transacoes.length > 0 ? 
            transacoes.reduce((sum, t) => sum + Number(t.valor), 0) / transacoes.length : 0
    };
}

window.obterEstatisticas = obterEstatisticas;

// ========== CONSOLE DE DEBUG (APENAS DESENVOLVIMENTO) ==========

// Função útil para debugging
window.debugGranaEvo = () => {
    console.log('=== DEBUG GRANAEVO ===');
    console.log('Usuário Atual:', usuarioAtual);
    console.log('Perfil Ativo:', perfilAtivo);
    console.log('Transações:', transacoes);
    console.log('Metas:', metas);
    console.log('Contas Fixas:', contasFixas);
    console.log('Cartões:', cartoesCredito);
    console.log('Estatísticas:', obterEstatisticas());
    console.log('=====================');
};

// ========== LOG DE SISTEMA ==========

// Sistema de log simples
const sistemaLog = {
    logs: [],
    adicionar(tipo, mensagem) {
        const log = {
            tipo,
            mensagem,
            timestamp: new Date().toISOString(),
            perfil: perfilAtivo ? perfilAtivo.nome : 'N/A'
        };
        this.logs.push(log);
        
        // Mantém apenas os últimos 100 logs
        if(this.logs.length > 100) {
            this.logs.shift();
        }
        
        // Salva logs no localStorage
        try {
            localStorage.setItem('granaevo_logs', JSON.stringify(this.logs));
        } catch(e) {
            console.error('Erro ao salvar logs', e);
        }
    },
    obter() {
        return this.logs;
    },
    limpar() {
        this.logs = [];
        localStorage.removeItem('granaevo_logs');
    }
};

// Carrega logs salvos
try {
    const logsSalvos = localStorage.getItem('granaevo_logs');
    if(logsSalvos) {
        sistemaLog.logs = JSON.parse(logsSalvos);
    }
} catch(e) {
    console.error('Erro ao carregar logs', e);
}

window.sistemaLog = sistemaLog;

// ========== INICIALIZAÇÃO FINAL ==========

// Log de inicialização
sistemaLog.adicionar('INFO', 'Sistema GranaEvo inicializado');

console.log('%c🚀 GranaEvo carregado com sucesso!', 'color: #43a047; font-size: 16px; font-weight: bold;');
console.log('%c💡 Use window.debugGranaEvo() para ver informações do sistema', 'color: #6c63ff; font-size: 12px;');

// Verificação automática de vencimentos a cada 30 minutos
setInterval(() => {
    if(perfilAtivo) {
        verificacaoAutomaticaVencimentos();
    }
}, 1800000); // 30 minutos

// Verificação inicial ao carregar
setTimeout(() => {
    if(perfilAtivo) {
        verificacaoAutomaticaVencimentos();
    }
}, 5000); // 5 segundos após carregar

// ========== SISTEMA DE PARTÍCULAS OTIMIZADO (APENAS DESKTOP) ==========
class ParticleSystem {
    constructor() {
        // ⚡ Bloqueia partículas em mobile
        if(window.innerWidth <= 768) {
            console.log('Partículas desativadas no mobile para melhor performance');
            return;
        }
        
        this.canvas = document.getElementById('particles-canvas');
        if (!this.canvas) return;
        
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.maxParticles = 50; // ⚡ REDUZIDO de 80 para 50
        this.mouse = { x: null, y: null, radius: 150 };
        
        this.resize();
        this.init();
        this.animate();
        
        window.addEventListener('resize', () => {
            // ⚡ Desativa se redimensionar para mobile
            if(window.innerWidth <= 768) {
                this.particles = [];
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                return;
            }
            this.resize();
        });
        
        window.addEventListener('mousemove', (e) => this.handleMouse(e));
    }
    
    // ... resto do código permanece igual
}

// ⚡ Inicializa APENAS em desktop
document.addEventListener('DOMContentLoaded', () => {
    if(window.innerWidth > 768) {
        setTimeout(() => {
            new ParticleSystem();
        }, 500);
    }
});


// ========== FIM DO ARQUIVO ========== = 'center';
    ctx.fillText('Valor (R$)', 0, 0);
    ctx.restore()

function desenharGraficoLinha() {
    const canvas = document.getElementById('linhaChart');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const padding = 60;
    const w = canvas.width - padding * 2;
    const h = canvas.height - padding * 2;
    
    const hoje = new Date();
    const meses = [];
    const saldos = [];
    
    for(let i = 5; i >= 0; i--) {
        const data = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        const y = data.getFullYear();
        const m = String(data.getMonth() + 1).padStart(2, '0');
        const periodo = `${y}-${m}`;
        
        const transacoesMes = transacoes.filter(t => {
            const dataISO = dataParaISO(t.data);
            return dataISO && dataISO.startsWith(periodo);
        });
        
        let entradas = 0, saidas = 0;
        transacoesMes.forEach(t => {
            if(t.categoria === 'entrada') entradas += Number(t.valor);
            else if(t.categoria === 'saida' || t.categoria === 'reserva') saidas += Number(t.valor);
        });
        
        meses.push(data.toLocaleString('pt-BR', {month: 'short'}));
        saldos.push(entradas - saidas);
    }
    
    const maxSaldo = Math.max(...saldos.map(Math.abs), 100);
    
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(padding, padding, w, h);
    
    const zeroY = padding + h/2;
    ctx.strokeStyle = '#666';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(padding, zeroY);
    ctx.lineTo(padding + w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const points = [];
    ctx.beginPath();
    saldos.forEach((saldo, i) => {
        const x = padding + (i / (saldos.length - 1)) * w;
        const y = padding + h/2 - (saldo / maxSaldo) * (h/2.5);
        
        if(i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        points.push({x, y, saldo, mes: meses[i]});
    });
    ctx.strokeStyle = '#4da6ff';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    ctx.lineTo(padding + w, padding + h);
    ctx.lineTo(padding, padding + h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, padding, 0, padding + h);
    gradient.addColorStop(0, '#4da6ff40');
    gradient.addColorStop(1, '#4da6ff00');
    ctx.fillStyle = gradient;
    ctx.fill();
    
    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = p.saldo >= 0 ? '#00ff99' : '#ff4b4b';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
    });
    
    ctx.fillStyle = '#ccc';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    meses.forEach((mes, i) => {
        const x = padding + (i / (saldos.length - 1)) * w;
        ctx.fillText(mes, x, padding + h + 20);
    });
    
    canvas._points = points;
    
    canvas.onclick = function(ev) {
        const rect = canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        
        const ponto = (canvas._points || []).find(p => {
            const dx = p.x - mx;
            const dy = p.y - my;
            return Math.sqrt(dx*dx + dy*dy) <= 8;
        });
        
        if(ponto) {
            alert(`Mês: ${ponto.mes}\nSaldo: ${formatBRL(ponto.saldo)}`);
        }
    };
}

function desenharTopGastos(dados, label) {
    const canvas = document.getElementById('topGastosChart');
    if(!canvas) return;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if(dados.top5.length === 0) {
        ctx.fillStyle = '#ccc';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Sem gastos registrados', canvas.width/2, canvas.height/2);
        return;
    }
    
    const padding = 40;
    const w = canvas.width - padding * 2 - 100;
    const h = canvas.height - padding * 2;
    const barHeight = h / dados.top5.length - 10;
    
    const maxValor = Math.max(...dados.top5.map(g => g.valor));
    
    dados.top5.forEach((gasto, i) => {
        const y = padding + i * (barHeight + 10);
        const largura = (gasto.valor / maxValor) * w;
        
        const gradient = ctx.createLinearGradient(padding + 100, 0, padding + 100 + largura, 0);
        gradient.addColorStop(0, '#ff4b4b');
        gradient.addColorStop(1, '#ff7a7a');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(padding + 100, y, largura, barHeight);
        
        ctx.strokeStyle = '#ff4b4b';
        ctx.lineWidth = 2;
        ctx.strokeRect(padding + 100, y, largura, barHeight);
        
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(gasto.tipo, padding + 95, y + barHeight/2 + 4);
        
        ctx.textAlign = 'left';
        ctx.fillText(formatBRL(gasto.valor), padding + 105 + largura, y + barHeight/2 + 4);
    });
    ctx.fillStyle = '#ccc';
    ctx.font = '12px sans-serif';
    ctx.textAlign
}