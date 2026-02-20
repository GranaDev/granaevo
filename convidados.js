// ========== CONFIGURAÇÃO SUPABASE ==========
const SUPABASE_URL = 'https://fvrhqqeofqedmhadzzqw.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2cmhxcWVvZnFlZG1oYWR6enF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczODIxMzgsImV4cCI6MjA4Mjk1ODEzOH0.1p6vHQm8qTJwq6xo7XYO0Et4_eZfN1-7ddcqfEN4LBo'; 

// ✅ CORREÇÃO: Renomeado de 'supabase' para 'supabaseClient'
// O SDK carregado via CDN já ocupa o nome global 'supabase', causando conflito.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========== ESTADO ==========
let verifiedEmail = '';
let verifiedCode = '';

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
    iniciarParticulas();
    verificarRefUrl();
    bindEventos();
});

function verificarRefUrl() {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) {
        console.log('📎 Invitation ref:', ref);
        // Apenas informativo; não pré-preenche código por segurança
    }
}

function bindEventos() {
    document.getElementById('btnVerify').addEventListener('click', verificarCodigo);
    document.getElementById('btnCreate').addEventListener('click', criarConta);

    // Formatar input do código: só números
    const codeInput = document.getElementById('inputCode');
    codeInput.addEventListener('input', function () {
        this.value = this.value.replace(/\D/g, '').slice(0, 6);
    });

    // Enter no code input → verificar
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verificarCodigo();
    });

    // Força de senha em tempo real
    document.getElementById('inputPassword').addEventListener('input', function () {
        atualizarForcaSenha(this.value);
    });
}

// ========== ETAPA 1: VERIFICAR ==========
async function verificarCodigo() {
    const email = document.getElementById('inputEmail').value.trim().toLowerCase();
    const code = document.getElementById('inputCode').value.trim();
    const errorBox = document.getElementById('step1Error');

    errorBox.style.display = 'none';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        mostrarErro('step1Error', 'Digite um email válido.');
        return;
    }
    if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
        mostrarErro('step1Error', 'O código deve ter exatamente 6 dígitos numéricos.');
        return;
    }

    setBtnLoading('btnVerify', true);

    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/verify-guest-invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: 'verify', email, code }),
        });

        const result = await response.json();

        if (!result.success) throw new Error(result.error || 'Código inválido.');

        // Guardar dados para etapa 2
        verifiedEmail = email;
        verifiedCode = code;

        // Preencher info da etapa 2
        document.getElementById('ownerNameDisplay').textContent = result.ownerName || '—';
        document.getElementById('welcomeBox').style.display = 'block';
        document.getElementById('step2Desc').textContent =
            `Olá, ${result.guestName}! Crie sua senha para acessar a conta.`;

        irParaStep('step2');

    } catch (err) {
        mostrarErro('step1Error', err.message);
        document.getElementById('inputCode').value = '';
        document.getElementById('inputCode').focus();
    }

    setBtnLoading('btnVerify', false);
}

// ========== ETAPA 2: CRIAR CONTA ==========
async function criarConta() {
    const password = document.getElementById('inputPassword').value;
    const passwordConfirm = document.getElementById('inputPasswordConfirm').value;
    const acceptedTerms = document.getElementById('checkTerms').checked;

    if (!password || password.length < 6) {
        mostrarErro('step2Error', 'A senha deve ter no mínimo 6 caracteres.');
        return;
    }
    if (password !== passwordConfirm) {
        mostrarErro('step2Error', 'As senhas não coincidem.');
        return;
    }
    if (!acceptedTerms) {
        mostrarErro('step2Error', 'Você precisa aceitar os Termos de Uso para continuar.');
        return;
    }

    setBtnLoading('btnCreate', true);

    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/verify-guest-invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                step: 'create',
                email: verifiedEmail,
                code: verifiedCode,
                password,
                acceptedTerms: true,
                ipAddress: null,
                userAgent: navigator.userAgent,
            }),
        });

        const result = await response.json();
        if (!result.success) throw new Error(result.error || 'Erro ao criar conta.');

        irParaStep('step3');

    } catch (err) {
        mostrarErro('step2Error', err.message);
    }

    setBtnLoading('btnCreate', false);
}

// ========== NAVEGAÇÃO ENTRE ETAPAS ==========
function irParaStep(stepId) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById(stepId).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function voltarEtapa1() {
    document.getElementById('step2Error').style.display = 'none';
    irParaStep('step1');
}

// ========== UTILITÁRIOS ==========
function mostrarErro(boxId, mensagem) {
    const box = document.getElementById(boxId);
    box.textContent = '⚠️ ' + mensagem;
    box.style.display = 'block';
}

function setBtnLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    const textEl = document.getElementById(btnId + 'Text');
    const loaderEl = document.getElementById(btnId + 'Loader');
    btn.disabled = loading;
    if (textEl) textEl.style.display = loading ? 'none' : 'inline';
    if (loaderEl) loaderEl.style.display = loading ? 'inline' : 'none';
}

function togglePassword(inputId, btn) {
    const input = document.getElementById(inputId);
    const icon = btn.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fas fa-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'fas fa-eye';
    }
}

function atualizarForcaSenha(senha) {
    const bar = document.getElementById('strengthBar');
    let force = 0;
    if (senha.length >= 6) force++;
    if (senha.length >= 10) force++;
    if (/[A-Z]/.test(senha)) force++;
    if (/[0-9]/.test(senha)) force++;
    if (/[^A-Za-z0-9]/.test(senha)) force++;

    const levels = ['', 'muito-fraca', 'fraca', 'razoavel', 'boa', 'forte'];
    const labels = ['', 'Muito Fraca', 'Fraca', 'Razoável', 'Boa', 'Forte'];
    bar.className = 'password-strength ' + (levels[force] || '');
    bar.setAttribute('data-label', labels[force] || '');
}

// ========== PARTÍCULAS DE FUNDO ==========
function iniciarParticulas() {
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [];

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 40; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.5 + 0.5,
            dx: (Math.random() - 0.5) * 0.3,
            dy: (Math.random() - 0.5) * 0.3,
            alpha: Math.random() * 0.4 + 0.1,
        });
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(16,185,129,${p.alpha})`;
            ctx.fill();
            p.x += p.dx;
            p.y += p.dy;
            if (p.x < 0 || p.x > canvas.width) p.dx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.dy *= -1;
        });
        requestAnimationFrame(animate);
    }
    animate();
}