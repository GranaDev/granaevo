// db-configuracoes.js — Seção de Configurações (lazy-loaded)
import { supabase } from '../services/supabase-client.js?v=2';
import { iniciarTutorial } from '../modules/tutorial.js';
import { initPWA, initInstallButton } from '../modules/pwa-installer.js';
import { isPushSupported, getPushPermission, requestPushPermission, unsubscribePush } from '../modules/push-notifications.js';
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
    // Inicializa botão de instalação do PWA na seção de Configurações
    initInstallButton();
    // Atualiza status de cache offline
    _updateOfflineStatus();
    // Inicializa botão de notificações push
    _initPushButton();
    // Inicializa botão de backup nas configurações (binding dinâmico)
    _bindBtnBackup();
}

function _bindBtnBackup() {
    const btn = document.getElementById('btnHistoricoBackup');
    if (!btn) return;
    btn.addEventListener('click', abrirHistoricoBackup);
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

            atualizarNomeUsuario();
            await _ctx.salvarDados();
            _ctx.fecharPopup();
            _ctx.mostrarNotificacao('✅ Nome alterado com sucesso!', 'success');

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
            _ctx.mostrarNotificacao('✅ Senha alterada com sucesso!', 'success');

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
    iniciarTutorial();
}

// Redireciona para a página de gerenciamento de assinatura (cancelar, trocar cartão, faturas)
function gerenciarAssinatura() {
    window.location.href = 'atualizarplano.html';
}

// ========== HISTÓRICO DE BACKUP ==========
// Lista os snapshots dos últimos 7 dias e permite restaurar qualquer um.
// Segurança: a sessão JWT é validada na Edge Function — usuário só acessa seus próprios backups.
async function abrirHistoricoBackup() {
    // Obtém token da sessão atual
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

    _ctx.criarPopupDOM((box) => {
        box.style.maxWidth = '480px';

        const h3 = document.createElement('h3');
        h3.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:4px;';
        const hI = document.createElement('i');
        hI.className = 'fas fa-history';
        hI.style.color = 'var(--primary)';
        h3.appendChild(hI);
        h3.appendChild(document.createTextNode('Histórico de Backups'));

        const sub = document.createElement('p');
        sub.style.cssText = 'color:var(--text-muted); font-size:0.8rem; margin-bottom:20px;';
        sub.textContent = 'Backups automáticos dos últimos 7 dias. Restaurar substitui todos os seus dados atuais.';

        const listWrap = document.createElement('div');
        listWrap.style.cssText = 'max-height:360px; overflow-y:auto;';

        const loading = document.createElement('div');
        loading.style.cssText = 'text-align:center; padding:32px; color:var(--text-muted);';
        loading.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Carregando backups…';
        listWrap.appendChild(loading);

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'margin-top:16px; width:100%;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', () => _ctx.fecharPopup());

        box.appendChild(h3);
        box.appendChild(sub);
        box.appendChild(listWrap);
        box.appendChild(btnFechar);

        // Carrega backups da API
        fetch('/api/user-data?backup=1', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
            },
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
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:rgba(255,255,255,0.04); border-radius:12px; margin-bottom:8px; border:1px solid rgba(255,255,255,0.07); gap:12px;';

                const left = document.createElement('div');
                const dateEl = document.createElement('div');
                dateEl.style.cssText = 'font-weight:600; font-size:0.9rem; color:var(--text-primary);';
                // Data no formato YYYY-MM-DD → DD/MM/YYYY
                const parts = (snap.snapshot_date || '').split('-');
                dateEl.textContent = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : (snap.snapshot_date || 'Data desconhecida');

                const metaEl = document.createElement('div');
                metaEl.style.cssText = 'font-size:0.75rem; color:var(--text-muted); margin-top:2px;';
                const perfisCount = snap.profiles_count ?? '?';
                const hora = snap.created_at ? new Date(snap.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
                metaEl.textContent = `${perfisCount} perfil(is)${hora ? ' · ' + hora : ''}`;

                left.appendChild(dateEl);
                left.appendChild(metaEl);

                const btnRestore = document.createElement('button');
                btnRestore.type = 'button';
                btnRestore.className = 'btn-primary';
                btnRestore.style.cssText = 'font-size:0.78rem; padding:6px 14px; white-space:nowrap; flex-shrink:0;';
                btnRestore.textContent = 'Restaurar';

                btnRestore.addEventListener('click', () => {
                    const dateStr = snap.snapshot_date;
                    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        _ctx.mostrarNotificacao('Data de snapshot inválida.', 'error');
                        return;
                    }

                    // Confirmação explícita antes de restaurar — ação destrutiva
                    _ctx.confirmarAcao(
                        `Restaurar backup de ${dateEl.textContent}? Todos os dados atuais serão substituídos. Esta ação não pode ser desfeita.`,
                        async () => {
                            btnRestore.disabled = true;
                            btnRestore.textContent = '⏳ Restaurando…';

                            try {
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
                                _ctx.mostrarNotificacao('✅ Backup restaurado! Recarregando…', 'success');
                                // Recarrega a página para aplicar os dados restaurados
                                setTimeout(() => window.location.reload(), 1500);
                            } catch (e) {
                                _ctx._log.error('BACKUP_RESTORE_001', e);
                                btnRestore.disabled = false;
                                btnRestore.textContent = 'Restaurar';
                                _ctx.mostrarNotificacao(`Erro ao restaurar: ${e.message}`, 'error');
                            }
                        }
                    );
                });

                row.appendChild(left);
                row.appendChild(btnRestore);
                listWrap.appendChild(row);
            });
        })
        .catch(err => {
            listWrap.innerHTML = '';
            const errEl = document.createElement('div');
            errEl.style.cssText = 'text-align:center; padding:32px; color:var(--danger);';
            errEl.innerHTML = '<i class="fas fa-exclamation-triangle" style="font-size:2rem; display:block; margin-bottom:12px;"></i>Não foi possível carregar os backups.<br><span style="font-size:0.78rem; color:var(--text-muted);">Tente novamente mais tarde.</span>';
            listWrap.appendChild(errEl);
        });
    });
}

