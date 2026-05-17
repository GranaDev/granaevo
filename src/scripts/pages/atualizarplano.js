/**
 * GranaEvo — atualizarplano.js v4
 * Gerenciamento de assinatura Stripe mensal.
 */

import AuthGuard    from '../modules/auth-guard.js?v=2';
import { supabase } from '../services/supabase-client.js?v=2';

// ── Loading screen ────────────────────────────────────────────────
window.addEventListener('load', () => {
    const ls = document.getElementById('loadingScreen');
    if (ls) setTimeout(() => ls.classList.add('hidden'), 800);
});

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

// ── Header scroll ─────────────────────────────────────────────────
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
    header?.classList.toggle('scrolled', window.scrollY > 10);
}, { passive: true });

// ── FAQ accordion ─────────────────────────────────────────────────
document.querySelectorAll('.faq-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        const answerId = btn.getAttribute('aria-controls');
        const answer   = document.getElementById(answerId);
        btn.setAttribute('aria-expanded', String(!expanded));
        if (answer) answer.hidden = expanded;
    });
});

// ── 3D tilt on [data-tilt] elements ──────────────────────────────
function initTilt() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    document.querySelectorAll('[data-tilt]').forEach(el => {
        const MAX = 10;

        el.addEventListener('mousemove', e => {
            const r  = el.getBoundingClientRect();
            const x  = (e.clientX - r.left) / r.width  - 0.5;
            const y  = (e.clientY - r.top)  / r.height - 0.5;
            const rx = (-y * MAX).toFixed(2);
            const ry = ( x * MAX).toFixed(2);
            el.style.transform =
                `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) scale3d(1.02,1.02,1.02)`;
        }, { passive: true });

        el.addEventListener('mouseleave', () => {
            el.style.transition = 'transform .45s cubic-bezier(.22,1,.36,1)';
            el.style.transform  = '';
            setTimeout(() => { el.style.transition = ''; }, 500);
        }, { passive: true });
    });
}

// 3D tilt + dynamic glare on the subscription card
function initCardTilt() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const scene = document.getElementById('cardScene');
    const card  = document.getElementById('subCard');
    const glare = document.getElementById('cardGlare');
    if (!scene || !card) return;

    const MAX = 16;

    scene.addEventListener('mousemove', e => {
        const r   = scene.getBoundingClientRect();
        const nx  = (e.clientX - r.left) / r.width;   // 0–1
        const ny  = (e.clientY - r.top)  / r.height;  // 0–1
        const rx  = (-(ny - 0.5) * MAX).toFixed(2);
        const ry  = ( (nx - 0.5) * MAX).toFixed(2);

        card.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;

        // Dynamic glare — radial highlight that follows mouse position on card face
        if (glare) {
            glare.style.background =
                `radial-gradient(circle at ${(nx * 100).toFixed(1)}% ${(ny * 100).toFixed(1)}%, ` +
                `rgba(255,255,255,.14) 0%, rgba(110,231,183,.06) 35%, transparent 65%)`;
        }

        // Shadow shifts with tilt to simulate real light source
        const dy = (ny - 0.5) * 18;
        card.style.boxShadow =
            `0 1px 0 rgba(110,231,183,.22) inset,` +
            `0 -1px 0 rgba(0,0,0,.35) inset,` +
            `0 ${4 + dy}px 6px rgba(0,0,0,.45),` +
            `0 ${14 + dy * 1.2}px 30px rgba(0,0,0,.55),` +
            `0 ${32 + dy * 1.5}px 64px rgba(0,0,0,.4),` +
            `0 ${18 + dy}px 48px rgba(16,185,129,.18),` +
            `0 ${52 + dy * 2}px 100px rgba(16,185,129,.1)`;
    }, { passive: true });

    scene.addEventListener('mouseleave', () => {
        card.style.transition =
            'transform .6s cubic-bezier(.22,1,.36,1), box-shadow .5s cubic-bezier(.22,1,.36,1)';
        card.style.transform  = '';
        card.style.boxShadow  = '';
        if (glare) glare.style.background = '';
        setTimeout(() => { card.style.transition = ''; }, 650);
    }, { passive: true });
}

initTilt();
initCardTilt();

// ── Helpers ───────────────────────────────────────────────────────
function formatDate(isoOrTs) {
    if (!isoOrTs) return '—';
    const d = typeof isoOrTs === 'number' ? new Date(isoOrTs * 1000) : new Date(isoOrTs);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateLong(isoOrTs) {
    if (!isoOrTs) return '—';
    const d = typeof isoOrTs === 'number' ? new Date(isoOrTs * 1000) : new Date(isoOrTs);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function normalizePlanName(raw) {
    const map = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
    return map[(raw || '').toLowerCase()] || raw || '—';
}

// ── Auth + subscription load ──────────────────────────────────────
async function init() {
    const userData = await AuthGuard.protect({
        requirePlan:      true,
        allowGuest:       false,
        guestCanUpgrade:  false,
        redirectOnFail:   true,
        loadingElementId: 'authLoading',
    });

    if (!userData) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    // Load basic info from Supabase immediately, then enrich with Stripe data
    await loadSubscription(session);
    setupPortalButton(session);
    setupPlanChangeCard(session);
    loadStripeDetails(session); // async, enriches UI when ready
}

const _FIELDS = 'plan_name, status, current_period_start, current_period_end, cancel_at_period_end, canceled_at, created_at, pending_plan_name, pending_plan_effective_at';

async function loadSubscription(session) {
    const userId    = session.user.id;
    const userEmail = (session.user.email || '').toLowerCase();

    try {
        let { data: sub } = await supabase
            .from('stripe_subscriptions')
            .select(_FIELDS)
            .eq('user_id', userId)
            .in('status', ['active', 'trialing', 'past_due', 'canceled'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!sub && userEmail) {
            const { data: byEmail } = await supabase
                .from('stripe_subscriptions')
                .select(_FIELDS)
                .ilike('user_email', userEmail)
                .in('status', ['active', 'trialing', 'past_due', 'canceled'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            sub = byEmail;
        }

        if (!sub) { renderNoSubscription(); return; }
        renderSubscription(sub);
        renderDetails(sub);
        _checkCancellationNotification(sub);

    } catch (err) {
        console.error('[atualizarplano] Erro ao carregar assinatura:', err);
        _setBadge('badge-cancel', 'Erro ao carregar');
    }
}

// ── Render helpers ────────────────────────────────────────────────
function _setBadge(cls, text) {
    const badge   = document.getElementById('planStatusBadge');
    const badgeTxt = document.getElementById('planStatusText');
    if (badge)    badge.className = `status-badge ${cls}`;
    if (badgeTxt) badgeTxt.textContent = text;
}

function renderSubscription(sub) {
    const planNameEl      = document.getElementById('planName');
    const planTypeEl      = document.getElementById('planType');
    const nextBillingEl   = document.getElementById('nextBilling');
    const nextBillingWrap = document.getElementById('nextBillingWrap');
    const cancelWrap      = document.getElementById('cancelWrap');
    const cancelDateEl    = document.getElementById('cancelDate');

    const normalized = normalizePlanName(sub.plan_name);
    _currentPlanSlug           = (sub.plan_name || '').toLowerCase().trim();
    _currentPendingPlan        = (sub.pending_plan_name || '').toLowerCase().trim();
    _currentPendingEffectiveAt = sub.pending_plan_effective_at || null;

    if (planNameEl) planNameEl.textContent = normalized;
    if (planTypeEl) planTypeEl.textContent = normalized;

    const statusMap = {
        active:   { text: 'Ativa',              cls: 'badge-active'  },
        trialing: { text: 'Teste gratuito',      cls: 'badge-trial'   },
        past_due: { text: 'Pgto. pendente',      cls: 'badge-warn'    },
        canceled: { text: 'Cancelada',           cls: 'badge-cancel'  },
    };
    const s = statusMap[sub.status] || { text: sub.status, cls: '' };

    if (sub.cancel_at_period_end && sub.status !== 'canceled') {
        _setBadge('badge-warn', 'Cancelamento agendado');
        if (nextBillingWrap) nextBillingWrap.hidden = true;
        if (cancelWrap)      cancelWrap.hidden      = false;
        if (cancelDateEl)    cancelDateEl.textContent = formatDate(sub.current_period_end);
    } else {
        _setBadge(s.cls, s.text);
        if (sub.status === 'canceled') {
            if (nextBillingWrap) nextBillingWrap.hidden = true;
        } else {
            if (nextBillingEl) nextBillingEl.textContent = formatDate(sub.current_period_end);
        }
    }
}

function renderNoSubscription() {
    _setBadge('badge-cancel', 'Não encontrada');
    const planNameEl = document.getElementById('planName');
    if (planNameEl) planNameEl.textContent = 'Sem assinatura';
}

// ── Detail cards section ──────────────────────────────────────────
function _makeCard(label, value, cls) {
    const card = document.createElement('div');
    card.className = 'detail-card' + (cls ? ' ' + cls : '');

    const lEl = document.createElement('span');
    lEl.className = 'dc-label';
    lEl.textContent = label;

    const vEl = document.createElement('span');
    vEl.className = 'dc-value';
    vEl.textContent = value;

    card.append(lEl, vEl);
    return card;
}

function _makePeriodCard(label, start, end) {
    const card = document.createElement('div');
    card.className = 'detail-card';

    const lEl = document.createElement('span');
    lEl.className = 'dc-label';
    lEl.textContent = label;

    const vEl = document.createElement('span');
    vEl.className = 'dc-value dc-period';

    const s = document.createElement('span'); s.textContent = start;
    const sep = document.createElement('span'); sep.className = 'dc-sep'; sep.textContent = '→';
    const e = document.createElement('span'); e.textContent = end;
    vEl.append(s, sep, e);

    card.append(lEl, vEl);
    return card;
}

function renderDetails(sub) {
    const section = document.getElementById('detailsSection');
    const grid    = document.getElementById('detailsGrid');
    if (!section || !grid) return;

    grid.innerHTML = '';

    const normalized = normalizePlanName(sub.plan_name);
    const isCancelling = sub.cancel_at_period_end && sub.status !== 'canceled';
    const isCanceled   = sub.status === 'canceled';
    const isPastDue    = sub.status === 'past_due';
    const isTrial      = sub.status === 'trialing';
    const isActive     = sub.status === 'active';

    // ── Card 1: Status ────────────────────────────────────────────
    const statusMap = {
        active:   { label: 'Ativa',              cls: 'ds-green' },
        trialing: { label: 'Teste gratuito',      cls: 'ds-blue'  },
        past_due: { label: 'Pagamento pendente',  cls: 'ds-amber' },
        canceled: { label: 'Encerrada',           cls: 'ds-red'   },
    };
    const sm = statusMap[sub.status] || { label: sub.status, cls: '' };
    const statusLabel = isCancelling ? 'Cancelamento agendado' : sm.label;
    const statusCls   = isCancelling ? 'ds-amber' : sm.cls;
    grid.appendChild(_makeCard('Status', statusLabel, statusCls));

    // ── Card 2: Plano ─────────────────────────────────────────────
    grid.appendChild(_makeCard('Plano', normalized));

    // ── Card 3: Ciclo de cobrança ─────────────────────────────────
    grid.appendChild(_makeCard('Ciclo de cobrança', 'Mensal'));

    // ── Card 4: Período atual (start → end) ───────────────────────
    const periodStart = sub.current_period_start ? formatDate(sub.current_period_start) : '—';
    const periodEnd   = sub.current_period_end   ? formatDate(sub.current_period_end)   : '—';
    grid.appendChild(_makePeriodCard('Período atual', periodStart, periodEnd));

    // ── Card 5: Próxima cobrança / Acesso válido até ──────────────
    let billingLabel, billingValue, billingCls;
    if (isCancelling) {
        billingLabel = 'Acesso válido até';
        billingValue = periodEnd;
        billingCls   = 'ds-amber';
    } else if (isCanceled) {
        billingLabel = 'Acesso válido até';
        billingValue = periodEnd;
        billingCls   = 'ds-red';
    } else if (isPastDue) {
        billingLabel = 'Venceu em';
        billingValue = periodEnd;
        billingCls   = 'ds-amber';
    } else if (isTrial) {
        billingLabel = 'Teste gratuito até';
        billingValue = periodEnd;
        billingCls   = 'ds-blue';
    } else {
        billingLabel = 'Próxima cobrança';
        billingValue = isActive ? periodEnd : '—';
        billingCls   = '';
    }
    grid.appendChild(_makeCard(billingLabel, billingValue, billingCls));

    // ── Card 6: Membro desde ──────────────────────────────────────
    grid.appendChild(_makeCard('Membro desde', formatDateLong(sub.created_at)));

    section.hidden = false;
}

// ── Stripe real-time details (subscription + invoices) ───────────
function formatCurrency(amountCents, currency = 'brl') {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(amountCents / 100);
}

function _showInvoiceSkeleton() {
    const list = document.getElementById('invoicesList');
    const sec  = document.getElementById('invoicesSection');
    if (!list || !sec) return;
    list.innerHTML = '';
    for (let i = 0; i < 3; i++) {
        const row = document.createElement('div');
        row.className = 'inv-skeleton';
        const b1 = document.createElement('div');
        b1.className = 'skel-bar'; b1.style.width = '140px'; b1.style.height = '14px';
        const b2 = document.createElement('div');
        b2.className = 'skel-bar'; b2.style.width = '80px'; b2.style.height = '14px';
        b2.style.marginLeft = 'auto';
        row.append(b1, b2);
        list.appendChild(row);
    }
    sec.hidden = false;
}

async function loadStripeDetails(session) {
    _showInvoiceSkeleton();

    try {
        const { data: { session: fresh } } = await supabase.auth.getSession();
        const token = fresh?.access_token || session.access_token;

        const resp = await fetch('/api/stripe', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body:   JSON.stringify({ action: 'details' }),
            signal: AbortSignal.timeout(20_000),
        });

        if (!resp.ok) {
            console.warn('[atualizarplano] details HTTP', resp.status);
            _renderInvoiceEmpty();
            return;
        }

        const { subscription, invoices } = await resp.json();

        // Re-renderiza os cards de detalhe com dados autoritativos do Stripe.
        // Fallback em cadeia: subscription.period_end → invoice mais recente paga → +30 dias.
        let derivedPeriodEnd   = subscription?.current_period_end   ?? null
        let derivedPeriodStart = subscription?.current_period_start ?? null
        let derivedCreated     = subscription?.start_date || subscription?.created || null

        if (!derivedPeriodEnd && Array.isArray(invoices) && invoices.length) {
            // Fallback 1: usa period_end da invoice paga mais recente (= próxima cobrança)
            const lastPaid = invoices.find(inv => inv.status === 'paid' && inv.period_end)
            if (lastPaid) {
                derivedPeriodEnd   = lastPaid.period_end
                if (!derivedPeriodStart) derivedPeriodStart = lastPaid.period_start
                if (!derivedCreated)     derivedCreated     = lastPaid.created
            }
        }

        if (!derivedPeriodEnd && Array.isArray(invoices) && invoices.length) {
            // Fallback 2: data da última invoice + 30 dias
            const lastAny = invoices.find(inv => inv.created)
            if (lastAny) {
                derivedPeriodEnd   = lastAny.created + 30 * 24 * 3600
                if (!derivedPeriodStart) derivedPeriodStart = lastAny.created
                if (!derivedCreated)     derivedCreated     = lastAny.created
            }
        }

        if (derivedPeriodEnd) {
            renderDetails({
                plan_name:                 _currentPlanSlug,
                status:                    subscription?.status             ?? 'active',
                current_period_start:      derivedPeriodStart,
                current_period_end:        derivedPeriodEnd,
                cancel_at_period_end:      subscription?.cancel_at_period_end ?? false,
                canceled_at:               subscription?.canceled_at          ?? null,
                created_at:                derivedCreated,
                pending_plan_name:         _currentPendingPlan        || null,
                pending_plan_effective_at: _currentPendingEffectiveAt || null,
            });

            _derivedPeriodEnd   = derivedPeriodEnd    // expõe para o modal usar como fallback
            _derivedPeriodStart = derivedPeriodStart  // expõe para cálculo de proration local

            // Atualiza o cartão 3D no topo da página — preenche AMBOS os elementos
            // independentemente de qual esteja visível (show/hide já definido em renderSubscription)
            const dateFmt       = formatDate(derivedPeriodEnd)
            const nextBillingEl = document.getElementById('nextBilling')
            const cancelDateEl  = document.getElementById('cancelDate')
            if (nextBillingEl) nextBillingEl.textContent = dateFmt
            if (cancelDateEl)  cancelDateEl.textContent  = dateFmt
        }

        _updateMemberSince(subscription);
        _updatePriceCard(subscription);

        // Render invoice list
        _renderInvoices(invoices || []);

        // Notificação de cancelamento via Stripe direto (sem depender do webhook)
        if (subscription) _checkCancellationNotification(subscription);

    } catch (err) {
        console.error('[atualizarplano] Erro ao buscar detalhes Stripe:', err);
        _renderInvoiceEmpty();
    }
}

// Atualiza TODOS os campos de data na UI com os dados autoritativos do Stripe.
// Resolve o "-" em "Próxima cobrança" quando o banco está com current_period_end NULL.
function _updateDatesFromStripe(subscription) {
    if (!subscription) return;

    const periodEnd   = subscription.current_period_end;
    const periodStart = subscription.current_period_start;
    const cancelAtEnd = subscription.cancel_at_period_end;
    const status      = subscription.status;
    const isCanceled  = status === 'canceled';

    if (!periodEnd) return;

    const endFmt   = formatDate(periodEnd);
    const startFmt = periodStart ? formatDate(periodStart) : null;

    // Header principal da página
    const nextBillingEl = document.getElementById('nextBilling');
    const cancelDateEl  = document.getElementById('cancelDate');
    if (nextBillingEl && !cancelAtEnd && !isCanceled) nextBillingEl.textContent = endFmt;
    if (cancelDateEl && (cancelAtEnd || isCanceled))  cancelDateEl.textContent  = endFmt;

    // Cards de detalhe — todos os rótulos que carregam datas de período
    const DATE_LABELS = new Set([
        'Próxima cobrança', 'Acesso válido até', 'Venceu em',
        'Teste gratuito até', 'Ciclo de cobrança',
    ]);
    document.querySelectorAll('.detail-card').forEach(card => {
        const labelEl = card.querySelector('.dc-label');
        const valueEl = card.querySelector('.dc-value');
        if (!labelEl || !valueEl) return;
        const label = labelEl.textContent?.trim();

        if (DATE_LABELS.has(label) && label !== 'Ciclo de cobrança') {
            // Só sobrescreve se o valor atual for "—" (vindo do banco sem data)
            if (valueEl.textContent === '—' || valueEl.textContent === '-') {
                valueEl.textContent = endFmt;
            }
        }
        if (label === 'Período atual' && startFmt) {
            const spans = valueEl.querySelectorAll('span:not(.dc-sep)');
            if (spans[0] && (spans[0].textContent === '—' || !spans[0].textContent.trim())) {
                spans[0].textContent = startFmt;
            }
            if (spans[1] && (spans[1].textContent === '—' || !spans[1].textContent.trim())) {
                spans[1].textContent = endFmt;
            }
        }
        if (label === 'Membro desde' && !valueEl.textContent.match(/\d{2}\/\d{2}\/\d{4}/)) {
            const ts = subscription.start_date || subscription.created;
            if (ts) valueEl.textContent = formatDateLong(ts);
        }
    });
}

function _updateMemberSince(subscription) {
    if (!subscription) return;
    const ts = subscription.start_date || subscription.created;
    if (!ts) return;
    document.querySelectorAll('.detail-card').forEach(card => {
        const label = card.querySelector('.dc-label');
        const value = card.querySelector('.dc-value');
        if (label?.textContent === 'Membro desde' && value) {
            value.textContent = formatDateLong(ts);
        }
    });
}

function _updatePriceCard(subscription) {
    if (!subscription?.price?.unit_amount) return;
    const amount   = formatCurrency(subscription.price.unit_amount, subscription.price.currency || 'brl');
    const interval = subscription.price.interval === 'month' ? 'mês' : subscription.price.interval;
    document.querySelectorAll('.detail-card').forEach(card => {
        const label = card.querySelector('.dc-label');
        const value = card.querySelector('.dc-value');
        if (label?.textContent === 'Ciclo de cobrança' && value) {
            value.textContent = `${amount} / ${interval}`;
        }
    });
}

function _renderInvoices(invoices) {
    const list = document.getElementById('invoicesList');
    const sec  = document.getElementById('invoicesSection');
    if (!list) return;
    list.innerHTML = '';

    if (!invoices.length) { _renderInvoiceEmpty(); return; }

    const statusMap = {
        paid:          { label: 'Pago',      cls: 'inv-paid'   },
        open:          { label: 'Pendente',  cls: 'inv-open'   },
        uncollectible: { label: 'Falhou',    cls: 'inv-failed' },
        void:          { label: 'Cancelada', cls: 'inv-failed' },
    };

    for (const inv of invoices) {
        const sm = statusMap[inv.status] || { label: inv.status, cls: '' };

        const row = document.createElement('div');
        row.className = 'inv-row';

        // Left: date + period
        const left = document.createElement('div');
        left.className = 'inv-left';

        const dateEl = document.createElement('span');
        dateEl.className = 'inv-date';
        dateEl.textContent = inv.number
            ? `${formatDate(inv.created)} · ${inv.number}`
            : formatDate(inv.created);
        left.appendChild(dateEl);

        if (inv.period_start && inv.period_end) {
            const period = document.createElement('span');
            period.className = 'inv-period';
            const s = document.createElement('span'); s.textContent = formatDate(inv.period_start);
            const sep = document.createElement('span'); sep.className = 'inv-period-sep'; sep.textContent = '→';
            const e = document.createElement('span'); e.textContent = formatDate(inv.period_end);
            period.append(s, sep, e);
            left.appendChild(period);
        }

        row.appendChild(left);

        // Amount
        const amtEl = document.createElement('span');
        amtEl.className = 'inv-amount';
        const paid = inv.amount_paid > 0 ? inv.amount_paid : inv.amount_due;
        amtEl.textContent = formatCurrency(paid || 0, inv.currency || 'brl');
        row.appendChild(amtEl);

        // Status badge
        const badge = document.createElement('span');
        badge.className = `inv-badge ${sm.cls}`;
        badge.textContent = sm.label;
        row.appendChild(badge);

        // PDF link
        const pdfUrl = inv.invoice_pdf || inv.hosted_invoice_url;
        if (pdfUrl) {
            const a = document.createElement('a');
            a.className = 'inv-pdf';
            a.href    = pdfUrl;
            a.target  = '_blank';
            a.rel     = 'noopener noreferrer';
            a.setAttribute('aria-label', `Baixar fatura ${inv.number || formatDate(inv.created)}`);
            a.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M3 12l2-2m0 0l3 3 5-7M5 10V4M3 14h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            row.appendChild(a);
        } else {
            const placeholder = document.createElement('div');
            placeholder.style.width = '34px';
            row.appendChild(placeholder);
        }

        list.appendChild(row);
    }

    if (sec) sec.hidden = false;
}

function _renderInvoiceEmpty() {
    const list = document.getElementById('invoicesList');
    const sec  = document.getElementById('invoicesSection');
    if (!list) return;
    list.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'inv-empty';
    empty.textContent = 'Nenhuma fatura encontrada.';
    list.appendChild(empty);
    if (sec) sec.hidden = false;
}

// ── Notificação de cancelamento ───────────────────────────────────
// sub pode vir do banco (ISO string) ou do Stripe direto (Unix timestamp em segundos)
function _checkCancellationNotification(sub) {
    if (!sub) return
    const isCancelling = sub.cancel_at_period_end && sub.status !== 'canceled'
    const isCanceled   = sub.status === 'canceled'
    if (!isCancelling && !isCanceled) return

    // Converte Unix timestamp (Stripe) ou ISO string (banco) para Date
    const rawEnd = sub.current_period_end
    let periodEndDate = null
    if (rawEnd) {
        periodEndDate = typeof rawEnd === 'number'
            ? new Date(rawEnd * 1000)   // Stripe retorna segundos
            : new Date(rawEnd)          // Supabase retorna ISO string
    }

    const periodEndFmt = periodEndDate
        ? periodEndDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
        : null

    // Chave única por estado + data de vencimento — evita mostrar mais de uma vez
    const storageKey = `ge_cancel_notif_${sub.status}_${periodEndDate?.toISOString().slice(0, 10) ?? 'nd'}`
    if (localStorage.getItem(storageKey)) return
    localStorage.setItem(storageKey, '1')

    const msg = isCancelling
        ? `Cancelamento agendado — acesso garantido até ${periodEndFmt ?? 'o fim do ciclo'}.`
        : `Assinatura encerrada${periodEndFmt ? ` em ${periodEndFmt}` : ''}.`

    _showToast(msg, isCanceled ? 'error' : 'warning')
}

function _showToast(msg, type = 'info') {
    const colors = {
        info:    'linear-gradient(135deg,#1e3a5f,#1e4080)',
        success: 'linear-gradient(135deg,#064e35,#065f46)',
        warning: 'linear-gradient(135deg,#78350f,#92400e)',
        error:   'linear-gradient(135deg,#7f1d1d,#991b1b)',
    }
    const el = document.createElement('div')
    el.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px', 'z-index:9999',
        'max-width:380px', 'padding:14px 20px', 'border-radius:12px',
        `background:${colors[type] ?? colors.info}`,
        'color:#f1f5f9', 'font-size:14px', 'font-weight:500',
        'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
        'border:1px solid rgba(255,255,255,0.1)',
        'line-height:1.5', 'transition:opacity .3s ease',
    ].join(';')
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(() => {
        el.style.opacity = '0'
        setTimeout(() => el.remove(), 320)
    }, 5000)
}

// ── Modal alterar plano ───────────────────────────────────────────
let _currentPlanSlug             = ''
let _currentPendingPlan          = ''
let _currentPendingEffectiveAt   = null
let _derivedPeriodEnd            = null  // Unix timestamp — fallback para data da alteração agendada
let _derivedPeriodStart          = null  // Unix timestamp — fallback para cálculo de proration

// ── Helpers do modal ─────────────────────────────────────────────
function _fmtMoney(cents, currency = 'brl') {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(cents / 100)
}

function _fmtDateFromTs(ts) {
    if (!ts) return '—'
    return new Date(ts * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function _fmtDateFromISO(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function _planLabel(slug) {
    return { individual: 'Individual', casal: 'Casal', familia: 'Família' }[slug] || slug || '—'
}

// Catálogo de planos (preços em centavos)
const plans = [
    {
        slug:    'individual',
        label:   'Individual',
        price:   1999,
        tagline: '1 perfil de usuário',
        desc:    'Controle total das suas finanças pessoais. Dashboard completo, metas e relatórios.',
        icon:    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
    },
    {
        slug:    'casal',
        label:   'Casal',
        price:   3499,
        tagline: '2 perfis de usuário',
        desc:    'Finanças compartilhadas para dois. Metas em conjunto e visão unificada do orçamento.',
        icon:    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><circle cx="15" cy="8" r="3"/><path d="M2 20c0-3.3 3.1-6 7-6"/><path d="M22 20c0-3.3-3.1-6-7-6"/><path d="M9 14c1-.4 2.1-.7 3-.7s2 .3 3 .7"/></svg>`,
    },
    {
        slug:    'familia',
        label:   'Família',
        price:   5499,
        tagline: '4 perfis de usuário',
        desc:    'Gestão financeira familiar completa. Até 4 membros com dashboards individuais.',
        icon:    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="7" r="3"/><circle cx="16" cy="7" r="3"/><path d="M2 19c0-3 2.7-5 6-5h8c3.3 0 6 2 6 5"/><circle cx="12" cy="14" r="2"/><path d="M9 19c0-1.7 1.3-3 3-3s3 1.3 3 3"/></svg>`,
    },
]

// ── Modal de Alteração de Plano (CSP-safe: zero inline styles) ────────
function _openPlanModal(session) {

    // ── Estado ────────────────────────────────────────────────────
    let _selectedPlan       = ''
    let _previewData        = null
    let _selectedForRemoval = new Set()
    let _fetchingPreview    = false

    // ── DOM base ──────────────────────────────────────────────────
    const overlay = document.createElement('div')
    overlay.id = 'planModalOverlay'

    const modal = document.createElement('div')
    modal.id = 'planModalInner'

    overlay.appendChild(modal)
    overlay.addEventListener('click', e => { if (e.target === overlay) _close() })
    document.body.appendChild(overlay)

    // ── Utilitários ───────────────────────────────────────────────
    const _close = () => overlay.remove()

    async function _getToken() {
        const { data: { session: fresh } } = await supabase.auth.getSession()
        return fresh?.access_token || session.access_token
    }

    function _setHtml(html) {
        modal.innerHTML = `<div class="gm-step-wrap">${html}</div>`
        modal.querySelector('[data-close]')?.addEventListener('click', _close)
    }

    function _hdr(title, withBack = false) {
        return `
          <div class="gm-hdr">
            <div class="gm-hdr-left">
              ${withBack ? `<button data-back class="gm-btn-back">← Voltar</button>` : ''}
              <h2 class="gm-title">${title}</h2>
            </div>
            <button data-close class="gm-btn-close" aria-label="Fechar">✕</button>
          </div>`
    }

    function _spin16() {
        return `<span class="gm-spin"></span>`
    }

    // ── Fetch preview ─────────────────────────────────────────────
    async function _fetchPreview(planSlug) {
        _fetchingPreview = true
        try {
            const token = await _getToken()
            const resp = await fetch('/api/stripe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ action: 'previewPlan', newPlan: planSlug }),
                signal: AbortSignal.timeout(22_000),
            })
            const data = await resp.json().catch(() => ({}))
            if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`)
            return data
        } catch (err) {
            console.error('[modal] preview error:', err.message)
            return null
        } finally {
            _fetchingPreview = false
        }
    }

    // ── Abrir portal Stripe ───────────────────────────────────────
    async function _openPortal() {
        try {
            const token = await _getToken()
            const resp = await fetch('/api/stripe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ action: 'portal' }),
                signal: AbortSignal.timeout(15_000),
            })
            if (!resp.ok) throw new Error()
            const { url } = await resp.json()
            if (url) { _close(); window.location.href = url }
        } catch {
            _showToast('Não foi possível abrir o portal. Tente novamente.', 'error')
        }
    }

    // ════════════════════════════════════════════════════════════
    // ETAPA 1 — Seleção de plano (cards estilo planos.html)
    // ════════════════════════════════════════════════════════════
    function _renderStep1() {
        _selectedPlan = ''
        _previewData  = null
        _selectedForRemoval = new Set()

        const curData  = plans.find(p => p.slug === _currentPlanSlug)
        const curPrice = curData?.price ?? 0
        const RANK     = { individual: 1, casal: 2, familia: 3 }
        const curRank  = RANK[_currentPlanSlug] ?? 0

        // Data da alteração agendada: usa ISO do banco → fallback para derivedPeriodEnd da Stripe
        const pendingDateStr = _currentPendingEffectiveAt
            ? _fmtDateFromISO(_currentPendingEffectiveAt)
            : (_derivedPeriodEnd ? _fmtDateFromTs(_derivedPeriodEnd) : '—')
        const pendingHtml = _currentPendingPlan
            ? `<div class="gm-pending-notice">
                 ⏳ Alteração agendada para <strong>${_planLabel(_currentPendingPlan)}</strong> em ${pendingDateStr}
               </div>` : ''

        const currentBanner = curData ? `
          <div class="gm-current-banner">
            <div class="gm-current-row">
              <div class="gm-current-left">
                <div class="gm-current-icon">${curData.icon}</div>
                <div>
                  <div class="gm-current-name-row">
                    <span class="gm-current-name">${curData.label}</span>
                    <span class="gm-current-active-badge">ATIVO</span>
                  </div>
                  <div class="gm-current-tagline">${curData.tagline}</div>
                </div>
              </div>
              <div class="gm-current-price-wrap">
                <div class="gm-current-price">${_fmtMoney(curData.price,'brl')}</div>
                <div class="gm-current-mo">/mês</div>
              </div>
            </div>
            ${pendingHtml}
          </div>` : ''

        const available = plans.filter(p => p.slug !== _currentPlanSlug || _currentPendingPlan)
        const cardsHtml = available.map(p => {
            const pRank      = RANK[p.slug] ?? 0
            const isUp       = pRank > curRank
            const diff       = p.price - curPrice
            const isPend     = p.slug === _currentPendingPlan
            const isCancPend = p.slug === _currentPlanSlug && !!_currentPendingPlan

            let diffHtml = ''
            if (!isPend && !isCancPend) {
                if (diff > 0)      diffHtml = `<div class="mpc-diff mpc-diff--up">↑ Upgrade · +${_fmtMoney(diff,'brl')}/mês</div>`
                else if (diff < 0) diffHtml = `<div class="mpc-diff mpc-diff--down">↓ Downgrade · Economize ${_fmtMoney(Math.abs(diff),'brl')}/mês</div>`
            }
            if (isPend)      diffHtml = `<div class="mpc-diff mpc-diff--pend">⏳ Já agendado</div>`
            if (isCancPend)  diffHtml = `<div class="mpc-diff mpc-diff--cancel-pend">↩ Cancelar alteração agendada</div>`

            const brlStr    = (p.price / 100).toFixed(2)
            const [intP, decP] = brlStr.split('.')
            const cardMod   = isCancPend ? 'mpc--cancel' : isUp ? 'mpc--up' : 'mpc--down'
            const btnMod    = isCancPend ? 'mpc-btn--cancel' : isUp ? 'mpc-btn--up' : 'mpc-btn--down'

            return `
              <div class="modal-plan-card ${cardMod}" data-plan="${p.slug}">
                <div class="mpc-glow"></div>
                <div class="mpc-body">
                  <div class="mpc-left">
                    <div class="mpc-icon">${p.icon}</div>
                    <div>
                      <h3 class="mpc-name">${p.label}</h3>
                      <p class="mpc-tag">${p.tagline}</p>
                    </div>
                  </div>
                  <div class="mpc-price-col">
                    <div class="mpc-price-row">
                      <span class="mpc-cur">R$</span>
                      <span class="mpc-int">${intP}</span>
                      <span class="mpc-dec">,${decP}</span>
                    </div>
                    <div class="mpc-mo">/mês</div>
                  </div>
                </div>
                ${diffHtml}
                <p class="mpc-desc">${p.desc}</p>
                <div class="mpc-btn ${btnMod}">
                  ${isCancPend ? 'Cancelar alteração agendada' : `Selecionar ${p.label} →`}
                </div>
                <div class="card-spinner">
                  <div class="cs-ring"></div>
                  <span class="cs-txt">Calculando...</span>
                </div>
              </div>`
        }).join('')

        _setHtml(`
          ${_hdr('Gerenciar Plano')}
          ${currentBanner}
          <div class="gm-section-label">Alterar para:</div>
          ${cardsHtml}
          <button data-close class="gm-cancel-btn">Cancelar</button>
        `)

        modal.querySelectorAll('.modal-plan-card').forEach(card => {
            card.addEventListener('click', () => _onPlanSelect(card.dataset.plan, card))
        })
    }

    async function _onPlanSelect(planSlug, cardEl) {
        if (_fetchingPreview) return
        const spinner = cardEl.querySelector('.card-spinner')
        if (spinner) spinner.classList.add('active')
        cardEl.style.pointerEvents = 'none'

        const preview = await _fetchPreview(planSlug)

        if (spinner) spinner.classList.remove('active')
        cardEl.style.pointerEvents = ''

        if (!preview) {
            _showToast('Erro ao calcular valores. Tente novamente.', 'error')
            return
        }

        // ── Fallback de proration local ───────────────────────────
        // O Edge Function calcula com dados do banco. Se o banco tem datas null,
        // amountDue volta 0. Recalculamos aqui com os dados reais da Stripe
        // usando a fórmula idêntica à do Stripe: round(fração×novo) - round(fração×atual)
        if (preview.type === 'upgrade' && preview.amountDue === 0 && _derivedPeriodEnd) {
            const nowSecs   = Math.floor(Date.now() / 1000)
            const endSecs   = _derivedPeriodEnd
            const startSecs = _derivedPeriodStart ?? (endSecs - 30 * 24 * 3600)
            const totalSecs = endSecs - startSecs
            const remaining = Math.max(0, endSecs - nowSecs)
            const fraction  = totalSecs > 0 ? remaining / totalSecs : 0

            if (fraction > 0) {
                const curPlanData = plans.find(p => p.slug === _currentPlanSlug)
                const newPlanData = plans.find(p => p.slug === planSlug)
                if (curPlanData && newPlanData) {
                    const credit = Math.round(curPlanData.price * fraction)
                    const charge = Math.round(newPlanData.price * fraction)
                    preview.amountDue    = Math.max(0, charge - credit)
                    preview.creditAmount = credit
                    preview.chargeAmount = charge
                    preview.periodEnd    = endSecs
                    preview.currency     = preview.currency || 'brl'
                    console.log(`[modal] proration local: fraction=${fraction.toFixed(4)} amountDue=${preview.amountDue}`)
                }
            }
        }

        // Para downgrade/cancel_pending, garante que periodEnd está preenchido
        if ((preview.type === 'downgrade' || preview.type === 'cancel_pending') && !preview.periodEnd && _derivedPeriodEnd) {
            preview.periodEnd = _derivedPeriodEnd
        }

        _selectedPlan = planSlug
        _previewData  = preview

        if (preview.requiresProfileRemoval && preview.members?.length) {
            _renderStep2()
        } else {
            _renderStep3()
        }
    }

    // ════════════════════════════════════════════════════════════
    // ETAPA 2 — Seleção de perfis para remover (downgrade com excesso)
    // ════════════════════════════════════════════════════════════
    function _renderStep2() {
        if (!_previewData) return
        const { members = [], excessCount = 1, newPlanLimit = 1 } = _previewData
        _selectedForRemoval = new Set()

        const membersHtml = members.map(m => `
          <label class="member-option" data-id="${m.id}">
            <input type="checkbox" class="mo-cb" value="${m.id}">
            <div class="mo-info">
              <div class="mo-name">${m.name}</div>
              <div class="mo-email">${m.email}</div>
            </div>
            <div class="mo-dot"></div>
          </label>`).join('')

        _setHtml(`
          ${_hdr(`Perfis para remover — ${excessCount} necessário${excessCount > 1 ? 's' : ''}`, true)}

          <div class="gm-danger-box">
            <div class="gm-danger-title">⚠️ Redução de perfis necessária</div>
            <div class="gm-danger-text">
              O plano <strong>${_planLabel(_selectedPlan)}</strong> permite até
              <strong>${newPlanLimit} perfil${newPlanLimit > 1 ? 's' : ''}</strong>.
              Selecione <strong>${excessCount} perfil${excessCount > 1 ? 's' : ''}</strong> para desativar
              na próxima renovação. Você mantém acesso completo até lá.
            </div>
          </div>

          <div class="gm-members-list">${membersHtml}</div>

          <p id="profileInfo" class="gm-profile-info">Selecione ${excessCount} perfil${excessCount > 1 ? 's' : ''} para continuar</p>

          <div class="gm-backup-box">
            <div class="gm-backup-title">🔒 Política de backup — seus dados estão protegidos</div>
            <div class="gm-tl">
              <div class="gm-tl-node"><div class="gm-tl-dot gm-tl-dot--now"></div><span class="gm-tl-lbl">Agora</span></div>
              <div class="gm-tl-line"></div>
              <div class="gm-tl-node"><div class="gm-tl-dot gm-tl-dot--mid"></div><span class="gm-tl-lbl">Renovação</span></div>
              <div class="gm-tl-line"></div>
              <div class="gm-tl-node"><div class="gm-tl-dot gm-tl-dot--mid"></div><span class="gm-tl-lbl">90 dias</span></div>
              <div class="gm-tl-line"></div>
              <div class="gm-tl-node"><div class="gm-tl-dot gm-tl-dot--end"></div><span class="gm-tl-lbl">Exclusão</span></div>
            </div>
            <div class="gm-backup-text">
              Os perfis selecionados serão <strong>desativados</strong> — não excluídos imediatamente.
              Todos os dados ficam em backup por <strong>90 dias</strong> a partir da renovação.
              Se você retornar ao plano <strong>${_planLabel(_currentPlanSlug)}</strong> ou superior
              dentro desse período, os perfis são <strong>restaurados automaticamente</strong>,
              sem nenhuma ação sua. Após 90 dias, os dados são excluídos permanentemente.
            </div>
          </div>

          <label class="gm-agree">
            <input type="checkbox" id="agreeCheck">
            <span class="gm-agree-txt">
              <strong>Declaro que li e estou de acordo</strong> com a remoção dos perfis selecionados
              e com a <strong>política de retenção de dados por 90 dias</strong>, após os quais
              os dados serão excluídos permanentemente.
            </span>
          </label>

          <div class="gm-btn-group">
            <button data-back class="gm-btn-secondary">← Voltar</button>
            <button id="profilesContinue" disabled class="gm-btn-primary">Continuar →</button>
          </div>
        `)

        modal.querySelector('[data-back]')?.addEventListener('click', _renderStep1)
        const continueBtn = modal.querySelector('#profilesContinue')
        const infoEl      = modal.querySelector('#profileInfo')
        const agreeCheck  = modal.querySelector('#agreeCheck')

        function _updateContinue() {
            const profilesOk = _selectedForRemoval.size >= excessCount
            const agreed     = agreeCheck?.checked ?? false
            if (continueBtn) continueBtn.disabled = !(profilesOk && agreed)
        }

        modal.querySelectorAll('.member-option input[type=checkbox]').forEach(cb => {
            cb.addEventListener('change', () => {
                const lbl = cb.closest('.member-option')
                if (cb.checked) {
                    _selectedForRemoval.add(cb.value)
                    lbl?.classList.add('mo-checked')
                } else {
                    _selectedForRemoval.delete(cb.value)
                    lbl?.classList.remove('mo-checked')
                }
                const count = _selectedForRemoval.size
                const ok    = count >= excessCount
                if (infoEl) {
                    infoEl.textContent = ok
                        ? `✓ ${count} perfil${count > 1 ? 's' : ''} selecionado${count > 1 ? 's' : ''}`
                        : `Selecione mais ${excessCount - count} perfil${excessCount - count > 1 ? 's' : ''}`
                    if (ok) infoEl.classList.add('pi-ok')
                    else    infoEl.classList.remove('pi-ok')
                }
                _updateContinue()
            })
        })

        agreeCheck?.addEventListener('change', _updateContinue)
        continueBtn?.addEventListener('click', _renderStep3)
    }

    // ════════════════════════════════════════════════════════════
    // ETAPA 3 — Confirmação com comparativo de valores
    // ════════════════════════════════════════════════════════════
    function _renderStep3() {
        if (!_previewData) return

        const curData  = plans.find(p => p.slug === _currentPlanSlug)
        const newData  = plans.find(p => p.slug === _selectedPlan)
        if (!curData || !newData) return

        const isUpgrade   = _previewData.type === 'upgrade'
        const isDowngrade = _previewData.type === 'downgrade'
        const isCancPend  = _previewData.type === 'cancel_pending'

        const compHtml = `
          <div class="gm-compare">
            <div class="gm-compare-plan">
              <div class="gm-cmp-label">Plano Atual</div>
              <div class="gm-cmp-icon gm-cmp-icon--cur">${curData.icon}</div>
              <div class="gm-cmp-name gm-cmp-name--cur">${curData.label}</div>
              <div class="gm-cmp-price gm-cmp-price--cur">${_fmtMoney(curData.price,'brl')}</div>
              <div class="gm-cmp-mo gm-cmp-mo--cur">/mês</div>
            </div>
            <div class="gm-compare-arrow">→</div>
            <div class="gm-compare-plan gm-compare-plan--new">
              <div class="gm-cmp-label gm-cmp-label--new">Novo Plano</div>
              <div class="gm-cmp-icon gm-cmp-icon--new">${newData.icon}</div>
              <div class="gm-cmp-name gm-cmp-name--new">${newData.label}</div>
              <div class="gm-cmp-price gm-cmp-price--new">${_fmtMoney(newData.price,'brl')}</div>
              <div class="gm-cmp-mo gm-cmp-mo--new">/mês</div>
            </div>
          </div>`

        let detailsHtml = ''
        if (isUpgrade) {
            const charge  = _previewData.amountDue ?? 0
            const cur     = _previewData.currency   || 'brl'
            const renewal = _fmtDateFromTs(_previewData.periodEnd)
            detailsHtml = `
              <div class="gm-box-up">
                <div class="gm-box-heading gm-box-heading--up">Resumo do Upgrade</div>
                <div class="gm-pay-row">
                  <span class="gm-pay-label">💳 Cobrado agora (proporcional):</span>
                  <span class="gm-pay-value">${_fmtMoney(charge, cur)}</span>
                </div>
                <div class="gm-pay-row">
                  <span class="gm-pay-label">📅 Próxima renovação (${renewal}):</span>
                  <span class="gm-pay-value gm-pay-value--sm">${_fmtMoney(newData.price,'brl')}<span class="gm-pay-sub">/mês</span></span>
                </div>
                <div class="gm-box-divider">
                  Calculado pelo Stripe com base nos dias restantes do ciclo atual. O cartão cadastrado será cobrado imediatamente.
                </div>
              </div>`
        } else if (isDowngrade) {
            const effectiveAt = _fmtDateFromTs(_previewData.periodEnd)
            const profileNote = _selectedForRemoval.size > 0
                ? `<div class="gm-pay-profile-note">⚠️ ${_selectedForRemoval.size} perfil${_selectedForRemoval.size > 1 ? 's' : ''} será desativado em ${effectiveAt}.</div>` : ''
            detailsHtml = `
              <div class="gm-box-down">
                <div class="gm-box-heading gm-box-heading--down">Resumo do Downgrade</div>
                <div class="gm-pay-row">
                  <span class="gm-pay-label">💰 Cobrança imediata:</span>
                  <span class="gm-pay-value gm-pay-value--md">Nenhuma</span>
                </div>
                <div class="gm-pay-row">
                  <span class="gm-pay-label">📅 Novo plano em vigor em:</span>
                  <span class="gm-pay-note-date">${effectiveAt}</span>
                </div>
                <div class="gm-pay-row">
                  <span class="gm-pay-label">💳 Novo valor a partir de ${effectiveAt}:</span>
                  <span class="gm-pay-value gm-pay-value--sm">${_fmtMoney(newData.price,'brl')}<span class="gm-pay-sub">/mês</span></span>
                </div>
                ${profileNote}
                <div class="gm-box-divider">
                  Você mantém todos os benefícios do plano atual até ${effectiveAt}. Sem cobrança ou estorno agora.
                </div>
              </div>`
        } else if (isCancPend) {
            detailsHtml = `
              <div class="gm-box-canc">
                <div class="gm-box-canc-text">
                  O agendamento de downgrade para <strong>${_planLabel(_previewData.pendingPlan)}</strong> será cancelado.
                  Você permanecerá normalmente no plano <strong>${_planLabel(_currentPlanSlug)}</strong>.
                </div>
              </div>`
        }

        const confirmLabel = isUpgrade
            ? `Confirmar e pagar ${_fmtMoney(_previewData.amountDue ?? 0, _previewData.currency || 'brl')}`
            : isDowngrade
            ? `Confirmar agendamento para ${_fmtDateFromTs(_previewData.periodEnd)}`
            : 'Cancelar alteração agendada'

        const confirmMod = isCancPend ? 'gm-confirm-btn--indigo' : 'gm-confirm-btn--green'

        _setHtml(`
          ${_hdr('Confirmar Alteração', true)}
          ${compHtml}
          ${detailsHtml}
          <button id="planConfirmBtn" class="gm-confirm-btn ${confirmMod}">
            ${confirmLabel}
          </button>
          <p id="planConfirmError" class="gm-confirm-error"></p>
        `)

        const backFn = (_selectedForRemoval.size > 0 && _previewData.requiresProfileRemoval)
            ? _renderStep2 : _renderStep1
        modal.querySelector('[data-back]')?.addEventListener('click', backFn)
        modal.querySelector('#planConfirmBtn')?.addEventListener('click', _doConfirm)
    }

    // ════════════════════════════════════════════════════════════
    // AÇÃO DE CONFIRMAÇÃO — Loading + Sucesso + Erros
    // ════════════════════════════════════════════════════════════
    async function _doConfirm() {
        const btn     = modal.querySelector('#planConfirmBtn')
        const errorEl = modal.querySelector('#planConfirmError')
        if (!btn || btn.disabled) return

        const prevLabel = btn.innerHTML
        btn.disabled    = true
        btn.innerHTML   = `<span class="gm-spin-loading">${_spin16()} Processando...</span>`
        errorEl?.classList.remove('visible')

        try {
            const token      = await _getToken()
            const planToSend = (_previewData?.type === 'cancel_pending') ? _currentPlanSlug : _selectedPlan

            const resp = await fetch('/api/stripe', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    action:           'updatePlan',
                    newPlan:          planToSend,
                    profilesToRemove: [..._selectedForRemoval],
                }),
                signal: AbortSignal.timeout(30_000),
            })

            const data = await resp.json().catch(() => ({}))

            if (!resp.ok) {
                const isPayFail = resp.status === 402 || data.code === 'payment_failed'
                if (isPayFail) {
                    _renderPaymentError()
                } else if (data.code === 'profile_removal_required') {
                    _selectedForRemoval = new Set()
                    _renderStep2()
                    _showToast(data.error || 'Selecione os perfis para remover.', 'warning')
                } else {
                    btn.disabled = false; btn.innerHTML = prevLabel
                    if (errorEl) { errorEl.textContent = data.error || 'Erro ao alterar plano. Tente novamente.'; errorEl.classList.add('visible') }
                }
                return
            }

            // ── Sucesso: mostra recibo ────────────────────────────
            _renderReceipt(planToSend, data)

        } catch (err) {
            btn.disabled = false; btn.innerHTML = prevLabel
            if (errorEl) { errorEl.textContent = err.message || 'Erro de conexão. Tente novamente.'; errorEl.classList.add('visible') }
        }
    }

    // ════════════════════════════════════════════════════════════
    // RECIBO — tela de confirmação animada após sucesso
    // ════════════════════════════════════════════════════════════
    function _renderReceipt(planToSend, data) {
        const isUpgrade   = _previewData?.type === 'upgrade'
        const isDowngrade = _previewData?.type === 'downgrade'
        const curData     = plans.find(p => p.slug === _currentPlanSlug)
        const newData     = plans.find(p => p.slug === planToSend)

        const now = new Date().toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        })
        const ref = `GE-${Date.now().toString(36).toUpperCase().slice(-8)}`

        let title, sub, rows

        if (isUpgrade) {
            title = 'Upgrade realizado!'
            sub   = `Bem-vindo ao plano ${_planLabel(planToSend)}`
            rows  = [
                { k: 'Plano anterior',    v: _planLabel(_currentPlanSlug) },
                { k: 'Novo plano',        v: _planLabel(planToSend),                                    c: 'gm-receipt-val--green' },
                { k: 'Cobrado agora',     v: _fmtMoney(_previewData?.amountDue ?? 0, _previewData?.currency || 'brl'), c: 'gm-receipt-val--big' },
                { k: 'Próxima renovação', v: _fmtDateFromTs(_previewData?.periodEnd) },
                { k: 'Novo valor mensal', v: _fmtMoney(newData?.price ?? 0, 'brl') },
            ]
        } else if (isDowngrade) {
            const effectDate = _fmtDateFromISO(data.effectiveAt) || _fmtDateFromTs(_previewData?.periodEnd)
            title = 'Downgrade agendado!'
            sub   = 'Você mantém todos os benefícios até a renovação'
            rows  = [
                { k: 'Plano atual',         v: _planLabel(_currentPlanSlug) },
                { k: 'Novo plano em',       v: effectDate,                        c: 'gm-receipt-val--amber' },
                { k: 'Cobrança imediata',   v: 'Nenhuma' },
                { k: 'Novo valor mensal',   v: _fmtMoney(newData?.price ?? 0, 'brl') },
                ...(data.profileRemovalsScheduled > 0
                    ? [{ k: 'Perfis desativados em', v: effectDate, c: 'gm-receipt-val--amber' }] : []),
            ]
        } else {
            title = 'Alteração cancelada!'
            sub   = `Você permanece no plano ${_planLabel(_currentPlanSlug)}`
            rows  = [
                { k: 'Plano mantido', v: _planLabel(_currentPlanSlug), c: 'gm-receipt-val--green' },
                { k: 'Alteração',     v: 'Agendamento cancelado' },
            ]
        }

        const rowsHtml = rows.map(r => `
          <div class="gm-receipt-row">
            <span class="gm-receipt-key">${r.k}</span>
            <span class="gm-receipt-val ${r.c || ''}">${r.v}</span>
          </div>`).join('')

        _setHtml(`
          <div class="gm-receipt">
            <div class="gm-receipt-icon">
              <svg class="gm-receipt-svg" viewBox="0 0 52 52" fill="none">
                <circle class="gm-receipt-circle" cx="26" cy="26" r="25"/>
                <path class="gm-receipt-tick" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
              </svg>
              <div class="gm-receipt-pulse"></div>
            </div>
            <div class="gm-receipt-title">${title}</div>
            <div class="gm-receipt-sub">${sub}</div>
            <div class="gm-receipt-card">
              <div class="gm-receipt-head">Comprovante da transação</div>
              ${rowsHtml}
            </div>
            <div class="gm-receipt-ref">${now} · Ref: ${ref}</div>
            <button id="receiptClose" class="gm-receipt-close">Concluído ✓</button>
          </div>
        `)

        modal.querySelector('#receiptClose')?.addEventListener('click', () => {
            _close()
            setTimeout(() => loadSubscription(session), 500)
        })
    }

    // ════════════════════════════════════════════════════════════
    // ERRO DE PAGAMENTO — link para portal Stripe
    // ════════════════════════════════════════════════════════════
    function _renderPaymentError() {
        _setHtml(`
          ${_hdr('Pagamento Recusado')}
          <div class="gm-error-center">
            <div class="gm-error-icon">
              <svg class="gm-error-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <h3 class="gm-error-title">Não foi possível realizar o pagamento</h3>
            <p class="gm-error-desc">
              Seu banco recusou a cobrança. O plano NÃO foi alterado.<br>Verifique se o cartão está válido e com limite disponível.
            </p>
            <button id="openPortalBtn" class="gm-portal-btn">
              Clique aqui para atualizar seu método de pagamento
            </button>
            <button data-back class="gm-try-other-btn">
              ← Tentar com outro plano
            </button>
          </div>
        `)
        modal.querySelector('#openPortalBtn')?.addEventListener('click', _openPortal)
        modal.querySelector('[data-back]')?.addEventListener('click', _renderStep1)
    }

    // ── Inicia na etapa 1 ─────────────────────────────────────────
    _renderStep1()
}





function setupPlanChangeCard(session) {
    // Wire no card "Alterar Plano" (3º card no action-grid)
    const grid = document.getElementById('actionGrid')
    if (!grid) return
    const cards = grid.querySelectorAll('.action-card')
    cards.forEach(card => {
        const title = card.querySelector('.ac-title')
        if (title?.textContent?.trim() === 'Alterar Plano') {
            card.style.cursor = 'pointer'
            card.addEventListener('click', () => _openPlanModal(session))
        }
    })
}

// ── Portal Stripe ─────────────────────────────────────────────────
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
            if (btnText) btnText.textContent = 'Abrir portal de gerenciamento';
        }
    });
}

// ── Start ─────────────────────────────────────────────────────────
init();
