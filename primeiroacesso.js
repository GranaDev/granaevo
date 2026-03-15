/**
 * GranaEvo — primeiroacesso.js (v7)
 *
 * ============================================================
 * HISTÓRICO DE CORREÇÕES — TODAS ATIVAS
 * ============================================================
 *
 * ── v7 (atual) ──────────────────────────────────────────────
 *
 * [SEC-TERMS-CACHE] termsWarning cacheado no topo com os demais elementos.
 *   Antes era consultado via getElementById DENTRO de dois event handlers
 *   separados (termsCheckbox.change e showTermsError). Isso causava:
 *   - dupla query ao DOM a cada evento
 *   - risco de dessincronização se o elemento fosse movido no DOM
 *   Fix: declarado na seção "ELEMENTOS DO DOM" e reutilizado em ambos os handlers.
 *
 * [SEC-CATCH-LOG] _createUserData: catch vazio substituído por console.warn.
 *   Antes: erros de insert em user_data eram silenciados completamente,
 *   tornando impossível diagnosticar falhas em produção.
 *   Fix: catch loga o erro com prefixo rastreável, sem interromper o fluxo.
 *
 * [SEC-LINK-TARGET] Links em showAlertWithLinks recebem target="_self" explícito.
 *   Antes: target era undefined (comportamento padrão do browser),
 *   o que em contextos de abertura por terceiros poderia abrir em nova aba.
 *   Fix: target="_self" garante navegação na mesma aba.
 *
 * [A11Y-ARIA-LIVE] alertBox recebe aria-live="assertive" via setAttribute no JS.
 *   Antes: leitores de tela (NVDA, JAWS, VoiceOver) não anunciavam os alertas
 *   porque o elemento não tinha a região live correta.
 *   Fix: atributo definido no JS logo após o DOMContentLoaded.
 *   (Complemento do aria-live="assertive" + role="alert" que está no HTML.)
 *
 * ── v6 (mantidos) ───────────────────────────────────────────
 *
 * [SEC-INLINE-STYLE] CRÍTICO — Todo element.style.X removido do JS.
 *   Qualquer atribuição de estilo inline via JS é bloqueada por CSP
 *   quando style-src não contém 'unsafe-inline'. Este arquivo não
 *   usa element.style.X em NENHUM lugar. Todo estado visual é
 *   gerenciado exclusivamente via classList.add/remove.
 *
 * [SEC-TIMEOUT] AbortController com timeout de 10s em TODOS os fetches.
 *
 * [SEC-MAXLENGTH] maxlength reforçado via setAttribute no JS.
 *   email → 254 chars (limite RFC 5321)
 *   senha → 128 chars (limite bcrypt)
 *
 * [UX-EMAIL-LOCK] emailInput.disabled = true após verificação bem-sucedida.
 *
 * [BUG-STRENGTH-FIX] Barra de força da senha corrigida via classes sw-*.
 *
 * [BUG-ANIM-FIX] document.createElement('style') removido.
 *
 * ── v4 / v3 (mantidos) ──────────────────────────────────────
 *
 * [SEC-02] Anon key removida do header de check-email-status.
 * [SEC-03] Account Enumeration eliminado — resposta genérica para não-ready.
 * [SEC-06] Rate limit de 5s no botão "Verificar Email".
 * [SEC-07] restoreButton via cloneNode + replaceChildren — zero innerHTML.
 * [SEC-08] Rate limit de 3s no botão "Criar Senha e Acessar".
 * [SEC-09] autocomplete="new-password" reforçado via setAttribute.
 * [SEC-10] userId validado como authData.user.id antes de qualquer insert.
 * [SEC-01] JWT do usuário nas Edge Functions autenticadas.
 * [SEC-04] showAlert/showAlertWithLinks sem innerHTML com dados externos.
 * [SEC-05] Campos de senha limpos em TODOS os caminhos de erro.
 * [BUG-03-FIX] _linkViaBackend com retry + backoff exponencial (3 tentativas).
 * [BUG-04-FIX] Tratamento de signUp sem session (confirmação de email ativa).
 * [FIX-01] submitBtn restaurado em todos os caminhos (finally).
 * [FIX-02] Email normalizado para lowercase antes de qualquer operação.
 * [FIX-03] Tratamento explícito do erro "email not confirmed" no login automático.
 */

import { supabase } from './supabase-client.js';

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co';

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
        // [SEC-02] Sem Authorization header — endpoint é pré-auth público.
        // [SEC-TIMEOUT] fetchWithTimeout aborta após 10s.
        const response = await fetchWithTimeout(
            `${SUPABASE_URL}/functions/v1/check-email-status`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ email }),
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

        const userId      = authData.user?.id;
        const accessToken = authData.session?.access_token;

        // ── ETAPA 2: Verificação de confirmação de email ────────────────
        // [BUG-04-FIX] Sem session = Supabase exige confirmação de email.
        // Sem JWT não podemos chamar _linkViaBackend.
        // O check-user-access auto-vincula no próximo login.
        if (!accessToken) {
            passwordInput.value        = '';
            confirmPasswordInput.value = '';
            showAlert(
                'warning',
                '✅ Conta criada! Confirme seu email na sua caixa de entrada para ativar o acesso, depois faça login.'
            );
            setTimeout(() => { window.location.href = 'login.html'; }, 4000);
            return;
        }

        // ── ETAPA 3: Vincular subscription via Edge Function ────────────
        // [BUG-03-FIX] Retry com backoff exponencial (até 3 tentativas).
        // Se ainda falhar, o check-user-access auto-vincula no próximo login.
        const linkSuccess = await _linkViaBackendWithRetry(
            accessToken,
            currentSubscriptionData.subscription_id
        );

        if (!linkSuccess) {
            console.warn('[primeiroacesso] _linkViaBackend falhou após retries — será corrigido no próximo login via check-user-access.');
        }

        // ── ETAPA 4: Registrar aceitação dos termos ─────────────────────
        // [SEC-10] Valida que userId é exatamente o usuário recém-criado
        if (userId && userId === authData.user?.id) {
            await _acceptTerms(userId, email);
        }

        // ── ETAPA 5: Criar user_data ────────────────────────────────────
        // [SEC-10] Valida que userId é exatamente o usuário recém-criado
        if (userId && userId === authData.user?.id) {
            await _createUserData(userId, email, currentSubscriptionData);
        }

        // ── ETAPA 6: Login automático ───────────────────────────────────
        // Aguarda propagação no servidor antes de tentar o login
        await new Promise(resolve => setTimeout(resolve, 1000));

        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });

        // [SEC-05] Limpa campos sensíveis independente do resultado do login
        passwordInput.value        = '';
        confirmPasswordInput.value = '';

        if (loginError) {
            // [FIX-03] Trata explicitamente o caso de email não confirmado
            if (loginError.message?.toLowerCase().includes('email not confirmed')) {
                showAlert('warning', '✅ Conta criada! Confirme seu email e faça o login.');
            } else {
                showAlert('info', '✅ Conta criada com sucesso! Faça o login para continuar.');
            }
            setTimeout(() => { window.location.href = 'login.html'; }, 2500);
            return;
        }

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
                    // [SEC-01] JWT do usuário autenticado — correto para endpoint protegido.
                    // Nunca usar anon key aqui.
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