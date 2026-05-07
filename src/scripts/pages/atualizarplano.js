/**
 * GranaEvo — atualizarplano.js v3
 * Gerenciamento de assinatura Stripe mensal.
 * Substitui lógica de upgrade vitalício (Cakto) pelo modelo recorrente.
 */

import AuthGuard    from '../modules/auth-guard.js?v=2';
import { supabase } from '../services/supabase-client.js?v=2';

// ── Loading screen ────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
    const ls = document.getElementById('loadingScreen');
    if (ls) setTimeout(() => ls.classList.add('hidden'), 800);
});

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

// ── FAQ accordion ─────────────────────────────────────────────────────────────
document.querySelectorAll('.faq-question-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        const answerId = btn.getAttribute('aria-controls');
        const answer   = document.getElementById(answerId);
        btn.setAttribute('aria-expanded', String(!expanded));
        if (answer) answer.hidden = expanded;
    });
});

// ── Header scroll ─────────────────────────────────────────────────────────────
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
    header?.classList.toggle('scrolled', window.scrollY > 10);
}, { passive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(isoOrTs) {
    if (!isoOrTs) return '—';
    const d = typeof isoOrTs === 'number' ? new Date(isoOrTs * 1000) : new Date(isoOrTs);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function normalizePlanName(raw) {
    const map = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
    return map[(raw || '').toLowerCase()] || raw || '—';
}

// ── Auth + subscription load ──────────────────────────────────────────────────
async function init() {
    const userData = await AuthGuard.protect({
        requirePlan:      true,
        allowGuest:       false, // convidados não gerenciam assinaturas
        guestCanUpgrade:  false,
        redirectOnFail:   true,
        loadingElementId: 'authLoading',
    });

    if (!userData) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    await loadSubscription(session);
    setupPortalButton(session);
    setupRetryButton(session);
}

async function loadSubscription(session) {
    const userId    = session.user.id;
    const userEmail = (session.user.email || '').toLowerCase();

    const loading = document.getElementById('statusLoading');
    const content = document.getElementById('statusContent');
    const error   = document.getElementById('statusError');

    try {
        // 1. Tenta por user_id
        let { data: sub } = await supabase
            .from('stripe_subscriptions')
            .select('plan_name, status, current_period_end, cancel_at_period_end, canceled_at')
            .eq('user_id', userId)
            .in('status', ['active', 'trialing', 'past_due', 'canceled'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        // 2. Fallback por email (user_id ainda não vinculado)
        if (!sub && userEmail) {
            const { data: subByEmail } = await supabase
                .from('stripe_subscriptions')
                .select('plan_name, status, current_period_end, cancel_at_period_end, canceled_at')
                .ilike('user_email', userEmail)
                .in('status', ['active', 'trialing', 'past_due', 'canceled'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            sub = subByEmail;
        }

        if (!sub) {
            renderNoSubscription();
            return;
        }

        renderSubscription(sub);

    } catch (err) {
        console.error('[atualizarplano] Erro ao carregar assinatura:', err);
        if (loading) loading.hidden = true;
        if (error)   error.hidden   = false;
    }
}

function renderSubscription(sub) {
    const loading         = document.getElementById('statusLoading');
    const content         = document.getElementById('statusContent');
    const planNameEl      = document.getElementById('planName');
    const planStatusEl    = document.getElementById('planStatus');
    const nextBillingEl   = document.getElementById('nextBilling');
    const nextBillingRow  = document.getElementById('nextBillingRow');
    const cancelNoticeRow = document.getElementById('cancelNoticeRow');
    const cancelDateEl    = document.getElementById('cancelDate');

    if (loading) loading.hidden = true;
    if (content) content.hidden = false;

    if (planNameEl) planNameEl.textContent = normalizePlanName(sub.plan_name);

    const statusMap = {
        active:   { text: 'Ativa',               cls: 'badge-active'  },
        trialing: { text: 'Em teste gratuito',    cls: 'badge-trial'   },
        past_due: { text: 'Pagamento pendente',   cls: 'badge-warn'    },
        canceled: { text: 'Cancelada',            cls: 'badge-cancel'  },
    };
    const s = statusMap[sub.status] || { text: sub.status, cls: '' };

    if (sub.cancel_at_period_end && sub.status !== 'canceled') {
        // Agendado para cancelar no fim do período
        if (planStatusEl) {
            planStatusEl.textContent = 'Cancelamento agendado';
            planStatusEl.className   = 'status-badge badge-warn';
        }
        if (nextBillingRow)  nextBillingRow.hidden  = true;
        if (cancelNoticeRow) cancelNoticeRow.hidden  = false;
        if (cancelDateEl)    cancelDateEl.textContent = formatDate(sub.current_period_end);
    } else {
        if (planStatusEl) {
            planStatusEl.textContent = s.text;
            planStatusEl.className   = `status-badge ${s.cls}`;
        }
        if (sub.status !== 'canceled') {
            if (nextBillingEl)  nextBillingEl.textContent = formatDate(sub.current_period_end);
        } else {
            if (nextBillingRow) nextBillingRow.hidden = true;
        }
    }
}

function renderNoSubscription() {
    const loading  = document.getElementById('statusLoading');
    const content  = document.getElementById('statusContent');
    const statusEl = document.getElementById('planStatus');
    if (loading) loading.hidden = true;
    if (content) content.hidden = false;
    if (statusEl) {
        statusEl.textContent = 'Não encontrada';
        statusEl.className   = 'status-badge badge-cancel';
    }
}

// ── Portal Stripe ─────────────────────────────────────────────────────────────
function setupPortalButton(session) {
    const btn     = document.getElementById('btnPortal');
    const btnText = document.getElementById('btnPortalText');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        if (btnText) btnText.textContent = 'Abrindo portal seguro...';

        try {
            const { data: { session: fresh } } = await supabase.auth.getSession();
            const token = fresh?.access_token || session.access_token;

            const resp = await fetch('/api/stripe', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body:   JSON.stringify({ action: 'portal' }),
                signal: AbortSignal.timeout(15_000),
            });

            if (!resp.ok) {
                const body = await resp.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${resp.status}`);
            }

            const { url } = await resp.json();
            if (!url) throw new Error('URL do portal não retornada pelo servidor.');

            window.location.href = url;

        } catch (err) {
            console.error('[atualizarplano] Erro no portal:', err);
            alert(`Não foi possível abrir o portal.\n\n${err.message}\n\nTente novamente em instantes.`);
            btn.disabled = false;
            btn.setAttribute('aria-busy', 'false');
            if (btnText) btnText.textContent = 'Gerenciar minha assinatura';
        }
    });
}

function setupRetryButton(session) {
    const btn = document.getElementById('btnRetry');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const error   = document.getElementById('statusError');
        const loading = document.getElementById('statusLoading');
        if (error)   error.hidden   = true;
        if (loading) loading.hidden = false;
        const { data: { session: fresh } } = await supabase.auth.getSession();
        await loadSubscription(fresh || session);
    });
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
