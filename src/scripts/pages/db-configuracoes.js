// db-configuracoes.js — Seção de Configurações (lazy-loaded)
// CSS desktop-only (min-width:769px) viaja neste chunk lazy — mobile não baixa.
import '../../styles/dashboard/_db-config-desktop-lazy.css';
import { supabase, logout } from '../services/supabase-client.js?v=2';
import { iniciarTutorial } from '../modules/tutorial.js';
import { initPWA, initInstallButton } from '../modules/pwa-installer.js';
import { isPushSupported, getPushPermission, requestPushPermission, unsubscribePush } from '../modules/push-notifications.js';
import { computeLevel } from '../modules/achievements-catalog.js?v=1';
import { renderConquistas } from '../modules/achievements-ui.js?v=2';
let _ctx = null;

// Inicializa PWA logo que o módulo é carregado (uma vez, independente de ctx)
initPWA();

// Proxies para utilitários de dashboard.js disponíveis via _ctx após init()
const sanitizeHTML       = (...a) => _ctx.sanitizeHTML(...a);
const mostrarPopupLimite = (...a) => _ctx.mostrarPopupLimite(...a);

export function init(ctx) {
    _ctx = ctx;
    window.alterarNome      = () => alterarNome();
    window.alterarEmail     = () => alterarEmail();
    window.abrirAlterarSenha = () => abrirAlterarSenha();
    window.enviarConvite    = () => enviarConvite();
    window.removerConvidado = (id) => removerConvidado(id);
    window.trocarPerfil        = () => trocarPerfil();
    window.comoUsar            = () => comoUsar();
    window.gerenciarAssinatura = () => gerenciarAssinatura();
    window.abrirHistoricoBackup = () => abrirHistoricoBackup();
    window.resetarPerfil        = () => resetarPerfil();
    window.excluirConta         = () => excluirConta();
    window.abrirPerfilHub       = () => abrirPerfilHub();
    // Inicializa botão de instalação do PWA na seção de Configurações
    initInstallButton();
    // Botão "Instalar Chat Assistente" (PWA próprio do assistente, separado)
    _initInstallAssistantButton();
    // Painel "Segurança da conta" (módulo lazy — só baixa ao abrir)
    _initSecurityPanelButton();
    // Atualiza status de cache offline
    _updateOfflineStatus();
    // Inicializa botão de notificações push
    _initPushButton();
    // Inicializa toggle de tema claro/escuro
    _initThemeToggle();
    // Inicializa toggle de navegação por swipe
    _initSwipeNavToggle();
    // Inicializa botão de backup nas configurações (binding dinâmico)
    _bindBtnBackup();
    // Torna o card de perfil clicável (hub de perfil → conquistas)
    _initPerfilCard();
    // Recursos: Horas de Vida + Desafios (módulos lazy próprios)
    _initHorasVidaButton();
    _initDesafiosButton();
}

// ── Horas de Vida: gastos em horas de trabalho ──────────────────────────────
function _atualizarSubHorasVida() {
    const sub = document.getElementById('horasVidaStatusText');
    if (!sub) return;
    const hv = _ctx?.configPerfil?.horasVida;
    if (hv?.ativo === true && Number.isFinite(Number(hv.valorHora))) {
        sub.textContent = `Ativo — sua hora vale ${_ctx.formatBRL(Number(hv.valorHora))}`;
    } else {
        sub.textContent = 'Veja gastos em horas de trabalho';
    }
}

function _initHorasVidaButton() {
    const btn = document.getElementById('btnHorasVida');
    if (!btn) return;
    _atualizarSubHorasVida();
    btn.addEventListener('click', async () => {
        try {
            const m = await import('../modules/horas-vida.js?v=1');
            m.abrirPopupHorasVida(_ctx, _atualizarSubHorasVida);
        } catch {
            _ctx.mostrarNotificacao('Não foi possível abrir agora. Tente novamente.', 'error');
        }
    });
}

// ── Desafios financeiros ─────────────────────────────────────────────────────
function _initDesafiosButton() {
    const btn = document.getElementById('btnDesafios');
    const sub = document.getElementById('desafiosStatusText');
    if (!btn) return;
    const dados = _ctx?.desafiosPerfil;
    const ativos = Array.isArray(dados?.ativos) ? dados.ativos.length : 0;
    const vencidos = Array.isArray(dados?.historico) ? dados.historico.filter(h => h?.sucesso === true).length : 0;
    if (sub && (ativos > 0 || vencidos > 0)) {
        const partes = [];
        if (ativos > 0)   partes.push(`${ativos} em andamento`);
        if (vencidos > 0) partes.push(`${vencidos} vencido${vencidos > 1 ? 's' : ''}`);
        sub.textContent = partes.join(' · ');
    }
    btn.addEventListener('click', async () => {
        try {
            const m = await import('../modules/desafios.js?v=1');
            m.abrirDesafios(_ctx);
        } catch {
            _ctx.mostrarNotificacao('Não foi possível abrir agora. Tente novamente.', 'error');
        }
    });
}

function _bindBtnBackup() {
    const btn = document.getElementById('btnHistoricoBackup');
    if (btn) btn.addEventListener('click', abrirHistoricoBackup);
    const btnReset = document.getElementById('btnResetarPerfil');
    if (btnReset) btnReset.addEventListener('click', resetarPerfil);
    const btnDel = document.getElementById('btnExcluirConta');
    if (btnDel) btnDel.addEventListener('click', excluirConta);
}

// "Instalar Chat Assistente" — leva o usuário ao app do assistente, que vive
// no SUBDOMÍNIO próprio (assistente.granaevo.com): identidade PWA separada do
// GranaEvo (o app principal tem escopo "/", que engloba /assistente e suprimia
// o instalador do assistente no mesmo domínio). O ?install=1 mostra o CTA
// "Instalar agora" no chat — o Chrome exige um gesto lá pra abrir o instalador.
const ASSIST_APP_URL = 'https://assistente.granaevo.com/assistente';

function _initInstallAssistantButton() {
    const btn = document.getElementById('btnInstalarAssistente');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const standalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
        const url = ASSIST_APP_URL + '?install=1';
        if (standalone) {
            // Dentro do app instalado: abre em janela externa (no Android, uma
            // Custom Tab; no desktop, aba do navegador). NÃO tentamos intent://
            // daqui — de dentro do WebAPK ele falha silenciosamente ("nada
            // acontece"). Na Custom Tab a própria página do assistente oferece
            // o "Abrir no Chrome e instalar" (lá o intent funciona: é Chrome
            // real, com a sessão do usuário compartilhada).
            window.open(url, '_blank', 'noopener');
        } else {
            // Navegador comum: navega na própria aba (mais fluido).
            window.location.href = url;
        }
    });
}

// Painel "Segurança da conta": sessões, aparelhos com push e atividade recente.
// O módulo é um chunk lazy — só baixa quando o usuário abre (budget do dashboard).
function _initSecurityPanelButton() {
    const btn = document.getElementById('btnPainelSeguranca');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            const { openSecurityPanel } = await import('../modules/security-panel.js');
            await openSecurityPanel();
        } catch {
            // Sem rede/erro de chunk: silencioso — o botão volta a funcionar.
        } finally {
            btn.disabled = false;
        }
    });
}

function _initPushButton() {
    const btn = document.getElementById('btnTogglePush');
    const sub = document.getElementById('pushStatusText');
    if (!btn || !sub) return;

    if (!isPushSupported()) {
        sub.textContent = 'Não suportado neste navegador';
        btn.disabled = true;
        return;
    }

    const perm = getPushPermission();
    if (perm === 'granted') {
        sub.textContent = 'Ativas — toque para desativar';
    } else if (perm === 'denied') {
        sub.textContent = 'Bloqueadas — reative nas configurações do browser';
        btn.disabled = true;
    } else {
        sub.textContent = 'Desativadas — toque para ativar';
    }

    btn.addEventListener('click', async () => {
        if (!_ctx?.accessToken && !_ctx?.session) return;
        const token = _ctx?.session?.access_token ?? _ctx?.accessToken ?? '';
        if (!token) return;

        btn.disabled = true;
        const currentPerm = getPushPermission();

        if (currentPerm === 'granted') {
            sub.textContent = 'Desativando...';
            await unsubscribePush(token);
            sub.textContent = 'Desativadas — toque para ativar';
            _ctx?.mostrarNotificacao?.('Notificações push desativadas.', 'info');
        } else {
            sub.textContent = 'Aguardando permissão...';
            const result = await requestPushPermission(token);
            if (result === 'granted') {
                sub.textContent = 'Ativas — toque para desativar';
                _ctx?.mostrarNotificacao?.('Notificações push ativadas!', 'success');
            } else if (result === 'denied') {
                sub.textContent = 'Bloqueadas — reative nas configurações do browser';
                btn.disabled = true;
                _ctx?.mostrarNotificacao?.('Permissão negada pelo browser.', 'error');
            } else {
                sub.textContent = 'Desativadas — toque para ativar';
                _ctx?.mostrarNotificacao?.('Não foi possível ativar notificações.', 'error');
            }
        }

        btn.disabled = currentPerm !== 'granted' && getPushPermission() === 'denied';
    });
}

// O CSS do tema claro (~37 KB) é um arquivo separado carregado on-demand. No
// boot, theme-init.js só o injeta se o tema salvo JÁ era 'light'. Ao alternar
// para claro em runtime (dark → light), precisamos garantir o carregamento aqui
// — senão só aplicam as poucas regras embutidas no dashboard.css e o tema claro
// fica "pela metade". A URL vem do data-light-css da tag theme-init (fonte única).
function _ensureLightThemeCss() {
    if (document.querySelector('link[rel="stylesheet"][href*="db-light-theme"]')) return;
    const href = document.querySelector('script[data-light-css]')?.dataset.lightCss;
    if (!href) return;
    const l = document.createElement('link');
    l.rel  = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
}

function _applyTheme(isLight) {
    if (isLight) {
        _ensureLightThemeCss();
        document.documentElement.setAttribute('data-theme', 'light');
        try { localStorage.setItem('ge_theme', 'light'); } catch {}
    } else {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.setItem('ge_theme', 'dark'); } catch {}
    }
    const status = document.getElementById('themeStatusText');
    const toggle = document.getElementById('themeToggle');
    const btn    = document.getElementById('btnToggleTema');
    if (status) status.textContent = isLight ? 'Claro' : 'Escuro';
    if (toggle) toggle.classList.toggle('cfg-toggle--active', isLight);
    if (btn)    btn.setAttribute('aria-pressed', String(isLight));
}

function _initThemeToggle() {
    const btn = document.getElementById('btnToggleTema');
    if (!btn) return;

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    _applyTheme(isLight);

    btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') === 'light';
        _applyTheme(!current);
    });
}

function _initSwipeNavToggle() {
    const btn    = document.getElementById('btnToggleSwipeNav');
    const toggle = document.getElementById('swipeNavToggle');
    if (!btn) return;

    const isOn = () => localStorage.getItem('ge_swipe_nav') === '1';

    function _apply(on) {
        localStorage.setItem('ge_swipe_nav', on ? '1' : '0');
        btn.setAttribute('aria-pressed', String(on));
        if (toggle) toggle.classList.toggle('cfg-toggle--on', on);
    }

    _apply(isOn()); // Aplica estado inicial

    btn.addEventListener('click', () => _apply(!isOn()));
}

function _updateOfflineStatus() {
    const el = document.getElementById('offlineStatusText');
    if (!el) return;
    if (!('serviceWorker' in navigator)) {
        el.textContent = 'Navegador sem suporte a modo offline';
        return;
    }
    navigator.serviceWorker.ready
        .then(() => { el.textContent = '✅ Cache ativo — app funciona offline'; })
        .catch(() => { el.textContent = 'Service Worker não registrado'; });
}

// ========== CONFIGURAÇÕES ==========
async function alterarNome() {
    if (!_ctx.perfilAtivo) {
        _ctx.mostrarNotificacao('Erro: Nenhum perfil ativo encontrado.', 'error');
        return;
    }

    // ✅ CORREÇÃO: HTML do popup sem dados do usuário interpolados.
    //    O value do input é preenchido via .value após a criação do DOM,
    //    evitando qualquer risco residual de injeção via atributo HTML.
    _ctx.criarPopup(`
        <h3>👤 Alterar Nome</h3>
        <div class="small">Digite seu novo nome ou apelido</div>
        <input type="text" id="novoNome" class="form-input" placeholder="Novo nome" maxlength="50">
        <button class="btn-primary" id="concluirNome">Concluir</button>
        <button class="btn-cancelar" id="cancelarNome">Cancelar</button>
    `);

    // ✅ Preenchimento seguro via .value — nunca via atributo HTML
    document.getElementById('novoNome').value = _ctx.perfilAtivo.nome;

    document.getElementById('cancelarNome').addEventListener('click', _ctx.fecharPopup);

    document.getElementById('concluirNome').addEventListener('click', async () => {
        const novoNome = document.getElementById('novoNome').value.trim();

        if (!novoNome) {
            _ctx.mostrarNotificacao('Por favor, digite um nome válido.', 'error');
            return;
        }
        if (novoNome.length < 2) {
            _ctx.mostrarNotificacao('O nome deve ter pelo menos 2 caracteres.', 'error');
            return;
        }

        const btn = document.getElementById('concluirNome');
        btn.disabled = true;
        btn.textContent = '⏳ Salvando...';

        try {
            // ✅ CORREÇÃO: usa _log (o logger definido neste arquivo) em vez de log
            _ctx._log.info('🔄 Atualizando nome do perfil...');

            const { data, error } = await supabase
                .from('profiles')
                .update({ name: novoNome })
                .eq('id', _ctx.perfilAtivo.id)
                .select()
                .single();

            if (error) throw error;

            _ctx._log.info('✅ Nome atualizado');

            _ctx.perfilAtivo.nome = novoNome;

            const idx = _ctx.usuarioLogado.perfis.findIndex(p => p.id === _ctx.perfilAtivo.id);
            if (idx !== -1) {
                _ctx.usuarioLogado.perfis[idx].nome = novoNome;
            }

            _ctx.atualizarNomeUsuario();
            await _ctx.salvarDados();
            _ctx.fecharPopup();
            _ctx.mostrarNotificacao('Nome alterado com sucesso!', 'success');

        } catch (error) {
            // ✅ CORREÇÃO: _log.error em vez de log.error
            _ctx._log.error('NOME_001', error);
            _ctx.mostrarNotificacao('Não foi possível alterar o nome. Tente novamente.', 'error');
            btn.disabled = false;
            btn.textContent = 'Concluir';
        }
    });
}

window.alterarNome = alterarNome;


// ========== GERENCIADOR DE CONVIDADOS ==========
async function alterarEmail() {
    if (_ctx.usuarioLogado.isGuest) {
        _ctx.criarPopup(`
            <h3>🔒 Função Restrita</h3>
            <p style="margin:16px 0; color:var(--text-secondary); line-height:1.6;">
                Apenas o <strong>titular da conta</strong> pode gerenciar convidados.
                Entre em contato com quem te convidou para alterações.
            </p>
            <button class="btn-primary" id="btnFecharRestrito">Entendi</button>
        `);
        document.getElementById('btnFecharRestrito').addEventListener('click', _ctx.fecharPopup);
        return;
    }

    const { data: members, error: membersError } = await supabase
        .from('account_members')
        .select('id, member_email, member_name, joined_at, is_active')
        .eq('owner_user_id', _ctx.usuarioLogado.userId)
        .eq('is_active', true);

    const plano = _ctx.usuarioLogado.plano;
    const limitesConvidados = { 'Individual': 0, 'Casal': 1, 'Família': 3 };
    const limiteConvidados = limitesConvidados[plano] ?? 0;
    const memberCount = members?.length ?? 0;

    // Helper interno: constrói HTML dos membros com sanitização completa
    function renderMembersHtml(lista) {
        if (!lista || lista.length === 0) {
            return `<p style="color:var(--text-muted); text-align:center; padding:16px 0;">Nenhum convidado ainda.</p>`;
        }
        let html = '';
        lista.forEach(m => {
            const dataEntrada = m.joined_at
                ? new Date(m.joined_at).toLocaleDateString('pt-BR')
                : 'Pendente';

            const safeName  = _ctx.sanitizeHTML(m.member_name);
            const safeEmail = _ctx.sanitizeHTML(m.member_email);
            const safeDate  = _ctx.sanitizeHTML(dataEntrada);
            const safeId    = _ctx.sanitizeHTML(String(m.id));

            html += `
                <div style="display:flex; justify-content:space-between; align-items:center;
                            padding:12px 16px; background:rgba(255,255,255,0.04);
                            border-radius:10px; margin-bottom:8px; border-left:3px solid #10b981;">
                    <div>
                        <div style="font-weight:600; color:var(--text-primary);">${safeName}</div>
                        <div style="font-size:0.85rem; color:var(--text-secondary);">${safeEmail}</div>
                        <div style="font-size:0.78rem; color:var(--text-muted);">Entrou em: ${safeDate}</div>
                    </div>
                    <button class="btn-excluir js-remove-member"
                            data-member-id="${safeId}"
                            data-member-name="${safeName}"
                            style="padding:6px 12px; font-size:0.8rem;">
                        🗑️ Remover
                    </button>
                </div>
            `;
        });
        return html;
    }

    if (limiteConvidados === 0) {
        _ctx.criarPopup(`
            <h3>👥 Convidar Usuário</h3>
            <div style="background:rgba(255,209,102,0.1); border:1px solid rgba(255,209,102,0.3);
                        border-radius:12px; padding:16px; margin:16px 0; text-align:center;">
                <div style="font-size:2rem; margin-bottom:8px;">🔒</div>
                <div style="font-weight:600; color:#ffd166; margin-bottom:6px;">Plano ${sanitizeHTML(plano)}</div>
                <div style="font-size:0.9rem; color:var(--text-secondary); line-height:1.6;">
                    Seu plano permite apenas <strong>01 email por conta</strong>.<br>
                    Faça upgrade para o Plano Casal ou Família para convidar pessoas.
                </div>
            </div>
            <button class="btn-primary" id="btnUpgradePlano" style="width:100%; margin-bottom:10px;">
                ⬆️ Fazer Upgrade
            </button>
            <button class="btn-cancelar" id="btnFecharUpgrade" style="width:100%;">Fechar</button>
        `);
        document.getElementById('btnUpgradePlano').addEventListener('click', irParaAtualizarPlano);
        document.getElementById('btnFecharUpgrade').addEventListener('click', _ctx.fecharPopup);
        return;
    }

    _ctx.criarPopup(`
        <div style="max-height:70vh; overflow-y:auto; padding-right:8px;">
            <h3 style="text-align:center; margin-bottom:6px;">👥 Gerenciar Convidados</h3>
            <p style="text-align:center; font-size:0.85rem; color:var(--text-secondary); margin-bottom:20px;">
                Plano ${sanitizeHTML(plano)} — ${memberCount}/${limiteConvidados} convidado(s)
            </p>

            <div style="margin-bottom:20px;">
                <div style="font-size:0.8rem; font-weight:700; letter-spacing:2px; text-transform:uppercase;
                            color:var(--text-muted); margin-bottom:10px;">Convidados Ativos</div>
                ${renderMembersHtml(members)}
            </div>

            ${memberCount < limiteConvidados ? `
            <div style="border-top:1px solid var(--border); padding-top:20px;">
                <div style="font-size:0.8rem; font-weight:700; letter-spacing:2px; text-transform:uppercase;
                            color:#10b981; margin-bottom:14px;">+ Novo Convite</div>
                <input type="text"  id="inputNomeConvidado"         class="form-input" placeholder="Nome do convidado"   style="margin-bottom:10px;">
                <input type="email" id="inputEmailConvidado"        class="form-input" placeholder="Email do convidado"  style="margin-bottom:10px;">
                <input type="email" id="inputEmailConvidadoConfirm" class="form-input" placeholder="Confirme o email"    style="margin-bottom:16px;">
                <button class="btn-primary" id="btnEnviarConvite" style="width:100%;">
                    📨 Enviar Convite
                </button>
            </div>
            ` : `
            <div style="background:rgba(255,209,102,0.08); border:1px solid rgba(255,209,102,0.25);
                        border-radius:10px; padding:14px; text-align:center; margin-top:8px;">
                <div style="color:#ffd166; font-weight:600; margin-bottom:4px;">Limite atingido</div>
                <div style="font-size:0.85rem; color:var(--text-secondary);">
                    Você já possui ${memberCount}/${limiteConvidados} convidado(s) para o Plano ${sanitizeHTML(plano)}.
                </div>
            </div>
            `}
        </div>
        <button class="btn-cancelar" id="btnFecharConvidados" style="width:100%; margin-top:14px;">Fechar</button>
    `);

    // Vincular remoção via addEventListener — sem onclick inline
    document.querySelectorAll('.js-remove-member').forEach(btn => {
        btn.addEventListener('click', () => {
            const id   = btn.dataset.memberId;
            const nome = btn.dataset.memberName;
            removerConvidado(id, nome);
        });
    });

    const btnEnviar = document.getElementById('btnEnviarConvite');
    if (btnEnviar) btnEnviar.addEventListener('click', enviarConvite);

    document.getElementById('btnFecharConvidados').addEventListener('click', _ctx.fecharPopup);
}

window.alterarEmail = alterarEmail;

// ✅ Hostname do Supabase definido como constante imutável no topo do módulo.
//    Nunca usar window.SUPABASE_URL ou variáveis mutáveis em runtime.

// ✅ Controle de rate limit client-side para convites
//    Impede spam via duplo clique ou automação simples no frontend
//    (a proteção real deve existir também no backend via rate limiter)
const _conviteControl = (() => {
    let _ultimoEnvio = 0;
    const _INTERVALO_MIN_MS = 30_000; // 30 segundos entre convites

    return {
        podeEnviar() {
            return (Date.now() - _ultimoEnvio) >= _INTERVALO_MIN_MS;
        },
        registrar() {
            _ultimoEnvio = Date.now();
        },
        tempoRestante() {
            const restante = _INTERVALO_MIN_MS - (Date.now() - _ultimoEnvio);
            return Math.max(0, Math.ceil(restante / 1000));
        }
    };
})();

async function enviarConvite() {
    const nome  = document.getElementById('inputNomeConvidado')?.value.trim();
    const email = document.getElementById('inputEmailConvidado')?.value.trim().toLowerCase();
    const emailConfirm = document.getElementById('inputEmailConvidadoConfirm')?.value.trim().toLowerCase();

    if (!nome || nome.length < 2) {
        _ctx.mostrarNotificacao('Digite o nome do convidado (mínimo 2 caracteres).', 'error');
        return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        _ctx.mostrarNotificacao('Digite um email válido.', 'error');
        return;
    }
    if (email !== emailConfirm) {
        _ctx.mostrarNotificacao('Os emails não coincidem.', 'error');
        return;
    }

    // ✅ CORREÇÃO: rate limit client-side — bloqueia reenvios rápidos
    if (!_conviteControl.podeEnviar()) {
        _ctx.mostrarNotificacao(
            `Aguarde ${_conviteControl.tempoRestante()} segundo(s) antes de enviar outro convite.`,
            'warning'
        );
        return;
    }

    const btnEnviar = document.getElementById('btnEnviarConvite');
    if (btnEnviar) {
        btnEnviar.disabled = true;
        btnEnviar.textContent = '⏳ Enviando...';
    }

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Sessão expirada. Faça login novamente.');

        const response = await fetch('/api/send-guest-invite', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ guestName: nome, guestEmail: email }),
        });

        // ✅ Registra o envio apenas após resposta bem-sucedida do servidor
        _conviteControl.registrar();

        const result = await response.json();

        if (!result.success) {
            const err = result.error || '';

            if (err.startsWith('PLAN_BLOCK:')) {
                const [, planName] = err.split(':');
                _ctx.fecharPopup();
                mostrarPopupLimite(`Seu plano ${sanitizeHTML(planName)} não permite convidados. Faça upgrade para continuar.`);
                return;
            }
            if (err.startsWith('LIMIT_REACHED:')) {
                const parts    = err.split(':');
                const planName = parts[1];
                const total    = parts[2];
                const emails   = parts[3] || '';
                _ctx.fecharPopup();
                _ctx.criarPopup(`
                    <h3>🔒 Limite do Plano</h3>
                    <p style="margin:16px 0; color:var(--text-secondary); line-height:1.6;">
                        Você possui o Plano <strong>${sanitizeHTML(planName)}</strong>, que permite até
                        <strong>${sanitizeHTML(total)} email(s)</strong> no total.<br><br>
                        ${emails ? `Emails cadastrados: <strong>${sanitizeHTML(emails)}</strong>` : ''}
                    </p>
                    <button class="btn-primary" id="btnUpgradeLimite" style="width:100%; margin-bottom:10px;">⬆️ Fazer Upgrade</button>
                    <button class="btn-cancelar" id="btnFecharLimite" style="width:100%;">Fechar</button>
                `);
                document.getElementById('btnUpgradeLimite').addEventListener('click', irParaAtualizarPlano);
                document.getElementById('btnFecharLimite').addEventListener('click', _ctx.fecharPopup);
                return;
            }
            if (err === 'INVITE_RATE_LIMIT') {
                const secs  = typeof result.retry_after_secs === 'number' ? result.retry_after_secs : 3600;
                const horas = Math.floor(secs / 3600);
                const mins  = Math.ceil((secs % 3600) / 60);
                const tempo = horas > 0 ? `${horas}h ${mins}min` : `${mins} minuto(s)`;
                throw new Error(`Limite de convites atingido. Tente novamente em ${tempo}.`);
            }
            throw new Error('Não foi possível enviar o convite. Tente novamente.');
        }

        const code = result.code;
        if (!/^\d{6}$/.test(code)) {
            throw new Error('Resposta inválida do servidor. Contate o suporte.');
        }

        const expiresAt = new Date(result.expiresAt).toLocaleString('pt-BR');

        _ctx.fecharPopup();
        _ctx.criarPopup(`
            <div style="text-align:center;">
                <div style="font-size:3rem; margin-bottom:12px;">🎉</div>
                <h3 style="margin-bottom:6px;">Convite Enviado!</h3>
                <p style="color:var(--text-secondary); font-size:0.9rem; margin-bottom:24px;">
                    Email enviado para <strong>${sanitizeHTML(email)}</strong>.<br>
                    Compartilhe o código abaixo com <strong>${sanitizeHTML(nome)}</strong>:
                </p>
                <div style="background:rgba(16,185,129,0.1); border:2px solid rgba(16,185,129,0.4);
                            border-radius:16px; padding:24px; margin-bottom:20px;">
                    <div style="font-size:0.8rem; color:#6ee7b7; letter-spacing:2px; margin-bottom:10px;">
                        CÓDIGO DE 6 DÍGITOS
                    </div>
                    <div id="codigoConvite" style="font-size:3rem; font-weight:900; letter-spacing:12px;
                                color:#10b981; font-family:'Courier New',monospace;">
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:10px;">
                        ⏰ Expira em: ${sanitizeHTML(expiresAt)}
                    </div>
                </div>
                <button id="btnCopiarCodigo" class="btn-primary" style="width:100%; margin-bottom:10px;">
                    📋 Copiar Código
                </button>
                <div style="background:rgba(255,209,102,0.1); border:1px solid rgba(255,209,102,0.3);
                            border-radius:10px; padding:12px; font-size:0.85rem; color:#ffd166; margin-bottom:14px;">
                    ⚠️ Guarde este código! Ele não será exibido novamente.
                </div>
                <button class="btn-cancelar" id="btnFecharConviteEnviado" style="width:100%;">Fechar</button>
            </div>
        `);

        document.getElementById('codigoConvite').textContent = code;

        document.getElementById('btnCopiarCodigo').addEventListener('click', () => {
            navigator.clipboard.writeText(code)
                .then(() => _ctx.mostrarNotificacao('Código copiado!', 'success'))
                .catch(() => _ctx.mostrarNotificacao('Não foi possível copiar automaticamente.', 'error'));
        });

        document.getElementById('btnFecharConviteEnviado').addEventListener('click', _ctx.fecharPopup);

    } catch (err) {
        _ctx._log.error('CONVITE_001', err);
        _ctx.mostrarNotificacao(err.message || 'Não foi possível enviar o convite. Tente novamente.', 'error');
        if (btnEnviar) {
            btnEnviar.disabled = false;
            btnEnviar.textContent = '📨 Enviar Convite';
        }
    }
}

async function removerConvidado(memberId, memberName) {
    _ctx.confirmarAcao(`Remover o acesso de "${sanitizeHTML(memberName)}"? Ele(a) não poderá mais entrar na conta.`, async () => {
        try {
            const { error } = await supabase
                .from('account_members')
                .update({ is_active: false })
                .eq('id', memberId)
                .eq('owner_user_id', _ctx.usuarioLogado.userId);

            if (error) throw error;

            _ctx.mostrarNotificacao(`Acesso de ${sanitizeHTML(memberName)} removido.`, 'success');
            _ctx.fecharPopup();
            setTimeout(() => alterarEmail(), 200);
        } catch (err) {
            // ✅ CORREÇÃO: _log.error em vez de log.error
            _ctx._log.error('MEMBRO_001', err);
            _ctx.mostrarNotificacao('Não foi possível remover o convidado. Tente novamente.', 'error');
        }
    });
}

window.removerConvidado = removerConvidado;

function abrirAlterarSenha() {
    _ctx.criarPopup(`
        <h3>🔒 Alterar Senha</h3>
        <div class="small">Preencha os campos abaixo</div>
        <input type="password" id="novaSenha"          class="form-input" placeholder="Nova senha (mín. 8 caracteres)">
        <input type="password" id="confirmarNovaSenha" class="form-input" placeholder="Confirme a nova senha">
        <button class="btn-primary"  id="concluirSenha">Concluir</button>
        <button class="btn-cancelar" id="cancelarSenha">Cancelar</button>
    `);

    document.getElementById('cancelarSenha').addEventListener('click', _ctx.fecharPopup);

    document.getElementById('concluirSenha').addEventListener('click', async () => {
        const novaSenha      = document.getElementById('novaSenha').value;
        const confirmarSenha = document.getElementById('confirmarNovaSenha').value;

        if (!novaSenha || !confirmarSenha) {
            _ctx.mostrarNotificacao('Por favor, preencha todos os campos.', 'error');
            return;
        }
        if (novaSenha !== confirmarSenha) {
            _ctx.mostrarNotificacao('As senhas não coincidem.', 'error');
            return;
        }
        if (novaSenha.length < 8) {
            _ctx.mostrarNotificacao('A nova senha deve ter pelo menos 8 caracteres.', 'error');
            return;
        }
        if (!/[A-Z]/.test(novaSenha) || !/[0-9]/.test(novaSenha)) {
            _ctx.mostrarNotificacao('A senha deve conter ao menos uma letra maiúscula e um número.', 'error');
            return;
        }

        const btn = document.getElementById('concluirSenha');
        btn.disabled = true;
        btn.textContent = '⏳ Aguarde...';

        try {
            // Supabase Auth cuida do hash — a senha nunca é armazenada no cliente
            const { error } = await supabase.auth.updateUser({ password: novaSenha });
            if (error) throw error;

            _ctx.fecharPopup();
            _ctx.mostrarNotificacao('Senha alterada com sucesso!', 'success');

        } catch (error) {
            // ✅ CORREÇÃO: _log.error em vez de log.error
            _ctx._log.error('SENHA_001', error);
            _ctx.mostrarNotificacao('Não foi possível alterar a senha. Tente novamente.', 'error');
            btn.disabled = false;
            btn.textContent = 'Concluir';
        }
    });
}
window.abrirAlterarSenha = abrirAlterarSenha;

function trocarPerfil() {
    try { sessionStorage.removeItem('ge_perfil_id'); } catch (_) {}
    _ctx.salvarDados();
    _ctx.mostrarSelecaoPerfis();
}

function comoUsar() {
    // Passa o contexto real do usuário para o tour adaptar os passos
    // (convidados veem o fluxo reduzido; Casal/Família veem o passo de convites)
    iniciarTutorial({
        plano:   _ctx?.usuarioLogado?.plano,
        isGuest: Boolean(_ctx?.usuarioLogado?.isGuest),
    });
}

// Redireciona para a página de gerenciamento de assinatura (cancelar, trocar cartão, faturas)
function gerenciarAssinatura() {
    window.location.href = 'atualizarplano.html';
}

// ── Helpers de nomes de backup (client-side, armazenados em localStorage) ──
function _backupNomeKey() {
    return 'ge_backup_names_' + (_ctx.usuarioLogado?.userId || 'anon');
}
function _getBackupNomes() {
    try { return JSON.parse(localStorage.getItem(_backupNomeKey()) || '{}'); } catch { return {}; }
}
function _setBackupNome(date, nome) {
    try {
        const nomes = _getBackupNomes();
        nomes[date] = { nome: String(nome).slice(0, 80), ts: Date.now() };
        localStorage.setItem(_backupNomeKey(), JSON.stringify(nomes));
    } catch { /* localStorage pode estar bloqueado */ }
}

// ── Salva o estado ATUAL como um safety backup antes de restaurar ──────────
// Simplesmente trigger a salvarDados que gera um snapshot no servidor.
// O nome é armazenado localmente com a data de hoje.
async function _salvarSafetyBackup(nomePersonalizado, token) {
    const hoje = new Date().toISOString().slice(0, 10);
    _setBackupNome(hoje, nomePersonalizado || 'Antes da restauração — ' + new Date().toLocaleDateString('pt-BR'));
    // Força save para garantir que o servidor tem o estado mais recente
    try { await _ctx.salvarDados(); } catch { /* save silencioso */ }
}

// ========== HISTÓRICO DE BACKUP ==========
// Lista snapshots com nomes personalizados, permite nomear ponto atual antes de restaurar.
// Segurança: a sessão JWT é validada na Edge Function — usuário só acessa seus próprios backups.
async function abrirHistoricoBackup() {
    let token = null;
    try {
        const { supabase } = await import('../services/supabase-client.js?v=2');
        const { data: { session } } = await supabase.auth.getSession();
        token = session?.access_token ?? null;
    } catch { /* ignore */ }

    if (!token) {
        _ctx.mostrarNotificacao('Sessão expirada. Faça login novamente.', 'error');
        return;
    }

    const nomesMap = _getBackupNomes();

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '520px';

        const h3 = document.createElement('h3');
        h3.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:4px;';
        const hI = document.createElement('i');
        hI.className = 'fas fa-history';
        hI.style.color = 'var(--primary)';
        h3.appendChild(hI);
        h3.appendChild(document.createTextNode(' Histórico de Backups'));

        const sub = document.createElement('p');
        sub.style.cssText = 'color:var(--text-muted); font-size:0.8rem; margin-bottom:8px; line-height:1.5;';
        sub.textContent = 'Backups automáticos diários — disponíveis por 7 dias. Antes de restaurar, o sistema salva seu estado atual automaticamente.';

        // ── Caixa para nomear o estado atual ──────────────────────────────
        const nomearBox = document.createElement('div');
        nomearBox.style.cssText = 'background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.2); border-radius:12px; padding:12px 14px; margin-bottom:16px;';

        const nomearLabel = document.createElement('label');
        nomearLabel.htmlFor = 'backupNomeAtual';
        nomearLabel.style.cssText = 'font-size:0.75rem; font-weight:700; color:var(--primary); text-transform:uppercase; letter-spacing:0.06em; display:block; margin-bottom:6px;';
        nomearLabel.textContent = '📍 Nomear estado atual (opcional)';

        const nomearInput = document.createElement('input');
        nomearInput.type = 'text';
        nomearInput.id   = 'backupNomeAtual';
        nomearInput.className = 'form-input';
        nomearInput.placeholder = 'Ex: Antes das férias, Financeiro de junho…';
        nomearInput.maxLength = 80;
        nomearInput.style.cssText = 'font-size:0.85rem; padding:8px 12px;';

        const nomearHint = document.createElement('p');
        nomearHint.style.cssText = 'font-size:0.72rem; color:var(--text-muted); margin-top:6px;';
        nomearHint.textContent = 'Este nome aparecerá na lista de backups — útil para identificar o ponto de partida antes de uma restauração.';

        nomearBox.appendChild(nomearLabel);
        nomearBox.appendChild(nomearInput);
        nomearBox.appendChild(nomearHint);

        const listWrap = document.createElement('div');
        listWrap.style.cssText = 'max-height:340px; overflow-y:auto; margin-top:4px;';

        const loading = document.createElement('div');
        loading.style.cssText = 'text-align:center; padding:32px; color:var(--text-muted);';
        loading.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Carregando backups…';
        listWrap.appendChild(loading);

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'margin-top:14px; width:100%;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => _ctx.fecharPopup());

        box.appendChild(h3);
        box.appendChild(sub);
        box.appendChild(nomearBox);
        box.appendChild(listWrap);
        box.appendChild(btnFechar);

        // ── Carrega backups da API ────────────────────────────────────────
        fetch('/api/user-data?backup=1', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
        })
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(data => {
            listWrap.innerHTML = '';

            const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];

            if (snapshots.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'text-align:center; padding:32px; color:var(--text-muted);';
                empty.innerHTML = '<i class="fas fa-box-open" style="font-size:2rem; display:block; margin-bottom:12px; opacity:0.4;"></i>Nenhum backup disponível ainda.<br><span style="font-size:0.78rem;">Backups automáticos são criados diariamente após o primeiro uso.</span>';
                listWrap.appendChild(empty);
                return;
            }

            snapshots.forEach(snap => {
                const dateStr  = snap.snapshot_date || '';
                const parts    = dateStr.split('-');
                const dateBR   = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : dateStr;

                // Nome personalizado (do localStorage) ou label automático
                const nomeInfo = nomesMap[dateStr];
                const nomeLabel = nomeInfo?.nome || '';

                const row = document.createElement('div');
                row.style.cssText = 'padding:12px 14px; background:rgba(255,255,255,0.04); border-radius:12px; margin-bottom:8px; border:1px solid rgba(255,255,255,0.07);';

                const topRow = document.createElement('div');
                topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:4px;';

                // ── Badge de data + nome ──────────────────────────────────
                const leftDiv = document.createElement('div');

                const dateEl = document.createElement('div');
                dateEl.style.cssText = 'font-weight:700; font-size:0.9rem; color:var(--text-primary); display:flex; align-items:center; gap:8px;';
                dateEl.textContent = dateBR;

                // Indicar se é hoje (estado mais recente)
                const hoje = new Date().toISOString().slice(0, 10);
                if (dateStr === hoje) {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'font-size:0.62rem; font-weight:700; background:rgba(16,185,129,0.18); color:#10b981; padding:2px 7px; border-radius:99px;';
                    badge.textContent = 'Hoje';
                    dateEl.appendChild(badge);
                }

                const metaRow = document.createElement('div');
                metaRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:3px; flex-wrap:wrap;';

                const perfisCount = snap.profiles_count ?? '?';
                const hora = snap.created_at ? new Date(snap.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
                const metaText = document.createElement('span');
                metaText.style.cssText = 'font-size:0.74rem; color:var(--text-muted);';
                metaText.textContent = `${perfisCount} perfil(is)${hora ? ' · ' + hora : ''}`;
                metaRow.appendChild(metaText);

                // Nome personalizado (se houver)
                if (nomeLabel) {
                    const nomeEl = document.createElement('span');
                    nomeEl.style.cssText = 'font-size:0.72rem; background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.6); padding:1px 8px; border-radius:99px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                    nomeEl.title = nomeLabel;
                    nomeEl.textContent = '📍 ' + nomeLabel;
                    metaRow.appendChild(nomeEl);
                }

                leftDiv.appendChild(dateEl);
                leftDiv.appendChild(metaRow);

                const btnRestore = document.createElement('button');
                btnRestore.type = 'button';
                btnRestore.className = 'btn-primary';
                btnRestore.style.cssText = 'font-size:0.78rem; padding:7px 14px; white-space:nowrap; flex-shrink:0;';
                btnRestore.innerHTML = '<i class="fas fa-undo" aria-hidden="true"></i> Restaurar';

                btnRestore.addEventListener('click', () => {
                    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        _ctx.mostrarNotificacao('Data de snapshot inválida.', 'error');
                        return;
                    }

                    // ── Fluxo de 2 etapas: nomear estado atual → confirmar → restaurar ──
                    _abrirConfirmacaoRestauracao(dateStr, dateBR, token, nomearInput, btnRestore);
                });

                topRow.appendChild(leftDiv);
                topRow.appendChild(btnRestore);
                row.appendChild(topRow);
                listWrap.appendChild(row);
            });
        })
        .catch(() => {
            listWrap.innerHTML = '';
            const errEl = document.createElement('div');
            errEl.style.cssText = 'text-align:center; padding:32px; color:var(--danger);';
            errEl.innerHTML = '<i class="fas fa-exclamation-triangle" style="font-size:2rem; display:block; margin-bottom:12px;"></i>Não foi possível carregar os backups.<br><span style="font-size:0.78rem; color:var(--text-muted);">Tente novamente mais tarde.</span>';
            listWrap.appendChild(errEl);
        });
    });
}

// ── Confirmação em 2 etapas: salva estado atual → confirma → restaura ────
function _abrirConfirmacaoRestauracao(dateStr, dateBR, token, nomearInput, btnRestore) {
    const nomeAtual = (nomearInput?.value || '').trim() ||
        ('Antes da restauração para ' + dateBR + ' — ' + new Date().toLocaleDateString('pt-BR'));

    _ctx.criarPopupDOM((box2) => {
        box2.style.maxWidth = '420px';

        const h3 = document.createElement('h3');
        h3.innerHTML = '<i class="fas fa-shield-alt" style="color:#f59e0b" aria-hidden="true"></i> Confirmar Restauração';
        h3.style.marginBottom = '16px';

        // ── Safety backup info ──────────────────────────────────────────
        const safetyInfo = document.createElement('div');
        safetyInfo.style.cssText = 'background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.25); border-radius:12px; padding:12px 14px; margin-bottom:16px;';
        safetyInfo.innerHTML = `
            <div style="font-size:0.78rem; font-weight:700; color:#f59e0b; margin-bottom:6px;">
                <i class="fas fa-save" aria-hidden="true"></i> Ponto de retorno criado automaticamente
            </div>
            <div style="font-size:0.8rem; color:rgba(255,255,255,0.65); line-height:1.5;">
                Antes de restaurar, vamos salvar seu estado atual com o nome:
            </div>`;

        const nomeDisplay = document.createElement('div');
        nomeDisplay.style.cssText = 'font-size:0.85rem; font-weight:600; color:#fff; background:rgba(255,255,255,0.06); border-radius:8px; padding:8px 10px; margin-top:8px;';
        nomeDisplay.textContent = '📍 ' + nomeAtual;
        safetyInfo.appendChild(nomeDisplay);

        const safetyNote = document.createElement('p');
        safetyNote.style.cssText = 'font-size:0.74rem; color:rgba(255,255,255,0.4); margin-top:8px;';
        safetyNote.textContent = 'Disponível por 5 dias. Se se arrepender, você pode restaurar este ponto.';
        safetyInfo.appendChild(safetyNote);

        // ── Aviso destrutivo ─────────────────────────────────────────────
        const warning = document.createElement('div');
        warning.style.cssText = 'background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); border-radius:12px; padding:12px 14px; margin-bottom:20px;';
        warning.innerHTML = `
            <div style="font-size:0.78rem; font-weight:700; color:#f87171; margin-bottom:4px;">
                <i class="fas fa-exclamation-triangle" aria-hidden="true"></i> Ação destrutiva
            </div>
            <div style="font-size:0.8rem; color:rgba(255,255,255,0.65); line-height:1.5;">
                Será restaurado o backup de <strong>${sanitizeHTML(dateBR)}</strong>.<br>
                Todos os dados atuais serão substituídos.
            </div>`;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; gap:10px;';

        const btnConfirmar = document.createElement('button');
        btnConfirmar.className = 'btn-primary';
        btnConfirmar.type = 'button';
        btnConfirmar.style.cssText = 'flex:1; background:linear-gradient(135deg,#dc2626,#b91c1c);';
        btnConfirmar.innerHTML = '<i class="fas fa-undo" aria-hidden="true"></i> Restaurar agora';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar';
        btnCancelar.type = 'button';
        btnCancelar.style.flex = '1';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        btnConfirmar.addEventListener('click', async () => {
            btnConfirmar.disabled = true;
            btnConfirmar.textContent = '⏳ Salvando estado atual…';
            if (btnRestore) btnRestore.disabled = true;

            try {
                // 1. Salva estado atual como safety backup com nome personalizado
                await _salvarSafetyBackup(nomeAtual, token);

                btnConfirmar.textContent = '⏳ Restaurando…';

                // 2. Executa a restauração
                const resp = await fetch('/api/user-data', {
                    method: 'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({ action: 'restore', snapshot_date: dateStr }),
                });

                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err?.error || `HTTP ${resp.status}`);
                }

                _ctx.fecharPopup();
                _ctx.mostrarNotificacao('Backup restaurado! Recarregando…', 'success');
                setTimeout(() => window.location.reload(), 1500);

            } catch (e) {
                _ctx._log.error('BACKUP_RESTORE_002', e);
                btnConfirmar.disabled = false;
                if (btnRestore) btnRestore.disabled = false;
                btnConfirmar.innerHTML = '<i class="fas fa-undo" aria-hidden="true"></i> Restaurar agora';
                _ctx.mostrarNotificacao(`Erro: ${e.message || 'Tente novamente.'}`, 'error');
            }
        });

        row.appendChild(btnConfirmar);
        row.appendChild(btnCancelar);

        box2.appendChild(h3);
        box2.appendChild(safetyInfo);
        box2.appendChild(warning);
        box2.appendChild(row);
    });
}

// ========== RESETAR PERFIL ==========
// Apaga todos os dados financeiros do perfil ativo (transações, metas, contas, cartões).
// Antes de resetar: salva safety backup + exige confirmação dupla com "RESETAR".
async function resetarPerfil() {
    if (!_ctx.perfilAtivo) {
        _ctx.mostrarNotificacao('Nenhum perfil ativo.', 'error');
        return;
    }

    const nomePerfil = _ctx._sanitizeText(_ctx.perfilAtivo.nome || 'Perfil');

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '440px';

        const h3 = document.createElement('h3');
        h3.innerHTML = '<i class="fas fa-trash-alt" style="color:#ef4444" aria-hidden="true"></i> Resetar Perfil';
        h3.style.marginBottom = '16px';

        // ── Bloco de informações sobre o backup automático ───────────────
        const backupInfo = document.createElement('div');
        backupInfo.style.cssText = 'background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.2); border-radius:12px; padding:12px 14px; margin-bottom:14px;';
        backupInfo.innerHTML = `
            <div style="font-size:0.78rem; font-weight:700; color:#10b981; margin-bottom:5px;">
                <i class="fas fa-shield-alt" aria-hidden="true"></i> Backup automático será criado
            </div>
            <div style="font-size:0.8rem; color:rgba(255,255,255,0.65); line-height:1.5;">
                Antes de resetar, seus dados atuais serão salvos como backup nomeado "<em>Antes do reset — ${sanitizeHTML(nomePerfil)}</em>".<br>
                Este backup ficará disponível por <strong>5 dias</strong> em Configurações → Dados e Backup.
            </div>`;

        // ── Bloco de aviso do que será apagado ──────────────────────────
        const warnBox = document.createElement('div');
        warnBox.style.cssText = 'background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); border-radius:12px; padding:12px 14px; margin-bottom:16px;';
        warnBox.innerHTML = `
            <div style="font-size:0.78rem; font-weight:700; color:#f87171; margin-bottom:8px;">
                <i class="fas fa-exclamation-triangle" aria-hidden="true"></i> O seguinte será apagado permanentemente:
            </div>
            <ul style="font-size:0.82rem; color:rgba(255,255,255,0.65); line-height:1.8; padding-left:18px;">
                <li>Todas as transações</li>
                <li>Todas as metas e reservas</li>
                <li>Todas as contas fixas</li>
                <li>Todos os cartões de crédito</li>
                <li>Todos os orçamentos e tipos personalizados</li>
            </ul>
            <div style="font-size:0.75rem; color:rgba(255,255,255,0.35); margin-top:8px;">
                Nome, foto e plano do perfil são mantidos.
            </div>`;

        // ── Campo de confirmação ─────────────────────────────────────────
        const confirmLabel = document.createElement('label');
        confirmLabel.htmlFor = 'resetConfirmInput';
        confirmLabel.style.cssText = 'font-size:0.8rem; color:var(--text-secondary); display:block; margin-bottom:6px;';
        confirmLabel.innerHTML = 'Digite <strong style="color:#ef4444;">RESETAR</strong> para confirmar:';

        const confirmInput = document.createElement('input');
        confirmInput.type = 'text';
        confirmInput.id   = 'resetConfirmInput';
        confirmInput.className = 'form-input';
        confirmInput.placeholder = 'RESETAR';
        confirmInput.style.cssText = 'letter-spacing:0.1em; font-weight:700; text-transform:uppercase;';
        confirmInput.autocomplete = 'off';

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:10px; margin-top:14px;';

        const btnConfirmar = document.createElement('button');
        btnConfirmar.className = 'btn-primary';
        btnConfirmar.type = 'button';
        btnConfirmar.style.cssText = 'flex:1; background:linear-gradient(135deg,#dc2626,#b91c1c); opacity:0.5; cursor:not-allowed;';
        btnConfirmar.disabled = true;
        btnConfirmar.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i> Resetar perfil';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar';
        btnCancelar.type = 'button';
        btnCancelar.style.flex = '1';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        // Ativa botão apenas quando digitar "RESETAR"
        confirmInput.addEventListener('input', () => {
            const ok = confirmInput.value.trim().toUpperCase() === 'RESETAR';
            btnConfirmar.disabled = !ok;
            btnConfirmar.style.opacity = ok ? '1' : '0.5';
            btnConfirmar.style.cursor  = ok ? 'pointer' : 'not-allowed';
        });

        btnConfirmar.addEventListener('click', async () => {
            if (confirmInput.value.trim().toUpperCase() !== 'RESETAR') return;

            btnConfirmar.disabled = true;
            btnCancelar.disabled  = true;
            btnConfirmar.textContent = '⏳ Salvando backup…';

            try {
                // 1. Salva safety backup com nome descritivo
                const nomeBackup = 'Antes do reset — ' + nomePerfil + ' — ' + new Date().toLocaleDateString('pt-BR');
                const hoje = new Date().toISOString().slice(0, 10);
                _setBackupNome(hoje, nomeBackup);
                await _ctx.salvarDados();

                btnConfirmar.textContent = '⏳ Resetando…';

                // 2. Apaga todos os dados financeiros do perfil
                _ctx.transacoes          = [];
                _ctx.metas               = [];
                _ctx.contasFixas         = [];
                _ctx.cartoesCredito      = [];
                _ctx.orcamentos          = {};
                _ctx.tiposPersonalizados = [];

                // 3. Salva o estado vazio
                await _ctx.salvarDados(true); // urgente

                _ctx.fecharPopup();
                _ctx.atualizarTudo();
                _ctx.mostrarNotificacao(`Perfil "${nomePerfil}" resetado! Backup salvo por 5 dias.`, 'success');

                // Remove o perfil do cache para forçar recarregamento limpo
                try { sessionStorage.removeItem('ge_perfis_cache'); } catch { /* ignore */ }

            } catch (e) {
                _ctx._log.error('RESET_PERFIL_001', e);
                btnConfirmar.disabled = false;
                btnCancelar.disabled  = false;
                btnConfirmar.innerHTML = '<i class="fas fa-trash-alt" aria-hidden="true"></i> Resetar perfil';
                _ctx.mostrarNotificacao('Erro ao resetar o perfil. Tente novamente.', 'error');
            }
        });

        btnRow.appendChild(btnConfirmar);
        btnRow.appendChild(btnCancelar);

        box.appendChild(h3);
        box.appendChild(backupInfo);
        box.appendChild(warnBox);
        box.appendChild(confirmLabel);
        box.appendChild(confirmInput);
        box.appendChild(btnRow);
    });
}
window.resetarPerfil = resetarPerfil;

// ========== EXCLUIR CONTA (LGPD art. 18, VI — direito à eliminação) ==========
// Exclusão permanente e irreversível da conta de login + TODOS os dados (cascata no
// banco). Exige digitar o e-mail exato da conta para habilitar. Backend: Edge Function
// delete-account via proxy /api/user-data (action:"delete-account"), que revalida o
// e-mail contra o JWT no servidor. Após sucesso: logout + redireciona para login.
async function excluirConta() {
    const accountEmail = String(_ctx?.usuarioLogado?.email || '').trim().toLowerCase();
    const isGuest = Boolean(_ctx?.usuarioLogado?.isGuest);

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '460px';

        const h3 = document.createElement('h3');
        h3.innerHTML = '<i class="fas fa-user-slash" style="color:#ef4444" aria-hidden="true"></i> Excluir minha conta';
        h3.style.marginBottom = '16px';

        // ── Aviso destrutivo ─────────────────────────────────────────────
        const warnBox = document.createElement('div');
        warnBox.style.cssText = 'background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:12px; padding:12px 14px; margin-bottom:14px;';
        warnBox.innerHTML = `
            <div style="font-size:0.78rem; font-weight:700; color:#f87171; margin-bottom:8px;">
                <i class="fas fa-exclamation-triangle" aria-hidden="true"></i> Esta ação é permanente e irreversível
            </div>
            <ul style="font-size:0.82rem; color:rgba(255,255,255,0.65); line-height:1.8; padding-left:18px; margin:0;">
                <li>Sua conta de acesso será apagada</li>
                <li>Todos os dados financeiros, perfis e backups serão excluídos</li>
                <li>${isGuest ? 'Você perderá o acesso à conta que te convidou' : 'Convidados vinculados perderão o acesso'}</li>
            </ul>`;

        // ── Aviso de assinatura (só titular) ─────────────────────────────
        const subNote = document.createElement('div');
        subNote.style.cssText = 'background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.25); border-radius:10px; padding:10px 12px; margin-bottom:14px; font-size:0.8rem; color:#fbbf24; line-height:1.5;';
        subNote.innerHTML = '<i class="fas fa-exclamation-triangle" aria-hidden="true"></i> Se você tem assinatura ativa, cancele-a antes (em Gerenciar assinatura) para evitar cobranças futuras.';

        // ── Transparência LGPD (B1): retenção legal dos logs de acesso ──────
        // O restante (dados financeiros, perfis, backups) é apagado na hora pela cascata.
        const retentionNote = document.createElement('div');
        retentionNote.style.cssText = 'background:rgba(148,163,184,0.08); border:1px solid rgba(148,163,184,0.2); border-radius:10px; padding:10px 12px; margin-bottom:14px; font-size:0.78rem; color:var(--text-muted); line-height:1.5;';
        retentionNote.innerHTML = '<i class="fas fa-shield-halved" aria-hidden="true"></i> Por obrigação legal (Marco Civil da Internet, art. 15), os registros de acesso (data, hora e IP — <strong>sem seus dados financeiros</strong>) são mantidos por até <strong>6 meses</strong> após a exclusão e então apagados automaticamente.';

        // ── Confirmação por e-mail ───────────────────────────────────────
        const confirmLabel = document.createElement('label');
        confirmLabel.htmlFor = 'delAccountInput';
        confirmLabel.style.cssText = 'font-size:0.8rem; color:var(--text-secondary); display:block; margin-bottom:6px;';
        confirmLabel.innerHTML = 'Digite seu e-mail <strong style="color:#ef4444;">' + sanitizeHTML(accountEmail || 'da conta') + '</strong> para confirmar:';

        const confirmInput = document.createElement('input');
        confirmInput.type = 'email';
        confirmInput.id   = 'delAccountInput';
        confirmInput.className = 'form-input';
        confirmInput.placeholder = 'seu@email.com';
        confirmInput.autocomplete = 'off';

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:10px; margin-top:14px;';

        const btnConfirmar = document.createElement('button');
        btnConfirmar.className = 'btn-primary';
        btnConfirmar.type = 'button';
        btnConfirmar.style.cssText = 'flex:1; background:linear-gradient(135deg,#dc2626,#b91c1c); opacity:0.5; cursor:not-allowed;';
        btnConfirmar.disabled = true;
        btnConfirmar.innerHTML = '<i class="fas fa-user-slash" aria-hidden="true"></i> Excluir para sempre';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-cancelar';
        btnCancelar.type = 'button';
        btnCancelar.style.flex = '1';
        btnCancelar.textContent = 'Cancelar';
        btnCancelar.addEventListener('click', () => _ctx.fecharPopup());

        // Habilita só quando o e-mail bate (se conhecido) ou parece válido (fallback)
        confirmInput.addEventListener('input', () => {
            const val = confirmInput.value.trim().toLowerCase();
            const ok  = accountEmail ? (val === accountEmail) : (val.includes('@') && val.length > 4);
            btnConfirmar.disabled = !ok;
            btnConfirmar.style.opacity = ok ? '1' : '0.5';
            btnConfirmar.style.cursor  = ok ? 'pointer' : 'not-allowed';
        });

        btnConfirmar.addEventListener('click', async () => {
            const typed = confirmInput.value.trim().toLowerCase();
            if (!typed || (accountEmail && typed !== accountEmail)) return;

            btnConfirmar.disabled = true;
            btnCancelar.disabled  = true;
            btnConfirmar.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Excluindo…';

            let token = null;
            try {
                const { data: { session } } = await supabase.auth.getSession();
                token = session?.access_token ?? null;
            } catch { /* ignore */ }

            if (!token) {
                _ctx.mostrarNotificacao('Sessão expirada. Faça login novamente.', 'error');
                btnConfirmar.disabled = false; btnCancelar.disabled = false;
                btnConfirmar.innerHTML = '<i class="fas fa-user-slash" aria-hidden="true"></i> Excluir para sempre';
                return;
            }

            try {
                const resp = await fetch('/api/user-data', {
                    method: 'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({ action: 'delete-account', confirmEmail: typed }),
                });
                const result = await resp.json().catch(() => ({}));

                if (!resp.ok || !result?.ok) {
                    throw new Error(result?.message || result?.error || `HTTP ${resp.status}`);
                }

                // Sucesso: limpa sessão local e redireciona ao login
                try { sessionStorage.clear(); } catch { /* ignore */ }
                try { await logout(); } catch { /* best effort */ }
                _ctx.fecharPopup();
                _ctx.mostrarNotificacao('Conta excluída. Até logo 👋', 'success');
                setTimeout(() => { window.location.href = 'login.html'; }, 1200);

            } catch (e) {
                _ctx._log.error('DELETE_ACCOUNT_001', e);
                btnConfirmar.disabled = false; btnCancelar.disabled = false;
                btnConfirmar.innerHTML = '<i class="fas fa-user-slash" aria-hidden="true"></i> Excluir para sempre';
                _ctx.mostrarNotificacao(`Não foi possível excluir: ${e.message || 'tente novamente.'}`, 'error');
            }
        });

        btnRow.appendChild(btnConfirmar);
        btnRow.appendChild(btnCancelar);

        box.appendChild(h3);
        box.appendChild(warnBox);
        if (!isGuest) box.appendChild(subNote);
        box.appendChild(retentionNote);
        box.appendChild(confirmLabel);
        box.appendChild(confirmInput);
        box.appendChild(btnRow);
    });
}
window.excluirConta = excluirConta;

// ========== PERFIL: HUB + CONQUISTAS ==========
// O card de perfil vira clicável e abre um "hub" com o nível do usuário e
// opções (a 1ª é Conquistas). Cada perfil tem suas conquistas/nível próprios —
// o estado vem do dashboard via _ctx (engine em modules/achievements.js).

function _initPerfilCard() {
    const card = document.querySelector('.cfg-profile-card');
    if (!card || card.dataset.hubBound === '1') return;
    card.dataset.hubBound = '1';
    card.classList.add('is-clickable');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'Abrir perfil e conquistas');

    card.addEventListener('click', abrirPerfilHub);
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirPerfilHub(); }
    });

    _atualizarBadgeNivel();
}

// Atualiza/insere o mini-badge de nível dentro do card de perfil.
function _atualizarBadgeNivel() {
    try {
        _ctx.checarConquistas?.(); // garante backfill antes de ler o nível
        const nivel = computeLevel(_ctx.getConquistas || {});
        const info = document.querySelector('.cfg-profile-card .cfg-profile-info');
        if (!info) return;
        let badge = info.querySelector('.cfg-profile-levelbadge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'cfg-profile-levelbadge';
            info.appendChild(badge);
        }
        badge.textContent = '';
        const star = document.createElement('span'); star.textContent = '⭐';
        const txt  = document.createElement('span');
        txt.textContent = `Nível ${nivel.nivel} · ${nivel.titulo}`;
        badge.append(star, txt);
    } catch { /* badge é opcional */ }
}

// Hub de perfil — avatar, nome, nível + lista de opções (Conquistas primeiro).
function abrirPerfilHub() {
    try { _ctx.checarConquistas?.(); } catch {}
    const unlocked = _ctx.getConquistas || {};
    const nivel    = computeLevel(unlocked);
    const nome     = _ctx._sanitizeText?.(_ctx.perfilAtivo?.nome || 'Perfil') || 'Perfil';
    const fotoUrl  = _ctx._sanitizeImgUrl?.(_ctx.perfilAtivo?.foto) || '';

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '440px';

        // ── Cabeçalho do perfil ──────────────────────────────────────────
        const head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:center; gap:14px; margin-bottom:18px;';

        const avatar = document.createElement('div');
        avatar.style.cssText = 'width:58px; height:58px; border-radius:50%; flex-shrink:0; display:grid; place-items:center; font-size:1.5rem; font-weight:800; color:#fff; background:linear-gradient(135deg,#10b981,#059669); overflow:hidden;';
        if (fotoUrl) {
            const img = document.createElement('img');
            img.src = fotoUrl;
            img.alt = '';
            img.style.cssText = 'width:100%; height:100%; object-fit:cover;';
            avatar.appendChild(img);
        } else {
            avatar.textContent = nome.trim().charAt(0).toUpperCase() || 'U';
        }

        const hInfo = document.createElement('div');
        hInfo.style.minWidth = '0';
        const hNome = document.createElement('div');
        hNome.style.cssText = 'font-size:1.1rem; font-weight:800; color:var(--text-primary);';
        hNome.textContent = nome;
        const hNivel = document.createElement('div');
        hNivel.style.cssText = 'font-size:0.82rem; color:#f5a524; font-weight:700; margin-top:2px;';
        hNivel.textContent = `⭐ Nível ${nivel.nivel} · ${nivel.titulo}`;
        hInfo.append(hNome, hNivel);
        head.append(avatar, hInfo);

        // ── Lista de opções ──────────────────────────────────────────────
        const lista = document.createElement('div');
        lista.style.cssText = 'display:flex; flex-direction:column; gap:10px;';

        const opcao = (icon, titulo, sub, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cfg-item';
            b.style.cssText = 'width:100%; text-align:left;';
            const ic = document.createElement('div');
            ic.className = 'cfg-item-icon cfg-item-icon--gold';
            const iEl = document.createElement('span'); iEl.textContent = icon; iEl.style.fontSize = '1.05rem';
            ic.appendChild(iEl);
            const tw = document.createElement('div'); tw.className = 'cfg-item-text';
            const t1 = document.createElement('span'); t1.className = 'cfg-item-title'; t1.textContent = titulo;
            const t2 = document.createElement('span'); t2.className = 'cfg-item-sub';   t2.textContent = sub;
            tw.append(t1, t2);
            const arrow = document.createElement('i'); arrow.className = 'fas fa-chevron-right cfg-item-arrow'; arrow.setAttribute('aria-hidden', 'true');
            b.append(ic, tw, arrow);
            b.addEventListener('click', onClick);
            return b;
        };

        lista.appendChild(opcao('👤', 'Alterar nome', 'Mude seu nome ou apelido', () => {
            _ctx.fecharPopup();
            alterarNome();
        }));

        lista.appendChild(opcao('📷', 'Alterar foto de perfil', 'Escolha uma nova imagem', () => {
            _ctx.fecharPopup();
            document.getElementById('photoUpload')?.click();
        }));

        const total  = Object.keys(unlocked).length;
        lista.appendChild(opcao('🏆', 'Conquistas', `${total} desbloqueada(s) · nível ${nivel.nivel}`, () => {
            _ctx.fecharPopup();
            abrirConquistas();
        }));

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'width:100%; margin-top:16px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => _ctx.fecharPopup());

        box.append(head, lista, btnFechar);
    });
}

// Tela de Conquistas — nível no topo + grid de cards (engine renderiza).
function abrirConquistas() {
    try { _ctx.checarConquistas?.(); } catch {}

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '660px';
        box.style.width = '100%';

        const h3 = document.createElement('h3');
        h3.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:14px;';
        const hi = document.createElement('span'); hi.textContent = '🏆';
        h3.append(hi, document.createTextNode(' Conquistas'));

        const container = document.createElement('div');
        container.style.cssText = 'max-height:62vh; overflow-y:auto; padding-right:6px; margin:0 -2px;';

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'width:100%; margin-top:16px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => {
            window._reRenderConquistas = null;
            _ctx.fecharPopup();
            _atualizarBadgeNivel();
        });

        box.append(h3, container, btnFechar);

        const render = () => renderConquistas(container, {
            state:     _ctx.getConquistaState(),
            unlocked:  _ctx.getConquistas,
            formatBRL: _ctx.formatBRL,
        });
        render();
        // Permite que o dashboard re-renderize ao vivo quando algo desbloquear
        window._reRenderConquistas = render;
    });

    // Persiste eventuais backfills/desbloqueios feitos ao abrir
    try { _ctx.salvarDados?.(); } catch {}
}

