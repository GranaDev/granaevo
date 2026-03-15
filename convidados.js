/**
 * GranaEvo — convidados.js  (v2 — revisão de segurança completa)
 *
 * ═══════════════════════════════════════════════════════════════
 *  CORREÇÕES APLICADAS — RELATÓRIO EXTERNO
 * ═══════════════════════════════════════════════════════════════
 *
 * [FIX-R01]  SDK Supabase (@supabase/supabase-js) removido do frontend.
 *            Estava carregado via CDN mas nunca utilizado nesta página.
 *            Impacto: cdn.jsdelivr.net eliminado do script-src da CSP.
 *            CSP agora trava script-src em 'self' apenas — zero CDN de scripts.
 *            Elimina por completo o risco de supply chain via CDN de scripts.
 *
 * [FIX-R02]  VERIFY_ENDPOINT configurável como constante única.
 *            Para implementar proxy interno (recomendado):
 *              1. Crie POST /api/verify-invite no seu servidor
 *              2. Essa rota encaminha para a Edge Function real
 *                 adicionando rate limit, CSRF e bloqueio de automação
 *              3. Substitua o valor de VERIFY_ENDPOINT por '/api/verify-invite'
 *              4. Atualize CSP: connect-src 'self' (remove URL Supabase)
 *
 * [FIX-R03]  Nonce criptográfico (16 bytes via crypto.getRandomValues) incluído
 *            em cada requisição. Para ser efetivo, o backend deve:
 *              - Aceitar cada nonce apenas uma vez (armazenar em Redis/DB)
 *              - Expirar nonces após TTL curto (ex: 2 minutos)
 *              - Rejeitar requisições sem nonce válido
 *            Sem validação backend, o nonce é defesa em profundidade apenas.
 *
 * [FIX-R04]  Contador de tentativas por sessão (MAX_VERIFY_ATTEMPTS = 5).
 *            Após o limite, o formulário é bloqueado na sessão atual.
 *            Reset automático ao verificar com sucesso.
 *            NOTA: proteção real exige rate limit backend por IP + email.
 *
 * ═══════════════════════════════════════════════════════════════
 *  CORREÇÕES APLICADAS — ADICIONAIS (encontradas nesta revisão)
 * ═══════════════════════════════════════════════════════════════
 *
 * [FIX-A01]  Mensagem de erro do step 'verify' normalizada para texto genérico.
 *            Antes: result.error do servidor era exibido verbatim → permitia
 *            enumeração de emails ("email não encontrado" vs "código inválido").
 *            Agora: sempre "Código inválido ou expirado." — independente do erro.
 *
 * [FIX-A02]  voltarEtapa1() agora limpa campos de senha, confirmação, barra de
 *            força e checkbox de termos antes de retornar à Etapa 1.
 *            Evita dados sensíveis remanescentes no DOM ao navegar entre etapas.
 *
 * [FIX-A03]  Campos de senha limpos do DOM imediatamente após criarConta()
 *            bem-sucedido — _limparFormularioStep2() chamado antes de ir à Etapa 3.
 *
 * [FIX-A04]  Headers Authorization e apikey adicionados às chamadas fetch.
 *            O gateway Supabase rejeita requisições sem a chave anon antes
 *            mesmo de chegarem à Edge Function — reduz superfície de ataque.
 *
 * ═══════════════════════════════════════════════════════════════
 *  CORREÇÕES MANTIDAS DA VERSÃO ANTERIOR
 * ═══════════════════════════════════════════════════════════════
 *
 * [FIX-⚠️5]   Cooldown de 5s entre tentativas (frontend).
 * [FIX-⚠️6]   ownerName exibido apenas na Etapa 3 (após criação bem-sucedida).
 * [FIX-⚠️10]  Senha mínima de 10 caracteres.
 * [FIX-⚠️12]  userAgent removido do payload — facilmente falsificável.
 * [FIX-VUL-A] _verifiedEmail e _verifiedCode zerados após uso.
 * [FIX-VUL-B] Sanitização do código no evento 'input' E no 'paste'.
 * [FIX-VUL-C] Redirect via SafeRedirect com validação same-origin.
 * [FIX-VUL-E] Parâmetro 'ref' da URL nunca inserido no DOM.
 * [FIX-VUL-F] Força mínima "razoável" (score ≥ 3) obrigatória para criar conta.
 * [FIX-REL-1] Visibilidade via classes CSS — sem style inline.
 * [FIX-REL-6] AbortController por requisição — cancela fetch anterior.
 *
 * ═══════════════════════════════════════════════════════════════
 *  NOTAS OBRIGATÓRIAS PARA O BACKEND (Edge Function)
 * ═══════════════════════════════════════════════════════════════
 *  - Rate limit por IP e por email (ambas as etapas)
 *  - Invalidar código após uso bem-sucedido (anti-replay)
 *  - Expiração do código (ex: 24h)
 *  - Resposta com tempo uniforme (evitar timing attack de enumeração)
 *  - Revalidar email + code no step 'create' (não confiar no estado JS)
 *  - Não logar o campo 'password' em nenhuma circunstância
 *  - Validar nonce: único por request + TTL curto + limite por IP
 *  - Verificar header Origin para rejeitar chamadas fora do domínio autorizado
 */

'use strict';

// ═══════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO
// ═══════════════════════════════════════════════════════════════
const SUPABASE_URL      = 'https://fvrhqqeofqedmhadzzqw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo';

/**
 * [FIX-R02] Ponto único de configuração do endpoint.
 *
 * AGORA  → chama Edge Function diretamente (URL exposta no frontend).
 * FUTURO → substitua por '/api/verify-invite' após implementar proxy interno.
 *           Com proxy: atualize CSP connect-src para 'self' apenas.
 */
const VERIFY_ENDPOINT = `${SUPABASE_URL}/functions/v1/verify-guest-invite`;

// ═══════════════════════════════════════════════════════════════
//  CONSTANTES DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════
const SECURITY = Object.freeze({
    VERIFY_COOLDOWN_MS:  5_000,  // [FIX-⚠️5]  5s entre tentativas
    PASSWORD_MIN_LENGTH: 10,     // [FIX-⚠️10] mínimo 10 caracteres
    MAX_VERIFY_ATTEMPTS: 5,      // [FIX-R04]  tentativas por sessão
    LOGIN_URL:           'login.html',
    EMAIL_MAX_LENGTH:    254,
    CODE_LENGTH:         6,
});

// ═══════════════════════════════════════════════════════════════
//  ESTADO PRIVADO
// ═══════════════════════════════════════════════════════════════
let _verifiedEmail    = '';
let _verifiedCode     = '';
let _ownerName        = '';     // [FIX-⚠️6]  exibido só na Etapa 3
let _verifyCooldown   = false;  // [FIX-⚠️5]
let _verifyController = null;   // [FIX-REL-6] AbortController do verify
let _createController = null;   // [FIX-REL-6] AbortController do create
let _attemptCount     = 0;      // [FIX-R04]  contador de tentativas na sessão

// ═══════════════════════════════════════════════════════════════
//  NONCE CRIPTOGRÁFICO  [FIX-R03]
//  Gera 16 bytes aleatórios via CSPRNG do browser.
//  Incluso em cada request — backend deve validar unicidade + TTL.
// ═══════════════════════════════════════════════════════════════
function _gerarNonce() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════════════════════
//  HEADERS PADRÃO PARA FETCH  [FIX-A04]
//  Authorization: Bearer garante que o gateway Supabase rejeite
//  requisições sem a chave anon antes de chegar à Edge Function.
// ═══════════════════════════════════════════════════════════════
function _buildHeaders() {
    return {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey':         SUPABASE_ANON_KEY,
    };
}

// ═══════════════════════════════════════════════════════════════
//  REDIRECT SEGURO  [FIX-VUL-C]
//  Valida same-origin e bloqueia schemes perigosos antes de redirecionar.
// ═══════════════════════════════════════════════════════════════
const SafeRedirect = {
    _DANGEROUS_SCHEMES: ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:'],

    _isSafe(url) {
        if (!url || typeof url !== 'string') return false;
        const lower = url.trim().toLowerCase();
        for (const scheme of this._DANGEROUS_SCHEMES) {
            if (lower.startsWith(scheme)) return false;
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) return true;
        try {
            return new URL(url, window.location.origin).origin === window.location.origin;
        } catch {
            return false;
        }
    },

    to(url) {
        if (!this._isSafe(url)) {
            console.error('[INVITE] Redirect bloqueado — URL não segura:', url);
            return;
        }
        window.location.replace(url);
    },
};

// ═══════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    iniciarParticulas();
    _lerRefUrl();
    _bindEventos();
});

// [FIX-VUL-E] Parâmetro 'ref' sanitizado e nunca inserido no DOM
function _lerRefUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        const ref    = params.get('ref');
        if (ref) {
            const refSanitized = String(ref).replace(/[^a-zA-Z0-9\-_]/g, '');
            if (refSanitized) console.log('[INVITE] ref:', refSanitized);
        }
    } catch {
        // Silencioso — parâmetro inválido ignorado
    }
}

function _bindEventos() {
    // Botões principais
    document.getElementById('btnVerify').addEventListener('click', verificarCodigo);
    document.getElementById('btnCreate').addEventListener('click', criarConta);
    document.getElementById('btnBack').addEventListener('click', voltarEtapa1);

    // [FIX-VUL-C] Redirect via SafeRedirect
    document.getElementById('btnGoLogin').addEventListener('click', () => {
        SafeRedirect.to(SECURITY.LOGIN_URL);
    });

    // Toggle de visibilidade das senhas (sem onclick inline)
    document.getElementById('togglePwd1').addEventListener('click', () => {
        _togglePassword('inputPassword', document.getElementById('togglePwd1'));
    });
    document.getElementById('togglePwd2').addEventListener('click', () => {
        _togglePassword('inputPasswordConfirm', document.getElementById('togglePwd2'));
    });

    // Código: apenas dígitos, sanitizado no input E no paste [FIX-VUL-B]
    const codeInput    = document.getElementById('inputCode');
    const _sanitizeCode = function () {
        this.value = this.value.replace(/\D/g, '').slice(0, SECURITY.CODE_LENGTH);
    };
    codeInput.addEventListener('input', _sanitizeCode);
    codeInput.addEventListener('paste', function () {
        setTimeout(() => _sanitizeCode.call(this), 0);
    });

    // Enter nos inputs
    codeInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') verificarCodigo();
    });
    document.getElementById('inputEmail').addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('inputCode').focus();
    });

    // Barra de força em tempo real
    document.getElementById('inputPassword').addEventListener('input', function () {
        atualizarForcaSenha(this.value);
    });
}

// ═══════════════════════════════════════════════════════════════
//  ETAPA 1: VERIFICAR CÓDIGO
// ═══════════════════════════════════════════════════════════════
async function verificarCodigo() {
    // [FIX-⚠️5] Cooldown ativo — aguardar
    if (_verifyCooldown) {
        _mostrarCooldownMsg('Aguarde alguns segundos antes de tentar novamente.');
        return;
    }

    // [FIX-R04] Limite de tentativas por sessão
    if (_attemptCount >= SECURITY.MAX_VERIFY_ATTEMPTS) {
        _mostrarErro(
            'step1Error',
            'Muitas tentativas incorretas. Recarregue a página para tentar novamente.'
        );
        document.getElementById('btnVerify').disabled = true;
        return;
    }

    const email = document.getElementById('inputEmail').value.trim().toLowerCase();
    const code  = document.getElementById('inputCode').value.trim();

    _ocultarErro('step1Error');

    // Validações locais
    if (
        !email ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > SECURITY.EMAIL_MAX_LENGTH
    ) {
        _mostrarErro('step1Error', 'Digite um email válido.');
        return;
    }
    if (!code || code.length !== SECURITY.CODE_LENGTH || !/^\d{6}$/.test(code)) {
        _mostrarErro('step1Error', 'O código deve ter exatamente 6 dígitos numéricos.');
        return;
    }

    _ativarCooldown();                // [FIX-⚠️5]
    _attemptCount++;                  // [FIX-R04]
    _setBtnLoading('btnVerify', true);

    try {
        if (_verifyController) _verifyController.abort();  // [FIX-REL-6]
        _verifyController = new AbortController();

        const response = await fetch(VERIFY_ENDPOINT, {
            method:  'POST',
            headers: _buildHeaders(),     // [FIX-A04]
            body:    JSON.stringify({
                step:  'verify',
                email,
                code,
                nonce: _gerarNonce(),    // [FIX-R03]
            }),
            signal: _verifyController.signal,
        });

        if (!response.ok && response.status !== 400) {
            throw new Error('Erro de rede. Tente novamente em alguns instantes.');
        }

        const result = await response.json();

        // [FIX-A01] Mensagem genérica — não expõe result.error do servidor.
        //           Evita enumeração de emails por mensagens distintas de erro.
        if (!result.success) {
            throw new Error('Código inválido ou expirado. Verifique e tente novamente.');
        }

        // Código válido — armazena estado para Etapa 2
        _verifiedEmail = email;
        _verifiedCode  = code;
        _ownerName     = result.ownerName || '';  // [FIX-⚠️6] exibido só na Etapa 3

        _attemptCount = 0;  // reset ao verificar com sucesso [FIX-R04]

        // step2Desc: saudação mínima — sem ownerName ainda [FIX-⚠️6]
        const guestName = result.guestName
            ? String(result.guestName).replace(/[<>"'&]/g, '')  // sanitiza defensivamente
            : '';
        document.getElementById('step2Desc').textContent = guestName
            ? `Olá, ${guestName}! Crie sua senha para acessar a conta.`
            : 'Bem-vindo(a)! Crie sua senha para acessar a conta.';

        _irParaStep('step2');

    } catch (err) {
        if (err?.name !== 'AbortError') {   // [FIX-REL-6] AbortError = cancelamento intencional
            _mostrarErro(
                'step1Error',
                err.message || 'Erro ao verificar. Tente novamente.'
            );
            document.getElementById('inputCode').value = '';
            document.getElementById('inputCode').focus();
        }
    }

    _setBtnLoading('btnVerify', false);
}

// ═══════════════════════════════════════════════════════════════
//  ETAPA 2: CRIAR CONTA
// ═══════════════════════════════════════════════════════════════
async function criarConta() {
    const password        = document.getElementById('inputPassword').value;
    const passwordConfirm = document.getElementById('inputPasswordConfirm').value;
    const acceptedTerms   = document.getElementById('checkTerms').checked;

    _ocultarErro('step2Error');

    // [FIX-⚠️10] Mínimo 10 caracteres
    if (!password || password.length < SECURITY.PASSWORD_MIN_LENGTH) {
        _mostrarErro(
            'step2Error',
            `A senha deve ter no mínimo ${SECURITY.PASSWORD_MIN_LENGTH} caracteres.`
        );
        return;
    }

    // [FIX-VUL-F] Força mínima "razoável" (score ≥ 3)
    if (_calcularForcaSenha(password) < 3) {
        _mostrarErro(
            'step2Error',
            'Sua senha é muito fraca. Use letras maiúsculas, números ou símbolos.'
        );
        return;
    }

    if (password !== passwordConfirm) {
        _mostrarErro('step2Error', 'As senhas não coincidem.');
        return;
    }
    if (!acceptedTerms) {
        _mostrarErro('step2Error', 'Você precisa aceitar os Termos de Uso para continuar.');
        return;
    }

    // Garante estado verificado ainda presente
    if (!_verifiedEmail || !_verifiedCode) {
        _mostrarErro(
            'step2Error',
            'Sessão expirada. Por favor, volte e verifique o código novamente.'
        );
        return;
    }

    _setBtnLoading('btnCreate', true);

    try {
        if (_createController) _createController.abort();  // [FIX-REL-6]
        _createController = new AbortController();

        const response = await fetch(VERIFY_ENDPOINT, {
            method:  'POST',
            headers: _buildHeaders(),    // [FIX-A04]
            body:    JSON.stringify({
                step:          'create',
                email:         _verifiedEmail,
                code:          _verifiedCode,
                password,
                acceptedTerms: true,
                nonce:         _gerarNonce(),  // [FIX-R03]
                // [FIX-⚠️12] userAgent removido — facilmente falsificável
            }),
            signal: _createController.signal,
        });

        if (!response.ok && response.status !== 400) {
            throw new Error('Erro de rede. Tente novamente em alguns instantes.');
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Erro ao criar conta. Tente novamente.');
        }

        // [FIX-VUL-A] Zera estado sensível imediatamente após uso
        _verifiedCode  = '';
        _verifiedEmail = '';

        // [FIX-A03] Limpa campos de senha do DOM antes de ir para Etapa 3
        _limparFormularioStep2();

        // [FIX-⚠️6] ownerName exibido agora — conta criada com sucesso
        if (_ownerName) {
            // textContent: nunca innerHTML com dado externo [FIX-⚠️13]
            document.getElementById('ownerNameDisplay').textContent = _ownerName;
            document.getElementById('welcomeBox').classList.remove('is-hidden');
            _ownerName = '';
        }

        _irParaStep('step3');

    } catch (err) {
        if (err?.name !== 'AbortError') {   // [FIX-REL-6]
            _mostrarErro('step2Error', err.message || 'Erro ao criar conta. Tente novamente.');
        }
    }

    _setBtnLoading('btnCreate', false);
}

// ═══════════════════════════════════════════════════════════════
//  NAVEGAÇÃO ENTRE ETAPAS
// ═══════════════════════════════════════════════════════════════
function _irParaStep(stepId) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById(stepId).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// [FIX-A02] Limpa dados da Etapa 2 ao voltar — sem resíduos no DOM
function voltarEtapa1() {
    _limparFormularioStep2();
    _ocultarErro('step2Error');
    _irParaStep('step1');
}

// ═══════════════════════════════════════════════════════════════
//  LIMPEZA DO FORMULÁRIO DA ETAPA 2  [FIX-A02] [FIX-A03]
//  Chamado em voltarEtapa1() e após criarConta() bem-sucedido.
//  Garante que senha, confirmação, barra de força e checkbox
//  não permaneçam no DOM após o uso ou ao navegar para trás.
// ═══════════════════════════════════════════════════════════════
function _limparFormularioStep2() {
    document.getElementById('inputPassword').value        = '';
    document.getElementById('inputPasswordConfirm').value = '';
    document.getElementById('checkTerms').checked         = false;

    const bar = document.getElementById('strengthBar');
    bar.className = 'password-strength';
    bar.setAttribute('data-label', '');
}

// ═══════════════════════════════════════════════════════════════
//  COOLDOWN  [FIX-⚠️5]
// ═══════════════════════════════════════════════════════════════
function _ativarCooldown() {
    _verifyCooldown = true;
    let remaining   = Math.ceil(SECURITY.VERIFY_COOLDOWN_MS / 1_000);
    const msg       = document.getElementById('cooldownMsg');

    msg.classList.remove('is-hidden');
    msg.textContent = `Próxima tentativa em ${remaining}s...`;

    const timer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(timer);
            _verifyCooldown = false;
            msg.classList.add('is-hidden');
            msg.textContent = '';
        } else {
            msg.textContent = `Próxima tentativa em ${remaining}s...`;
        }
    }, 1_000);
}

function _mostrarCooldownMsg(mensagem) {
    const msg = document.getElementById('cooldownMsg');
    msg.classList.remove('is-hidden');
    msg.textContent = mensagem;
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS DE UI
// ═══════════════════════════════════════════════════════════════

// [FIX-⚠️13] textContent — nunca innerHTML com mensagem externa
// [FIX-REL-1] Usa classes em vez de style inline
function _mostrarErro(boxId, mensagem) {
    const box     = document.getElementById(boxId);
    box.textContent = '⚠️ ' + mensagem;
    box.classList.remove('is-hidden');
}

function _ocultarErro(boxId) {
    const box = document.getElementById(boxId);
    if (box) box.classList.add('is-hidden');
}

function _setBtnLoading(btnId, loading) {
    const btn      = document.getElementById(btnId);
    const textEl   = document.getElementById(btnId + 'Text');
    const loaderEl = document.getElementById(btnId + 'Loader');
    btn.disabled = loading;
    if (textEl)   textEl.classList.toggle('is-hidden', loading);
    if (loaderEl) loaderEl.classList.toggle('is-hidden', !loading);
}

// Toggle visibilidade da senha — listener bindado em _bindEventos (sem onclick inline)
function _togglePassword(inputId, btn) {
    const input = document.getElementById(inputId);
    const icon  = btn.querySelector('i');
    if (input.type === 'password') {
        input.type     = 'text';
        icon.className = 'fas fa-eye-slash';
        btn.setAttribute('aria-label', 'Ocultar senha');
    } else {
        input.type     = 'password';
        icon.className = 'fas fa-eye';
        btn.setAttribute('aria-label', 'Mostrar senha');
    }
}

// ═══════════════════════════════════════════════════════════════
//  FORÇA DE SENHA  [FIX-VUL-F]
//  Separado em função reutilizável — usado na barra visual
//  e na validação do criarConta() (score mínimo 3 = "razoável").
// ═══════════════════════════════════════════════════════════════
function _calcularForcaSenha(senha) {
    let score = 0;
    if (senha.length >= SECURITY.PASSWORD_MIN_LENGTH) score++;
    if (senha.length >= 14)                           score++;
    if (/[A-Z]/.test(senha))                          score++;
    if (/[0-9]/.test(senha))                          score++;
    if (/[^A-Za-z0-9]/.test(senha))                  score++;
    return score;
}

function atualizarForcaSenha(senha) {
    const bar    = document.getElementById('strengthBar');
    const score  = _calcularForcaSenha(senha);
    const levels = ['', 'muito-fraca', 'fraca', 'razoavel', 'boa', 'forte'];
    const labels = ['', 'Muito Fraca', 'Fraca', 'Razoável', 'Boa', 'Forte'];
    bar.className = 'password-strength ' + (levels[score] || '');
    bar.setAttribute('data-label', labels[score] || '');
}

// ═══════════════════════════════════════════════════════════════
//  PARTÍCULAS DE FUNDO
// ═══════════════════════════════════════════════════════════════
function iniciarParticulas() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function resize() {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    const particles = Array.from({ length: 40 }, () => ({
        x:     Math.random() * canvas.width,
        y:     Math.random() * canvas.height,
        r:     Math.random() * 1.5 + 0.5,
        dx:    (Math.random() - 0.5) * 0.3,
        dy:    (Math.random() - 0.5) * 0.3,
        alpha: Math.random() * 0.4 + 0.1,
    }));

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(16,185,129,${p.alpha})`;
            ctx.fill();
            p.x += p.dx;
            p.y += p.dy;
            if (p.x < 0 || p.x > canvas.width)  p.dx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.dy *= -1;
        });
        requestAnimationFrame(animate);
    }
    animate();
}