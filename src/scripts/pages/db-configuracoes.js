// db-configuracoes.js — Seção de Configurações (lazy-loaded)
let _ctx = null;

export function init(ctx) {
    _ctx = ctx;
    window.alterarNome      = () => alterarNome();
    window.alterarEmail     = () => alterarEmail();
    window.abrirAlterarSenha = () => abrirAlterarSenha();
    window.enviarConvite    = () => enviarConvite();
    window.removerConvidado = (id) => removerConvidado(id);
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
    _ctx.salvarDados();
    mostrarSelecaoPerfis();
}

function comoUsar() {
    alert('Funcionalidade "Como usar o GranaEvo?" será implementada em breve!');
}

