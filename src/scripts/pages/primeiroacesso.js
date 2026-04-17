/**
 * GranaEvo — primeiroacesso.js
 *
 * ============================================================
 * HISTÓRICO DE CORREÇÕES — TODAS ATIVAS
 * ============================================================
 *
 * [FIX-CONFIRM-REMOVED] CRÍTICO — Removida chamada à Edge Function
 *   confirm-email (que na verdade se chama confirm-user-email no Supabase).
 *   Como "Email Confirmation" está DESATIVADA nas configurações do projeto
 *   (Authentication → User Signups), o Supabase já cria o usuário com email
 *   confirmado automaticamente. A chamada era desnecessária e, por usar o
 *   nome errado da função, retornava CORS 404, interrompendo todo o fluxo
 *   pós-signUp e impedindo a criação de conta. A Edge Function
 *   confirm-user-email foi reescrita separadamente com validações de
 *   segurança reais, mas NÃO é chamada aqui enquanto a confirmação de email
 *   permanecer desativada no Supabase.
 *
 * [FIX-FLOW-ORDER] Fluxo pós-signUp reestruturado na ordem correta:
 *   1. signUp                       → cria usuário (já confirmado, pois
 *                                     Email Confirmation está desativada)
 *   2. signInWithPassword           → obtém session + accessToken
 *   3. _linkViaBackendWithRetry     → vincula subscription via JWT
 *   4. _acceptTerms                 → registra aceitação LGPD/GDPR
 *   5. _createUserData              → cria perfil inicial
 *   6. redirect                     → envia para login.html
 *
 * [FIX-EXPORTS] CRÍTICO — Depende de supabase-client.js que exporta
 *   SUPABASE_URL e SUPABASE_ANON_KEY corretamente. Esta era a causa raiz
 *   de todo o fluxo de Primeiro Acesso não funcionar: as constantes chegavam
 *   como `undefined`, quebrando silenciosamente todos os fetch às Edge Functions.
 *
 * [FIX-401] Adicionado header 'apikey' com SUPABASE_ANON_KEY em todas as
 *   chamadas a Edge Functions. O gateway do Supabase exige essa chave para
 *   rotear a requisição, mesmo em endpoints sem autenticação de usuário.
 *
 * [FIX-TERMS-VERSION] terms_acceptance.terms_version é NOT NULL no banco.
 *   Coluna ausente causava silent insert error. Adicionado campo com versão
 *   controlada pela constante TERMS_VERSION.
 *
 * [FIX-02]  Normaliza email lowercase antes de qualquer operação
 * [SEC-06]  Rate limit: 5s cooldown no "Verificar Email"
 * [SEC-08]  Rate limit: 3s cooldown no "Criar Senha e Acessar"
 * [SEC-TIMEOUT]   fetchWithTimeout aborta requisições após 10s
 * [SEC-03]  Resposta genérica para estados não-ready (anti-enumeração)
 * [SEC-04]  Sem innerHTML com dados externos — DOM programático
 * [SEC-05]  Limpa campos de senha em todos os caminhos de saída
 * [SEC-07]  setButtonLoading usa cloneNode + replaceChildren (zero innerHTML)
 * [SEC-09]  autocomplete + maxlength reforçados via JS (cobre HTML cacheado)
 * [SEC-10]  userId validado como authData.user.id antes de ops de banco
 * [SEC-INLINE-STYLE] Nenhum style.* direto — classList apenas (compatível CSP)
 * [A11Y-ARIA-LIVE]   aria-live="assertive" reforçado via JS
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../services/supabase-client.js?v=2';

// ==========================================
// CONFIGURAÇÃO
// ==========================================

/**
 * [FIX-TERMS-VERSION] Versão atual dos Termos de Uso e Política de Privacidade.
 * Atualize este valor sempre que publicar uma nova versão dos termos.
 * O valor é gravado em terms_acceptance.terms_version (NOT NULL no banco).
 */
const TERMS_VERSION = '1.0';

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

// [SEC-TERMS-CACHE] Cacheado no topo — evita dupla query ao DOM em dois handlers.
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

// [SEC-09] autocomplete="new-password" reforçado via JS para cobrir HTML cacheado.
// [SEC-MAXLENGTH] maxlength reforçado via JS pela mesma razão.
if (passwordInput) {
    passwordInput.setAttribute('autocomplete', 'new-password');
    passwordInput.setAttribute('maxlength', '128');
}
if (confirmPasswordInput) {
    confirmPasswordInput.setAttribute('autocomplete', 'new-password');
    confirmPasswordInput.setAttribute('maxlength', '128');
}
if (emailInput) {
    emailInput.setAttribute('maxlength', '254');
}

// [A11Y-ARIA-LIVE] Garante que leitores de tela anunciem os alertas.
if (alertBox) {
    alertBox.setAttribute('aria-live', 'assertive');
    alertBox.setAttribute('aria-atomic', 'true');
}

// ==========================================
// VERIFICAR EMAIL
// ==========================================
checkEmailBtn.addEventListener('click', async () => {

    // [SEC-06] Rate limit: bloqueia se ainda dentro do cooldown.
    const now = Date.now();
    if (now - lastEmailCheckAt < EMAIL_CHECK_COOLDOWN_MS) {
        const remaining = Math.ceil((EMAIL_CHECK_COOLDOWN_MS - (now - lastEmailCheckAt)) / 1000);
        showAlert('warning', `Aguarde ${remaining}s antes de tentar novamente.`);
        return;
    }

    // [FIX-02] Normaliza lowercase antes de qualquer operação.
    const email = (emailInput.value || '').trim().toLowerCase();

    if (!email) {
        showAlert('error', 'Por favor, digite seu email.');
        return;
    }

    if (!isValidEmail(email)) {
        showAlert('error', 'Email inválido. Digite um email válido.');
        return;
    }

    // Registra timestamp ANTES da requisição para cobrir erros de rede também.
    lastEmailCheckAt = Date.now();

    setButtonLoading(checkEmailBtn, 'Verificando...');

    try {
        // [FIX-401] Header 'apikey' obrigatório para o gateway do Supabase rotear
        // a requisição até a Edge Function. A anon key é pública por design.
        //
        // [SEC-02] Sem Authorization header — endpoint é pré-auth público.
        // [SEC-TIMEOUT] fetchWithTimeout aborta após 10s.
        //
        // [FIX-EXPORTS] SUPABASE_URL e SUPABASE_ANON_KEY agora chegam com valores
        // reais graças às exportações corrigidas em supabase-client.js.
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
            // Impede enumeração de emails/status de pagamento.
            default:
                showAlert(
                    'info',
                    'Se este email estiver cadastrado e com pagamento confirmado, você poderá continuar o cadastro.'
                );
                hidePasswordInputs();
        }

    } catch (err) {
        // [SEC-TIMEOUT] AbortError = timeout expirou.
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

    // textContent — nunca innerHTML com dados do servidor.
    userName.textContent  = sanitize(data.user_name  || 'Usuário');
    userEmail.textContent = sanitize(data.email);
    planName.textContent  = sanitize(data.plan_name);

    emailCheckState.classList.add('hide');
    passwordInputs.classList.add('show-block');

    // [UX-EMAIL-LOCK] Trava o campo após verificação bem-sucedida.
    emailInput.disabled = true;

    setTimeout(() => passwordInput.focus(), 300);
}

function hidePasswordInputs() {
    passwordInputs.classList.remove('show-block');
    infoBox.classList.remove('show-block');
    emailCheckState.classList.remove('hide');

    // [UX-EMAIL-LOCK] Reabilita para nova tentativa com outro email.
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
        throw err;
    }
}

// ==========================================
// SHOW ALERT
// [SEC-04] Sem innerHTML com dados externos — DOM programático
// [SEC-INLINE-STYLE] className completo — nenhum style.display
// ==========================================
function showAlert(type, message) {
    alertBox.className       = `alert-box ${type} show-flex`;
    alertMessage.textContent = message;

    if (type !== 'error') {
        setTimeout(() => { alertBox.classList.remove('show-flex'); }, 8000);
    }
}

/**
 * Alerta com links hardcoded — construído via DOM, sem innerHTML.
 * hrefs são strings literais no código, nunca vindos do servidor.
 */
function showAlertWithLinks(type, message, links = []) {
    alertBox.className       = `alert-box ${type} show-flex`;
    alertMessage.textContent = '';

    alertMessage.appendChild(document.createTextNode(message + ' '));

    links.forEach((link, i) => {
        if (i > 0) alertMessage.appendChild(document.createTextNode(' · '));
        const a       = document.createElement('a');
        a.href        = link.href;
        a.textContent = link.text;
        a.target      = '_self'; // [SEC-LINK-TARGET] navegação explícita na mesma aba.
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
    btn._origNodes  = Array.from(btn.childNodes).map(n => n.cloneNode(true));
    btn.textContent = label;
}

function restoreButton(btn, fallbackLabel) {
    btn.disabled = false;
    if (btn._origNodes?.length) {
        btn.replaceChildren(...btn._origNodes);
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
// [BUG-STRENGTH-FIX] className completo — nenhum style.width (CSP compliance)
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
        strengthFill.className   = 'strength-fill';
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
    termsWarning?.classList.add('show');
    termsError?.classList.add('show-block');
    checkboxWrapper?.classList.add('error');

    checkboxWrapper?.classList.add('do-shake');
    checkboxWrapper?.addEventListener('animationend', () => {
        checkboxWrapper.classList.remove('do-shake');
    }, { once: true });

    checkboxWrapper?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => termsCheckbox?.focus(), 500);
}

// ==========================================
// SUBMIT — CRIAR SENHA
// ==========================================
accessForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    // [SEC-08] Rate limit no submit — 3s de cooldown entre tentativas.
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

    // Valida aceitação dos termos ANTES de qualquer operação de conta.
    // [UX-TERMS-FIRST] O usuário deve aceitar os termos explicitamente —
    // é obrigatório por LGPD/GDPR. Interrompemos aqui para garantir isso.
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

    lastSubmitAt = Date.now();

    setButtonLoading(submitBtn, 'Criando sua conta...');

    try {
        // [FIX-02] Email sempre normalizado.
        const email = (currentSubscriptionData.email || '').toLowerCase().trim();

        // ── ETAPA 1: Criar usuário no Auth ──────────────────────────────
        // [FIX-CONFIRM-REMOVED] Como "Email Confirmation" está DESATIVADA
        // no Supabase (Authentication → User Signups), o usuário é criado
        // já confirmado. Nenhuma Edge Function de confirmação é necessária.
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

        // [SEC-10] Valida que o userId veio do objeto correto antes de usá-lo.
        const userId = authData.user?.id;

        if (!userId) {
            throw new Error('Não foi possível obter o ID do usuário após o cadastro.');
        }

        // ── ETAPA 2: Login com as credenciais recém-criadas ──────────────
        // Com "Email Confirmation" desativada, o login é imediato após signUp.
        // Não há delay necessário pois não há propagação de confirmação a aguardar.
        setButtonLoading(submitBtn, 'Entrando na sua conta...');

        const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        // [SEC-05] Limpa campos sensíveis independente do resultado.
        passwordInput.value        = '';
        confirmPasswordInput.value = '';

        if (loginError) {
            // Se o login falhar por algum motivo inesperado, redireciona
            // para o login manual — a conta já foi criada com sucesso.
            showAlert('info', '✅ Conta criada com sucesso! Faça o login para continuar.');
            setTimeout(() => { window.location.href = 'login.html'; }, 2500);
            return;
        }

        const accessToken = loginData.session?.access_token;

        // ── ETAPA 3: Vincular subscription via Edge Function ────────────
        // Feito com retry pois depende do JWT que acabou de ser emitido.
        if (accessToken) {
            const linkSuccess = await _linkViaBackendWithRetry(
                accessToken,
                currentSubscriptionData.subscription_id
            );

            if (!linkSuccess) {
                // Não crítico — o check-user-access corrige no próximo login.
                console.warn('[primeiroacesso] _linkViaBackend falhou após retries — será corrigido via check-user-access no próximo login.');
            }
        }

        // ── ETAPA 4: Registrar aceitação dos termos (LGPD/GDPR) ─────────
        // Executado após login para que a RLS (auth.uid() = user_id) passe.
        // [SEC-10] Dupla validação de userId antes de operar no banco.
        if (userId && userId === authData.user?.id) {
            await _acceptTerms(userId, email);
        }

        // ── ETAPA 5: Criar user_data ────────────────────────────────────
        // [SEC-10] Dupla validação de userId antes de operar no banco.
        if (userId && userId === authData.user?.id) {
            await _createUserData(userId, email, currentSubscriptionData);
        }

        // ── ETAPA 6: Redirecionar para login ────────────────────────────
        showAlert('info', '✅ Conta criada com sucesso! Redirecionando para o login...');
        setTimeout(() => { window.location.href = 'login.html'; }, 1500);

    } catch (err) {
        // [SEC-05] Limpa senha em qualquer erro inesperado.
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
        // [FIX-01] Restaura o botão em TODOS os caminhos sem exceção.
        restoreButton(submitBtn, 'Criar Senha e Acessar');
    }
});

// ==========================================
// HELPERS INTERNOS
// ==========================================

/**
 * [BUG-03-FIX] Tenta vincular até `maxRetries` vezes com backoff exponencial.
 * Útil pois o JWT recém-emitido pode ter um delay de propagação mínimo.
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
            const delay = 500 * attempt;
            console.warn(`[primeiroacesso] _linkViaBackend tentativa ${attempt} falhou. Retry em ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return false;
}

/**
 * [SEC-01] Vincula subscription usando o JWT do usuário como autenticação.
 * [FIX-401] Envia 'apikey' (anon key) além do Authorization header.
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
 * Registra aceitação dos termos de uso (obrigatório por LGPD/GDPR).
 *
 * [FIX-TERMS-VERSION] Inclui o campo terms_version (NOT NULL no banco).
 *   Valor controlado pela constante TERMS_VERSION no topo do arquivo.
 *   Atualizar TERMS_VERSION ao publicar nova versão dos termos.
 *
 * [SEC-10] userId validado como authData.user.id antes de chamar esta função.
 *
 * RLS na tabela terms_acceptance:
 *   INSERT: WITH CHECK (auth.uid() = user_id)  ← já existe no banco ✅
 *
 * @param {string} userId - UUID do usuário autenticado
 * @param {string} email  - Email normalizado (lowercase) do usuário
 */
async function _acceptTerms(userId, email) {
    try {
        const { error } = await supabase.from('terms_acceptance').insert({
            user_id:       userId,
            email,
            accepted:      true,
            accepted_at:   new Date().toISOString(),
            user_agent:    navigator.userAgent.slice(0, 200),
            terms_version: TERMS_VERSION, // [FIX-TERMS-VERSION] campo NOT NULL
        });

        if (error) {
            // Não crítico — não impede o fluxo mas registra para diagnóstico.
            console.warn('[primeiroacesso] _acceptTerms insert error (não crítico):', error.message);
        }
    } catch (err) {
        console.warn('[primeiroacesso] _acceptTerms exceção (não crítico):', err?.message);
    }
}

/**
 * Cria entrada em user_data com informações iniciais do usuário.
 *
 * [SEC-10] userId validado como authData.user.id antes de chamar esta função.
 * [SEC-CATCH-LOG] catch loga o erro para diagnóstico em produção.
 *
 * RLS na tabela user_data:
 *   INSERT: WITH CHECK (auth.uid() = user_id)  ← já existe no banco ✅
 *
 * @param {string} userId  - UUID do usuário autenticado
 * @param {string} email   - Email normalizado (lowercase) do usuário
 * @param {object} subData - Dados da subscription (plan_name, user_name)
 */
async function _createUserData(userId, email, subData) {
    try {
        const { error } = await supabase.from('user_data').insert({
            user_id: userId,
            email,
            data_json: {
                created_via: 'first_access',
                plan:        sanitize(subData.plan_name),
                name:        sanitize(subData.user_name),
                created_at:  new Date().toISOString(),
            },
        });

        if (error) {
            // Não crítico — não impede o fluxo mas registra para diagnóstico.
            console.warn('[primeiroacesso] _createUserData insert error (não crítico):', error.message);
        }
    } catch (err) {
        console.warn('[primeiroacesso] _createUserData exceção (não crítico):', err?.message);
    }
}