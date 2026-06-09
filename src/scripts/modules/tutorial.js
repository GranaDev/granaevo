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
  // ── 1 · Boas-vindas ────────────────────────────────────────────
  {
    pagina:   null,
    seletor:  null,
    icon:     'fa-rocket',
    iconColor:'#10b981',
    secao:    null,
    titulo:   'Bem-vindo ao GranaEvo!',
    texto:    'Você está a poucos minutos de dominar o app. Vou te mostrar cada recurso — do controle básico às <strong>análises avançadas</strong> que vão mudar sua relação com o dinheiro.',
    pos:      'centro',
  },

  // ── 2 · Dashboard — visão geral ────────────────────────────────
  {
    pagina:   'dashboard',
    seletores:['.saldo-hero-mobile', '.cards-grid'],
    icon:     'fa-chart-line',
    iconColor:'#10b981',
    secao:    'Dashboard',
    titulo:   'Painel Financeiro',
    texto:    'Resumo completo do mês: <strong>Saldo disponível</strong>, Entradas, Saídas e Reservas. Toque no <em>seletor de período</em> no topo para analisar qualquer mês passado.',
    pos:      'baixo',
  },

  // ── 3 · Dashboard — Alertas inteligentes (NOVO) ────────────────
  {
    pagina:   'dashboard',
    seletor:  '.alertas-vencimento',
    icon:     'fa-bell',
    iconColor:'#ef4444',
    secao:    'Dashboard',
    titulo:   'Alertas de Vencimento',
    texto:    'O app detecta automaticamente contas <strong>vencidas</strong>, vencendo hoje, em 3 dias e nos próximos 7 dias. Nunca mais pague multa por esquecer — visualize, pague e marque como concluído.',
    pos:      'cima',
  },

  // ── 4 · Contas Fixas ───────────────────────────────────────────
  {
    pagina:   'dashboard',
    seletor:  '#sectionContasFixas',
    icon:     'fa-folder-open',
    iconColor:'#f59e0b',
    secao:    'Dashboard',
    titulo:   'Contas Fixas',
    texto:    'Cadastre contas recorrentes — aluguel, internet, streaming, academia... O app gera <strong>alertas automáticos</strong> de vencimento e você marca como paga com um clique.',
    pos:      'cima',
  },

  // ── 5 · Transações — Formulário ────────────────────────────────
  {
    pagina:   'transacoes',
    seletor:  '.transaction-form',
    icon:     'fa-plus-circle',
    iconColor:'#10b981',
    secao:    'Transações',
    titulo:   'Lançar Transações',
    texto:    'Registre entradas, saídas e reservas. Para compras no crédito, selecione <strong>Saída no Crédito</strong>, escolha o cartão e o número de parcelas — o app divide e rastreia <em>cada parcela automaticamente</em>.',
    pos:      'baixo',
  },

  // ── 6 · Transações — Busca & Filtros (NOVO) ────────────────────
  {
    pagina:    'transacoes',
    seletores: ['#movBuscaInput', '#toggleFiltrosBtn'],
    icon:      'fa-search',
    iconColor: '#8b5cf6',
    secao:     'Transações',
    titulo:    'Busca e Filtros',
    texto:     'Encontre qualquer lançamento pela <strong>busca por descrição</strong>. Use os filtros para ver apenas um período: últimos 15, 30 ou 60 dias — ou selecione um mês específico para análise focada.',
    pos:       'baixo',
  },

  // ── 7 · Transações — Histórico ─────────────────────────────────
  {
    pagina:   'transacoes',
    seletor:  '#listaMovimentacoes',
    icon:     'fa-list-ul',
    iconColor:'#3b82f6',
    secao:    'Transações',
    titulo:   'Histórico Completo',
    texto:    'Todas as movimentações em ordem cronológica. <strong>Toque</strong> em qualquer item para editar descrição, categoria, valor ou excluir. O histórico fica guardado para sempre.',
    pos:      'cima',
  },

  // ── 8 · Orçamentos por Categoria ──────────────────────────────
  {
    pagina:   'transacoes',
    seletor:  '#orcamentosSection',
    icon:     'fa-wallet',
    iconColor:'#f59e0b',
    secao:    'Transações',
    titulo:   'Orçamentos por Categoria',
    texto:    'Defina <strong>limites mensais</strong> por gasto — toque em editar para ajustar o teto. A barra fica <strong style="color:#f59e0b">amarela a 80%</strong> e <strong style="color:#ef4444">vermelha ao estourar</strong>. Você controla quanto quer gastar em cada área.',
    pos:      'baixo',
  },

  // ── 9 · Reservas / Metas ───────────────────────────────────────
  {
    pagina:   'reservas',
    seletor:  '.reservas-sidebar',
    icon:     'fa-piggy-bank',
    iconColor:'#a78bfa',
    secao:    'Reservas',
    titulo:   'Metas e Reservas',
    texto:    'Crie metas com nome e valor-alvo. O <strong>simulador de aportes</strong> calcula quanto depositar por mês para chegar lá — com opção de rendimento <em>CDI</em> ou taxa personalizada. Depósitos recorrentes são criados automaticamente.',
    pos:      'direita',
  },

  // ── 10 · Cartões de Crédito ────────────────────────────────────
  {
    pagina:   'cartoes',
    seletor:  null,
    icon:     'fa-credit-card',
    iconColor:'#ec4899',
    secao:    'Cartões',
    titulo:   'Cartões de Crédito',
    texto:    'Cadastre seus cartões com limite e data de fechamento. Veja <strong>faturas detalhadas</strong> por compra com rastreamento de parcelas. Sabe exatamente quanto do limite está comprometido — e pode <em>congelar</em> um cartão quando não quiser usá-lo.',
    pos:      'centro',
  },

  // ── 11 · Gráficos ──────────────────────────────────────────────
  {
    pagina:   'graficos',
    seletor:  '.graficos-filtros',
    icon:     'fa-chart-pie',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Análise Visual',
    texto:    'Transforme números em <strong>gráficos inteligentes</strong>. Veja distribuição por categoria, evolução mensal do saldo e compare diferentes períodos para entender tendências.',
    pos:      'baixo',
  },

  // ── 12 · Relatórios ────────────────────────────────────────────
  {
    pagina:   'relatorios',
    seletor:  '.rel-filtros',
    icon:     'fa-file-alt',
    iconColor:'#f97316',
    secao:    'Relatórios',
    titulo:   'Relatórios Completos',
    texto:    'Relatórios detalhados de <strong>onde foi seu dinheiro</strong>, evolução patrimonial e histórico financeiro. Exporte em <strong>CSV, Excel, PDF</strong> ou como apresentação animada.',
    pos:      'baixo',
  },

  // ── 13 · Score Financeiro (NOVO) ───────────────────────────────
  {
    pagina:   'relatorios',
    seletor:  null,
    icon:     'fa-trophy',
    iconColor:'#f59e0b',
    secao:    'Relatórios',
    titulo:   'Score Financeiro',
    texto:    'O GranaEvo avalia sua <strong>saúde financeira</strong> e gera uma pontuação baseada em orçamentos cumpridos, reservas, dívidas e fundo de emergência. Receba <em>dicas personalizadas</em> para evoluir todo mês.',
    pos:      'centro',
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
    texto:    'Convide membros por email — cada um recebe <strong>login próprio</strong> e acessa o mesmo painel financeiro. Você define as permissões de cada convidado e pode remover o acesso a qualquer momento.',
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
    texto:    'Você foi convidado para acessar esta conta. Dependendo das permissões concedidas, você pode <strong>visualizar e editar</strong> as finanças do grupo.',
    pos:      'centro',
  },
  {
    pagina:   'dashboard',
    seletores:['.saldo-hero-mobile', '.cards-grid'],
    icon:     'fa-chart-line',
    iconColor:'#10b981',
    secao:    'Dashboard',
    titulo:   'Painel Compartilhado',
    texto:    'Resumo financeiro da conta que você foi convidado a acessar. Dados <strong>atualizados em tempo real</strong> — use o seletor de período para ver qualquer mês.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '.transaction-form',
    icon:     'fa-plus-circle',
    iconColor:'#10b981',
    secao:    'Transações',
    titulo:   'Lançar Transações',
    texto:    'Se você tiver permissão de edição, pode registrar novas entradas e saídas. <strong>Toque em qualquer item</strong> do histórico para editar ou excluir.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '#listaMovimentacoes',
    icon:     'fa-list-ul',
    iconColor:'#3b82f6',
    secao:    'Transações',
    titulo:   'Histórico de Transações',
    texto:    'Veja todas as movimentações do grupo. Use a <strong>busca por descrição</strong> e os filtros de período para encontrar qualquer lançamento rapidamente.',
    pos:      'cima',
  },
  {
    pagina:   'graficos',
    seletor:  '.graficos-filtros',
    icon:     'fa-chart-pie',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Análise Visual',
    texto:    'Gráficos completos da conta compartilhada: distribuição por categoria, evolução mensal e comparativos de período. Uma forma clara de entender o <strong>fluxo financeiro do grupo</strong>.',
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
  texto:    'Ajuste <strong>nome, senha e tema</strong>. Ative <strong>notificações push</strong> para alertas direto no celular. Use o <em>backup automático</em> para proteger seus dados — e reinicie este tutorial quando quiser.',
  pos:      'cima',
};

const PASSO_CONCLUSAO = {
  pagina:   null,
  seletor:  null,
  icon:     'fa-check-circle',
  iconColor:'#10b981',
  secao:    null,
  titulo:   'Tudo pronto para evoluir!',
  texto:    'Você conhece tudo que o GranaEvo oferece. Comece lançando suas primeiras transações e veja como é fácil ter <strong>clareza financeira total</strong> todos os dias.',
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
let _direcao   = 'centro';
let _backdrop  = null;
let _spotlight = null;
let _card      = null;
let _ativo     = false;

// ── API pública ────────────────────────────────────────────────────────────────
export function iniciarTutorial(perfil = {}) {
  if (_ativo) return;
  _ativo    = true;
  _passo    = 0;
  _direcao  = 'centro';
  _passos   = montarPassos(perfil);
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

  _direcao = idx > _passo ? 'avancar' : (idx < _passo ? 'voltar' : _direcao);

  const p   = _passos[idx];
  _passo    = idx;

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

  const iconColor = p.iconColor || '#10b981';

  if (spRect?.height > 0) {
    _spotlight.style.setProperty('--tut-color',    iconColor);
    _spotlight.style.setProperty('--tut-color-20', _hexToRgba(iconColor, 0.20));
    _spotlight.style.setProperty('--tut-color-25', _hexToRgba(iconColor, 0.25));
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
  const total    = _passos.length;
  const primeiro = idx === 0;
  const ultimo   = idx === total - 1 || p.ultimo;
  const pct      = Math.round(((idx + 1) / total) * 100);
  const iconColor = p.iconColor || '#10b981';

  _card.innerHTML = '';
  _card.style.setProperty('--tut-color', iconColor);

  // ── Header ─────────────────────────────────────────────────────
  const header = _el('div', 'tut-header');

  const progressWrap = _el('div', 'tut-progress-wrap');
  const progressBar  = _el('div', 'tut-progress-bar');
  progressBar.style.width = pct + '%';
  progressWrap.appendChild(progressBar);

  const headerMeta = _el('div', 'tut-header-meta');

  const secaoEl = _el('span', 'tut-secao');
  if (p.secao) {
    const ic = document.createElement('i');
    ic.className = `fas ${_secaoIcon(p.secao)}`;
    ic.setAttribute('aria-hidden', 'true');
    secaoEl.appendChild(ic);
    secaoEl.appendChild(document.createTextNode(' ' + p.secao));
  }

  const badge = _el('span', 'tut-badge');
  badge.setAttribute('aria-label', `Passo ${idx + 1} de ${total}`);
  badge.textContent = `${idx + 1} / ${total}`;

  headerMeta.appendChild(secaoEl);
  headerMeta.appendChild(badge);
  header.appendChild(progressWrap);
  header.appendChild(headerMeta);

  // Dot navigation
  const dotsWrap = _el('div', 'tut-dots');
  dotsWrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < total; i++) {
    const cls = i === idx ? 'tut-dot tut-dot-ativo' : i < idx ? 'tut-dot tut-dot-feito' : 'tut-dot';
    const dot = _el('span', cls);
    const iCaptured = i;
    dot.addEventListener('click', () => { if (iCaptured !== _passo) _ir(iCaptured); });
    dotsWrap.appendChild(dot);
  }
  header.appendChild(dotsWrap);

  // ── Body ───────────────────────────────────────────────────────
  const body = _el('div', 'tut-body');

  const stepNum = _el('span', 'tut-step-num');
  stepNum.textContent = String(idx + 1).padStart(2, '0');
  stepNum.setAttribute('aria-hidden', 'true');
  body.appendChild(stepNum);

  const iconWrap = _el('div', 'tut-icon-wrap');
  iconWrap.style.background    = iconColor + '18';
  iconWrap.style.borderColor   = iconColor + '40';
  iconWrap.style.boxShadow     = `0 4px 24px ${_hexToRgba(iconColor, 0.28)}`;
  const iconEl = document.createElement('i');
  iconEl.className = `fas ${p.icon || 'fa-star'}`;
  iconEl.style.color = iconColor;
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

  // ── Footer ─────────────────────────────────────────────────────
  const footer = _el('div', 'tut-footer');

  const btnPular = _el('button', 'tut-btn-pular');
  btnPular.type = 'button';
  btnPular.textContent = 'Pular';
  btnPular.setAttribute('aria-label', 'Pular tutorial');
  btnPular.onclick = _desmontar;

  const nav = _el('div', 'tut-nav');

  const btnVoltar = _el('button', 'tut-btn-voltar');
  btnVoltar.type = 'button';
  btnVoltar.innerHTML = '<i class="fas fa-arrow-left" aria-hidden="true"></i>';
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
  // Reset className e força reflow para reiniciar a animação CSS
  _card.className = 'tut-card';
  void _card.offsetHeight;

  const isUltimo  = _passo === _passos.length - 1 || _passos[_passo]?.ultimo;
  const isMobile  = window.innerWidth <= 768;
  const GAP       = 12;
  let baseClass   = `tut-card tut-entr-${_direcao}${isUltimo ? ' tut-final' : ''}`;

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
    _card.className = baseClass;
    return;
  }

  const CW    = 400;
  const GAP_D = 24;
  const vw    = window.innerWidth;
  const vh    = window.innerHeight;
  const ch    = _card.offsetHeight || 290;

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

  _card.className = `${baseClass}${seta ? ' ' + seta : ''}`;
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

function _hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
