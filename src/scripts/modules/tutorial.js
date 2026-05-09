/**
 * tutorial.js — Sistema de Tutorial Interativo do GranaEvo
 */

// ── Ícone helper ──────────────────────────────────────────────────────────────
const ic = (cls) => `<i class="fas ${cls}"></i>`;

// ── Passos do tutorial ─────────────────────────────────────────────────────────
// seletor   : um único seletor CSS
// seletores : array de seletores — spotlight cobre o rect unido de todos
// pos       : 'centro' | 'baixo' | 'cima' | 'direita' | 'esquerda'

const PASSOS = [
  {
    pagina: null,
    seletor: null,
    titulo: `${ic('fa-star')} Bem-vindo ao GranaEvo!`,
    texto: 'Que bom ter você aqui! Em menos de 2 minutos vou te mostrar tudo que o <strong>GranaEvo</strong> tem para transformar a sua vida financeira.',
    pos: 'centro',
  },
  {
    // No mobile o card de Saldo fica oculto e aparece no hero — cobre os dois
    pagina: 'dashboard',
    seletores: ['.saldo-hero-mobile', '.cards-grid'],
    titulo: `${ic('fa-chart-line')} Seu Painel Financeiro`,
    texto: 'Aqui está o resumo do mês: <em>Saldo</em>, <em>Entradas</em>, <em>Saídas</em> e <em>Reservas</em>. Uma olhada e você já sabe como estão suas finanças.',
    pos: 'baixo',
  },
  {
    pagina: 'dashboard',
    seletor: '#sectionContasFixas',
    titulo: `${ic('fa-folder-open')} Contas Fixas`,
    texto: 'Cadastre suas contas recorrentes — aluguel, internet, academia, streaming... O GranaEvo <em>alerta sobre vencimentos próximos</em> e você marca como paga com um clique.',
    pos: 'cima',
  },
  {
    pagina: 'transacoes',
    seletor: '.transaction-form',
    titulo: `${ic('fa-credit-card')} Lançar Transações`,
    texto: 'O coração do app. Registre <em>tudo que entra e sai</em>: receitas, gastos, reservas e compras no crédito. Selecione categoria, tipo, descrição e valor.',
    pos: 'baixo',
  },
  {
    pagina: 'transacoes',
    seletor: '#listaMovimentacoes',
    titulo: `${ic('fa-list')} Histórico Completo`,
    texto: 'Suas movimentações ficam aqui, organizadas e filtráveis por período. Toque em qualquer item para <strong>editar ou excluir</strong>.',
    pos: 'cima',
  },
  {
    pagina: 'reservas',
    seletor: '.reservas-sidebar',
    titulo: `${ic('fa-piggy-bank')} Reservas`,
    texto: 'Crie reservas para seus objetivos: viagem, emergência, novo equipamento... Acompanhe o progresso em <em>gráficos em tempo real</em>.',
    pos: 'direita',
  },
  {
    pagina: 'cartoes',
    seletor: null,
    titulo: `${ic('fa-gem')} Cartões de Crédito`,
    texto: 'Gerencie seus cartões, visualize as <strong>faturas detalhadas</strong> com cada compra, acompanhe parcelas e nunca mais seja pego de surpresa.',
    pos: 'centro',
  },
  {
    pagina: 'graficos',
    seletor: '.graficos-filtros',
    titulo: `${ic('fa-chart-bar')} Análise Visual`,
    texto: 'Transforme números em <em>gráficos inteligentes</em>. Veja distribuição dos gastos, evolução mensal e compare períodos. Clique em "Gerar Gráficos" para explorar.',
    pos: 'baixo',
  },
  {
    pagina: 'relatorios',
    seletor: '.rel-filtros',
    titulo: `${ic('fa-file-alt')} Relatórios Detalhados`,
    texto: 'Gere relatórios completos com análise por categoria. Perfeito para entender <strong>onde foi seu dinheiro</strong> e planejar o próximo mês.',
    pos: 'baixo',
  },
  {
    pagina: 'configuracoes',
    seletor: '.cfg-body',
    titulo: `${ic('fa-cog')} Personalize Tudo`,
    texto: 'Aqui você altera <strong>nome e senha</strong>, convida familiares, gerencia sua assinatura e pode reiniciar esse tutorial quando quiser.',
    pos: 'cima',
  },
  {
    pagina: null,
    seletor: null,
    titulo: `${ic('fa-check-circle')} Tudo pronto!`,
    texto: 'Parabéns! Agora você domina o GranaEvo. Comece lançando suas primeiras transações e veja sua vida financeira se transformar.',
    pos: 'centro',
    ultimo: true,
  },
];

// ── Estado ─────────────────────────────────────────────────────────────────────
let _passo     = 0;
let _backdrop  = null;
let _spotlight = null;
let _card      = null;
let _ativo     = false;

// ── API pública ────────────────────────────────────────────────────────────────
export function iniciarTutorial() {
  if (_ativo) return;
  _ativo = true;
  _passo = 0;
  _montar();
  _ir(0);
}

// ── Montagem / desmontagem ─────────────────────────────────────────────────────
function _montar() {
  _backdrop  = _criarEl('div', 'tut-backdrop');
  _spotlight = _criarEl('div', 'tut-spotlight tut-spot-oculto');
  _card      = _criarEl('div', 'tut-card');
  document.body.append(_backdrop, _spotlight, _card);

  // Bloqueia scroll/swipe do usuário enquanto o tutorial está ativo
  _backdrop.addEventListener('touchstart', _pararEvento, { passive: false });
  _backdrop.addEventListener('touchmove',  _pararEvento, { passive: false });
  document.addEventListener('wheel', _pararRoda, { passive: false });
}

function _desmontar() {
  if (!_card) return;
  _card.classList.add('tut-saindo');

  if (_backdrop) {
    _backdrop.removeEventListener('touchstart', _pararEvento);
    _backdrop.removeEventListener('touchmove',  _pararEvento);
  }
  document.removeEventListener('wheel', _pararRoda);

  setTimeout(() => {
    _backdrop?.remove();
    _spotlight?.remove();
    _card?.remove();
    _backdrop = _spotlight = _card = null;
    _ativo = false;
  }, 230);
}

function _pararEvento(e) { e.preventDefault(); }
function _pararRoda(e)   { if (!e.target.closest('.tut-card')) e.preventDefault(); }

// ── Navegação entre passos ─────────────────────────────────────────────────────
async function _ir(idx) {
  if (!_ativo) return;
  const p = PASSOS[idx];
  _passo = idx;

  // Navegar para a página se necessário
  const paginaAtual = document.querySelector('.page.active')?.id?.replace('Page', '');
  if (p.pagina && paginaAtual !== p.pagina) {
    _navegarPara(p.pagina);
    await _esperar(320);
  }

  // Resolver elemento representativo e rect do spotlight
  let alvo   = null;
  let spRect = null;

  if (p.seletores) {
    spRect = _unionRect(p.seletores);
    alvo   = p.seletores
      .map(s => document.querySelector(s))
      .filter(el => el && el.getBoundingClientRect().height > 0)
      .pop() ?? null;
  } else if (p.seletor) {
    alvo = document.querySelector(p.seletor);
  }

  // Scroll para o elemento e recalcular rect após scroll
  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _esperar(380);
    spRect = p.seletores ? _unionRect(p.seletores) : alvo.getBoundingClientRect();
  }

  // Posicionar spotlight
  if (spRect && spRect.height > 0) {
    _posSpotlight(spRect);
    _spotlight.classList.remove('tut-spot-oculto');
  } else {
    _spotlight.classList.add('tut-spot-oculto');
  }

  // Renderizar e posicionar card
  _renderCard(p, idx);
  await _esperar(12);
  _posCard(spRect, p.pos);
}

// ── Spotlight ──────────────────────────────────────────────────────────────────
function _posSpotlight(rect) {
  const pad = 10;
  Object.assign(_spotlight.style, {
    top:          rect.top    - pad + 'px',
    left:         rect.left   - pad + 'px',
    width:        rect.width  + pad * 2 + 'px',
    height:       rect.height + pad * 2 + 'px',
    borderRadius: '12px',
  });
}

// Calcula o rect que envolve todos os elementos visiveis dos seletores
function _unionRect(selectors) {
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  let any = false;
  selectors.forEach(s => {
    const el = document.querySelector(s);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.height === 0) return;
    any    = true;
    top    = Math.min(top,    r.top);
    left   = Math.min(left,   r.left);
    bottom = Math.max(bottom, r.bottom);
    right  = Math.max(right,  r.right);
  });
  return any ? { top, left, bottom, right, width: right - left, height: bottom - top } : null;
}

// ── Card ───────────────────────────────────────────────────────────────────────
function _renderCard(p, idx) {
  const total   = PASSOS.length;
  const primeiro = idx === 0;
  const ultimo   = idx === total - 1 || p.ultimo;

  const dots = PASSOS.map((_, i) => {
    const cls = i < idx ? 'tut-dot tut-done' : i === idx ? 'tut-dot tut-ativo' : 'tut-dot';
    return `<span class="${cls}"></span>`;
  }).join('');

  _card.innerHTML = `
    <div class="tut-top">
      <span class="tut-badge">Passo ${idx + 1} de ${total}</span>
      <div class="tut-dots">${dots}</div>
    </div>
    <h3 class="tut-titulo">${p.titulo}</h3>
    <p class="tut-texto">${p.texto}</p>
    <div class="tut-acoes">
      <button class="tut-pular-tudo" type="button">Pular tutorial</button>
      <div class="tut-nav">
        <button class="tut-voltar" type="button" ${primeiro ? 'disabled' : ''}>Voltar</button>
        <button class="tut-avancar" type="button">${ultimo ? 'Concluir' : 'Prosseguir'}</button>
      </div>
    </div>
  `;

  _card.querySelector('.tut-pular-tudo').onclick = _desmontar;
  _card.querySelector('.tut-voltar').onclick     = () => { if (!primeiro) _ir(_passo - 1); };
  _card.querySelector('.tut-avancar').onclick    = () => { ultimo ? _desmontar() : _ir(_passo + 1); };
}

function _posCard(spRect, pos) {
  _card.className = 'tut-card';

  const isMobile = window.innerWidth <= 768;
  const GAP      = 12;
  const BOT_NAV  = 72;

  if (isMobile) {
    const vw = window.innerWidth;
    _card.style.position = 'fixed';
    _card.style.left     = GAP + 'px';
    _card.style.right    = GAP + 'px';
    _card.style.width    = (vw - GAP * 2) + 'px';

    // Se o elemento destacado está na metade inferior da tela, card vai pro topo
    const elCenter = spRect ? (spRect.top + spRect.height / 2) : 0;
    if (spRect && elCenter > window.innerHeight * 0.48) {
      _card.style.top    = (GAP + 8) + 'px';
      _card.style.bottom = 'auto';
    } else {
      _card.style.bottom = (BOT_NAV + GAP) + 'px';
      _card.style.top    = 'auto';
    }
    return;
  }

  // ── Desktop ──────────────────────────────────────────────────────────────────
  const CW  = 340;
  const GAP_D = 20;
  const vw  = window.innerWidth;
  const vh  = window.innerHeight;
  const ch  = _card.offsetHeight || 210;

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
    top:   top  + 'px',
    left:  left + 'px',
    width: CW   + 'px',
  });

  if (seta) _card.classList.add(seta);
}

// ── Navegação entre seções ─────────────────────────────────────────────────────
function _navegarPara(pagina) {
  const btn = document.querySelector(`[data-page="${pagina}"]`);
  if (btn) { btn.click(); return; }
  if (pagina === 'configuracoes') document.getElementById('mobileSettingsBtn')?.click();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _criarEl(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function _esperar(ms) {
  return new Promise(r => setTimeout(r, ms));
}
