// ui.js — controlador de DOM do chat (renderização SEGURA por construção)
// ---------------------------------------------------------------------------
// Nunca usa innerHTML com conteúdo dinâmico. Texto do usuário e das frases é
// inserido via textContent (XSS-proof); só o *negrito* controlado das frases
// vira <strong>, construído com createElement — nada de HTML cru.
// ---------------------------------------------------------------------------

let els = null;
let _group = null; // container ativo p/ agrupar lançamentos de um envio (D38)

export function mountUI() {
    els = {
        messages: document.getElementById('geMessages'),
        input:    document.getElementById('geInput'),
        send:     document.getElementById('geSend'),
        quick:    document.getElementById('geQuick'),
    };
    return els;
}

// Alvo de inserção: o grupo ativo (D38) ou a lista de mensagens.
function _target() { return _group || els.messages; }

/** D38: abre um card que agrupa as mensagens de um envio composto. */
export function beginGroup() {
    if (!els?.messages) return;
    _group = document.createElement('div');
    _group.className = 'ge-group';
    els.messages.appendChild(_group);
}
export function endGroup() { _group = null; scrollDown(); }

/** D39: vibração sutil (respeita prefers-reduced-motion; no-op se não suportado). */
export function haptic(ms = 12) {
    try {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        navigator.vibrate?.(ms);
    } catch { /* ignore */ }
}

/** D32/D33/D40: renderiza chips de sugestão. items = [{label, text}]. */
export function setQuickReplies(items, onPick) {
    if (!els?.quick) return;
    els.quick.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) { els.quick.hidden = true; return; }
    for (const it of items) {
        const b = document.createElement('button');
        b.className = 'ge-quick-chip';
        b.type = 'button';
        b.textContent = it.label;                 // textContent — XSS-proof
        b.addEventListener('click', () => onPick?.(it.text ?? it.label));
        els.quick.appendChild(b);
    }
    els.quick.hidden = false;
}

/** Pré-preenche e foca o input (usado pelo botão Corrigir — D35). */
export function focusInput(prefill) {
    if (!els?.input) return;
    if (typeof prefill === 'string') {
        els.input.value = prefill;
        els.input.dispatchEvent(new Event('input')); // reativa autoresize + habilita enviar
    }
    els.input.focus();
    const n = els.input.value.length;
    try { els.input.setSelectionRange(n, n); } catch { /* ignore */ }
}

/** Cria um <i> de ícone Font Awesome com nome em whitelist (sem HTML cru). */
export function faIcon(name, extraClass = '') {
    const i = document.createElement('i');
    if (/^fa-[a-z0-9-]+$/.test(name)) i.className = `fas ${name}${extraClass ? ' ' + extraClass : ''}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

// Constrói nós com suporte a *negrito* e ícones {{fa-nome}} — SEM innerHTML.
// Os ícones são criados via createElement com classe em whitelist (fa-xxx),
// então não há vetor de XSS mesmo com texto vindo da IA (que nunca chega aqui).
function renderFormatted(container, text) {
    const str = String(text ?? '');
    const re = /\*([^*\n]+)\*|\{\{(fa-[a-z0-9-]+)\}\}/g;
    let last = 0, m;
    while ((m = re.exec(str)) !== null) {
        if (m.index > last) container.appendChild(document.createTextNode(str.slice(last, m.index)));
        if (m[1] !== undefined) {
            const strong = document.createElement('strong');
            strong.textContent = m[1];
            container.appendChild(strong);
        } else {
            container.appendChild(faIcon(m[2], 'ge-ic'));
        }
        last = re.lastIndex;
    }
    if (last < str.length) container.appendChild(document.createTextNode(str.slice(last)));
}

function scrollDown() {
    if (els?.messages) els.messages.scrollTop = els.messages.scrollHeight;
}

export function addUserMessage(text) {
    const str = String(text ?? '');
    const row = document.createElement('div');
    row.className = 'ge-row user';
    const bubble = document.createElement('div');
    bubble.className = 'ge-bubble ge-editable';
    bubble.textContent = str; // texto do usuário: sempre textContent
    // D34: tocar na própria mensagem reaproveita o texto no input (editar/reenviar).
    bubble.title = 'Tocar para reaproveitar e editar';
    bubble.addEventListener('click', () => focusInput(str));
    row.appendChild(bubble);
    _target().appendChild(row);
    scrollDown();
}

// Remove tokens de formatação ({{fa-*}} e *negrito*) → texto puro (p/ copiar/TTS).
export function stripTokens(text) {
    return String(text ?? '').replace(/\{\{fa-[a-z0-9-]+\}\}/g, '').replace(/\*([^*\n]+)\*/g, '$1').replace(/\s+\n/g, '\n').trim();
}

const MSG_CAP = 1400; // E47: teto defensivo de tamanho de uma mensagem renderizada.

/**
 * Mensagem do assistente. opts: { cta:{label, href|onClick, icon?}, copiavel:boolean }.
 * cta → botão de ação: navega (href) ou executa callback (onClick — ex.: instalar
 * PWA, que exige gesto do usuário); copiavel → botão "Copiar" (A7).
 */
export function addAssistantMessage(text, opts = {}) {
    let str = String(text ?? '');
    if (str.length > MSG_CAP) str = str.slice(0, MSG_CAP) + '…';
    const row = document.createElement('div');
    row.className = 'ge-row assistant';
    const bubble = document.createElement('div');
    bubble.className = 'ge-bubble';
    renderFormatted(bubble, str);
    if (opts.cta || opts.copiavel) bubble.appendChild(_actions(str, opts));
    row.appendChild(bubble);
    _target().appendChild(row);
    scrollDown();
}

// Linha de ações abaixo da bolha (CTA "Ver no GranaEvo" + "Copiar").
function _actions(rawText, opts) {
    const bar = document.createElement('div');
    bar.className = 'ge-actions';
    if (opts.cta && (typeof opts.cta.href === 'string' || typeof opts.cta.onClick === 'function')) {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'ge-cta-btn';
        a.appendChild(faIcon(opts.cta.icon || 'fa-arrow-up-right-from-square'));
        a.appendChild(document.createTextNode(' ' + (opts.cta.label || 'Ver no GranaEvo')));
        a.addEventListener('click', () => {
            try {
                if (typeof opts.cta.onClick === 'function') opts.cta.onClick(a);
                else window.location.assign(opts.cta.href);
            } catch { /* ignore */ }
        });
        bar.appendChild(a);
    }
    if (opts.copiavel) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'ge-copy-btn';
        c.appendChild(faIcon('fa-copy'));
        c.appendChild(document.createTextNode(' Copiar'));
        c.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(stripTokens(rawText)); c.replaceChildren(faIcon('fa-check'), document.createTextNode(' Copiado')); }
            catch { /* clipboard indisponível — silencioso */ }
        });
        bar.appendChild(c);
    }
    return bar;
}

/** D37: fala um texto (template local) via SpeechSynthesis. No-op se indisponível. */
export function speak(text) {
    try {
        const synth = window.speechSynthesis;
        if (!synth) return;
        synth.cancel();
        const u = new SpeechSynthesisUtterance(stripTokens(text));
        u.lang = 'pt-BR'; u.rate = 1.05;
        synth.speak(u);
    } catch { /* ignore */ }
}
export function stopSpeak() { try { window.speechSynthesis?.cancel(); } catch { /* ignore */ } }

/** Chip de confirmação com botão Desfazer (+ Corrigir p/ saída/entrada). onUndo é async. */
export function addConfirm({ text, chip }, onUndo) {
    haptic(); // D39: feedback tátil sutil ao confirmar
    const row = document.createElement('div');
    row.className = 'ge-row assistant';
    const wrap = document.createElement('div');
    wrap.className = 'ge-confirm ge-confirm--timed'; // D39: janela visual de desfazer

    const t = document.createElement('div');
    t.className = 'ge-confirm-text';
    renderFormatted(t, text);
    wrap.appendChild(t);

    // D35: "Corrigir" — só pra saída/entrada (onde a correção inline funciona).
    if (chip?.categoria === 'saida' || chip?.categoria === 'entrada') {
        const fix = document.createElement('button');
        fix.className = 'ge-correct-btn';
        fix.type = 'button';
        fix.textContent = 'Corrigir';
        fix.addEventListener('click', () => focusInput('corrige pra '));
        wrap.appendChild(fix);
    }

    const btn = document.createElement('button');
    btn.className = 'ge-undo-btn';
    btn.textContent = chip?.undoLabel || 'Desfazer';
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        const res = await onUndo();
        btn.replaceChildren(faIcon('fa-check'));
        if (res?.text) addAssistantMessage(res.text);
    }, { once: true });
    wrap.appendChild(btn);

    row.appendChild(wrap);
    _target().appendChild(row);
    scrollDown();
}

/** D36/D38: cabeçalho sutil quando um único envio gera vários lançamentos. */
export function addMultiHeader(n) {
    if (!(n > 1)) return;
    const head = document.createElement('div');
    head.className = 'ge-multi-head';
    head.appendChild(faIcon('fa-layer-group'));
    head.appendChild(document.createTextNode(` ${n} lançamentos de uma vez:`));
    _target().appendChild(head);
}

let typingRow = null;
export function showTyping() {
    if (typingRow) return;
    typingRow = document.createElement('div');
    typingRow.className = 'ge-row assistant';
    const t = document.createElement('div');
    t.className = 'ge-typing';
    t.appendChild(document.createElement('span'));
    t.appendChild(document.createElement('span'));
    t.appendChild(document.createElement('span'));
    typingRow.appendChild(t);
    els.messages.appendChild(typingRow);
    scrollDown();
}
export function hideTyping() {
    if (typingRow) { typingRow.remove(); typingRow = null; }
}

/** Auto-expande a textarea e habilita/desabilita o botão enviar. */
export function wireInput(onSend) {
    const { input, send } = els;
    const autoresize = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        send.disabled = input.value.trim() === '';
    };
    input.addEventListener('input', autoresize);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);
    function submit() {
        const text = input.value.trim();
        if (!text) return;
        input.value = ''; autoresize();
        onSend(text);
    }
    autoresize();
    input.focus();
}
