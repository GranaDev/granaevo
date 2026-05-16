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
        // Isso resolve Período Atual e Próxima Cobrança mostrando "—" quando
        // current_period_start / current_period_end estão NULL no banco.
        if (subscription?.current_period_end) {
            renderDetails({
                plan_name:                 _currentPlanSlug,
                status:                    subscription.status    ?? 'active',
                current_period_start:      subscription.current_period_start,
                current_period_end:        subscription.current_period_end,
                cancel_at_period_end:      subscription.cancel_at_period_end ?? false,
                canceled_at:               subscription.canceled_at ?? null,
                created_at:                subscription.start_date || subscription.created,
                pending_plan_name:         _currentPendingPlan        || null,
                pending_plan_effective_at: _currentPendingEffectiveAt || null,
            });
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

// ── Helpers do modal ──────────────────────────────────────────────
function _fmtMoney(cents, currency = 'brl') {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: currency.toUpperCase(),
        minimumFractionDigits: 2,
    }).format(cents / 100)
}

function _fmtDateFromTs(unixTs) {
    if (!unixTs) return '—'
    return new Date(unixTs * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function _fmtDateFromISO(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function _planLabel(slug) {
    return { individual: 'Individual', casal: 'Casal', familia: 'Família' }[slug] || slug
}

function _openPlanModal(session) {

    // ── Keyframe spinner (injeta uma única vez) ───────────────────
    if (!document.getElementById('_ge_spin_style')) {
        const st = document.createElement('style')
        st.id = '_ge_spin_style'
        st.textContent = '@keyframes _ge_spin{to{transform:rotate(360deg)}}'
        document.head.appendChild(st)
    }

    // ── Estado ────────────────────────────────────────────────────
    let _selectedPlan       = ''
    let _previewData        = null
    let _selectedForRemoval = new Set()
    let _fetchingPreview    = false

    // ── DOM base ──────────────────────────────────────────────────
    const overlay = document.createElement('div')
    overlay.id = 'planModalOverlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(6,8,16,0.9);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:16px;'

    const modal = document.createElement('div')
    modal.id = 'planModalInner'
    modal.style.cssText = 'background:linear-gradient(160deg,#0d1117 0%,#0f172a 100%);border:1px solid rgba(16,185,129,0.18);border-radius:22px;padding:28px;max-width:560px;width:100%;box-shadow:0 40px 100px rgba(0,0,0,0.85);max-height:92vh;overflow-y:auto;'

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
        modal.innerHTML = html
        modal.querySelector('[data-close]')?.addEventListener('click', _close)
    }

    function _hdr(title, withBack = false) {
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
            <div style="display:flex;align-items:center;gap:10px;">
              ${withBack ? `<button data-back style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:13px;padding:7px 12px;border-radius:8px;font-family:inherit;">← Voltar</button>` : ''}
              <h2 style="font-size:19px;font-weight:800;color:#f1f5f9;letter-spacing:-.3px;margin:0;">${title}</h2>
            </div>
            <button data-close style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;cursor:pointer;font-size:16px;padding:6px 10px;border-radius:8px;line-height:1;" aria-label="Fechar">✕</button>
          </div>`
    }

    function _spin16() {
        return `<div style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:_ge_spin .7s linear infinite;flex-shrink:0;"></div>`
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

        // Banner plano atual
        const pendingHtml = _currentPendingPlan
            ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:8px;font-size:12px;color:#fbbf24;line-height:1.5;">
                 ⏳ Alteração agendada para <strong>${_planLabel(_currentPendingPlan)}</strong> em ${_fmtDateFromISO(_currentPendingEffectiveAt)}
               </div>` : ''

        const currentBanner = curData ? `
          <div style="background:rgba(16,185,129,0.07);border:1.5px solid rgba(16,185,129,0.3);border-radius:14px;padding:16px 18px;margin-bottom:22px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div style="display:flex;align-items:center;gap:12px;">
                <div style="color:#10b981;opacity:.9;">${curData.icon}</div>
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:16px;font-weight:800;color:#10b981;">${curData.label}</span>
                    <span style="font-size:10px;font-weight:700;background:rgba(16,185,129,0.18);border:1px solid rgba(16,185,129,0.3);border-radius:50px;padding:2px 8px;color:#10b981;letter-spacing:.4px;">ATIVO</span>
                  </div>
                  <div style="font-size:12px;color:#64748b;margin-top:2px;">${curData.tagline}</div>
                </div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:20px;font-weight:900;color:#10b981;letter-spacing:-1px;line-height:1;">${_fmtMoney(curData.price,'brl')}</div>
                <div style="font-size:10px;color:#475569;">/mês</div>
              </div>
            </div>
            ${pendingHtml}
          </div>` : ''

        // Cards dos planos disponíveis
        const available = plans.filter(p => p.slug !== _currentPlanSlug || _currentPendingPlan)
        const cardsHtml = available.map(p => {
            const pRank    = RANK[p.slug] ?? 0
            const isUp     = pRank > curRank
            const diff     = p.price - curPrice
            const isPend   = p.slug === _currentPendingPlan
            const isCancPend = p.slug === _currentPlanSlug && !!_currentPendingPlan

            let diffHtml = ''
            if (!isPend && !isCancPend) {
                if (diff > 0)      diffHtml = `<div style="font-size:12px;font-weight:700;color:#34d399;margin-top:6px;">↑ Upgrade · +${_fmtMoney(diff,'brl')}/mês</div>`
                else if (diff < 0) diffHtml = `<div style="font-size:12px;font-weight:700;color:#fbbf24;margin-top:6px;">↓ Downgrade · Economize ${_fmtMoney(Math.abs(diff),'brl')}/mês</div>`
            }
            if (isPend)      diffHtml = `<div style="font-size:12px;font-weight:700;color:#fbbf24;margin-top:6px;">⏳ Já agendado</div>`
            if (isCancPend)  diffHtml = `<div style="font-size:12px;font-weight:700;color:#818cf8;margin-top:6px;">↩ Cancelar alteração agendada</div>`

            // Separa R$ XX,YY para exibição grande
            const brlStr = (p.price / 100).toFixed(2)
            const [intP, decP] = brlStr.split('.')
            const hoverBorder  = isUp ? 'rgba(52,211,153,0.5)' : 'rgba(245,158,11,0.5)'
            const btnStyle     = isUp
                ? 'background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.3);color:#34d399;'
                : isCancPend
                ? 'background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);color:#818cf8;'
                : 'background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:#fbbf24;'

            return `
              <div class="modal-plan-card" data-plan="${p.slug}"
                style="background:linear-gradient(160deg,#0d1117,#111827);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:20px;cursor:pointer;transition:border-color .2s,transform .2s,box-shadow .2s;position:relative;overflow:hidden;margin-bottom:12px;"
                onmouseenter="this.style.borderColor='${hoverBorder}';this.style.transform='translateY(-2px)';this.style.boxShadow='0 12px 32px rgba(0,0,0,0.5)'"
                onmouseleave="this.style.borderColor='rgba(255,255,255,0.08)';this.style.transform='';this.style.boxShadow=''">
                <div style="position:absolute;top:-60px;right:-60px;width:160px;height:160px;background:radial-gradient(circle,rgba(16,185,129,0.06),transparent);border-radius:50%;pointer-events:none;"></div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;">
                  <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                    <div style="color:#e2e8f0;opacity:.85;flex-shrink:0;">${p.icon}</div>
                    <div>
                      <h3 style="font-size:17px;font-weight:800;color:#f1f5f9;margin:0 0 3px;letter-spacing:-.3px;">${p.label}</h3>
                      <p style="font-size:12px;color:#64748b;margin:0;">${p.tagline}</p>
                    </div>
                  </div>
                  <div style="text-align:right;flex-shrink:0;">
                    <div style="display:flex;align-items:baseline;gap:2px;justify-content:flex-end;">
                      <span style="font-size:13px;color:#94a3b8;font-weight:600;">R$</span>
                      <span style="font-size:30px;font-weight:900;color:#f1f5f9;letter-spacing:-1.5px;line-height:1;">${intP}</span>
                      <span style="font-size:16px;font-weight:700;color:#f1f5f9;">,${decP}</span>
                    </div>
                    <div style="font-size:10px;color:#64748b;">/mês</div>
                  </div>
                </div>
                ${diffHtml}
                <p style="font-size:12px;color:#475569;line-height:1.5;margin:10px 0 14px;">${p.desc}</p>
                <div style="width:100%;padding:11px;${btnStyle}border-radius:10px;font-size:13px;font-weight:700;text-align:center;box-sizing:border-box;">
                  ${isCancPend ? 'Cancelar alteração agendada' : `Selecionar ${p.label} →`}
                </div>
                <div class="card-spinner" style="display:none;position:absolute;inset:0;background:rgba(6,8,16,0.8);border-radius:16px;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
                  <div style="width:24px;height:24px;border:2.5px solid rgba(16,185,129,0.3);border-top-color:#10b981;border-radius:50%;animation:_ge_spin .7s linear infinite;"></div>
                  <span style="font-size:12px;color:#10b981;font-weight:600;">Calculando...</span>
                </div>
              </div>`
        }).join('')

        _setHtml(`
          ${_hdr('Gerenciar Plano')}
          ${currentBanner}
          <div style="font-size:11px;font-weight:700;color:#475569;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:14px;">Alterar para:</div>
          ${cardsHtml}
          <button data-close style="width:100%;padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;color:#64748b;font-size:14px;cursor:pointer;font-family:inherit;margin-top:4px;">Cancelar</button>
        `)

        modal.querySelectorAll('.modal-plan-card').forEach(card => {
            card.addEventListener('click', () => _onPlanSelect(card.dataset.plan, card))
        })
    }

    async function _onPlanSelect(planSlug, cardEl) {
        if (_fetchingPreview) return
        const spinner = cardEl.querySelector('.card-spinner')
        if (spinner) spinner.style.display = 'flex'
        cardEl.style.pointerEvents = 'none'

        const preview = await _fetchPreview(planSlug)

        if (spinner) spinner.style.display = 'none'
        cardEl.style.pointerEvents = ''

        if (!preview) {
            _showToast('Erro ao calcular valores. Tente novamente.', 'error')
            return
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
          <label class="member-option" style="display:flex;align-items:center;gap:14px;padding:14px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;cursor:pointer;transition:border-color .2s;">
            <input type="checkbox" value="${m.id}" style="width:17px;height:17px;accent-color:#ef4444;flex-shrink:0;cursor:inherit;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:14px;font-weight:700;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.name}</div>
              <div style="font-size:12px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.email}</div>
            </div>
            <div style="width:10px;height:10px;border-radius:50%;background:rgba(52,211,153,0.5);flex-shrink:0;"></div>
          </label>`).join('')

        _setHtml(`
          ${_hdr(`Remover Perfis — ${excessCount} necessário${excessCount > 1 ? 's' : ''}`, true)}
          <div style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.25);border-radius:12px;padding:14px 16px;margin-bottom:20px;">
            <div style="font-size:13px;font-weight:700;color:#f87171;margin-bottom:5px;">⚠️ Redução de perfis necessária</div>
            <div style="font-size:13px;color:#94a3b8;line-height:1.65;">
              O plano <strong style="color:#f1f5f9;">${_planLabel(_selectedPlan)}</strong> permite até
              <strong style="color:#f1f5f9;">${newPlanLimit} perfil${newPlanLimit > 1 ? 's' : ''}</strong>.
              Selecione <strong style="color:#f87171;">${excessCount} perfil${excessCount > 1 ? 's' : ''}</strong> para
              desativar quando o novo plano entrar em vigor. Você continua com acesso total até a próxima renovação.
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">${membersHtml}</div>
          <p id="profileInfo" style="font-size:12px;color:#64748b;text-align:center;margin-bottom:16px;">Selecione ${excessCount} perfil${excessCount > 1 ? 's' : ''} para continuar</p>
          <div style="display:flex;gap:10px;">
            <button data-back style="flex:1;padding:13px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#64748b;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">← Voltar</button>
            <button id="profilesContinue" disabled style="flex:2;padding:13px;background:linear-gradient(135deg,#10b981,#059669);border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;opacity:0.4;font-family:inherit;">Continuar →</button>
          </div>
        `)

        modal.querySelector('[data-back]')?.addEventListener('click', _renderStep1)
        const continueBtn = modal.querySelector('#profilesContinue')
        const infoEl      = modal.querySelector('#profileInfo')

        modal.querySelectorAll('.member-option').forEach(lbl => {
            lbl.addEventListener('mouseenter', () => { lbl.style.borderColor = 'rgba(239,68,68,0.4)' })
            lbl.addEventListener('mouseleave', () => { lbl.style.borderColor = lbl.querySelector('input').checked ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.08)' })
        })

        modal.querySelectorAll('.member-option input[type=checkbox]').forEach(cb => {
            cb.addEventListener('change', () => {
                const lbl = cb.closest('.member-option')
                if (cb.checked) {
                    _selectedForRemoval.add(cb.value)
                    if (lbl) lbl.style.borderColor = 'rgba(239,68,68,0.5)'
                } else {
                    _selectedForRemoval.delete(cb.value)
                    if (lbl) lbl.style.borderColor = 'rgba(255,255,255,0.08)'
                }
                const count = _selectedForRemoval.size
                const ok    = count >= excessCount
                if (continueBtn) { continueBtn.disabled = !ok; continueBtn.style.opacity = ok ? '1' : '0.4' }
                if (infoEl) {
                    infoEl.textContent = ok
                        ? `✓ ${count} perfil${count > 1 ? 's' : ''} selecionado${count > 1 ? 's' : ''}`
                        : `Selecione mais ${excessCount - count} perfil${excessCount - count > 1 ? 's' : ''}`
                    infoEl.style.color = ok ? '#10b981' : '#64748b'
                }
            })
        })

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

        // Comparativo visual
        const compHtml = `
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:22px;">
            <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:13px;padding:16px;text-align:center;">
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Plano Atual</div>
              <div style="color:#64748b;opacity:.7;margin-bottom:6px;">${curData.icon}</div>
              <div style="font-size:15px;font-weight:800;color:#64748b;">${curData.label}</div>
              <div style="font-size:18px;font-weight:900;color:#475569;letter-spacing:-1px;">${_fmtMoney(curData.price,'brl')}</div>
              <div style="font-size:10px;color:#475569;">/mês</div>
            </div>
            <div style="font-size:22px;color:#10b981;flex-shrink:0;">→</div>
            <div style="flex:1;background:rgba(16,185,129,0.07);border:1.5px solid rgba(16,185,129,0.3);border-radius:13px;padding:16px;text-align:center;">
              <div style="font-size:10px;color:#10b981;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Novo Plano</div>
              <div style="color:#10b981;margin-bottom:6px;">${newData.icon}</div>
              <div style="font-size:15px;font-weight:800;color:#10b981;">${newData.label}</div>
              <div style="font-size:18px;font-weight:900;color:#10b981;letter-spacing:-1px;">${_fmtMoney(newData.price,'brl')}</div>
              <div style="font-size:10px;color:#34d399;">/mês</div>
            </div>
          </div>`

        // Detalhes financeiros
        let detailsHtml = ''
        if (isUpgrade) {
            const charge  = _previewData.amountDue ?? 0
            const cur     = _previewData.currency   || 'brl'
            const renewal = _fmtDateFromTs(_previewData.periodEnd)
            detailsHtml = `
              <div style="background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:12px;padding:16px;margin-bottom:18px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#10b981;margin-bottom:12px;">Resumo do Upgrade</div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <span style="font-size:13px;color:#94a3b8;">💳 Cobrado agora (proporcional):</span>
                  <span style="font-size:17px;font-weight:800;color:#f1f5f9;">${_fmtMoney(charge, cur)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-size:13px;color:#94a3b8;">📅 Próxima renovação (${renewal}):</span>
                  <span style="font-size:14px;font-weight:700;color:#f1f5f9;">${_fmtMoney(newData.price,'brl')}<span style="font-size:11px;color:#64748b;">/mês</span></span>
                </div>
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:#64748b;line-height:1.5;">
                  Calculado pelo Stripe com base nos dias restantes do ciclo atual. O cartão cadastrado será cobrado imediatamente.
                </div>
              </div>`
        } else if (isDowngrade) {
            const effectiveAt = _fmtDateFromTs(_previewData.periodEnd)
            const profileNote = _selectedForRemoval.size > 0
                ? `<div style="margin-top:8px;font-size:12px;color:#fbbf24;line-height:1.5;">⚠️ ${_selectedForRemoval.size} perfil${_selectedForRemoval.size > 1 ? 's' : ''} será desativado em ${effectiveAt}.</div>` : ''
            detailsHtml = `
              <div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:12px;padding:16px;margin-bottom:18px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#fbbf24;margin-bottom:12px;">Resumo do Downgrade</div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <span style="font-size:13px;color:#94a3b8;">💰 Cobrança imediata:</span>
                  <span style="font-size:15px;font-weight:800;color:#f1f5f9;">Nenhuma</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <span style="font-size:13px;color:#94a3b8;">📅 Novo plano em vigor em:</span>
                  <span style="font-size:13px;font-weight:700;color:#fbbf24;">${effectiveAt}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-size:13px;color:#94a3b8;">💳 Novo valor a partir de ${effectiveAt}:</span>
                  <span style="font-size:14px;font-weight:700;color:#f1f5f9;">${_fmtMoney(newData.price,'brl')}<span style="font-size:11px;color:#64748b;">/mês</span></span>
                </div>
                ${profileNote}
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:#64748b;line-height:1.5;">
                  Você mantém todos os benefícios do plano atual até ${effectiveAt}. Sem cobrança ou estorno agora.
                </div>
              </div>`
        } else if (isCancPend) {
            detailsHtml = `
              <div style="background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.25);border-radius:12px;padding:16px;margin-bottom:18px;">
                <div style="font-size:13px;color:#94a3b8;line-height:1.65;">
                  O agendamento de downgrade para <strong style="color:#f1f5f9;">${_planLabel(_previewData.pendingPlan)}</strong> será cancelado.
                  Você permanecerá normalmente no plano <strong style="color:#10b981;">${_planLabel(_currentPlanSlug)}</strong>.
                </div>
              </div>`
        }

        const confirmLabel = isUpgrade
            ? `Confirmar e pagar ${_fmtMoney(_previewData.amountDue ?? 0, _previewData.currency || 'brl')}`
            : isDowngrade
            ? `Confirmar agendamento para ${_fmtDateFromTs(_previewData.periodEnd)}`
            : 'Cancelar alteração agendada'

        const confirmBg = isCancPend
            ? 'linear-gradient(135deg,#6366f1,#4f46e5)'
            : 'linear-gradient(135deg,#10b981,#059669)'

        _setHtml(`
          ${_hdr('Confirmar Alteração', true)}
          ${compHtml}
          ${detailsHtml}
          <button id="planConfirmBtn" style="width:100%;padding:15px;background:${confirmBg};border:none;border-radius:12px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:10px;transition:opacity .2s;">
            ${confirmLabel}
          </button>
          <p id="planConfirmError" style="font-size:13px;color:#f87171;text-align:center;display:none;margin-top:8px;"></p>
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

        const prevLabel   = btn.innerHTML
        btn.disabled      = true
        btn.style.opacity = '0.7'
        btn.innerHTML     = `<span style="display:flex;align-items:center;justify-content:center;gap:8px;">${_spin16()} Processando...</span>`
        if (errorEl) errorEl.style.display = 'none'

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
                    btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = prevLabel
                    if (errorEl) { errorEl.textContent = data.error || 'Erro ao alterar plano. Tente novamente.'; errorEl.style.display = 'block' }
                }
                return
            }

            // ── Sucesso ───────────────────────────────────────────
            _close()
            if (data.action === 'downgrade_scheduled') {
                const d        = _fmtDateFromISO(data.effectiveAt)
                const profNote = (data.profileRemovalsScheduled > 0)
                    ? ` ${data.profileRemovalsScheduled} perfil${data.profileRemovalsScheduled > 1 ? 's' : ''} será desativado na mesma data.` : ''
                _showToast(`Plano ${_planLabel(planToSend)} agendado para ${d}.${profNote}`, 'info')
            } else if (data.action === 'cancelled_pending') {
                _showToast(`Alteração agendada cancelada. Você permanece no plano ${_planLabel(_currentPlanSlug)}.`, 'info')
            } else {
                _showToast(`Upgrade para ${_planLabel(planToSend)} realizado com sucesso!`, 'success')
            }
            setTimeout(() => loadSubscription(session), 1500)

        } catch (err) {
            btn.disabled = false; btn.style.opacity = '1'; btn.innerHTML = prevLabel
            if (errorEl) { errorEl.textContent = err.message || 'Erro de conexão. Tente novamente.'; errorEl.style.display = 'block' }
        }
    }

    // ════════════════════════════════════════════════════════════
    // ERRO DE PAGAMENTO — link para portal Stripe
    // ════════════════════════════════════════════════════════════
    function _renderPaymentError() {
        _setHtml(`
          ${_hdr('Pagamento Recusado')}
          <div style="text-align:center;padding:12px 0 8px;">
            <div style="width:72px;height:72px;background:rgba(239,68,68,0.1);border:1.5px solid rgba(239,68,68,0.3);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
              <svg style="width:32px;height:32px;color:#ef4444;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <h3 style="font-size:18px;font-weight:800;color:#f1f5f9;margin:0 0 10px;">Não foi possível realizar o pagamento</h3>
            <p style="font-size:14px;color:#94a3b8;line-height:1.7;margin-bottom:24px;">
              Seu banco recusou a cobrança. O plano NÃO foi alterado.<br>Verifique se o cartão está válido e com limite disponível.
            </p>
            <button id="openPortalBtn" style="width:100%;padding:14px;background:linear-gradient(135deg,#3b82f6,#2563eb);border:none;border-radius:12px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:10px;">
              Clique aqui para atualizar seu método de pagamento
            </button>
            <button data-back style="width:100%;padding:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#64748b;font-size:14px;cursor:pointer;font-family:inherit;">
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
