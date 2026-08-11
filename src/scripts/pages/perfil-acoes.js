// ----------------------------------------------------------------------------
// perfil-acoes.js — CRIAR PERFIL e TROCAR FOTO (LAZY, Passo 10)
//
// POR QUE FOI EXTRAÍDO: ~374 linhas em todo boot para duas ações que a maioria
// dos usuários faz uma vez na vida. Criar perfil só acontece no "+" da tela de
// perfis; trocar foto, no `change` de um <input type=file>. Nenhuma das duas
// participa da primeira pintura.
//
// O QUE FICOU DO OUTRO LADO (de propósito):
//   · `mostrarPopupLimite` — chamada de vários pontos quentes;
//   · `_gerarSignedUrl` — `carregarPerfis` a usa no boot para as fotos;
//   · `_renovarFotosExpiradas` — roda em timer, não por clique.
//
// APAGADO no caminho: `_IMG_SIGNATURES`, uma tabela de magic bytes declarada e
// nunca lida — `_validarMagicBytes` tem os bytes escritos à mão logo abaixo.
// Era código morto que parecia a fonte da verdade da validação.
//
// SEM alias local para `_ctx.usuarioLogado` / `_ctx.perfilAtivo`: os setters
// de _makeCtx trocam a referência ao entrar num perfil, e um `const` capturado
// no init apontaria para o objeto do boot. Mesma regra de db-contas-fixas.js.
// ----------------------------------------------------------------------------

import { supabase, refreshSession as hybridRefresh } from '../services/supabase-client.js?v=2';

let _ctx = null;

const fecharPopup                 = (...a) => _ctx.fecharPopup(...a);
const criarPopupDOM               = (...a) => _ctx.criarPopupDOM(...a);
const mostrarPopupLimite          = (...a) => _ctx.mostrarPopupLimite(...a);
const mostrarNotificacao          = (...a) => _ctx.mostrarNotificacao(...a);
const salvarDados                 = (...a) => _ctx.salvarDados(...a);
const atualizarTelaPerfis         = (...a) => _ctx.atualizarTelaPerfis(...a);
const atualizarReferenciasGlobais = (...a) => _ctx.atualizarReferenciasGlobais(...a);
const invalidarCachePerfis        = (...a) => _ctx.invalidarCachePerfis(...a);
const _resolverFotoPerfil         = (...a) => _ctx._resolverFotoPerfil(...a);
const _sanitizeImageFile          = (...a) => _ctx._sanitizeImageFile(...a);
const _sanitizeImgUrl             = (...a) => _ctx._sanitizeImgUrl(...a);
const _sanitizeText               = (...a) => _ctx._sanitizeText(...a);
const _gerarSignedUrl             = (...a) => _ctx._gerarSignedUrl(...a);
// Três níveis explícitos em vez de um Proxy: são os três que este módulo usa
// (10 error, 5 info, 2 warn) e não há como um nome errado passar despercebido.
// Proxy aqui seria esperteza sem teste que a exercite — o build não roda isto.
const _log = {
    info:  (...a) => _ctx._log.info(...a),
    warn:  (...a) => _ctx._log.warn(...a),
    error: (...a) => _ctx._log.error(...a),
};

export function init(ctx) { _ctx = ctx; }

export function adicionarNovoPerfil() {
    // ✅ Verificação local serve apenas como UX — a validação real ocorre no backend via RLS
    const plano       = _ctx.usuarioLogado.plano;
    const limitePerfis = _ctx.limitesPlano[plano] ?? 1; // fallback seguro: plano desconhecido = 1
    const perfisAtuais = _ctx.usuarioLogado.perfis.length;

    if (perfisAtuais >= limitePerfis) {
        mostrarPopupLimite();
        return;
    }

    // ✅ Popup construído via DOM — sem innerHTML com dados variáveis
    const container = criarPopupDOM((popup) => {
        const titulo = document.createElement('h3');
        titulo.textContent = 'Novo Perfil';

        const inputNome = document.createElement('input');
        inputNome.type        = 'text';
        inputNome.id          = 'novoPerfilNome';
        inputNome.className   = 'form-input';
        inputNome.placeholder = 'Nome do usuário (obrigatório)';
        inputNome.maxLength   = 50; // ✅ limite no próprio campo

        const inputFoto = document.createElement('input');
        inputFoto.type      = 'file';
        inputFoto.id        = 'novoPerfilFoto';
        inputFoto.className = 'form-input';
        inputFoto.accept    = 'image/jpeg,image/png,image/webp'; // ✅ restringe seleção
        inputFoto.style.padding = '10px';

        const btnCriar     = document.createElement('button');
        btnCriar.className = 'btn-primary';
        btnCriar.type      = 'button';
        btnCriar.textContent = 'Criar Perfil';

        const btnCancelar     = document.createElement('button');
        btnCancelar.className = 'btn-cancelar';
        btnCancelar.type      = 'button';
        btnCancelar.textContent = 'Cancelar';

        btnCancelar.addEventListener('click', fecharPopup);
        btnCriar.addEventListener('click', () => {
            if (btnCriar.disabled) return;
            btnCriar.disabled = true;
            btnCriar.textContent = 'Criando...';
            _criarPerfilHandler(inputNome, inputFoto, plano, limitePerfis)
                .finally(() => {
                    btnCriar.disabled = false;
                    btnCriar.textContent = 'Criar Perfil';
                });
        });

        popup.appendChild(titulo);
        popup.appendChild(inputNome);
        popup.appendChild(inputFoto);
        popup.appendChild(btnCriar);
        popup.appendChild(btnCancelar);
    });
}

async function _criarPerfilHandler(inputNome, inputFoto, plano, limitePerfis) {
    const nome = inputNome.value.trim();

    if (!nome) { alert('Digite o nome do usuário!'); return; }
    if (nome.length < 2) { alert('O nome deve ter pelo menos 2 caracteres.'); return; }
    if (_ctx.usuarioLogado.perfis.length >= limitePerfis) { mostrarPopupLimite(); fecharPopup(); return; }

    try {
        // ── Verifica sessão inicial ───────────────────────────────────────
        const { data: { session: sessionInicial }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !sessionInicial?.user?.id) throw new Error('SEM_SESSAO_VALIDA');

        const effectiveUserId = _ctx.usuarioLogado.effectiveUserId || sessionInicial.user.id;

        _log.info('[_criarPerfilHandler] effectiveUserId:', effectiveUserId.slice(0, 8) + '...');

        // ── Verificação de limite do plano ────────────────────────────────
        const limiteLocal = _ctx.limitesPlano[_ctx.usuarioLogado.plano] ?? 1;
        _log.info('[_criarPerfilHandler] Plano:', _ctx.usuarioLogado.plano, '| Limite:', limiteLocal, '| Perfis:', _ctx.usuarioLogado.perfis.length);

        if (_ctx.usuarioLogado.perfis.length >= limiteLocal) {
            mostrarPopupLimite();
            fecharPopup();
            return;
        }

        // ── Upload de foto (opcional) ─────────────────────────────────────
        let fotoUrl = null;

        if (inputFoto.files && inputFoto.files[0]) {
            const arquivoOriginal = inputFoto.files[0];

            if (arquivoOriginal.size > _ctx._FOTO_ORIGEM_MAX_BYTES) { alert('A foto é grande demais (máx. 25MB).'); return; }

            const mimesPermitidos = ['image/jpeg', 'image/png', 'image/webp'];
            if (!mimesPermitidos.includes(arquivoOriginal.type)) { alert('Tipo de arquivo inválido. Use JPG, PNG ou WebP.'); return; }

            const magicValido = await _validarMagicBytes(arquivoOriginal);
            if (!magicValido) { alert('Arquivo inválido. O conteúdo não corresponde a uma imagem real.'); return; }

            const arquivo = await _sanitizeImageFile(arquivoOriginal);
            if (!arquivo) {
                alert('Não foi possível processar a imagem. Tente com outro arquivo.');
                return;
            }

            // ── FIX-2: Token garantidamente fresco via refresh (cookie HttpOnly) ───
            // getSession() lê do cache em memória; o refresh bate em
            // /api/auth-session (cookie HttpOnly) e renova o access token.
            let sessionFresh;
            try {
                let refreshData = null, refreshError = null;
                try {
                    const grant = await hybridRefresh();
                    const { data } = await supabase.auth.getSession();
                    refreshData = data;
                    if (!grant) refreshError = new Error('refresh_rejected');
                } catch (e) { refreshError = e; }

                if (refreshError || !refreshData?.session?.access_token) {
                    // Fallback: tenta getSession uma última vez
                    _log.warn('[_criarPerfilHandler] refreshSession falhou — tentando fallback getSession. Erro:', refreshError?.message);
                    const { data: fallbackData, error: fallbackError } =
                        await supabase.auth.getSession();

                    if (fallbackError || !fallbackData?.session?.access_token) {
                        _log.error('PERFIL_TOKEN_001',
                            refreshError || fallbackError || 'token ausente após refresh e fallback');
                        alert('Sua sessão expirou. Por favor, faça login novamente.');
                        if (typeof AuthGuard !== 'undefined') {
                            AuthGuard.logout('TOKEN_EXPIRED');
                        } else {
                            window.location.replace('login.html');
                        }
                        return;
                    }
                    _log.warn('[_criarPerfilHandler] Usando token do cache como fallback.');
                    sessionFresh = fallbackData.session;
                } else {
                    sessionFresh = refreshData.session;
                }
            } catch (tokenErr) {
                _log.error('PERFIL_TOKEN_002', tokenErr);
                alert('Erro ao validar sua sessão. Por favor, faça login novamente.');
                return;
            }

            _log.info('[_criarPerfilHandler] Token fresco obtido. Iniciando upload...');

            const formData = new FormData();
            formData.append('file', arquivo);

            const uploadResponse = await fetch(
                '/api/upload-profile-photo',
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${sessionFresh.access_token}`,
                    },
                    body: formData,
                }
            );

            if (!uploadResponse.ok) {
                let uploadErrorMsg = 'Erro ao fazer upload da foto. Tente novamente.';
                let rawBody = '';
                try {
                    rawBody = await uploadResponse.text();
                    const parsed = JSON.parse(rawBody);
                    uploadErrorMsg = parsed.error ?? parsed.message ?? uploadErrorMsg;
                } catch (_) {
                    if (rawBody) uploadErrorMsg = rawBody.slice(0, 200);
                }
                _log.error('PERFIL_FOTO_001',
                    `HTTP ${uploadResponse.status} | ${uploadErrorMsg}`);
                console.error('[UPLOAD DEBUG]',
                    'status:', uploadResponse.status,
                    '| body:', rawBody.slice(0, 500));
                alert(uploadErrorMsg);
                return;
            }

            const uploadData = await uploadResponse.json();
            const nomeArquivo = uploadData?.path;

            if (!nomeArquivo) {
                _log.error('PERFIL_FOTO_001B', 'path ausente na resposta da edge function');
                alert('Erro ao processar a foto. Tente novamente.');
                return;
            }

            // Salva o PATH no banco (não a signed URL) para que _resolverFotoPerfil
            // possa renovar a URL automaticamente — signed URLs expiram em 7 dias.
            if (uploadData.path) {
                fotoUrl = uploadData.path; // path relativo: "{userId}/{ts}.ext"
            } else if (uploadData.signedUrl) {
                // Fallback legado: sem path na resposta — usa signed URL diretamente
                fotoUrl = _sanitizeImgUrl(uploadData.signedUrl) || null;
            } else {
                _log.error('PERFIL_FOTO_002', 'path e signedUrl ausentes na resposta');
                alert('Erro ao processar a foto. Tente novamente.');
                return;
            }
        }

        // ── Insere perfil no banco ────────────────────────────────────────
        _log.info('[_criarPerfilHandler] Inserindo perfil no banco...');

        const { data: novoPerfil, error } = await supabase
            .from('profiles')
            .insert({
                name:      nome,
                photo_url: fotoUrl,
                user_id:   effectiveUserId,
            })
            .select()
            .single();

        if (error) {
            // Loga detalhes completos no console (visível no DevTools mesmo em produção)
            console.error('[PERFIL_INSERT] code:', error.code, '| message:', error.message, '| details:', error.details, '| hint:', error.hint);
            if (error.code === '23505' || error.code === '23514' || error.code === '42501' || error.code === '42P17') {
                mostrarPopupLimite();
            } else {
                alert(`Erro ao criar perfil (${error.code || 'HTTP 400'}): ${error.message || 'Tente novamente.'}`);
            }
            fecharPopup();
            return;
        }

        _log.info('[_criarPerfilHandler] Perfil inserido com sucesso. ID:', novoPerfil.id);

        _ctx.usuarioLogado.perfis.push({
            id:   novoPerfil.id,
            nome: _sanitizeText(novoPerfil.name),
            foto: _sanitizeImgUrl(novoPerfil.photo_url),
        });

        invalidarCachePerfis(); // Perfil novo → invalida cache para próximo carregamento
        fecharPopup();
        atualizarTelaPerfis();
        atualizarReferenciasGlobais();
        mostrarNotificacao('Perfil criado com sucesso!', 'success');

    } catch (error) {
        _log.error('PERFIL_002', error);
        if (error.message === 'SEM_SESSAO_VALIDA') {
            alert('Sessão inválida. Por favor, faça login novamente.');
            window.location.replace('login.html');
        } else {
            alert('Ocorreu um erro ao criar o perfil. Tente novamente.');
        }
    }
}


async function _validarMagicBytes(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const arr = new Uint8Array(e.target.result);
            const matchJpeg = [0xFF, 0xD8, 0xFF].every((b, i) => arr[i] === b);
            const matchPng  = [0x89, 0x50, 0x4E, 0x47].every((b, i) => arr[i] === b);
            // WebP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
            const matchWebp = arr[0] === 0x52 && arr[1] === 0x49 &&
                              arr[2] === 0x46 && arr[3] === 0x46 &&
                              arr[8] === 0x57 && arr[9] === 0x45 &&
                              arr[10]=== 0x42 && arr[11]=== 0x50;
            resolve(matchJpeg || matchPng || matchWebp);
        };
        reader.onerror = () => resolve(false);
        reader.readAsArrayBuffer(file.slice(0, 12));
    });
}

// ✅ Gera ou renova signed URL para um path já existente no storage

export async function alterarFoto(event) {
    const fileOriginal = event.target.files[0];
    if (!fileOriginal) return;
    if (!_ctx.perfilAtivo) { alert('Erro: Nenhum perfil ativo encontrado.'); return; }

    if (fileOriginal.size > _ctx._FOTO_ORIGEM_MAX_BYTES) { alert('A foto é grande demais (máx. 25MB).'); return; }

    const mimesPermitidos = ['image/jpeg', 'image/png', 'image/webp'];
    if (!mimesPermitidos.includes(fileOriginal.type)) { alert('Tipo de arquivo inválido. Use JPG, PNG ou WebP.'); return; }

    const magicValido = await _validarMagicBytes(fileOriginal);
    if (!magicValido) { alert('Arquivo inválido. O conteúdo não corresponde a uma imagem real.'); return; }

    try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !session || !session.user || !session.user.id) throw new Error('SEM_SESSAO_VALIDA');

        const file = await _sanitizeImageFile(fileOriginal);

        if (!file) {
            alert('Não foi possível processar a imagem. Tente com outro arquivo.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        const uploadResponse = await fetch(
            '/api/upload-profile-photo',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                },
                body: formData,
            }
        );

        if (!uploadResponse.ok) {
            let uploadErrorMsg = 'Erro ao fazer upload. Tente novamente.';
            try {
                const uploadErrorData = await uploadResponse.json();
                uploadErrorMsg = uploadErrorData.message ?? uploadErrorMsg;
            } catch (_) {}
            _log.error('FOTO_001', `Status: ${uploadResponse.status}`);
            alert(uploadErrorMsg);
            return;
        }

        const uploadData = await uploadResponse.json();
        const storagePath = uploadData?.path;

        if (!storagePath) {
            _log.error('FOTO_001B', 'path ausente na resposta da edge function');
            alert('Erro ao processar a foto. Tente novamente.');
            return;
        }

        const urlSegura = await _gerarSignedUrl(storagePath);
        if (!urlSegura) { alert('Erro interno ao processar a foto. Tente novamente.'); return; }

        const { error: updateError } = await supabase
            .from('profiles')
            .update({ photo_url: storagePath })
            .eq('id', _ctx.perfilAtivo.id)
            .eq('user_id', session.user.id)
            .select()
            .single();

        if (updateError) { _log.error('FOTO_003', updateError); alert('Erro ao salvar a foto. Tente novamente.'); return; }

        _ctx.perfilAtivo.foto         = urlSegura;
        _ctx.perfilAtivo._storagePath = storagePath;

        const idx = _ctx.usuarioLogado.perfis.findIndex(p => p.id === _ctx.perfilAtivo.id);
        if (idx !== -1) {
            _ctx.usuarioLogado.perfis[idx].foto         = urlSegura;
            _ctx.usuarioLogado.perfis[idx]._storagePath = storagePath;
        }

        const userPhotoEl = document.getElementById('userPhoto');
        if (userPhotoEl) userPhotoEl.src = urlSegura;

        // Sincronizar foto na topbar mobile
        const mobilePhotoEl = document.getElementById('mobileUserPhoto');
        const mobilePhotoFbEl = document.getElementById('mobileUserPhotoFallback');
        if (mobilePhotoEl)  { mobilePhotoEl.src = urlSegura; mobilePhotoEl.style.display = ''; }
        if (mobilePhotoFbEl) mobilePhotoFbEl.style.display = 'none';

        await salvarDados();
        atualizarTelaPerfis();
        atualizarReferenciasGlobais();
        mostrarNotificacao('Foto alterada com sucesso!', 'success');

    } catch (error) {
        _log.error('FOTO_004', error);
        alert('Ocorreu um erro ao alterar a foto. Tente novamente.');
    }
}
