/**
 * GranaEvo — aceitar-termos.js
 * Página de aceite de Termos de Uso (LGPD/VUL-008).
 *
 * NÃO usa auth-guard para evitar loop de redirect.
 * Faz verificação de sessão manual: sem sessão → login.
 */

import { supabase } from '../services/supabase-client.js?v=2';

(async () => {
    const loadingEl = document.getElementById('loading');
    const contentEl = document.getElementById('content');
    const errorEl   = document.getElementById('errorMsg');
    const checkbox  = document.getElementById('chkTerms');
    const btnAccept = document.getElementById('btnAccept');

    // ── 1. Verificar sessão ────────────────────────────────────────────────────
    let session;
    try {
        const { data } = await supabase.auth.getSession();
        session = data.session;
    } catch {
        session = null;
    }

    if (!session) {
        // Sem sessão → login (sem parâmetro next para evitar open-redirect)
        window.location.replace('login.html');
        return;
    }

    // ── 2. Exibe o formulário ─────────────────────────────────────────────────
    if (loadingEl) loadingEl.hidden = true;
    if (contentEl) contentEl.hidden = false;

    // ── 3. Checkbox habilita botão ────────────────────────────────────────────
    checkbox?.addEventListener('change', () => {
        if (btnAccept) btnAccept.disabled = !checkbox.checked;
    });

    // ── 4. Submissão do aceite ────────────────────────────────────────────────
    btnAccept?.addEventListener('click', async () => {
        if (!checkbox?.checked) return;

        btnAccept.disabled   = true;
        btnAccept.textContent = 'Registrando...';
        if (errorEl) errorEl.textContent = '';

        try {
            // Obtém sessão fresca para token válido
            const { data: { session: fresh } } = await supabase.auth.getSession();
            const token = fresh?.access_token ?? session.access_token;

            const r = await fetch('/api/accept-terms', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body:   JSON.stringify({}),
                signal: AbortSignal.timeout(10_000),
            });

            if (r.ok) {
                // Termos aceitos — vai para o dashboard (auth-guard vai cachear o OK)
                window.location.replace('dashboard.html');
            } else {
                const body = await r.json().catch(() => ({}));
                if (errorEl) errorEl.textContent = body.error || 'Erro ao registrar aceite. Tente novamente.';
                btnAccept.disabled   = false;
                btnAccept.textContent = 'Aceitar e continuar';
            }
        } catch {
            if (errorEl) errorEl.textContent = 'Erro de conexão. Verifique sua internet e tente novamente.';
            btnAccept.disabled   = false;
            btnAccept.textContent = 'Aceitar e continuar';
        }
    });
})();
