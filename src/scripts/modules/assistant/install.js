// install.js — Motor de instalação do PWA "Assistente GranaEvo".
// ---------------------------------------------------------------------------
// O fluxo "Baixar" tenta SEMPRE o caminho mais nativo disponível e degrada com
// honestidade, a partir de um gesto do usuário (exigência do Chrome):
//
//   1) Prompt NATIVO — beforeinstallprompt (Chrome/Edge/Samsung), capturado
//      cedo em /pwa-init.js. Um toque → instalador do sistema → ícone na tela.
//   2) Android sem prompt (Opera/Firefox, ou aba interna/Custom Tab aberta por
//      outro app — onde o Chrome NÃO entrega o prompt) → CTA "Abrir no Chrome":
//      um intent:// reabre esta página no Chrome de verdade, onde o passo 1
//      funciona com um toque. Nada de decorar menus.
//   3) iOS/iPadOS → a Apple não expõe API de instalação para a web: instrução
//      curta do Compartilhar → Adicionar à Tela de Início (único caminho).
//   4) Desktop Firefox/Opera → instrução do menu do navegador (limitação).
//
// Por que o prompt às vezes não vem NEM no Chrome:
//   • o app já está instalado (checado via getInstalledRelatedApps + flag);
//   • o usuário dispensou o instalador há pouco (o Chrome segura por semanas);
//   • a página abriu numa Custom Tab (ex.: window.open de dentro do app
//     GranaEvo instalado) — o intent:// do passo 2 resolve.
//
// Diagnóstico em produção: abrir /assistente?pwadebug=1 imprime no chat o
// estado real do aparelho (prompt, SW, manifesto, instalado, modo…).
//
// Segurança/LGPD: nenhum dado pessoal envolvido; usa apenas um flag local
// (localStorage, só deste aparelho) lembrando que o app foi instalado.

import * as UI from './ui.js';

const INSTALLED_FLAG = 'ge_assistant_installed';
const INSTALL_PATH   = '/assistente';

// ── Ambiente ──────────────────────────────────────────────────────────────────

export function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

// Classifica o navegador pelo que ele CONSEGUE fazer, não pelo nome.
// bip = entrega o beforeinstallprompt (instalação 1-toque pelo botão do site).
function detectar() {
    const ua = navigator.userAgent || '';
    const ios = /iphone|ipad|ipod/i.test(ua) || (/mac/i.test(ua) && 'ontouchend' in document);
    if (ios) return { os: 'ios', nome: 'ios', rotulo: 'navegador do iOS', bip: false };
    const os = /android/i.test(ua) ? 'android' : 'desktop';
    if (/OPR\/|OPT\/|\bOpera/i.test(ua)) return { os, nome: 'opera',   rotulo: 'Opera',            bip: false };
    if (/Firefox\//i.test(ua))           return { os, nome: 'firefox', rotulo: 'Firefox',          bip: false };
    if (/SamsungBrowser/i.test(ua))      return { os, nome: 'samsung', rotulo: 'Samsung Internet', bip: true  };
    if (/Edg\//i.test(ua))               return { os, nome: 'edge',    rotulo: 'Edge',             bip: true  };
    if (/Chrome\//i.test(ua))            return { os, nome: 'chrome',  rotulo: 'Chrome',           bip: true  };
    return { os, nome: 'outro', rotulo: 'navegador', bip: false };
}
const NAV = detectar();

// ── Prompt nativo (capturado cedo em /pwa-init.js) ────────────────────────────

function promptAtual() { return window.__pwaInstallPrompt || null; }

// O evento pode chegar 1-3s depois do load (SW registrando, manifesto baixando).
// Espera curta, dentro da janela de ativação de gesto do Chrome (~5s).
function esperarPrompt(ms = 3500) {
    if (promptAtual()) return Promise.resolve(promptAtual());
    return new Promise((resolve) => {
        let fim = false;
        const finish = () => {
            if (fim) return; fim = true;
            document.removeEventListener('ge:pwa-ready', finish);
            clearTimeout(timer);
            resolve(promptAtual());
        };
        document.addEventListener('ge:pwa-ready', finish);
        const timer = setTimeout(finish, ms);
    });
}

// ── Já instalado? ─────────────────────────────────────────────────────────────

function flagInstalado() { try { return localStorage.getItem(INSTALLED_FLAG) === '1'; } catch { return false; } }
function limparFlag()    { try { localStorage.removeItem(INSTALLED_FLAG); } catch { /* */ } }

// getInstalledRelatedApps (Chrome Android) é a fonte da verdade quando existe —
// depende do related_applications (platform "webapp") no assistente.webmanifest.
// No desktop a API não enxerga PWAs instalados → só o flag local (best-effort).
async function jaInstalado() {
    try {
        if (navigator.getInstalledRelatedApps) {
            const apps = await navigator.getInstalledRelatedApps();
            const achou = apps.some((a) => a.platform === 'webapp' && String(a.url || '').includes('assistente'));
            if (achou) return true;
            if (NAV.os === 'android') { limparFlag(); return false; }
        }
    } catch { /* API indisponível/erro → cai pro flag */ }
    return flagInstalado();
}

// ── intent:// — Android: reabre esta página no Chrome DE VERDADE ──────────────
// Escapa de Custom Tabs (onde o instalador não roda) e de navegadores sem
// suporte (Opera/Firefox). Se o Chrome não existir no aparelho, o
// browser_fallback_url mantém o usuário onde está (sem erro).

function chromeIntentUrl() {
    const alvo     = location.host + INSTALL_PATH + '?install=1';
    const fallback = encodeURIComponent(location.origin + INSTALL_PATH + '?install=1');
    return 'intent://' + alvo + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + fallback + ';end';
}

export function abrirNoChrome(onFalha) {
    // Navegação via <a> REAL + click(): é o único caminho que o Chromium trata
    // como "clique de link" e roteia pro handler de protocolo externo. Navegar
    // via location.href falha com "scheme does not have a registered handler"
    // (erro visto em produção). Em ambiente sem handler nenhum (emulação mobile
    // do DevTools, desktop com UA falso, WebView restrita) nem o clique lança.
    try {
        const a = document.createElement('a');
        a.href = chromeIntentUrl();
        a.rel  = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch { if (typeof onFalha === 'function') onFalha(); return; }
    if (typeof onFalha !== 'function') return;
    // Intent lançado de verdade → esta aba perde a visibilidade (o Chrome ou o
    // seletor de apps assume a tela). Se seguimos visíveis, não há handler aqui
    // → plano B do chamador. (1.4s ainda cabe na janela de gesto de ~5s.)
    setTimeout(() => { if (document.visibilityState === 'visible') onFalha(); }, 1400);
}

// ── Instalação (chamar SEMPRE a partir de um gesto do usuário) ────────────────

/** @returns {Promise<'accepted'|'dismissed'|'installed'|'standalone'|'unavailable'>} */
export async function instalar() {
    if (isStandalone()) {
        UI.addAssistantMessage('Você já está no modo app. Pra instalar o **Chat Assistente** como app separado, abra **' + location.host + '/assistente** pelo navegador e toque em **Baixar** {{fa-download}}.');
        return 'standalone';
    }

    // 1) Prompt nativo já na mão → um toque e pronto.
    let p = promptAtual();

    // 2) Sem prompt E já instalado: o navegador nunca vai disparar o evento —
    //    avisa em vez de esperar à toa. (Se desinstalou, o flag é limpo e o
    //    próximo toque segue o fluxo normal.)
    if (!p && await jaInstalado()) {
        UI.addAssistantMessage('O **Chat Assistente** já está instalado neste aparelho. {{fa-circle-check}} Procure o ícone **Assistente** na tela inicial. Se você tiver desinstalado, toque em **Baixar** de novo que eu preparo outra instalação.');
        limparFlag();
        return 'installed';
    }

    // 3) Navegador compatível mas o evento ainda não chegou: espera curta.
    if (!p && NAV.bip) {
        UI.addAssistantMessage('Preparando a instalação… {{fa-download}}');
        p = await esperarPrompt();
    }

    if (p) {
        try {
            p.prompt();
            const escolha = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
            window.__pwaInstallPrompt = null;
            if (escolha?.outcome === 'accepted') {
                UI.addAssistantMessage('Instalando o Chat Assistente… {{fa-circle-check}} Em instantes o ícone aparece na sua tela inicial!');
                return 'accepted';
            }
            // Dispensou o instalador: o Chrome segura o prompt por um tempo —
            // ser honesto evita um botão que "não funciona" na próxima vez.
            UI.addAssistantMessage('Sem problema! Se mudar de ideia, dá pra instalar a qualquer momento pelo menu do navegador (⋮ → **“Instalar app”**).');
            return 'dismissed';
        } catch { /* prompt consumido/expirado → orientação abaixo */ }
    }

    orientarSemPrompt();
    return 'unavailable';
}

// Sem prompt nativo: melhor caminho REAL por plataforma, com CTA de 1 toque
// no Android (intent:// pro Chrome) em vez de instruções de menu.
function orientarSemPrompt() {
    if (NAV.os === 'ios') {
        UI.addAssistantMessage('No iPhone/iPad a instalação é pelo sistema: toque em **Compartilhar** {{fa-arrow-up-from-bracket}} e depois em **“Adicionar à Tela de Início”**. Se a opção não aparecer, abra esta página no **Safari**. O resultado é o mesmo: o Assistente vira app na sua tela. {{fa-circle-check}}');
        return;
    }
    if (NAV.os === 'android') {
        const texto = NAV.bip
            ? 'O navegador segurou o instalador desta vez — acontece quando a instalação foi dispensada há pouco, ou quando a página abre numa **aba interna** de outro app. Toque abaixo pra abrir no **Chrome** e instalar com um toque — ou use o menu (⋮) → **“Instalar app”**.'
            : 'O **' + NAV.rotulo + '** não deixa o site instalar o app com um toque (limitação do navegador). Toque abaixo pra abrir no **Chrome**, onde a instalação é direta — ou procure **“Instalar”** / **“Adicionar à tela inicial”** no menu do ' + NAV.rotulo + '.';
        UI.addAssistantMessage(texto, { cta: { label: 'Abrir no Chrome e instalar', icon: 'fa-download', onClick: () => abrirNoChrome(_intentFalhou) } });
        return;
    }
    // Desktop sem prompt
    if (NAV.nome === 'opera') {
        UI.addAssistantMessage('No **Opera** de computador a instalação é pelo navegador: clique no ícone de **instalar na barra de endereço** (à direita) ou no **menu do Opera → “Instalar Assistente GranaEvo…”**. Pra instalar com 1 clique pelo botão, use **Chrome** ou **Edge**.');
        return;
    }
    if (NAV.nome === 'firefox') {
        UI.addAssistantMessage('O **Firefox** de computador não instala apps da web por padrão. Abra esta página no **Chrome** ou **Edge** e toque em **Baixar** — lá instala com 1 clique.');
        return;
    }
    UI.addAssistantMessage('Procure o ícone de **instalar** na barra de endereço, ou abra o menu (⋮) → **“Instalar app”**. Se não aparecer, recarregue a página (F5) e toque em **Baixar** de novo.');
}

// O intent:// não lançou (sem handler neste ambiente — ex.: emulação mobile do
// DevTools, WebView restrita): dá o caminho manual que SEMPRE existe.
function _intentFalhou() {
    UI.addAssistantMessage('Não consegui abrir o Chrome automaticamente por aqui (este ambiente bloqueia o atalho). Caminho garantido: menu do navegador (⋮ ou ☰) → **“Instalar app”** / **“Adicionar à tela inicial”**. No computador, o ícone de **instalar** fica na barra de endereço.');
}

// ── Fiação da página (/assistente): botão do header + deep-link + debug ───────

export function wireInstall() {
    const standalone = isStandalone();
    const btn = document.getElementById('geInstall');

    if (btn && !standalone) {
        btn.hidden = false;
        btn.addEventListener('click', () => { instalar(); });
        document.addEventListener('ge:pwa-installed', () => {
            btn.hidden = true;
            UI.addAssistantMessage('Pronto! **Chat Assistente** instalado. {{fa-circle-check}} Abra pelo ícone na tela inicial — direto no lançamento, sem navegador.');
        });
        // Prompt chegou depois do load → convite visual ao toque.
        document.addEventListener('ge:pwa-ready', () => { btn.classList.add('ge-pulse'); }, { once: true });
    }

    let params;
    try { params = new URLSearchParams(location.search); } catch { return; }

    // Diagnóstico on-device: /assistente?pwadebug=1
    if (params.get('pwadebug') === '1') diagnostico();

    // Deep-link das Configurações (/assistente?install=1): UM CTA claro no chat.
    // O toque no CTA é o gesto que o Chrome exige pra abrir o instalador —
    // por isso não dá pra auto-instalar sem clique.
    if (params.get('install') === '1' && !standalone) {
        if (btn) btn.classList.add('ge-pulse');
        UI.addAssistantMessage('Vamos instalar o **Chat Assistente** como app próprio — abre em 1 toque, direto pra lançar o gasto. {{fa-download}}', {
            cta: { label: 'Instalar agora', icon: 'fa-download', onClick: () => { instalar(); } },
        });
        history.replaceState(null, '', INSTALL_PATH);
    }
}

// ── Diagnóstico (?pwadebug=1): por que o prompt (não) veio NESTE aparelho ─────

async function diagnostico() {
    const d = window.__pwaDiag || {};
    const linhas = ['🔧 **Diagnóstico de instalação (este aparelho)**'];
    linhas.push('Navegador: ' + NAV.rotulo + ' · ' + NAV.os + ' · prompt nativo: ' + (NAV.bip ? 'suportado' : 'NÃO suportado'));
    linhas.push('Modo atual: ' + (isStandalone() ? 'app instalado (standalone)' : 'navegador'));
    const mf = document.querySelector('link[rel="manifest"]');
    linhas.push('Manifesto: ' + (mf ? mf.getAttribute('href') : 'AUSENTE ⚠'));
    try {
        const reg = await navigator.serviceWorker?.getRegistration(INSTALL_PATH);
        linhas.push('Service worker: ' + (reg
            ? (reg.active ? 'ativo' : 'registrando…') + ' (escopo ' + reg.scope + ')'
            : (d.swErr ? 'ERRO: ' + d.swErr : 'não registrado ⚠')));
    } catch { linhas.push('Service worker: indisponível'); }
    if (window.__pwaPromptFired) {
        linhas.push('beforeinstallprompt: capturado' + (d.bipAt && d.t0 ? ' em ' + (d.bipAt - d.t0) + 'ms' : '') + ' ✔');
    } else {
        linhas.push('beforeinstallprompt: não disparou' + (NAV.bip
            ? ' (causas comuns: já instalado, instalação dispensada há pouco, aba interna/Custom Tab)'
            : ' (este navegador não emite o evento)'));
    }
    let ira = 'API indisponível neste navegador';
    try {
        if (navigator.getInstalledRelatedApps) {
            const apps = await navigator.getInstalledRelatedApps();
            ira = apps.length ? 'JÁ INSTALADO (' + apps.map((a) => a.platform).join(', ') + ')' : 'não consta como instalado';
        }
    } catch { ira = 'erro ao consultar'; }
    linhas.push('getInstalledRelatedApps: ' + ira);
    linhas.push('Flag local de instalação: ' + (flagInstalado() ? 'presente' : 'ausente'));
    UI.addAssistantMessage(linhas.join('\n'));
}
