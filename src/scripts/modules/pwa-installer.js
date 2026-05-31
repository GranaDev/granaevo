/**
 * @module pwa-installer
 * @description Gerencia a instalação do GranaEvo como PWA (Progressive Web App).
 *
 * Uso:
 *   import { initPWA, getPWAInstallState, promptInstall } from './pwa-installer.js';
 *   initPWA(); // chamar uma vez no dashboard
 *
 * @typedef {'installable'|'installed'|'not_supported'|'dismissed'} PWAState
 */

/** @type {BeforeInstallPromptEvent|null} */
let _deferredPrompt = null;

/** @type {PWAState} */
let _state = 'not_supported';

/** @type {Function[]} Callbacks para mudança de estado */
const _listeners = [];

/**
 * Retorna o estado atual da instalação PWA.
 * @returns {PWAState}
 */
export function getPWAInstallState() {
  return _state;
}

/**
 * Registra callback para mudanças de estado de instalação.
 * @param {function(PWAState): void} callback
 */
export function onPWAStateChange(callback) {
  _listeners.push(callback);
}

function _setState(newState) {
  _state = newState;
  _listeners.forEach(cb => { try { cb(newState); } catch { /* */ } });
}

/**
 * Inicializa o sistema de PWA. Captura o evento beforeinstallprompt.
 * Deve ser chamado uma vez durante a inicialização do dashboard.
 */
export function initPWA() {
  // Verifica se já está instalado (modo standalone)
  if (window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true) {
    _setState('installed');
    return;
  }

  // Verifica suporte a PWA
  if (!('serviceWorker' in navigator)) {
    _setState('not_supported');
    return;
  }

  // Captura o prompt de instalação antes que o browser o processe
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // previne banner automático do browser
    _deferredPrompt = e;
    _setState('installable');
    _updateInstallButton();
  });

  // Detecta instalação concluída
  window.addEventListener('appinstalled', () => {
    _deferredPrompt = null;
    _setState('installed');
    _updateInstallButton();
    _showInstallSuccess();
  });

  // Verifica se o SW está registrado com sucesso
  navigator.serviceWorker.ready.then(() => {
    console.info('[PWA] Service Worker ativo e pronto.');
  }).catch(() => { /* SW não disponível */ });
}

/**
 * Solicita ao usuário que instale o app.
 * @returns {Promise<'accepted'|'dismissed'|'not_available'>}
 */
export async function promptInstall() {
  if (!_deferredPrompt) return 'not_available';

  try {
    _deferredPrompt.prompt();
    const { outcome } = await _deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      _deferredPrompt = null;
      _setState('installed');
      return 'accepted';
    } else {
      _setState('dismissed');
      return 'dismissed';
    }
  } catch {
    return 'not_available';
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _updateInstallButton() {
  const btn = document.getElementById('btnInstalarApp');
  if (!btn) return;

  const subtitle = btn.querySelector('.cfg-item-sub');
  const icon     = btn.querySelector('.cfg-item-icon i');

  switch (_state) {
    case 'installable':
      btn.removeAttribute('disabled');
      btn.classList.remove('cfg-item--installed');
      if (subtitle) subtitle.textContent = 'Instale o GranaEvo como app no seu dispositivo';
      if (icon) icon.className = 'fas fa-download';
      break;

    case 'installed':
      btn.setAttribute('disabled', 'true');
      btn.classList.add('cfg-item--installed');
      if (subtitle) subtitle.textContent = '✅ GranaEvo já está instalado como app';
      if (icon) icon.className = 'fas fa-check-circle';
      break;

    case 'not_supported':
      btn.setAttribute('disabled', 'true');
      if (subtitle) subtitle.textContent = 'Este navegador não suporta instalação de PWA';
      if (icon) icon.className = 'fas fa-ban';
      break;

    case 'dismissed':
      btn.removeAttribute('disabled');
      if (subtitle) subtitle.textContent = 'Toque aqui quando quiser instalar';
      if (icon) icon.className = 'fas fa-mobile-alt';
      break;
  }
}

function _showInstallSuccess() {
  // Toast de sucesso (usa o sistema de toast existente se disponível)
  if (typeof window.showToast === 'function') {
    window.showToast('GranaEvo instalado com sucesso! 🎉', 'success');
  } else {
    console.info('[PWA] App instalado com sucesso!');
  }
}

/**
 * Inicializa o botão de instalação na página de configurações.
 * Deve ser chamado após o DOM da página de configurações estar carregado.
 */
export function initInstallButton() {
  const btn = document.getElementById('btnInstalarApp');
  if (!btn) return;

  _updateInstallButton();

  btn.addEventListener('click', async () => {
    if (_state === 'installed') return;
    const result = await promptInstall();
    if (result === 'dismissed') {
      _updateInstallButton();
    }
  });

  // Escuta mudanças de estado para atualizar o botão
  onPWAStateChange(() => _updateInstallButton());
}
