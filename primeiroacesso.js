/**
 * GranaEvo — primeiroacesso.js (v8)
 *
 * ============================================================
 * HISTÓRICO DE CORREÇÕES — TODAS ATIVAS
 * ============================================================
 *
 * [FIX-401] Adicionado header 'apikey' com SUPABASE_ANON_KEY em todas as
 *   chamadas a Edge Functions públicas. O gateway do Supabase exige essa
 *   chave para rotear a requisição, mesmo em endpoints sem autenticação.
 *   Sem esse header, o gateway retorna 401 antes de chegar na função.
 *
 * [FIX-EMAIL-CONFIRM] Adicionada chamada à Edge Function confirm-email
 *   logo após o signUp. Como o Supabase pode exigir confirmação de email,
 *   o usuário não teria sessão e não poderia fazer login. A função
 *   confirm-email valida internamente contra a tabela subscriptions
 *   (pagamento aprovado + email correto + senha ainda não criada) e só
 *   então confirma o email via admin API. Isso é seguro pois a validação
 *   de legitimidade acontece no backend.
 *
 * [FIX-FLOW-ORDER] Fluxo pós-signUp reestruturado:
 *   1. signUp                          → obtém userId
 *   2. _confirmEmail                   → auto-confirma + atualiza subscription
 *   3. signInWithPassword              → obtém session + accessToken
 *   4. _linkViaBackendWithRetry        → vincula via JWT (agora disponível)
 *   5. _acceptTerms                    → registra LGPD/GDPR
 *   6. _createUserData                 → cria perfil inicial
 *   7. redirect                        → envia para login.html
 *
 * [FIX-02] Normaliza email lowercase antes de qualquer operação
 * [SEC-06] Rate limit: 5s cooldown no "Verificar Email"
 * [SEC-08] Rate limit: 3s cooldown no "Criar Senha e Acessar"
 * [SEC-TIMEOUT] fetchWithTimeout aborta requisições após 10s
 * [SEC-03] Resposta genérica para estados não-ready (anti-enumeração)
 * [SEC-04] Sem innerHTML com dados externos — DOM programático
 * [SEC-05] Limpa campos de senha em todos os caminhos de saída
 * [SEC-07] setButtonLoading usa cloneNode + replaceChildren (zero innerHTML)
 * [SEC-09] autocomplete + maxlength reforçados via JS (cobre HTML cacheado)
 * [SEC-10] userId validado como authData.user.id antes de ops de banco
 * [SEC-INLINE-STYLE] Nenhum style.* direto — classList apenas (compatível CSP)
 * [A11Y-ARIA-LIVE] aria-live="assertive" reforçado via JS
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client.js?v=8';

// ==========================================
// CONFIGURAÇÃO
// ==========================================

/** [SEC-06] Cooldown do botão "Verificar Email": 5 segundos */
const EMAIL_CHECK_COOLDOWN_MS = 5_000;

/** [SEC-08] Cooldown do botão "Criar Senha e Acessar": 3 segundos */
const SUBMIT_COOLDOWN_MS = 3_000;

/** [SEC-TIMEOUT] Timeout máximo para qualquer fetch: 10 segundos */
const FETCH_TIMEOUT_MS = 10_000;

// ==========================================
// ELEMENTOS DO DOM
// ==========================================
const accessForm           = document.getElementById('accessForm');
const emailCheckState      = document.getElementById('emailCheckState');
const passwordInputs       = document.getElementById('passwordInputs');
const checkEmailBtn        = document.getElementById('checkEmailBtn');
const submitBtn            = document.getElementById('submitBtn');

const emailInput           = document.getElementById('email');
const passwordInput        = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirmPassword');
const termsCheckbox        = document.getElementById('termsCheckbox');

const alertBox             = document.getElementById('alertBox');
const alertMessage         = document.getElementById('alertMessage');
const infoBox              = document.getElementById('infoBox');
const userName             = document.getElementById('userName');
const userEmail            = document.getElementById('userEmail');
const planName             = document.getElementById('planName');

const confirmError         = document.getElementById('confirmError');
const termsError           = document.getElementById('termsError');
const strengthFill         = document.getElementById('strengthFill');
const strengthText         = document.getElementById('strengthText');

const togglePassword1      = document.getElementById('togglePassword1');
const togglePassword2      = document.getElementById('togglePassword2');
const checkboxWrapper      = document.querySelector('.checkbox-wrapper');

// [SEC-TERMS-CACHE] Cacheado no topo — antes era consultado via getElementById
// dentro de dois event handlers separados, causando dupla query ao DOM.
const termsWarning         = document.getElementById('termsWarning');

// ==========================================
// ESTADO
// ==========================================
let currentSubscriptionData = null;

/** [SEC-06] Timestamp da última verificação de email */
let lastEmailCheckAt = 0;

/** [SEC-08] Timestamp da última tentativa de submit */
let lastSubmitAt = 0;

// ==========================================
// INICIALIZAÇÃO
// ==========================================

// [SEC-09] autocomplete="new-password" reforçado via JS para cobrir HTML cacheado
// [SEC-MAXLENGTH] maxlength reforçado via JS pela mesma razão
if (passwordInput) {
    passwordInput.setAttribute('autocomplete', 'new-password');
    passwordInput.setAttribute('maxlength',    '128');
}
if (confirmPasswordInput) {
    confirmPasswordInput.setAttribute('autocomplete', 'new-password');
    confirmPasswordInput.setAttribute('maxlength',    '128');
}
if (emailInput) {
    emailInput.setAttribute('maxlength', '254');
}

// [A11Y-ARIA-LIVE] Garante que leitores de tela anunciem os alertas.
// O role="alert" + aria-live="assertive" no HTML já cobre a maioria dos casos,
// mas reforçar via JS garante que HTML cacheado sem o atributo também funcione.
if (alertBox) {
    alertBox.setAttribute('aria-live', 'assertive');
    alertBox.setAttribute('aria-atomic', 'true');
}

// ==========================================
// VERIFICAR EMAIL
// ==========================================
checkEmailBtn.addEventListener('click', async () => {

    // [SEC-06] Rate limit: bloqueia se ainda dentro do cooldown
    const now = Date.now();
    if (now - lastEmailCheckAt < EMAIL_CHECK_COOLDOWN_MS) {
        const remaining = Math.ceil((EMAIL_CHECK_COOLDOWN_MS - (now - lastEmailCheckAt)) / 1000);
        showAlert('warning', `Aguarde ${remaining}s antes de tentar novamente.`);
        return;
    }

    // [FIX-02] Normaliza lowercase antes de qualquer operação
    const email = (emailInput.value || '').trim().toLowerCase();

    if (!email) {
        showAlert('error', 'Por favor, digite seu email.');
        return;
    }

    if (!isValidEmail(email)) {
        showAlert('error', 'Email inválido. Digite um email válido.');
        return;
    }

    // Registra timestamp ANTES da requisição para cobrir erros de rede também
    lastEmailCheckAt = Date.now();

    setButtonLoading(checkEmailBtn, 'Verificando...');

    try {
        // [FIX-401] Header 'apikey' obrigatório para o gateway do Supabase
        // rotear a requisição até a Edge Function. Sem ele, retorna 401
        // antes mesmo de chegar no código da função.
        // A anon key é pública por design no Supabase — segura no frontend.
        //
        // [SEC-02] Sem Authorization header — endpoint é pré-auth público.
        // [SEC-TIMEOUT] fetchWithTimeout aborta após 10s.
        const response = await fetchWithTimeout(
            `${SUPABASE_URL}/functions/v1/check-email-status`,
            {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey':       SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({ email }),
            }
        );

        if (!response.ok) {
            showAlert('error', 'Erro de conexão. Tente novamente.');
            return;
        }

        const result = await response.json();

        switch (result.status) {
            case 'ready':
                currentSubscriptionData = result.data;
                showPasswordForm(result.data);
                break;

            // [SEC-03] Resposta genérica para todos os estados não-ready.
            // Impede enumeração: atacante não distingue "inexistente",
            // "pagamento pendente" ou "conta já criada".
            default:
                showAlert(
                    'info',
                    'Se este email estiver cadastrado e com pagamento confirmado, você poderá continuar o cadastro.'
                );
                hidePasswordInputs();
        }

    } catch (err) {
        // [SEC-TIMEOUT] AbortError = timeout expirou
        if (err?.name === 'AbortError') {
            showAlert('error', 'Tempo esgotado. Verifique sua conexão e tente novamente.');
        } else {
            showAlert('error', 'Erro de conexão. Verifique sua internet e tente novamente.');
        }
        hidePasswordInputs();
    } finally {
        restoreButton(checkEmailBtn);
    }
});

// ==========================================
// MOSTRAR / OCULTAR FORMULÁRIO DE SENHA
// [SEC-INLINE-STYLE] classList apenas — nenhum style.display
// ==========================================
function showPasswordForm(data) {
    alertBox.classList.remove('show-flex');
    infoBox.classList.add('show-block');

    // textContent — nunca innerHTML com dados do servidor
    userName.textContent  = sanitize(data.user_name  || 'Usuário');
    userEmail.textContent = sanitize(data.email);
    planName.textContent  = sanitize(data.plan_name);

    emailCheckState.classList.add('hide');
    passwordInputs.classList.add('show-block');

    // [UX-EMAIL-LOCK] Trava o campo após verificação bem-sucedida.
    // Evita inconsistência entre email exibido e email usado no signUp.
    emailInput.disabled = true;

    setTimeout(() => passwordInput.focus(), 300);
}

function hidePasswordInputs() {
    passwordInputs.classList.remove('show-block');
    infoBox.classList.remove('show-block');
    emailCheckState.classList.remove('hide');

    // [UX-EMAIL-LOCK] Reabilita para nova tentativa com outro email
    emailInput.disabled = false;
}

// ==========================================
// UTILITÁRIOS
// ==========================================
function sanitize(value) {
    return String(value ?? '').trim();
}

function isValidEmail(email) {
    return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * [SEC-TIMEOUT] Wrapper de fetch com AbortController.
 * Aborta a requisição após `timeoutMs` ms, evitando botões travados
 * indefinidamente em caso de servidor lento ou rede instável.
 *
 * @param {string} url       - URL da requisição
 * @param {object} options   - Opções padrão do fetch
 * @param {number} timeoutMs - Timeout em ms (padrão: FETCH_TIMEOUT_MS)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timerId);
        return response;
    } catch (err) {
        clearTimeout(timerId);
        throw err; // Repropaga AbortError para tratamento no chamador
    }
}

// ==========================================
// SHOW ALERT
// [SEC-04] Sem innerHTML com dados externos — DOM programático
// [SEC-INLINE-STYLE] className completo — nenhum style.display
// ==========================================
function showAlert(type, message) {
    // className completo em uma operação: tipo + visibilidade
    alertBox.className       = `alert-box ${type} show-flex`;
    alertMessage.textContent = message; // textContent — imune a XSS

    if (type !== 'error') {
        setTimeout(() => { alertBox.classList.remove('show-flex'); }, 8000);
    }
}

/**
 * Alerta com links hardcoded — construído via DOM, sem innerHTML.
 * hrefs são strings literais no código, nunca vindos do servidor.
 *
 * [SEC-LINK-TARGET] target="_self" explícito para garantir navegação
 * na mesma aba independente do contexto de abertura da página.
 */
function showAlertWithLinks(type, message, links = []) {
    alertBox.className       = `alert-box ${type} show-flex`;
    alertMessage.textContent = '';

    alertMessage.appendChild(document.createTextNode(message + ' '));

    links.forEach((link, i) => {
        if (i > 0) alertMessage.appendChild(document.createTextNode(' · '));
        const a       = document.createElement('a');
        a.href        = link.href;    // href hardcoded — não vem do servidor
        a.textContent = link.text;    // textContent — imune a XSS
        a.target      = '_self';      // [SEC-LINK-TARGET] navegação explícita na mesma aba
        alertMessage.appendChild(a);
    });

    if (type !== 'error') {
        setTimeout(() => { alertBox.classList.remove('show-flex'); }, 8000);
    }
}

// ==========================================
// LOADING STATE DOS BOTÕES
// [SEC-07] cloneNode + replaceChildren — zero innerHTML
// ==========================================
function setButtonLoading(btn, label) {
    btn.disabled    = true;
    // Clona filhos originais (texto + SVGs) para restauração posterior
    btn._origNodes  = Array.from(btn.childNodes).map(n => n.cloneNode(true));
    btn.textContent = label; // textContent — sem innerHTML
}

function restoreButton(btn, fallbackLabel) {
    btn.disabled = false;
    if (btn._origNodes?.length) {
        btn.replaceChildren(...btn._origNodes); // replaceChildren — sem innerHTML
        delete btn._origNodes;
    } else if (fallbackLabel) {
        btn.textContent = fallbackLabel;
    }
}

// ==========================================
// TOGGLE PASSWORD VISIBILITY
// ==========================================
togglePassword1?.addEventListener('click', () => {
    passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
});

togglePassword2?.addEventListener('click', () => {
    confirmPasswordInput.type = confirmPasswordInput.type === 'password' ? 'text' : 'password';
});

// ==========================================
// PASSWORD STRENGTH
// [BUG-STRENGTH-FIX] className completo com classes sw-* (largura) +
// strength-* (cor). Nenhum style.width — resolve o bug onde inline style
// width:'0%' travava a barra nas digitações seguintes.
// [SEC-INLINE-STYLE] Nenhum style.width — obrigatório para CSP.
// ==========================================
function checkPasswordStrength(password) {
    let strength = 0;
    if (password.length >= 8)                                  strength++;
    if (password.length >= 12)                                 strength++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password))     strength++;
    if (/\d/.test(password))                                   strength++;
    if (/[^a-zA-Z0-9]/.test(password))                        strength++;
    return strength;
}

passwordInput?.addEventListener('input', () => {
    const strength = checkPasswordStrength(passwordInput.value);

    if (strength === 0) {
        strengthFill.className   = 'strength-fill';           // sem largura = 0% (default CSS)
        strengthText.textContent = 'Mínimo 8 caracteres';
    } else if (strength <= 2) {
        strengthFill.className   = 'strength-fill sw-33 strength-weak';
        strengthText.textContent = 'Senha fraca';
    } else if (strength <= 4) {
        strengthFill.className   = 'strength-fill sw-66 strength-medium';
        strengthText.textContent = 'Senha média';
    } else {
        strengthFill.className   = 'strength-fill sw-100 strength-strong';
        strengthText.textContent = 'Senha forte';
    }
});

// ==========================================
// VALIDAR CONFIRMAÇÃO DE SENHA
// [SEC-INLINE-STYLE] classList.add/remove('border-error') — nenhum style.borderColor
// ==========================================
confirmPasswordInput?.addEventListener('input', () => {
    if (confirmPasswordInput.value && confirmPasswordInput.value !== passwordInput.value) {
        confirmError.classList.add('show-block');
        confirmPasswordInput.classList.add('border-error');
    } else {
        confirmError.classList.remove('show-block');
        confirmPasswordInput.classList.remove('border-error');
    }
});

// ==========================================
// CHECKBOX DE TERMOS
// [SEC-INLINE-STYLE] classList apenas — nenhum style.borderColor / style.background
// [SEC-TERMS-CACHE] termsWarning já cacheado no topo — sem getElementById aqui
// ==========================================
termsCheckbox?.addEventListener('change', () => {
    if (termsCheckbox.checked) {
        termsError?.classList.remove('show-block');
        checkboxWrapper?.classList.remove('error');
        checkboxWrapper?.classList.add('cb-active');
        termsWarning?.classList.remove('show');
    } else {
        checkboxWrapper?.classList.remove('cb-active');
    }
});

function showTermsError() {
    // [SEC-TERMS-CACHE] termsWarning cacheado — sem getElementById repetido
    termsWarning?.classList.add('show');
    termsError?.classList.add('show-block');
    checkboxWrapper?.classList.add('error');

    // [SEC-INLINE-STYLE] Shake via classList + animationend para restaurar
    // pulse-error depois. Sem isso, style.animation ficaria preso e
    // impediria pulse-error de retomar após o shake.
    checkboxWrapper?.classList.add('do-shake');
    checkboxWrapper?.addEventListener('animationend', () => {
        checkboxWrapper.classList.remove('do-shake');
    }, { once: true }); // { once: true } = listener se auto-remove

    checkboxWrapper?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => termsCheckbox?.focus(), 500);
}

// ==========================================
// SUBMIT — CRIAR SENHA
//
// [FIX-FLOW-ORDER] Fluxo reestruturado (v8):
//   1. Validações locais (termos, senha, confirmação)
//   2. supabase.auth.signUp  → obtém userId (session pode ser null)
//   3. _confirmEmail         → auto-confirma email via Edge Function segura
//   4. supabase.auth.signIn  → obtém session + JWT
//   5. _linkViaBackendWithRetry → vincula subscription via JWT
//   6. _acceptTerms          → registra aceitação LGPD no banco
//   7. _createUserData       → cria perfil inicial do usuário
//   8. redirect              → envia para login.html
// ==========================================
accessForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    // [SEC-08] Rate limit no submit — 3s de cooldown entre tentativas
    const now = Date.now();
    if (now - lastSubmitAt < SUBMIT_COOLDOWN_MS) {
        const remaining = Math.ceil((SUBMIT_COOLDOWN_MS - (now - lastSubmitAt)) / 1000);
        showAlert('warning', `Aguarde ${remaining}s antes de tentar novamente.`);
        return;
    }

    if (!currentSubscriptionData) {
        showAlert('error', 'Dados da assinatura não encontrados. Recarregue a página.');
        return;
    }

    if (!termsCheckbox.checked) {
        showTermsError();
        showAlert('error', 'Você deve aceitar os Termos de Uso para criar sua conta.');
        return;
    }

    const password        = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (password.length < 8) {
        showAlert('error', 'A senha deve ter no mínimo 8 caracteres.');
        passwordInput.focus();
        return;
    }

    if (password.length > 128) {
        showAlert('error', 'A senha deve ter no máximo 128 caracteres.');
        passwordInput.focus();
        return;
    }

    if (password !== confirmPassword) {
        showAlert('error', 'As senhas não coincidem.');
        confirmPasswordInput.focus();
        return;
    }

    // Registra timestamp ANTES de iniciar (bloqueia multi-clique mesmo em erro)
    lastSubmitAt = Date.now();

    setButtonLoading(submitBtn, 'Criando sua conta...');

    try {
        // [FIX-02] Email sempre normalizado
        const email = (currentSubscriptionData.email || '').toLowerCase().trim();

        // ── ETAPA 1: Criar usuário no Auth ──────────────────────────────
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: undefined,
                data: {
                    name: currentSubscriptionData.user_name,
                    plan: currentSubscriptionData.plan_name,
                },
            },
        });

        if (authError) {
            const alreadyRegistered =
                authError.message.toLowerCase().includes('already registered') ||
                authError.message.toLowerCase().includes('user already registered');

            if (alreadyRegistered) {
                showAlertWithLinks(
                    'warning',
                    'Este email já possui cadastro.',
                    [
                        { text: 'Fazer login',         href: 'login.html' },
                        { text: 'Esqueci minha senha', href: 'login.html' },
                    ]
                );
                return;
            }
            throw authError;
        }

        const userId = authData.user?.id;

        if (!userId) {
            throw new Error('Não foi possível obter o ID do usuário após o cadastro.');
        }

        // ── ETAPA 2: Auto-confirmação de email via Edge Function segura ──
        // [FIX-EMAIL-CONFIRM] O Supabase pode exigir confirmação de email,
        // bloqueando o login. A Edge Function confirm-email valida a
        // legitimidade da requisição (subscription ativa + pagamento aprovado
        // + email correto + senha ainda não criada) e só então confirma.
        // Isso substitui o fluxo antigo que dependia de authData.session
        // não-null (que nunca vinha quando confirm email estava ativo).
        setButtonLoading(submitBtn, 'Confirmando acesso...');

        const confirmOk = await _confirmEmail(
            userId,
            email,
            currentSubscriptionData.subscription_id
        );

        if (!confirmOk) {
            // Falha na confirmação — não prosseguir.
            // O usuário será orientado a verificar o email ou tentar novamente.
            passwordInput.value        = '';
            confirmPasswordInput.value = '';
            showAlert(
                'warning',
                'Houve um problema ao ativar seu acesso. Tente novamente ou entre em contato: suporte@granaevo.com'
            );
            return;
        }

        // ── ETAPA 3: Login com as credenciais recém-criadas ──────────────
        // Aguarda propagação no Supabase Auth antes de tentar o login
        setButtonLoading(submitBtn, 'Entrando na sua conta...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        // [SEC-05] Limpa campos sensíveis independente do resultado do login
        passwordInput.value        = '';
        confirmPasswordInput.value = '';

        if (loginError) {
            // [FIX-03] Trata explicitamente caso de email não confirmado
            // (não deveria ocorrer após confirm-email, mas é uma salvaguarda)
            if (loginError.message?.toLowerCase().includes('email not confirmed')) {
                showAlert('warning', '✅ Conta criada! Confirme seu email na caixa de entrada e faça o login.');
            } else {
                showAlert('info', '✅ Conta criada com sucesso! Faça o login para continuar.');
            }
            setTimeout(() => { window.location.href = 'login.html'; }, 2500);
            return;
        }

        const accessToken = loginData.session?.access_token;

        // ── ETAPA 4: Vincular subscription via Edge Function ────────────
        // [BUG-03-FIX] Retry com backoff exponencial (até 3 tentativas).
        // Agora temos accessToken garantido pois o login funcionou.
        // Se ainda falhar, o check-user-access auto-vincula no próximo login.
        if (accessToken) {
            const linkSuccess = await _linkViaBackendWithRetry(
                accessToken,
                currentSubscriptionData.subscription_id
            );

            if (!linkSuccess) {
                console.warn('[primeiroacesso] _linkViaBackend falhou após retries — será corrigido no próximo login via check-user-access.');
            }
        }

        // ── ETAPA 5: Registrar aceitação dos termos ─────────────────────
        // [SEC-10] Valida que userId é exatamente o usuário recém-criado
        if (userId && userId === authData.user?.id) {
            await _acceptTerms(userId, email);
        }

        // ── ETAPA 6: Criar user_data ────────────────────────────────────
        // [SEC-10] Valida que userId é exatamente o usuário recém-criado
        if (userId && userId === authData.user?.id) {
            await _createUserData(userId, email, currentSubscriptionData);
        }

        // ── ETAPA 7: Redirecionar ────────────────────────────────────────
        showAlert('info', '✅ Conta criada com sucesso! Redirecionando...');
        setTimeout(() => { window.location.href = 'login.html'; }, 1500);

    } catch (err) {
        // [SEC-05] Limpa senha em qualquer erro inesperado
        passwordInput.value        = '';
        confirmPasswordInput.value = '';

        let msg = 'Erro ao criar conta. Tente novamente.';
        const msgLower = (err?.message || '').toLowerCase();

        if (msgLower.includes('invalid email')) {
            msg = 'Email inválido.';
        } else if (msgLower.includes('password')) {
            msg = 'Erro na senha. Tente uma senha diferente.';
        } else if (msgLower.includes('network') || msgLower.includes('fetch')) {
            msg = 'Erro de conexão. Verifique sua internet e tente novamente.';
        }

        showAlert('error', msg);

    } finally {
        // [FIX-01] Restaura o botão em TODOS os caminhos sem exceção
        restoreButton(submitBtn, 'Criar Senha e Acessar');
    }
});

// ==========================================
// HELPERS INTERNOS
// ==========================================

/**
 * [FIX-EMAIL-CONFIRM] Chama a Edge Function confirm-email para auto-confirmar
 * o email do usuário recém-criado.
 *
 * SEGURANÇA: A Edge Function valida internamente:
 *   - subscriptionId existe e está ativo
 *   - payment_status === 'approved'
 *   - email bate com o da subscription
 *   - password_created === false (uso único)
 *   - userId existe no Auth e o email confere
 *   - Usuário foi criado recentemente (janela de 10 minutos)
 *
 * Não envia Authorization header pois o usuário não tem JWT ainda.
 * A validação de legitimidade acontece inteiramente no backend.
 *
 * [FIX-401] Envia 'apikey' (anon key) para o gateway do Supabase rotear
 * corretamente a requisição até a Edge Function.
 *
 * @param {string} userId         - UUID do usuário recém-criado
 * @param {string} email          - Email normalizado
 * @param {string} subscriptionId - ID da subscription validada
 * @returns {Promise<boolean>}    - true se confirmou com sucesso
 */
async function _confirmEmail(userId, email, subscriptionId) {
    try {
        const response = await fetchWithTimeout(
            `${SUPABASE_URL}/functions/v1/confirm-email`,
            {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey':       SUPABASE_ANON_KEY,
                    // Sem Authorization — usuário não tem JWT neste ponto.
                    // Autenticação é feita via subscriptionId + userId no backend.
                },
                body: JSON.stringify({ userId, email, subscriptionId }),
            }
        );

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            console.error('[primeiroacesso] _confirmEmail HTTP', response.status, errBody?.error);
            return false;
        }

        const result = await response.json();
        return result?.success === true;

    } catch (err) {
        const label = err?.name === 'AbortError' ? 'timeout' : 'erro de rede';
        console.error(`[primeiroacesso] _confirmEmail ${label}:`, err?.message);
        return false;
    }
}

/**
 * [BUG-03-FIX] Tenta vincular até `maxRetries` vezes com backoff exponencial.
 * Cobre falhas de rede transitórias que antes deixavam user_id = NULL
 * na subscription, quebrando todos os logins futuros.
 *
 * @param {string} accessToken    - JWT do usuário autenticado
 * @param {string} subscriptionId - ID da subscription a vincular
 * @param {number} maxRetries     - Número máximo de tentativas (padrão: 3)
 * @returns {Promise<boolean>}
 */
async function _linkViaBackendWithRetry(accessToken, subscriptionId, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const success = await _linkViaBackend(accessToken, subscriptionId);
        if (success) return true;

        if (attempt < maxRetries) {
            const delay = 500 * attempt; // 500ms → 1000ms (backoff exponencial)
            console.warn(`[primeiroacesso] _linkViaBackend tentativa ${attempt} falhou. Retry em ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return false;
}

/**
 * [SEC-01] Vincula subscription usando o JWT do usuário como autenticação.
 * [FIX-401] Envia 'apikey' (anon key) além do Authorization para cobrir
 *   o roteamento do gateway do Supabase.
 * [SEC-TIMEOUT] Usa fetchWithTimeout para evitar requisições penduradas.
 *
 * @param {string} accessToken    - JWT do usuário autenticado
 * @param {string} subscriptionId - ID da subscription a vincular
 * @returns {Promise<boolean>}
 */
async function _linkViaBackend(accessToken, subscriptionId) {
    try {
        const response = await fetchWithTimeout(
            `${SUPABASE_URL}/functions/v1/link-user-subscription`,
            {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'apikey':        SUPABASE_ANON_KEY,
                    // [SEC-01] JWT do usuário autenticado — correto para endpoint protegido.
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ subscription_id: subscriptionId }),
            }
        );

        if (!response.ok) {
            console.error(`[primeiroacesso] _linkViaBackend HTTP ${response.status}`);
            return false;
        }
        const result = await response.json();
        return result?.success === true;
    } catch (err) {
        const label = err?.name === 'AbortError' ? 'timeout' : 'erro de rede';
        console.error(`[primeiroacesso] _linkViaBackend ${label}:`, err?.message);
        return false;
    }
}

/**
 * Registra aceitação dos termos de uso.
 *
 * [SEC-10] userId validado como authData.user.id antes de chamar esta função.
 *
 * REQUISITO RLS obrigatório na tabela terms_acceptance:
 *   CREATE POLICY "insert_own_terms" ON terms_acceptance
 *     FOR INSERT TO authenticated
 *     WITH CHECK (auth.uid() = user_id);
 *
 * @param {string} userId - UUID do usuário autenticado
 * @param {string} email  - Email normalizado do usuário
 */
async function _acceptTerms(userId, email) {
    try {
        await supabase.from('terms_acceptance').insert({
            user_id:     userId,
            email,
            accepted:    true,
            accepted_at: new Date().toISOString(),
            user_agent:  navigator.userAgent.slice(0, 200),
        });
    } catch (err) {
        // Não bloqueia o fluxo principal — falha não impede o cadastro
        console.warn('[primeiroacesso] _acceptTerms falhou (não crítico):', err?.message);
    }
}

/**
 * Cria entrada em user_data com informações iniciais do usuário.
 *
 * [SEC-10] userId validado como authData.user.id antes de chamar esta função.
 * [SEC-CATCH-LOG] catch loga o erro — antes era silencioso, impossibilitando
 * diagnóstico de falhas em produção.
 *
 * REQUISITO RLS obrigatório na tabela user_data:
 *   CREATE POLICY "insert_own_user_data" ON user_data
 *     FOR INSERT TO authenticated
 *     WITH CHECK (auth.uid() = user_id);
 *
 * @param {string} userId  - UUID do usuário autenticado
 * @param {string} email   - Email normalizado do usuário
 * @param {object} subData - Dados da subscription (plan_name, user_name)
 */
async function _createUserData(userId, email, subData) {
    try {
        await supabase.from('user_data').insert({
            user_id: userId,
            email,
            data_json: {
                created_via: 'first_access',
                plan:        sanitize(subData.plan_name),
                name:        sanitize(subData.user_name),
                created_at:  new Date().toISOString(),
            },
        });
    } catch (err) {
        // [SEC-CATCH-LOG] Loga para diagnóstico — não bloqueia o fluxo principal
        console.warn('[primeiroacesso] _createUserData falhou (não crítico):', err?.message);
    }
}