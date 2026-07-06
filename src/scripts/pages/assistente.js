// assistente.js — boot da PWA "Assistente GranaEvo"
// ---------------------------------------------------------------------------
// Porta de auth (sessão longa, sem re-login) → trava opt-in (PIN/biometria) →
// init do engine → seleção de perfil (só 1x) → chat. Toda a lógica vive nos
// módulos assistant/*; aqui é só orquestração de UI e sessão.
// ---------------------------------------------------------------------------

import { supabaseReady, getValidAccessToken, logout, supabase } from '../services/supabase-client.js?v=2';
import { dataManager } from '../modules/data-manager.js';
import { assistant } from '../modules/assistant/engine.js';
import { formatBRL } from '../modules/assistant/money.js';
import * as UI from '../modules/assistant/ui.js';
import * as Lock from '../modules/assistant/session-lock.js';
import { clearLearned } from '../modules/assistant/learn.js';
import { SISTEMA } from '../modules/assistant/phrases.js';
import * as Install from '../modules/assistant/install.js';

const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
};

// ── Instalação nativa ─────────────────────────────────────────────────────────
// Todo o fluxo de instalação (prompt nativo, intent:// pro Chrome no Android,
// instruções por navegador, detecção de "já instalado" e o diagnóstico
// ?pwadebug=1) vive em modules/assistant/install.js. O beforeinstallprompt é
// capturado cedo em /pwa-init.js e o SW próprio é registrado lá também.

const overlay = document.getElementById('geOverlay');
const sheet   = document.getElementById('geSheet');
function openSheet() { overlay.hidden = false; }
function closeSheet() { overlay.hidden = true; sheet.replaceChildren(); }
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

// ── Estado de sessão + helpers de UX (D32-D40) ───────────────────────────────
let currentUserId = null;
let histLog = [];
const HIST_MAX = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STARTERS = [
    { label: 'Resumo do mês', text: 'resumo do mês' },
    { label: 'Meu saldo', text: 'meu saldo' },
    { label: 'Onde gastei mais', text: 'onde mais gastei' },
    { label: 'Quanto posso gastar', text: 'quanto posso gastar esse mês' },
];

// ── Preferências locais (E41 opt-out de histórico · D37 voz) ──────────────────
function prefKey(k) { return `ge_pref_${k}_${currentUserId || 'anon'}`; }
function histEnabled() { try { return localStorage.getItem(prefKey('hist')) !== '0'; } catch { return true; } } // E41: ON por padrão
function setHistEnabled(on) { try { localStorage.setItem(prefKey('hist'), on ? '1' : '0'); } catch {} }
function ttsEnabled() { try { return localStorage.getItem(prefKey('tts')) === '1'; } catch { return false; } } // D37: OFF por padrão
function setTtsEnabled(on) { try { localStorage.setItem(prefKey('tts'), on ? '1' : '0'); } catch {} }

// D37/E41: histórico local da conversa (device-local; limpo no logout; opt-out).
function histKey() { return `ge_chat_hist_${currentUserId || 'anon'}`; }
function loadHistory() {
    if (!histEnabled()) return [];
    try { const a = JSON.parse(localStorage.getItem(histKey()) || '[]'); return Array.isArray(a) ? a.slice(-HIST_MAX) : []; }
    catch { return []; }
}
function saveHistory() { if (!histEnabled()) return; try { localStorage.setItem(histKey(), JSON.stringify(histLog.slice(-HIST_MAX))); } catch {} }
function pushHist(role, text) {
    if (!histEnabled() || typeof text !== 'string' || !text) return;
    histLog.push({ r: role === 'user' ? 'u' : 'a', t: text.slice(0, 500) });
    if (histLog.length > HIST_MAX) histLog = histLog.slice(-HIST_MAX);
    saveHistory();
}
function clearHistory() { try { localStorage.removeItem(histKey()); } catch {} histLog = []; }

function activeProfileName() {
    const p = assistant.listProfiles().find((x) => x.id === assistant.activeProfileId);
    return p ? p.name : '';
}

// D33: sugestões contextuais conforme a resposta.
function quickFor(res) {
    if (res?.creditoCards || res?.reservaPicker) return []; // fluxo com picker: sem chips
    const temChip = res?.chip || (Array.isArray(res?.multi) && res.multi.some((r) => r?.chip));
    if (temChip) return [
        { label: 'Meu saldo', text: 'meu saldo' },
        { label: 'Quanto posso gastar', text: 'quanto posso gastar esse mês' },
        { label: 'Resumo do mês', text: 'explica meu mês' },
    ];
    return [
        { label: 'Onde gastei mais', text: 'onde mais gastei' },
        { label: 'Comparar c/ mês passado', text: 'gastei mais que mês passado?' },
        { label: 'Minhas reservas', text: 'minhas reservas' },
        { label: 'Minhas assinaturas', text: 'minhas assinaturas' },
    ];
}

// Telas válidas p/ deep-link do CTA "Ver no GranaEvo" (A1/F48).
const TELAS_OK = new Set(['dashboard', 'transacoes', 'reservas', 'cartoes', 'graficos', 'relatorios', 'configuracoes']);
function ctaHref(tela) { return TELAS_OK.has(tela) ? `/dashboard#${tela}` : '/dashboard'; }

// Mescla chips contextuais com os starters (sem duplicar), cap 5.
function mergeQuick(extra, base) {
    const seen = new Set();
    const out = [];
    for (const c of [...(extra || []), ...base]) {
        if (!c || seen.has(c.text)) continue;
        seen.add(c.text); out.push(c);
        if (out.length >= 5) break;
    }
    return out;
}

// C21-C30: insights de abertura — no máximo 1x por dia. Retorna chips de ação.
function showDailyInsights(userId) {
    const key = `ge_asst_daily_${userId}`;
    const today = new Date().toDateString();
    let last = null; try { last = localStorage.getItem(key); } catch {}
    if (last === today) return [];
    try { localStorage.setItem(key, today); } catch {}
    const { messages, quick } = assistant.aberturaInsights();
    for (const t of messages) { UI.addAssistantMessage(t); if (ttsEnabled()) UI.speak(t); }
    return Array.isArray(quick) ? quick : [];
}

// D38: entrada por voz (Web Speech API). Preenche o input; o usuário revisa e envia.
function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = document.getElementById('geMic');
    if (!SR || !mic) return; // não suportado → botão continua oculto
    mic.hidden = false;
    let rec = null, listening = false;
    mic.addEventListener('click', () => {
        if (listening) { try { rec?.stop(); } catch {} return; }
        rec = new SR();
        rec.lang = 'pt-BR'; rec.interimResults = false; rec.maxAlternatives = 1;
        rec.onstart = () => { listening = true; mic.classList.add('listening'); };
        rec.onerror = () => { listening = false; mic.classList.remove('listening'); };
        rec.onend = () => { listening = false; mic.classList.remove('listening'); };
        rec.onresult = (e) => { const txt = e.results?.[0]?.[0]?.transcript?.trim(); if (txt) UI.focusInput(txt); };
        try { rec.start(); } catch {}
    });
}

// ── Busca na conversa (D35) — varre as bolhas no DOM (independe do histórico) ──
function collectMessages() {
    const out = [];
    document.querySelectorAll('#geMessages .ge-row').forEach((row) => {
        const bubble = row.querySelector('.ge-bubble');
        if (bubble) out.push({ role: row.classList.contains('user') ? 'u' : 'a', text: bubble.textContent || '', node: bubble });
    });
    return out;
}
function openSearch() {
    sheet.replaceChildren();
    sheet.appendChild(el('h2', null, 'Buscar na conversa'));
    const input = el('input');
    input.type = 'search'; input.className = 'ge-input'; input.placeholder = 'Digite pra buscar…'; input.autocomplete = 'off';
    const wrap = el('div', 'ge-sheet-section'); wrap.appendChild(input); sheet.appendChild(wrap);
    const results = el('div', 'ge-search-results'); sheet.appendChild(results);
    const render = () => {
        const q = input.value.trim().toLowerCase();
        results.replaceChildren();
        if (q.length < 2) { results.appendChild(el('p', 'ge-muted', 'Digite ao menos 2 letras.')); return; }
        const hits = collectMessages().filter((m) => m.text.toLowerCase().includes(q)).reverse().slice(0, 30);
        if (!hits.length) { results.appendChild(el('p', 'ge-muted', 'Nada encontrado.')); return; }
        for (const m of hits) {
            const b = el('button', 'ge-search-hit');
            b.appendChild(el('span', 'ge-search-role', m.role === 'u' ? 'Você' : 'Ge'));
            b.appendChild(el('span', null, m.text.length > 90 ? m.text.slice(0, 90) + '…' : m.text));
            b.addEventListener('click', () => {
                closeSheet();
                try { m.node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
                m.node.classList.add('ge-flash');
                setTimeout(() => m.node.classList.remove('ge-flash'), 1500);
            });
            results.appendChild(b);
        }
    };
    input.addEventListener('input', render);
    render();
    openSheet();
    setTimeout(() => input.focus(), 50);
}
function setupSearch() {
    const btn = document.getElementById('geSearch');
    if (!btn) return;
    btn.hidden = false;
    btn.addEventListener('click', openSearch);
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function boot() {
    await supabaseReady;
    const token = await getValidAccessToken();
    if (!token) { location.replace('/login?next=/assistente'); return; }

    // Identifica o usuário pela sessão e INICIALIZA o dataManager — obrigatório
    // antes de carregar dados. Sem isto, loadUserData() volta vazio (0 perfis).
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    const email  = session?.user?.email;
    if (!userId || !email) { location.replace('/login?next=/assistente'); return; }

    const okInit = await dataManager.initialize(userId, email);
    if (!okInit) { UI.mountUI(); UI.addAssistantMessage(SISTEMA.erro()); return; }

    // 1) Trava opt-in
    if (Lock.isEnabled(userId)) {
        const ok = await showLockScreen(userId);
        if (!ok) return; // ficou travado
    }

    // 2) Engine
    let state;
    try { state = await assistant.init(); }
    catch { UI.mountUI(); UI.addAssistantMessage(SISTEMA.erro()); return; }

    UI.mountUI();

    // 3) Seleção de perfil só na 1ª vez (mais de 1 perfil e sem escolha salva)
    const savedKey = `ge_assistant_profile_${userId}`;
    const jaEscolheu = (() => { try { return !!localStorage.getItem(savedKey); } catch { return false; } })();
    if (state.profiles.length > 1 && !jaEscolheu) {
        await pickProfile(state.profiles);
    }
    renderHeaderProfile();

    // 4) Histórico + saudação personalizada + insights de abertura + wiring
    currentUserId = userId;
    const nomeAtivo = activeProfileName();
    histLog = loadHistory();
    if (histLog.length) {
        for (const m of histLog) {
            if (m.r === 'u') UI.addUserMessage(m.t);
            else UI.addAssistantMessage(m.t);
        }
        UI.addAssistantMessage('{{fa-clock-rotate-left}} Retomando de onde paramos. Manda a próxima!');
    } else {
        UI.addAssistantMessage(SISTEMA.saudacao(nomeAtivo));
        const hintKey = `ge_asst_hinted_${userId}`;
        let jaViu = false;
        try { jaViu = !!localStorage.getItem(hintKey); } catch {}
        if (!jaViu) {
            // D32: onboarding curto com exemplos reais (2 balões + convite aos chips).
            UI.addAssistantMessage('É só falar naturalmente. Por exemplo:');
            UI.addAssistantMessage('{{fa-cart-shopping}} “gastei 80 no mercado”\n{{fa-money-bill-wave}} “recebi 2000 de salário”\n{{fa-piggy-bank}} “guardei 200 na viagem”');
            UI.addAssistantMessage('E pra consultar: “meu saldo”, “onde mais gastei?”, “resumo do mês”. Toca numa sugestão aqui embaixo pra experimentar. {{fa-lightbulb}}');
            try { localStorage.setItem(hintKey, '1'); } catch {}
        }
    }
    const dailyQuick = showDailyInsights(userId);
    UI.setQuickReplies(mergeQuick(dailyQuick, STARTERS), onSend);
    UI.wireInput(onSend);
    setupMic();

    document.getElementById('geSettings').addEventListener('click', () => openSettings(userId));
    setupSearch(); // D35
    setupChrome();
})();

async function onSend(text) {
    UI.addUserMessage(text);
    pushHist('user', text);
    UI.haptic();
    UI.setQuickReplies([], onSend); // esconde sugestões enquanto processa
    UI.showTyping();
    const started = Date.now();
    let res;
    try { res = await assistant.handle(text); }
    catch { res = { text: SISTEMA.erro() }; }
    // Garante um mínimo de "digitando" perceptível (mais humano).
    const minDelay = 350 + Math.random() * 300;
    const elapsed = Date.now() - started;
    if (elapsed < minDelay) await sleep(minDelay - elapsed);
    UI.hideTyping();
    if (res && Array.isArray(res.multi)) {
        UI.beginGroup();                     // D38: agrupa os lançamentos do envio
        UI.addMultiHeader(res.multi.length); // D36
        res.multi.forEach(renderResponse);
        UI.endGroup();
    } else {
        renderResponse(res);
    }
    // C25/B13/F50: chips específicos da resposta vencem os genéricos.
    const quick = (res && res.quickReplies) ? res.quickReplies : quickFor(res); // D33
    UI.setQuickReplies(quick, onSend);
}

function renderResponse(res) {
    if (!res) return;
    if (res.creditoCards) { creditoFlow(res.credito, res.creditoCards); return; }
    if (res.reservaPicker) { retiradaFlow(res.retirada, res.reservaPicker); return; }
    if (res.chip) { UI.addConfirm(res, res.undo); pushHist('a', res.text); return; }
    const opts = {};
    if (res.cta) opts.cta = { label: res.cta.label, href: ctaHref(res.cta.tela) }; // A1/F48
    if (res.copiavel) opts.copiavel = true;                                        // A7
    UI.addAssistantMessage(res.text, opts);
    pushHist('a', res.text);
    if (ttsEnabled()) UI.speak(res.text);                                          // D37
}

// ── Fluxo de retirada: escolhe a reserva no picker → aplica ──────────────────
async function retiradaFlow(retirada, reservas) {
    const meta = await pickReserva(reservas);
    if (!meta) { UI.addAssistantMessage('Ok, cancelei a retirada.'); return; }
    UI.showTyping();
    let res;
    try { res = await assistant.retirarDe({ valor: retirada.valor, metaId: meta.id }); }
    catch { res = { text: SISTEMA.erro() }; }
    UI.hideTyping();
    renderResponse(res);
}

function pickReserva(reservas) {
    return new Promise((resolve) => {
        sheet.replaceChildren();
        sheet.appendChild(el('h2', null, 'De qual reserva?'));
        const sec = el('div', 'ge-sheet-section');
        for (const r of reservas) {
            const b = el('button', 'ge-profile-opt');
            b.appendChild(UI.faIcon('fa-piggy-bank'));
            b.appendChild(el('span', null, `${r.nome} · ${formatBRL(r.saved)}`));
            b.addEventListener('click', () => { closeSheet(); resolve(r); });
            sec.appendChild(b);
        }
        sheet.appendChild(sec);
        const cancel = el('button', 'ge-undo-btn', 'Cancelar');
        cancel.addEventListener('click', () => { closeSheet(); resolve(null); });
        sheet.appendChild(cancel);
        openSheet();
    });
}

// ── Fluxo de compra no crédito: cartão → parcelas → aplica ───────────────────
async function creditoFlow(credito, cards) {
    const usaveis = cards.filter((c) => !c.congelado);
    if (usaveis.length === 0) { UI.addAssistantMessage('{{fa-snowflake}} Todos os seus cartões estão congelados. Descongele um no menu Cartões.'); return; }

    const card = await pickCard(usaveis);
    if (!card) { UI.addAssistantMessage('Ok, cancelei a compra no crédito.'); return; }

    // Se o usuário já disse "em Nx" no texto, não pergunta as parcelas.
    let parcelas = credito.parcelas;
    if (!parcelas) {
        parcelas = await pickParcelas();
        if (!parcelas) { UI.addAssistantMessage('Ok, cancelei a compra no crédito.'); return; }
    }

    UI.showTyping();
    let res;
    try { res = await assistant.applyCredito({ ...credito, cardId: card.id, parcelas }); }
    catch { res = { text: SISTEMA.erro() }; }
    UI.hideTyping();
    renderResponse(res);
}

function pickCard(cards) {
    return new Promise((resolve) => {
        sheet.replaceChildren();
        sheet.appendChild(el('h2', null, 'Qual cartão?'));
        const sec = el('div', 'ge-sheet-section');
        for (const c of cards) {
            const b = el('button', 'ge-profile-opt');
            b.appendChild(UI.faIcon('fa-credit-card'));
            b.appendChild(el('span', null, c.nome));
            b.addEventListener('click', () => { closeSheet(); resolve(c); });
            sec.appendChild(b);
        }
        sheet.appendChild(sec);
        const cancel = el('button', 'ge-undo-btn', 'Cancelar');
        cancel.addEventListener('click', () => { closeSheet(); resolve(null); });
        sheet.appendChild(cancel);
        openSheet();
    });
}

function pickParcelas() {
    return new Promise((resolve) => {
        let limite = 12; // 12 → 24 → 36 → 48 → input livre
        const render = () => {
            sheet.replaceChildren();
            sheet.appendChild(el('h2', null, 'Em quantas vezes?'));
            const grid = el('div', 'ge-parcelas-grid');
            for (let i = 1; i <= limite; i++) {
                const b = el('button', 'ge-parcela-btn', `${i}x`);
                b.addEventListener('click', () => { closeSheet(); resolve(i); });
                grid.appendChild(b);
            }
            sheet.appendChild(grid);

            if (limite < 48) {
                const mais = el('button', 'ge-btn-primary', 'Mais opções');
                mais.addEventListener('click', () => { limite += 12; render(); });
                sheet.appendChild(mais);
            } else {
                const wrap = el('div', 'ge-sheet-section');
                const input = el('input');
                input.type = 'number'; input.min = '1'; input.max = '420'; input.inputMode = 'numeric';
                input.className = 'ge-input'; input.style.textAlign = 'center';
                input.placeholder = 'Digite o nº de parcelas';
                wrap.appendChild(input);
                sheet.appendChild(wrap);
                const ok = el('button', 'ge-btn-primary', 'Confirmar');
                ok.addEventListener('click', () => {
                    const n = parseInt(input.value, 10);
                    if (Number.isInteger(n) && n >= 1 && n <= 420) { closeSheet(); resolve(n); }
                    else input.focus();
                });
                sheet.appendChild(ok);
                setTimeout(() => input.focus(), 50);
            }
            const cancel = el('button', 'ge-undo-btn', 'Cancelar');
            cancel.addEventListener('click', () => { closeSheet(); resolve(null); });
            sheet.appendChild(cancel);
        };
        render();
        openSheet();
    });
}

function renderHeaderProfile() {
    const p = assistant.listProfiles().find((x) => x.id === assistant.activeProfileId);
    const elp = document.getElementById('geHeaderProfile');
    if (elp) elp.textContent = p ? p.name : '';
}

// ── Seleção de perfil (overlay bloqueante) ───────────────────────────────────
function pickProfile(profiles) {
    return new Promise((resolve) => {
        sheet.replaceChildren();
        sheet.appendChild(el('h2', null, 'Qual perfil?'));
        sheet.appendChild(el('p', 'ge-muted', 'O assistente vai anotar tudo neste perfil. Dá pra trocar depois nas configurações.'));
        const sec = el('div', 'ge-sheet-section');
        for (const p of profiles) {
            const b = el('button', 'ge-profile-opt');
            b.appendChild(UI.faIcon('fa-user'));
            b.appendChild(el('span', null, p.name));
            b.addEventListener('click', () => { assistant.setActiveProfile(p.id); closeSheet(); resolve(); });
            sec.appendChild(b);
        }
        sheet.appendChild(sec);
        openSheet();
    });
}

// ── Configurações ────────────────────────────────────────────────────────────
function openSettings(userId) {
    sheet.replaceChildren();
    sheet.appendChild(el('h2', null, 'Configurações'));

    // Perfil ativo
    const profiles = assistant.listProfiles();
    if (profiles.length > 1) {
        const sec = el('div', 'ge-sheet-section');
        sec.appendChild(el('label', null, 'Perfil ativo'));
        for (const p of profiles) {
            const b = el('button', 'ge-profile-opt' + (p.id === assistant.activeProfileId ? ' active' : ''));
            b.appendChild(UI.faIcon('fa-user'));
            b.appendChild(el('span', null, p.name));
            b.addEventListener('click', () => {
                assistant.setActiveProfile(p.id);
                renderHeaderProfile();
                closeSheet();
                UI.addAssistantMessage(`Pronto! Agora anotando em *${p.name}*.`);
            });
            sec.appendChild(b);
        }
        sheet.appendChild(sec);
    }

    // Segurança — trava opt-in
    const secLock = el('div', 'ge-sheet-section');
    secLock.appendChild(el('label', null, 'Segurança'));
    const row = el('div', 'ge-toggle-row');
    const enabled = Lock.isEnabled(userId);
    row.appendChild(el('span', null, enabled ? `Trava ativa (${Lock.getMode(userId) === 'pin' ? 'PIN' : 'biometria'})` : 'Pedir PIN/biometria ao abrir'));
    const toggle = el('button', 'ge-undo-btn', enabled ? 'Desativar' : 'Ativar');
    toggle.addEventListener('click', () => {
        if (enabled) { Lock.disableLock(userId); openSettings(userId); }
        else setupLockFlow(userId);
    });
    row.appendChild(toggle);
    secLock.appendChild(row);
    sheet.appendChild(secLock);

    // Preferências (D37 voz · E41 opt-out de histórico local)
    const secPref = el('div', 'ge-sheet-section');
    secPref.appendChild(el('label', null, 'Preferências'));
    const rowTts = el('div', 'ge-toggle-row');
    rowTts.appendChild(el('span', null, 'Ler respostas em voz'));
    const tglTts = el('button', 'ge-undo-btn', ttsEnabled() ? 'Ativado' : 'Ativar');
    tglTts.addEventListener('click', () => { const on = !ttsEnabled(); setTtsEnabled(on); if (!on) UI.stopSpeak(); openSettings(userId); });
    rowTts.appendChild(tglTts);
    secPref.appendChild(rowTts);
    const rowHist = el('div', 'ge-toggle-row');
    rowHist.appendChild(el('span', null, 'Salvar conversa neste aparelho'));
    const tglHist = el('button', 'ge-undo-btn', histEnabled() ? 'Ativado' : 'Ativar');
    tglHist.addEventListener('click', () => { const on = !histEnabled(); setHistEnabled(on); if (!on) clearHistory(); openSettings(userId); });
    rowHist.appendChild(tglHist);
    secPref.appendChild(rowHist);
    secPref.appendChild(el('p', 'ge-muted', 'A conversa fica só neste aparelho e é apagada ao sair. Desligue se preferir não guardar valores localmente.'));
    sheet.appendChild(secPref);

    // Logout — E45: limpa histórico, aprendizado e todo estado do engine.
    const secOut = el('div', 'ge-sheet-section');
    const out = el('button', 'ge-btn-danger', 'Sair da conta');
    out.addEventListener('click', async () => {
        clearHistory(); clearLearned(); UI.stopSpeak();
        try { assistant.reset(); } catch {}
        await logout().catch(() => {});
        location.replace('/login');
    });
    secOut.appendChild(out);
    sheet.appendChild(secOut);

    openSheet();
}

// ── Fluxo de ativação da trava ────────────────────────────────────────────────
function setupLockFlow(userId) {
    sheet.replaceChildren();
    sheet.appendChild(el('h2', null, 'Proteger o assistente'));
    sheet.appendChild(el('p', 'ge-muted', 'Escolha como destravar ao abrir. Isso não muda seu login — é só uma camada extra neste aparelho.'));
    const sec = el('div', 'ge-sheet-section');

    const pinBtn = el('button', 'ge-profile-opt');
    pinBtn.appendChild(UI.faIcon('fa-hashtag'));
    pinBtn.appendChild(el('span', null, 'Usar um PIN'));
    pinBtn.addEventListener('click', () => setupPINFlow(userId));
    sec.appendChild(pinBtn);

    if (Lock.biometricSupported()) {
        const bioBtn = el('button', 'ge-profile-opt');
        bioBtn.appendChild(UI.faIcon('fa-fingerprint'));
        bioBtn.appendChild(el('span', null, 'Usar biometria do aparelho'));
        bioBtn.addEventListener('click', async () => {
            const ok = await Lock.setupBiometric(userId);
            if (ok) { closeSheet(); UI.addAssistantMessage('{{fa-lock}} Biometria ativada. Vou pedir ao abrir o assistente.'); }
            else UI.addAssistantMessage('Não consegui ativar a biometria neste aparelho.');
        });
        sec.appendChild(bioBtn);
    }
    sheet.appendChild(sec);
    openSheet();
}

function setupPINFlow(userId) {
    sheet.replaceChildren();
    sheet.appendChild(el('h2', null, 'Crie um PIN'));
    sheet.appendChild(el('p', 'ge-muted', 'De 4 a 8 dígitos.'));
    const input = el('input');
    input.type = 'password'; input.inputMode = 'numeric'; input.maxLength = 8;
    input.className = 'ge-input'; input.style.textAlign = 'center'; input.style.letterSpacing = '0.4em';
    input.placeholder = '••••';
    sheet.appendChild(el('div', 'ge-sheet-section')).appendChild(input);
    const save = el('button', 'ge-btn-primary', 'Salvar PIN');
    save.addEventListener('click', async () => {
        const ok = await Lock.setupPIN(userId, input.value.trim());
        if (ok) { closeSheet(); UI.addAssistantMessage('{{fa-lock}} PIN ativado. Vou pedir ao abrir o assistente.'); }
        else UI.addAssistantMessage('PIN inválido — use de 4 a 8 dígitos.');
    });
    sheet.appendChild(save);
    openSheet();
    input.focus();
}

// ── Tela de destravar (bloqueia até destravar) ─────────────────────────────────
function showLockScreen(userId) {
    return new Promise((resolve) => {
        const mode = Lock.getMode(userId);
        sheet.replaceChildren();
        const lockTitle = el('h2', 'ge-center');
        lockTitle.appendChild(UI.faIcon('fa-lock'));
        lockTitle.appendChild(document.createTextNode(' Assistente bloqueado'));
        sheet.appendChild(lockTitle);

        if (mode === 'biometric') {
            sheet.appendChild(el('p', 'ge-muted ge-center', 'Use sua biometria para entrar.'));
            const btn = el('button', 'ge-btn-primary', 'Desbloquear');
            const tryBio = async () => {
                const ok = await Lock.unlockBiometric(userId);
                if (ok) { closeSheet(); resolve(true); }
                else btn.textContent = 'Tentar de novo';
            };
            btn.addEventListener('click', tryBio);
            sheet.appendChild(btn);
            openSheet();
            tryBio();
        } else {
            sheet.appendChild(el('p', 'ge-muted ge-center', 'Digite seu PIN.'));
            const input = el('input');
            input.type = 'password'; input.inputMode = 'numeric'; input.maxLength = 8;
            input.className = 'ge-input'; input.style.textAlign = 'center'; input.style.letterSpacing = '0.4em';
            const secw = el('div', 'ge-sheet-section'); secw.appendChild(input); sheet.appendChild(secw);
            const btn = el('button', 'ge-btn-primary', 'Entrar');
            const err = el('p', 'ge-muted ge-center');
            const tryPin = async () => {
                if (await Lock.verifyPIN(userId, input.value.trim())) { closeSheet(); resolve(true); }
                else { err.textContent = 'PIN incorreto.'; input.value = ''; input.focus(); }
            };
            btn.addEventListener('click', tryPin);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });
            sheet.appendChild(btn);
            sheet.appendChild(err);
            openSheet();
            input.focus();
        }
    });
}

// ── Chrome do app: voltar ao dashboard (navegador) + instalar PWA ─────────────
function setupChrome() {
    // Voltar ao dashboard — SEMPRE visível (útil no navegador e no app instalado).
    const back = document.getElementById('geBack');
    if (back) {
        back.hidden = false;
        back.addEventListener('click', () => { window.location.href = '/dashboard'; });
    }

    // Botão Baixar do header + deep-link ?install=1 + diagnóstico ?pwadebug=1.
    Install.wireInstall();
}
