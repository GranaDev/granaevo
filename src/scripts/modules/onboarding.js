/**
 * @module onboarding
 * @description Experiência de boas-vindas do GranaEvo para novos perfis.
 *
 * Renderiza em camada própria (não usa o #modalOverlay compartilhado), por isso
 * não pode ser substituído por outros popups do app. A persistência de "visto"
 * é responsabilidade do caller, via callback `aoEscolher` — garantindo que o
 * flag só é gravado após interação real do usuário.
 *
 * Segurança:
 *  - Todo conteúdo é estático e hardcoded neste módulo.
 *  - O nome do usuário entra exclusivamente via textContent (nunca innerHTML).
 *  - Nenhuma chamada de rede, nenhum dado sensível tocado.
 *
 * Uso:
 *   import { mostrarBoasVindas } from './onboarding.js';
 *   mostrarBoasVindas({
 *     nome: 'Lucas',
 *     plano: 'Individual',
 *     isGuest: false,
 *     aoEscolher: (escolha) => { ... }   // 'tour' | 'explorar'
 *   });
 */

const FEATURES = [
  { icon: 'fa-exchange-alt',        cor: '#10b981', titulo: 'Transações',            desc: 'Entradas, saídas e parcelas no crédito' },
  { icon: 'fa-sync-alt',            cor: '#8b5cf6', titulo: 'Assinaturas',           desc: 'Cobranças recorrentes 100% automáticas' },
  { icon: 'fa-piggy-bank',          cor: '#a78bfa', titulo: 'Reservas e Metas',      desc: 'Simulador de aportes com rendimento CDI' },
  { icon: 'fa-wallet',              cor: '#f59e0b', titulo: 'Orçamentos',            desc: 'Tetos por categoria com alerta de estouro' },
  { icon: 'fa-bell',                cor: '#ef4444', titulo: 'Alertas Inteligentes',  desc: 'Nunca mais pague multa por esquecimento' },
  { icon: 'fa-chart-pie',           cor: '#06b6d4', titulo: 'Gráficos e Relatórios', desc: 'Análises, score financeiro e exportação' },
];

// ── Estado ─────────────────────────────────────────────────────────────────────
let _root    = null;
let _slide   = 0;
let _opts    = null;
let _ativo   = false;

// ── API pública ────────────────────────────────────────────────────────────────
export function mostrarBoasVindas(opts = {}) {
  if (_ativo) return;
  _ativo = true;
  _slide = 0;
  _opts  = {
    nome:       _limparNome(opts.nome),
    plano:      typeof opts.plano === 'string' ? opts.plano.slice(0, 24) : '',
    isGuest:    Boolean(opts.isGuest),
    aoEscolher: typeof opts.aoEscolher === 'function' ? opts.aoEscolher : () => {},
  };
  _montar();
  _render();
}

// Nome só via textContent; ainda assim, limita tamanho e remove controles
function _limparNome(nome) {
  if (typeof nome !== 'string') return '';
  // Remove caracteres de controle (U+0000–U+001F, U+007F) e <> por defesa em profundidade
  let limpo = '';
  for (const ch of nome) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c !== 127 && ch !== '<' && ch !== '>') limpo += ch;
  }
  return limpo.trim().slice(0, 40);
}

// ── Montagem / desmontagem ─────────────────────────────────────────────────────
function _montar() {
  _root = document.createElement('div');
  _root.className = 'obw-overlay';
  _root.setAttribute('role', 'dialog');
  _root.setAttribute('aria-modal', 'true');
  _root.setAttribute('aria-label', 'Boas-vindas ao GranaEvo');
  document.body.appendChild(_root);
  document.addEventListener('keydown', _teclas, true);
  document.body.classList.add('obw-no-scroll');
}

function _fechar(escolha) {
  if (!_root) return;
  const cb = _opts?.aoEscolher;
  document.removeEventListener('keydown', _teclas, true);
  document.body.classList.remove('obw-no-scroll');
  _root.classList.add('obw-saindo');
  const rootRef = _root;
  _root = null;
  setTimeout(() => {
    rootRef.remove();
    _ativo = false;
    try { cb?.(escolha); } catch { /* callback do caller não pode quebrar o app */ }
  }, 320);
}

function _teclas(e) {
  if (!_ativo) return;
  if (e.key === 'Escape')      { _fechar('explorar'); }
  else if (e.key === 'ArrowRight' && _slide < 2) { _slide++; _render(); }
  else if (e.key === 'ArrowLeft'  && _slide > 0) { _slide--; _render(); }
}

// ── Render ─────────────────────────────────────────────────────────────────────
function _render() {
  if (!_root) return;
  _root.innerHTML = '';

  const card = _el('div', 'obw-card');
  card.setAttribute('tabindex', '-1');

  // Aura decorativa de fundo
  const aura = _el('div', 'obw-aura');
  aura.setAttribute('aria-hidden', 'true');
  card.appendChild(aura);

  // Botão "Agora não" (sempre disponível — dispensa explícita)
  const btnSkip = _el('button', 'obw-skip');
  btnSkip.type = 'button';
  btnSkip.textContent = 'Agora não';
  btnSkip.setAttribute('aria-label', 'Dispensar boas-vindas');
  btnSkip.onclick = () => _fechar('explorar');
  card.appendChild(btnSkip);

  const corpo = _el('div', 'obw-body');
  if (_slide === 0)      _slideHero(corpo);
  else if (_slide === 1) _slideFeatures(corpo);
  else                   _slideEscolha(corpo);
  card.appendChild(corpo);

  // ── Footer: dots + navegação ───────────────────────────────────
  const footer = _el('div', 'obw-footer');

  const dots = _el('div', 'obw-dots');
  for (let i = 0; i < 3; i++) {
    const dot = _el('button', 'obw-dot' + (i === _slide ? ' obw-dot--ativo' : ''));
    dot.type = 'button';
    dot.setAttribute('aria-label', `Ir para tela ${i + 1} de 3`);
    const iCap = i;
    dot.onclick = () => { if (iCap !== _slide) { _slide = iCap; _render(); } };
    dots.appendChild(dot);
  }

  const nav = _el('div', 'obw-nav');

  if (_slide > 0) {
    const btnVoltar = _el('button', 'obw-btn-voltar');
    btnVoltar.type = 'button';
    btnVoltar.innerHTML = '<i class="fas fa-arrow-left" aria-hidden="true"></i>';
    btnVoltar.setAttribute('aria-label', 'Tela anterior');
    btnVoltar.onclick = () => { _slide--; _render(); };
    nav.appendChild(btnVoltar);
  }

  if (_slide < 2) {
    const btnAvancar = _el('button', 'obw-btn-avancar');
    btnAvancar.type = 'button';
    btnAvancar.innerHTML = 'Continuar <i class="fas fa-arrow-right" aria-hidden="true"></i>';
    btnAvancar.onclick = () => { _slide++; _render(); };
    nav.appendChild(btnAvancar);
  }

  footer.appendChild(dots);
  footer.appendChild(nav);
  card.appendChild(footer);

  _root.appendChild(card);
  requestAnimationFrame(() => card.focus?.());
}

// ── Slide 1 · Hero ─────────────────────────────────────────────────────────────
function _slideHero(corpo) {
  corpo.classList.add('obw-body--hero');

  const emblem = _el('div', 'obw-emblem');
  emblem.setAttribute('aria-hidden', 'true');
  emblem.innerHTML =
    '<span class="obw-ring obw-ring--1"></span>' +
    '<span class="obw-ring obw-ring--2"></span>' +
    '<span class="obw-ring obw-ring--3"></span>' +
    '<i class="fas fa-seedling"></i>';
  corpo.appendChild(emblem);

  const h2 = _el('h2', 'obw-titulo');
  // Nome do usuário entra como TEXTO — nunca como HTML
  h2.textContent = _opts.nome ? `Bem-vindo, ${_opts.nome}!` : 'Bem-vindo ao GranaEvo!';
  corpo.appendChild(h2);

  if (_opts.plano && !_opts.isGuest) {
    const chip = _el('span', 'obw-plano-chip');
    const ic = document.createElement('i');
    ic.className = 'fas fa-crown';
    ic.setAttribute('aria-hidden', 'true');
    chip.appendChild(ic);
    chip.appendChild(document.createTextNode(' Plano ' + _opts.plano));
    corpo.appendChild(chip);
  }

  const p = _el('p', 'obw-texto');
  p.textContent = _opts.isGuest
    ? 'Você foi convidado para acompanhar as finanças do grupo. Tudo o que acontece na conta aparece para você em tempo real — e, com permissão de edição, você também participa dos lançamentos.'
    : 'Seu painel financeiro está pronto. A partir de agora, cada real que entra e sai tem um lugar — e você tem clareza total para decidir melhor, todos os dias.';
  corpo.appendChild(p);
}

// ── Slide 2 · Recursos ─────────────────────────────────────────────────────────
function _slideFeatures(corpo) {
  corpo.classList.add('obw-body--features');

  const h2 = _el('h2', 'obw-titulo');
  h2.textContent = 'Tudo o que você pode fazer';
  corpo.appendChild(h2);

  const sub = _el('p', 'obw-texto obw-texto--sub');
  sub.textContent = 'Seis pilares para dominar seu dinheiro:';
  corpo.appendChild(sub);

  const grid = _el('div', 'obw-features');
  FEATURES.forEach((f, i) => {
    const item = _el('div', 'obw-feature');
    item.style.setProperty('--obw-delay', (i * 70) + 'ms');
    item.style.setProperty('--obw-cor', f.cor);

    const icWrap = _el('span', 'obw-feature-icon');
    const ic = document.createElement('i');
    ic.className = `fas ${f.icon}`;
    ic.setAttribute('aria-hidden', 'true');
    icWrap.appendChild(ic);

    const txt = _el('span', 'obw-feature-text');
    const t = _el('strong', 'obw-feature-titulo');
    t.textContent = f.titulo;
    const d = _el('span', 'obw-feature-desc');
    d.textContent = f.desc;
    txt.appendChild(t);
    txt.appendChild(d);

    item.appendChild(icWrap);
    item.appendChild(txt);
    grid.appendChild(item);
  });
  corpo.appendChild(grid);
}

// ── Slide 3 · Escolha ──────────────────────────────────────────────────────────
function _slideEscolha(corpo) {
  corpo.classList.add('obw-body--escolha');

  const h2 = _el('h2', 'obw-titulo');
  h2.textContent = 'Como você quer começar?';
  corpo.appendChild(h2);

  const sub = _el('p', 'obw-texto obw-texto--sub');
  sub.textContent = 'Recomendamos o tour — leva só alguns minutos e mostra tudo na prática.';
  corpo.appendChild(sub);

  const opcoes = _el('div', 'obw-opcoes');

  // Opção 1 — Tour guiado (recomendada)
  const opTour = _el('button', 'obw-opcao obw-opcao--primaria');
  opTour.type = 'button';
  opTour.innerHTML =
    '<span class="obw-opcao-badge">Recomendado</span>' +
    '<span class="obw-opcao-icon"><i class="fas fa-route" aria-hidden="true"></i></span>' +
    '<span class="obw-opcao-titulo">Fazer o tour guiado</span>' +
    '<span class="obw-opcao-desc">Passo a passo por todas as seções do app, com destaques na tela</span>';
  opTour.onclick = () => _fechar('tour');

  // Opção 2 — Explorar sozinho
  const opLivre = _el('button', 'obw-opcao');
  opLivre.type = 'button';
  opLivre.innerHTML =
    '<span class="obw-opcao-icon"><i class="fas fa-compass" aria-hidden="true"></i></span>' +
    '<span class="obw-opcao-titulo">Explorar por conta própria</span>' +
    '<span class="obw-opcao-desc">Você pode reabrir o tour quando quiser em Configurações → Como Usar</span>';
  opLivre.onclick = () => _fechar('explorar');

  opcoes.appendChild(opTour);
  opcoes.appendChild(opLivre);
  corpo.appendChild(opcoes);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _el(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}
