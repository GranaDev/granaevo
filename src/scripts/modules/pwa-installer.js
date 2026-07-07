/**
 * @module pwa-installer
 * @description Gerencia a instalação do GranaEvo como PWA em todos os browsers.
 *
 * Suporte por browser:
 *   Chrome/Edge/Samsung Internet → beforeinstallprompt (instalação nativa 1-clique)
 *   Safari iOS (iPhone/iPad)     → instruções manuais "Compartilhar → Tela de Início"
 *   Firefox                      → instruções manuais (sem suporte nativo a install prompt)
 *   Firefox Android              → instruções via menu "Instalar"
 *   Já instalado (standalone)    → mostra estado "Instalado"
 *
 * @typedef {'chromium'|'safari-ios'|'firefox'|'firefox-android'|'opera'|'unknown'} BrowserType
 * @typedef {'installable'|'installed'|'pending'|'dismissed'} PWAState
 */

/** @type {BeforeInstallPromptEvent|null} */
let _deferredPrompt = null;

/** @type {PWAState} */
let _state = 'pending';

/** @type {BrowserType} */
let _browserType = 'unknown';

/** @type {Function[]} */
const _listeners = [];

// ── Detecção de browser ────────────────────────────────────────────────────────
function _detectBrowser() {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isFirefox = /firefox/i.test(ua);
  const isAndroid = /android/i.test(ua);

  const isOpera = /OPR\/|OPT\/|\bOpera/i.test(ua);

  if (isIOS && isSafari)  return 'safari-ios';
  if (isFirefox && isAndroid) return 'firefox-android';
  if (isFirefox)          return 'firefox';
  // Opera NÃO emite beforeinstallprompt (instala só pela UI do próprio
  // navegador) → tratado à parte pra não esperarmos um prompt que nunca vem.
  if (isOpera)            return 'opera';
  return 'chromium'; // Chrome, Edge, Samsung Internet, Brave, etc.
}

// ── API pública ────────────────────────────────────────────────────────────────

/**
 * Retorna o estado atual da instalação.
 * @returns {PWAState}
 */
export function getPWAInstallState() { return _state; }

/**
 * Registra callback para mudanças de estado.
 * @param {function(PWAState): void} callback
 */
export function onPWAStateChange(callback) { _listeners.push(callback); }

function _setState(s) {
  _state = s;
  _listeners.forEach(cb => { try { cb(s); } catch { /* */ } });
}

/**
 * Inicializa o sistema PWA. Deve ser chamado uma vez no carregamento do módulo.
 * O listener de beforeinstallprompt é registrado ANTES no dashboard.html (inline script)
 * para não perder o evento por causa do lazy-loading deste módulo.
 */
export function initPWA() {
  _browserType = _detectBrowser();

  // Já está instalado como app standalone?
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                       window.navigator.standalone === true;
  if (isStandalone) { _setState('installed'); return; }

  // Escuta o evento de instalação concluída (capturado cedo no HTML)
  document.addEventListener('ge:pwa-installed', () => {
    _deferredPrompt = null;
    _setState('installed');
    _updateInstallButton();
    _notify('GranaEvo instalado como app! 🎉', 'success');
  });

  // Safari iOS / Firefox: sem beforeinstallprompt → instruções manuais
  if (_browserType !== 'chromium') {
    _setState('installable');
    return;
  }

  // Chromium: verifica se o prompt já foi capturado pelo listener antecipado no HTML
  if (window.__pwaInstallPrompt) {
    _deferredPrompt = window.__pwaInstallPrompt;
    _setState('installable');
    return;
  }

  // Ainda não veio → escuta o evento customizado disparado pelo listener do HTML
  document.addEventListener('ge:pwa-ready', () => {
    _deferredPrompt = window.__pwaInstallPrompt;
    _setState('installable');
    _updateInstallButton();
  }, { once: true });

  // Fallback: se após 4s o evento não veio, o Chrome pode já ter exibido
  // o mini-banner automaticamente (ou o usuário já instalou antes).
  // Ainda mostramos o botão com instruções alternativas.
  setTimeout(() => {
    if (_state === 'pending') {
      _setState('installable');
      _updateInstallButton();
    }
  }, 4000);
}

// Espera curta pelo beforeinstallprompt tardio. Na 1ª visita o Chromium libera
// o evento alguns segundos depois do load; sem esta espera, um clique cedo no
// botão caía direto nas instruções manuais mesmo em navegador compatível.
// Fica dentro da janela de ativação de gesto do Chrome (~5s).
function _esperarPrompt(ms = 3500) {
  if (_deferredPrompt) return Promise.resolve(_deferredPrompt);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      document.removeEventListener('ge:pwa-ready', onReady);
      clearTimeout(timer);
      resolve(_deferredPrompt);
    };
    const onReady = () => { _deferredPrompt = window.__pwaInstallPrompt || _deferredPrompt; finish(); };
    document.addEventListener('ge:pwa-ready', onReady);
    const timer = setTimeout(finish, ms);
  });
}

/**
 * Aciona o prompt nativo de instalação (Chrome/Edge/Samsung Internet).
 * Para outros browsers, abre modal com instruções manuais.
 * @returns {Promise<'accepted'|'dismissed'|'manual'>}
 */
export async function promptInstall() {
  // Chromium: usa o prompt já capturado; se ainda não chegou, espera um pouco
  // (dentro da janela de gesto) antes de desistir. Opera/Firefox/Safari não
  // emitem o evento → vão direto às instruções, sem espera inútil.
  let p = _deferredPrompt;
  if (!p && _browserType === 'chromium') p = await _esperarPrompt();

  if (p) {
    try {
      p.prompt();
      const { outcome } = await p.userChoice;
      _deferredPrompt = null;
      window.__pwaInstallPrompt = null;
      if (outcome === 'accepted') {
        _setState('installed');
        return 'accepted';
      }
      _setState('dismissed');
      return 'dismissed';
    } catch {
      // Prompt consumido/expirado — cai para instruções manuais
    }
  }

  // Para todos os outros casos: instruções manuais por browser
  _showManualInstructions();
  return 'manual';
}

// ── Instruções manuais por browser ────────────────────────────────────────────

function _showManualInstructions() {
  const existing = document.getElementById('pwaInstructionsModal');
  if (existing) { existing.style.display = 'flex'; return; }

  const instructions = _getInstructions();
  const modal = document.createElement('div');
  modal.id = 'pwaInstructionsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Como instalar o GranaEvo');

  modal.innerHTML = `
    <div class="pwa-modal-overlay"></div>
    <div class="pwa-modal-card">
      <div class="pwa-modal-header">
        <img src="/assets/icons/granaevo-logo.jpg" alt="GranaEvo" class="pwa-modal-logo">
        <h3 class="pwa-modal-title">Instalar GranaEvo</h3>
        <button class="pwa-modal-close" aria-label="Fechar" type="button">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <p class="pwa-modal-subtitle">${instructions.subtitle}</p>
      <ol class="pwa-modal-steps">
        ${instructions.steps.map(s => `<li>${s}</li>`).join('')}
      </ol>
      <div class="pwa-modal-note">
        <i class="fas fa-info-circle"></i> ${instructions.note}
      </div>
      <button class="pwa-modal-btn" type="button" id="pwaModalDismiss">Entendido</button>
    </div>
  `;

  // Estilos inline do modal (sem depender de CSS externo para funcionar em qualquer estado)
  const style = document.createElement('style');
  style.textContent = `
    #pwaInstructionsModal {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
    }
    .pwa-modal-overlay {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
    }
    .pwa-modal-card {
      position: relative; background: #13141f;
      border: 1px solid rgba(16,185,129,0.2); border-radius: 20px;
      padding: 28px 24px; max-width: 400px; width: 100%;
      box-shadow: 0 24px 48px rgba(0,0,0,0.5);
    }
    .pwa-modal-header {
      display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
    }
    .pwa-modal-logo {
      width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
    }
    .pwa-modal-title {
      flex: 1; font-size: 1.1rem; font-weight: 700; color: #fff; margin: 0;
    }
    .pwa-modal-close {
      background: none; border: none; color: #6b7280;
      font-size: 1rem; cursor: pointer; padding: 4px 8px;
    }
    .pwa-modal-subtitle {
      color: #9ca3af; font-size: 0.875rem; margin-bottom: 16px; line-height: 1.5;
    }
    .pwa-modal-steps {
      padding-left: 20px; margin: 0 0 16px 0; color: #d1d5db;
      font-size: 0.9rem; line-height: 1.8;
    }
    .pwa-modal-steps li { margin-bottom: 4px; }
    .pwa-modal-note {
      background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.2);
      border-radius: 10px; padding: 10px 14px; font-size: 0.8rem;
      color: #6ee7b7; margin-bottom: 20px;
      display: flex; gap: 8px; align-items: flex-start; line-height: 1.5;
    }
    .pwa-modal-btn {
      width: 100%; background: linear-gradient(135deg,#10b981,#059669);
      color: #fff; border: none; border-radius: 12px; padding: 14px;
      font-weight: 700; font-size: 0.95rem; cursor: pointer;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(modal);

  const close = () => { modal.style.display = 'none'; };
  modal.querySelector('.pwa-modal-close').onclick  = close;
  modal.querySelector('#pwaModalDismiss').onclick   = close;
  modal.querySelector('.pwa-modal-overlay').onclick = close;
}

function _getInstructions() {
  switch (_browserType) {
    case 'safari-ios':
      return {
        subtitle: 'No Safari do iPhone/iPad, siga os passos abaixo:',
        steps: [
          'Toque no botão <strong>Compartilhar</strong> <span style="color:#10b981">⎙</span> (na barra inferior)',
          'Role para baixo e toque em <strong>"Adicionar à Tela de Início"</strong>',
          'Toque em <strong>"Adicionar"</strong> no canto superior direito',
        ],
        note: 'O GranaEvo aparecerá como um app na sua tela inicial, sem a barra do Safari.',
      };
    case 'firefox':
      return {
        subtitle: 'No Firefox desktop, siga os passos abaixo:',
        steps: [
          'Clique no ícone de <strong>três linhas</strong> ☰ no canto superior direito',
          'Clique em <strong>"Instalar Site como App..."</strong>',
          'Confirme clicando em <strong>"Instalar"</strong>',
        ],
        note: 'Se a opção não aparecer, o Firefox pode não suportar instalação neste sistema. Tente usar o Chrome ou Edge.',
      };
    case 'firefox-android':
      return {
        subtitle: 'No Firefox Android, siga os passos:',
        steps: [
          'Toque no ícone de <strong>três pontos</strong> ⋮ (menu)',
          'Toque em <strong>"Instalar"</strong> ou <strong>"Adicionar à tela inicial"</strong>',
        ],
        note: 'O app será adicionado à tela inicial do Android.',
      };
    case 'opera':
      return {
        subtitle: 'No Opera, a instalação é pelo próprio navegador:',
        steps: [
          'Clique no ícone de <strong>instalar</strong> na barra de endereço (à direita)',
          'Ou abra o <strong>menu do Opera</strong> e procure <strong>"Instalar GranaEvo…"</strong>',
          'Confirme a instalação',
        ],
        note: 'Pra instalar com 1 clique pelo botão, use Chrome ou Edge — o Opera não permite que o site abra o instalador sozinho.',
      };
    default: // chromium sem prompt capturado ainda
      return {
        subtitle: 'Para instalar no seu navegador:',
        steps: [
          'Procure o ícone de <strong>instalação</strong> na barra de endereço',
          'Ou clique no menu ⋮ e procure <strong>"Instalar GranaEvo"</strong>',
          'Confirme a instalação',
        ],
        note: 'O GranaEvo funcionará como um app nativo, sem a interface do navegador.',
      };
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

/**
 * Inicializa o botão de instalação PWA na página de configurações.
 */
export function initInstallButton() {
  const btn = document.getElementById('btnInstalarApp');
  if (!btn) return;

  _updateInstallButton();
  onPWAStateChange(() => _updateInstallButton());

  btn.addEventListener('click', async () => {
    if (_state === 'installed') return;
    btn.disabled = true;
    const icon = btn.querySelector('.cfg-item-icon i');
    if (icon) { icon.className = 'fas fa-spinner fa-spin'; }

    const result = await promptInstall();

    if (result === 'accepted') {
      if (icon) { icon.className = 'fas fa-check-circle'; }
      btn.classList.add('cfg-item--installed');
    } else {
      btn.disabled = false;
      if (icon) { icon.className = 'fas fa-download'; }
    }
  });
}

/**
 * Controla quando mostrar o prompt de instalação PWA.
 * Lógica de engajamento progressivo:
 *   - 1ª visita: aguarda 60s de uso antes de exibir banner
 *   - 2ª visita: exibe após 10s
 *   - 3ª+ visita: não interrompe (usuário já decidiu não instalar)
 */
export function shouldShowInstallPrompt() {
  if (_state === 'installed' || _state === 'pending') return false;
  const visits    = parseInt(sessionStorage.getItem('ge:pwa_visits') ?? '0', 10);
  const newVisits = visits + 1;
  sessionStorage.setItem('ge:pwa_visits', String(newVisits));

  if (newVisits === 1) {
    // Primeira visita: mostrar prompt após 60s de engajamento
    setTimeout(() => _showBannerIfNotInstalled(), 60_000);
    return false;
  }
  if (newVisits === 2) {
    // Segunda visita: mostrar após 10s
    setTimeout(() => _showBannerIfNotInstalled(), 10_000);
    return false;
  }
  // Terceira+ visita: não interromper
  return false;
}

function _showBannerIfNotInstalled() {
  if (_state === 'installed') return;
  // Dispara evento customizado para o dashboard mostrar um banner suave
  document.dispatchEvent(new CustomEvent('ge:pwa-show-banner'));
}

function _updateInstallButton() {
  const btn = document.getElementById('btnInstalarApp');
  if (!btn) return;

  const subtitle = btn.querySelector('.cfg-item-sub');
  const icon     = btn.querySelector('.cfg-item-icon i');

  switch (_state) {
    case 'installable':
      btn.removeAttribute('disabled');
      btn.classList.remove('cfg-item--installed');
      if (icon) icon.className = 'fas fa-download';
      if (subtitle) {
        const labels = {
          'safari-ios':       'Siga as instruções para Safari iOS',
          'firefox':          'Veja como instalar no Firefox',
          'firefox-android':  'Instale via menu do Firefox Android',
          'opera':            'Veja como instalar no Opera',
          'chromium':         'Adicione o GranaEvo à tela inicial',
          'unknown':          'Instale como aplicativo',
        };
        subtitle.textContent = labels[_browserType] ?? 'Instale como aplicativo';
      }
      break;

    case 'installed':
      btn.setAttribute('disabled', 'true');
      btn.classList.add('cfg-item--installed');
      if (icon)     icon.className = 'fas fa-check-circle';
      if (subtitle) subtitle.textContent = '✅ GranaEvo já está instalado como app';
      break;

    case 'pending':
    default:
      btn.setAttribute('disabled', 'true');
      if (icon)     icon.className = 'fas fa-spinner fa-spin';
      if (subtitle) subtitle.textContent = 'Verificando suporte do navegador...';
      // Após 2s sem evento, provavelmente é chromium sem suporte — mostra fallback
      setTimeout(() => {
        if (_state === 'pending') {
          _setState('installable');
          _updateInstallButton();
        }
      }, 2000);
      break;
  }
}

function _notify(msg, type = 'success') {
  if (typeof window.mostrarNotificacao === 'function') {
    window.mostrarNotificacao(msg, type);
  }
}
