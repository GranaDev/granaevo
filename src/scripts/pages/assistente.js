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
import { SISTEMA } from '../modules/assistant/phrases.js';

const el = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
};

const overlay = document.getElementById('geOverlay');
const sheet   = document.getElementById('geSheet');
function openSheet() { overlay.hidden = false; }
function closeSheet() { overlay.hidden = true; sheet.replaceChildren(); }
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

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

    // 4) Saudação + dica inicial (só na 1ª vez) + wiring
    UI.addAssistantMessage(SISTEMA.saudacao());
    const hintKey = `ge_asst_hinted_${userId}`;
    let jaViu = false;
    try { jaViu = !!localStorage.getItem(hintKey); } catch {}
    if (!jaViu) {
        UI.addAssistantMessage('Dá pra: registrar (“gastei 80 no mercado”, “recebi 2000 de salário”, “guardei 200 na reserva”), consultar (“quanto gastei em transporte?”, “meu saldo”, “onde mais gastei?”) e pedir resumo. Fala naturalmente que eu entendo.');
        try { localStorage.setItem(hintKey, '1'); } catch {}
    }
    UI.wireInput(onSend);

    document.getElementById('geSettings').addEventListener('click', () => openSettings(userId));
    setupChrome();
})();

async function onSend(text) {
    UI.addUserMessage(text);
    UI.showTyping();
    let res;
    try { res = await assistant.handle(text); }
    catch { res = { text: SISTEMA.erro() }; }
    UI.hideTyping();
    if (res && Array.isArray(res.multi)) res.multi.forEach(renderResponse);
    else renderResponse(res);
}

function renderResponse(res) {
    if (!res) return;
    if (res.creditoCards) { creditoFlow(res.credito, res.creditoCards); return; }
    if (res.reservaPicker) { retiradaFlow(res.retirada, res.reservaPicker); return; }
    if (res.chip) UI.addConfirm(res, res.undo);
    else UI.addAssistantMessage(res.text);
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

    // Logout
    const secOut = el('div', 'ge-sheet-section');
    const out = el('button', 'ge-btn-danger', 'Sair da conta');
    out.addEventListener('click', async () => { await logout().catch(() => {}); location.replace('/login'); });
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
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

function setupChrome() {
    const standalone = isStandalone();

    // Voltar ao dashboard — SEMPRE visível (útil no navegador e no app instalado).
    const back = document.getElementById('geBack');
    if (back) {
        back.hidden = false;
        back.addEventListener('click', () => { window.location.href = '/dashboard'; });
    }

    // Botão instalar — some se já está instalado (standalone).
    const btn = document.getElementById('geInstall');
    if (btn && !standalone) {
        btn.hidden = false; // sempre visível no navegador; o clique decide o que fazer
        btn.addEventListener('click', async () => {
            const p = window.__pwaInstallPrompt;
            if (p) {
                p.prompt();
                await p.userChoice.catch(() => {});
                window.__pwaInstallPrompt = null;
                return;
            }
            // Sem prompt nativo (iOS, ou critério ainda não atendido) → instruções.
            const ua = navigator.userAgent || '';
            if (/iphone|ipad|ipod/i.test(ua) || (/mac/i.test(ua) && 'ontouchend' in document)) {
                UI.addAssistantMessage('Pra instalar no iPhone/iPad: toque em **Compartilhar** (o ícone {{fa-arrow-up-from-bracket}}) e depois em **"Adicionar à Tela de Início"**.');
            } else {
                UI.addAssistantMessage('Pra instalar: abra o **menu do navegador** e toque em **"Instalar app"** / **"Adicionar à tela inicial"**.');
            }
        });
        document.addEventListener('ge:pwa-installed', () => { btn.hidden = true; });
    }
}
