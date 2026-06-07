/**
 * @module tutorial
 * @description Tutorial interativo do GranaEvo — redesenhado.
 *
 * Uso:
 *   import { iniciarTutorial } from './tutorial.js';
 *   iniciarTutorial();
 *   iniciarTutorial({ plano: 'Casal' });
 *   iniciarTutorial({ isGuest: true });
 */

// ── Passos base ────────────────────────────────────────────────────────────────
const PASSOS_BASE = [
  {
    pagina:   null,
    seletor:  null,
    icon:     'fa-rocket',
    iconColor:'#10b981',
    secao:    null,
    titulo:   'Bem-vindo ao GranaEvo!',
    texto:    'Em poucos passos você vai conhecer <strong>todas as funcionalidades</strong> do app. Vou te guiar por cada seção.',
    pos:      'centro',
  },
  {
    pagina:   'dashboard',
    seletores:['.saldo-hero-mobile', '.cards-grid'],
    icon:     'fa-chart-line',
    iconColor:'#10b981',
    secao:    'Dashboard',
    titulo:   'Painel Financeiro',
    texto:    'Aqui está o resumo do mês: <strong>Saldo disponível</strong>, Entradas, Saídas e Reservas. Uma olhada e você já sabe como estão suas finanças.',
    pos:      'baixo',
  },
  {
    pagina:   'dashboard',
    seletor:  '#sectionContasFixas',
    icon:     'fa-folder-open',
    iconColor:'#f59e0b',
    secao:    'Dashboard',
    titulo:   'Contas Fixas',
    texto:    'Cadastre contas recorrentes — aluguel, internet, streaming... O app <strong>alerta vencimentos próximos</strong> e você marca como paga com um clique.',
    pos:      'cima',
  },
  {
    pagina:   'transacoes',
    seletor:  '.transaction-form',
    icon:     'fa-plus-circle',
    iconColor:'#10b981',
    secao:    'Transações',
    titulo:   'Lançar Transações',
    texto:    'Registre <strong>tudo que entra e sai</strong>: receitas, gastos, reservas e crédito. A categoria é sugerida automaticamente enquanto você digita.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '#listaMovimentacoes',
    icon:     'fa-list-ul',
    iconColor:'#3b82f6',
    secao:    'Transações',
    titulo:   'Histórico Completo',
    texto:    'Todas as movimentações organizadas e filtráveis por período. <strong>Deslize</strong> um item para editar ou excluir rapidamente.',
    pos:      'cima',
  },
  {
    pagina:   'transacoes',
    seletor:  '#orcamentosSection',
    icon:     'fa-wallet',
    iconColor:'#f59e0b',
    secao:    'Transações',
    titulo:   'Orçamentos por Categoria',
    texto:    'Defina limites mensais por gasto. A barra fica <strong style="color:#f59e0b">amarela a 80%</strong> e <strong style="color:#ef4444">vermelha ao estourar</strong>. Você recebe alerta automático.',
    pos:      'baixo',
  },
  {
    pagina:   'reservas',
    seletor:  '.reservas-sidebar',
    icon:     'fa-piggy-bank',
    iconColor:'#a78bfa',
    secao:    'Reservas',
    titulo:   'Metas e Reservas',
    texto:    'Crie reservas para objetivos: viagem, emergência, equipamento... Acompanhe o progresso com <strong>gráficos e simulador de aportes</strong>.',
    pos:      'direita',
  },
  {
    pagina:   'cartoes',
    seletor:  null,
    icon:     'fa-credit-card',
    iconColor:'#ec4899',
    secao:    'Cartões',
    titulo:   'Cartões de Crédito',
    texto:    'Gerencie cartões, visualize <strong>faturas detalhadas</strong> com cada compra, acompanhe parcelas e nunca seja pego de surpresa no fechamento.',
    pos:      'centro',
  },
  {
    pagina:   'graficos',
    seletor:  '.graficos-filtros',
    icon:     'fa-chart-pie',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Análise Visual',
    texto:    'Transforme números em <strong>gráficos inteligentes</strong>. Veja distribuição dos gastos, evolução mensal e compare períodos.',
    pos:      'baixo',
  },
  {
    pagina:   'relatorios',
    seletor:  '.rel-filtros',
    icon:     'fa-file-alt',
    iconColor:'#f97316',
    secao:    'Relatórios',
    titulo:   'Relatórios Completos',
    texto:    'Exporte relatórios em <strong>CSV, Excel ou PDF</strong>. Analise por categoria, período e veja o histórico patrimonial da sua evolução financeira.',
    pos:      'baixo',
  },
];

const PASSOS_CONVIDADOS = [
  {
    pagina:   'configuracoes',
    seletor:  '.cfg-convidados, [data-section="convidados"]',
    icon:     'fa-users',
    iconColor:'#10b981',
    secao:    'Configurações',
    titulo:   'Gerenciar Convidados',
    texto:    'No plano <strong>Casal/Família</strong>, convide membros por email e compartilhe o código de 6 dígitos. Cada um tem seu acesso.',
    pos:      'cima',
  },
];

const PASSOS_GUEST = [
  {
    pagina:   null,
    seletor:  null,
    icon:     'fa-hand-wave',
    iconColor:'#10b981',
    secao:    null,
    titulo:   'Bem-vindo ao GranaEvo!',
    texto:    'Você foi convidado para acessar este GranaEvo. Você pode <strong>visualizar</strong> as finanças e, dependendo das permissões, editar transações.',
    pos:      'centro',
  },
  {
    pagina:   'dashboard',
    seletores:['.saldo-hero-mobile', '.cards-grid'],
    icon:     'fa-chart-line',
    iconColor:'#10b981',
    secao:    'Dashboard',
    titulo:   'Painel Financeiro Compartilhado',
    texto:    'Resumo financeiro da conta que você foi convidado a acessar. Os dados são <strong>atualizados em tempo real</strong>.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '#listaMovimentacoes',
    icon:     'fa-list-ul',
    iconColor:'#3b82f6',
    secao:    'Transações',
    titulo:   'Histórico de Transações',
    texto:    'Visualize todas as movimentações. Dependendo das permissões, você pode <strong>adicionar ou editar</strong> transações.',
    pos:      'cima',
  },
  {
    pagina:   'graficos',
    seletor:  '.graficos-filtros',
    icon:     'fa-chart-pie',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Análise Visual',
    texto:    'Gráficos e análises financeiras da conta. Uma forma visual de entender o <strong>fluxo de dinheiro</strong> em tempo real.',
    pos:      'baixo',
  },
];

const PASSO_FINAL = {
  pagina:   'configuracoes',
  seletor:  '.cfg-body',
  icon:     'fa-sliders-h',
  iconColor:'#6366f1',
  secao:    'Configurações',
  titulo:   'Personalize Tudo',
  texto:    'Altere <strong>nome, senha e tema</strong>, gerencie sua assinatura, ative notificações push e reinicie este tutorial quando quiser.',
  pos:      'cima',
};

const PASSO_CONCLUSAO = {
  pagina:   null,
  seletor:  null,
  icon:     'fa-check-circle',
  iconColor:'#10b981',
  secao:    null,
  titulo:   'Você está pronto!',
  texto:    'Parabéns! Agora você domina o GranaEvo. Comece lançando suas primeiras transações e acompanhe sua evolução financeira.',
  pos:      'centro',
  ultimo:   true,
};

function montarPassos(perfil) {
  const { plano = 'Individual', isGuest = false } = perfil;
  if (isGuest) return [...PASSOS_GUEST, PASSO_FINAL, PASSO_CONCLUSAO];
  const passos = [...PASSOS_BASE];
  if (plano === 'Casal' || plano === 'Família') passos.push(...PASSOS_CONVIDADOS);
  passos.push(PASSO_FINAL, PASSO_CONCLUSAO);
  return passos;
}

// ── Estado ─────────────────────────────────────────────────────────────────────
let _passos    = [];
let _passo     = 0;
let _backdrop  = null;
let _spotlight = null;
let _card      = null;
let _ativo     = false;

// ── API pública ────────────────────────────────────────────────────────────────
export function iniciarTutorial(perfil = {}) {
  if (_ativo) return;
  _ativo  = true;
  _passo  = 0;
  _passos = montarPassos(perfil);
  _montar();
  _ir(0);
}

function _reiniciar(perfil = {}) {
  _desmontar();
  setTimeout(() => iniciarTutorial(perfil), 350);
}

// ── Montagem ───────────────────────────────────────────────────────────────────
function _montar() {
  _backdrop  = _el('div', 'tut-backdrop');
  _spotlight = _el('div', 'tut-spotlight tut-spot-oculto');
  _card      = _el('div', 'tut-card');
  document.body.append(_backdrop, _spotlight, _card);

  _backdrop.addEventListener('touchstart', _blk, { passive: false });
  _backdrop.addEventListener('touchmove',  _blk, { passive: false });
  document.addEventListener('wheel', _blkWheel, { passive: false });
}

function _desmontar() {
  if (!_card) return;
  _card.classList.add('tut-saindo');
  _spotlight?.classList.add('tut-spot-oculto');

  _backdrop?.removeEventListener('touchstart', _blk);
  _backdrop?.removeEventListener('touchmove',  _blk);
  document.removeEventListener('wheel', _blkWheel);

  setTimeout(() => {
    _backdrop?.remove();
    _spotlight?.remove();
    _card?.remove();
    _backdrop = _spotlight = _card = null;
    _ativo = false;
  }, 280);
}

function _blk(e)      { e.preventDefault(); }
function _blkWheel(e) { if (!e.target.closest('.tut-card')) e.preventDefault(); }

// ── Navegação ──────────────────────────────────────────────────────────────────
async function _ir(idx) {
  if (!_ativo) return;
  const p = _passos[idx];
  _passo  = idx;

  const paginaAtual = document.querySelector('.page.active')?.id?.replace('Page', '');
  if (p.pagina && paginaAtual !== p.pagina) {
    _navPara(p.pagina);
    await _wait(360);
  }

  let alvo = null, spRect = null;

  if (p.seletores) {
    spRect = _unionRect(p.seletores);
    alvo = p.seletores.map(s => document.querySelector(s)).filter(el => el?.getBoundingClientRect().height > 0).pop() ?? null;
  } else if (p.seletor) {
    alvo = document.querySelector(p.seletor);
  }

  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _wait(400);
    spRect = p.seletores ? _unionRect(p.seletores) : alvo.getBoundingClientRect();
  }

  if (spRect?.height > 0) {
    _posSpotlight(spRect);
    _spotlight.classList.remove('tut-spot-oculto');
  } else {
    _spotlight.classList.add('tut-spot-oculto');
  }

  _renderCard(p, idx);
  await _wait(16);
  _posCard(spRect, p.pos);
}

// ── Spotlight ──────────────────────────────────────────────────────────────────
function _posSpotlight(rect) {
  const pad = 12;
  Object.assign(_spotlight.style, {
    top:    rect.top    - pad + 'px',
    left:   rect.left   - pad + 'px',
    width:  rect.width  + pad * 2 + 'px',
    height: rect.height + pad * 2 + 'px',
    borderRadius: '16px',
  });
}

function _unionRect(sels) {
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity, any = false;
  sels.forEach(s => {
    const el = document.querySelector(s);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.height === 0) return;
    any = true;
    top = Math.min(top, r.top); left = Math.min(left, r.left);
    bottom = Math.max(bottom, r.bottom); right = Math.max(right, r.right);
  });
  return any ? { top, left, bottom, right, width: right - left, height: bottom - top } : null;
}

// ── Card ───────────────────────────────────────────────────────────────────────
function _renderCard(p, idx) {
  const total   = _passos.length;
  const primeiro = idx === 0;
  const ultimo   = idx === total - 1 || p.ultimo;
  const pct      = Math.round(((idx + 1) / total) * 100);

  _card.innerHTML = '';

  // Header: progresso + seção
  const header = _el('div', 'tut-header');

  const progressWrap = _el('div', 'tut-progress-wrap');
  const progressBar  = _el('div', 'tut-progress-bar');
  progressBar.style.width = pct + '%';
  progressWrap.appendChild(progressBar);

  const headerMeta = _el('div', 'tut-header-meta');
  const badge = _el('span', 'tut-badge');
  badge.setAttribute('aria-label', `Passo ${idx + 1} de ${total}`);
  badge.textContent = `${idx + 1} / ${total}`;

  const secaoEl = _el('span', 'tut-secao');
  if (p.secao) {
    const ic = document.createElement('i');
    ic.className = `fas ${_secaoIcon(p.secao)}`;
    ic.setAttribute('aria-hidden', 'true');
    secaoEl.appendChild(ic);
    secaoEl.appendChild(document.createTextNode(' ' + p.secao));
  }

  headerMeta.appendChild(badge);
  if (p.secao) headerMeta.appendChild(secaoEl);
  header.appendChild(progressWrap);
  header.appendChild(headerMeta);

  // Body: icon + título + texto
  const body = _el('div', 'tut-body');

  const iconWrap = _el('div', 'tut-icon-wrap');
  iconWrap.style.background = (p.iconColor || '#10b981') + '18';
  iconWrap.style.borderColor = (p.iconColor || '#10b981') + '40';
  const iconEl = document.createElement('i');
  iconEl.className = `fas ${p.icon || 'fa-star'}`;
  iconEl.style.color = p.iconColor || '#10b981';
  iconEl.setAttribute('aria-hidden', 'true');
  iconWrap.appendChild(iconEl);

  const titulo = _el('h3', 'tut-titulo');
  titulo.textContent = p.titulo;

  const texto = _el('p', 'tut-texto');
  // p.texto contém apenas HTML estático hardcoded no módulo — safe
  texto.innerHTML = p.texto;

  body.appendChild(iconWrap);
  body.appendChild(titulo);
  body.appendChild(texto);

  // Footer: botões
  const footer = _el('div', 'tut-footer');

  const btnPular = _el('button', 'tut-btn-pular');
  btnPular.type = 'button';
  btnPular.textContent = 'Pular tutorial';
  btnPular.setAttribute('aria-label', 'Pular tutorial');
  btnPular.onclick = _desmontar;

  const nav = _el('div', 'tut-nav');

  const btnVoltar = _el('button', 'tut-btn-voltar');
  btnVoltar.type = 'button';
  btnVoltar.textContent = 'Voltar';
  btnVoltar.setAttribute('aria-label', 'Passo anterior');
  if (primeiro) { btnVoltar.disabled = true; btnVoltar.setAttribute('aria-disabled', 'true'); }
  btnVoltar.onclick = () => { if (!primeiro) _ir(_passo - 1); };

  const btnAvancar = _el('button', 'tut-btn-avancar');
  btnAvancar.type = 'button';
  btnAvancar.setAttribute('aria-label', ultimo ? 'Concluir tutorial' : 'Próximo passo');
  if (ultimo) {
    btnAvancar.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> Concluir';
    btnAvancar.classList.add('tut-btn-avancar--concluir');
  } else {
    btnAvancar.innerHTML = 'Próximo <i class="fas fa-arrow-right" aria-hidden="true"></i>';
  }
  btnAvancar.onclick = () => ultimo ? _desmontar() : _ir(_passo + 1);

  nav.appendChild(btnVoltar);
  nav.appendChild(btnAvancar);
  footer.appendChild(btnPular);
  footer.appendChild(nav);

  _card.appendChild(header);
  _card.appendChild(body);
  _card.appendChild(footer);

  // Keyboard nav
  _card.onkeydown = (e) => {
    if (e.key === 'Escape')                  { _desmontar(); return; }
    if (e.key === 'ArrowRight' && !ultimo)   { _ir(_passo + 1); return; }
    if (e.key === 'ArrowLeft'  && !primeiro) { _ir(_passo - 1); return; }
  };
  _card.setAttribute('tabindex', '0');
  _card.setAttribute('role', 'dialog');
  _card.setAttribute('aria-modal', 'true');
  _card.setAttribute('aria-label', `Tutorial — ${p.titulo}`);
  requestAnimationFrame(() => _card?.focus());
}

function _secaoIcon(secao) {
  const map = {
    'Dashboard':     'fa-house',
    'Transações':    'fa-exchange-alt',
    'Reservas':      'fa-piggy-bank',
    'Cartões':       'fa-credit-card',
    'Gráficos':      'fa-chart-pie',
    'Relatórios':    'fa-file-alt',
    'Configurações': 'fa-cog',
  };
  return map[secao] || 'fa-circle';
}

// ── Posicionamento do card ─────────────────────────────────────────────────────
function _posCard(spRect, pos) {
  _card.className = 'tut-card';

  const isMobile = window.innerWidth <= 768;
  const GAP      = 12;

  if (isMobile) {
    Object.assign(_card.style, {
      position: 'fixed',
      left:     GAP + 'px',
      right:    GAP + 'px',
      width:    (window.innerWidth - GAP * 2) + 'px',
      top:      '',
      bottom:   '',
    });
    const elCenter = spRect ? (spRect.top + spRect.height / 2) : 0;
    if (spRect && elCenter > window.innerHeight * 0.5) {
      _card.style.top    = (GAP + 8) + 'px';
      _card.style.bottom = 'auto';
    } else {
      _card.style.bottom = '84px';
      _card.style.top    = 'auto';
    }
    return;
  }

  const CW   = 360;
  const GAP_D = 24;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ch = _card.offsetHeight || 260;

  let top = 0, left = 0, seta = '';

  if (!spRect || pos === 'centro') {
    top  = (vh - ch) / 2;
    left = (vw - CW) / 2;
  } else {
    const cx = spRect.left + spRect.width / 2;
    switch (pos) {
      case 'baixo':
        top  = spRect.bottom + GAP_D;
        left = cx - CW / 2;
        seta = 'tut-seta-cima';
        break;
      case 'cima':
        top  = spRect.top - ch - GAP_D;
        left = cx - CW / 2;
        seta = 'tut-seta-baixo';
        break;
      case 'direita':
        top  = Math.max(GAP_D, spRect.top);
        left = spRect.right + GAP_D;
        seta = 'tut-seta-esq';
        break;
      default:
        top  = (vh - ch) / 2;
        left = (vw - CW) / 2;
    }
  }

  left = Math.max(GAP_D, Math.min(vw - CW - GAP_D, left));
  top  = Math.max(GAP_D, Math.min(vh - ch - GAP_D, top));

  Object.assign(_card.style, {
    position: 'fixed',
    top:      top  + 'px',
    left:     left + 'px',
    width:    CW   + 'px',
    right:    '',
    bottom:   '',
  });

  if (seta) _card.classList.add(seta);
}

// ── Navegação entre seções ─────────────────────────────────────────────────────
function _navPara(pagina) {
  const btn = document.querySelector(`[data-page="${pagina}"]`);
  if (btn) { btn.click(); return; }
  if (pagina === 'configuracoes') document.getElementById('mobileSettingsBtn')?.click();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _el(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }
