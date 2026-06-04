/**
 * @module tutorial
 * @description Sistema de tutorial interativo do GranaEvo.
 *
 * Uso:
 *   import { iniciarTutorial } from './tutorial.js';
 *   iniciarTutorial();                        // tutorial padrão (Individual)
 *   iniciarTutorial({ plano: 'Casal' });      // tutorial com steps de convidados
 *   iniciarTutorial({ isGuest: true });       // tutorial simplificado para convidados
 *
 * @typedef {'Individual'|'Casal'|'Família'} PlanoNome
 *
 * @typedef {Object} TutorialPerfil
 * @property {PlanoNome} [plano='Individual'] - Plano do usuário
 * @property {boolean}   [isGuest=false]      - Se é conta convidada
 *
 * @typedef {Object} Passo
 * @property {string|null}   pagina    - ID da página interna (ex: 'dashboard')
 * @property {string|null}   [seletor] - Seletor CSS do elemento destacado
 * @property {string[]}      [seletores] - Múltiplos seletores (união do rect)
 * @property {string}        titulo    - Título do passo (HTML permitido via ic())
 * @property {string}        texto     - Texto do passo (HTML)
 * @property {'centro'|'baixo'|'cima'|'direita'|'esquerda'} pos - Posição do card
 * @property {boolean}       [ultimo]  - Marca o último passo
 */

// ── Ícone helper ───────────────────────────────────────────────────────────────
const ic = (cls) => `<i class="fas ${cls}"></i>`;

// ── Passos base (comuns a todos os perfis) ─────────────────────────────────────
const PASSOS_BASE = [
  {
    pagina: null,
    seletor: null,
    titulo: `${ic('fa-star')} Bem-vindo ao GranaEvo!`,
    texto: 'Que bom ter você aqui! Em menos de 2 minutos vou te mostrar tudo que o <strong>GranaEvo</strong> tem para transformar a sua vida financeira.',
    pos: 'centro',
  },
  {
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
    pagina: 'transacoes',
    seletor: '#orcamentosSection',
    titulo: `${ic('fa-wallet')} Orçamentos por Categoria`,
    texto: 'Defina limites mensais para cada tipo de gasto — Mercado, Lazer, Farmácia... A barra fica <em style="color:var(--warning)">amarela</em> a 80% e <em style="color:var(--danger)">vermelha</em> ao estourar. Você recebe alerta automático.',
    pos: 'baixo',
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
];

// ── Passos específicos de planos com convidados ─────────────────────────────────
const PASSOS_CONVIDADOS = [
  {
    pagina: 'configuracoes',
    seletor: '.cfg-convidados, [data-section="convidados"]',
    titulo: `${ic('fa-users')} Gerenciar Convidados`,
    texto: 'No seu plano <strong>Casal/Família</strong>, você pode convidar membros para compartilhar o acesso. Envie o convite por email e compartilhe o código de 6 dígitos.',
    pos: 'cima',
  },
];

// ── Passos para convidados (versão simplificada) ────────────────────────────────
const PASSOS_GUEST = [
  {
    pagina: null,
    seletor: null,
    titulo: `${ic('fa-star')} Bem-vindo ao GranaEvo!`,
    texto: 'Você foi convidado para acessar o GranaEvo! Você tem acesso <strong>visualização</strong> das finanças. Vou te mostrar o que você pode fazer.',
    pos: 'centro',
  },
  {
    pagina: 'dashboard',
    seletores: ['.saldo-hero-mobile', '.cards-grid'],
    titulo: `${ic('fa-chart-line')} Painel Financeiro Compartilhado`,
    texto: 'Aqui você vê o resumo financeiro da conta que você foi convidado a acessar. Os dados são atualizados em tempo real.',
    pos: 'baixo',
  },
  {
    pagina: 'transacoes',
    seletor: '#listaMovimentacoes',
    titulo: `${ic('fa-list')} Histórico de Transações`,
    texto: 'Você pode visualizar todas as movimentações. Dependendo das permissões, pode adicionar ou editar transações.',
    pos: 'cima',
  },
  {
    pagina: 'graficos',
    seletor: '.graficos-filtros',
    titulo: `${ic('fa-chart-bar')} Análise Visual`,
    texto: 'Visualize gráficos e análises financeiras. Uma forma visual de entender o fluxo de dinheiro.',
    pos: 'baixo',
  },
];

// ── Passo final (comum a todos) ─────────────────────────────────────────────────
const PASSO_FINAL = {
  pagina: 'configuracoes',
  seletor: '.cfg-body',
  titulo: `${ic('fa-cog')} Personalize Tudo`,
  texto: 'Aqui você altera <strong>nome e senha</strong>, gerencia sua assinatura e pode reiniciar esse tutorial quando quiser.',
  pos: 'cima',
};

const PASSO_CONCLUSAO = {
  pagina: null,
  seletor: null,
  titulo: `${ic('fa-check-circle')} Tudo pronto!`,
  texto: 'Parabéns! Agora você domina o GranaEvo. Comece lançando suas primeiras transações e veja sua vida financeira se transformar.',
  pos: 'centro',
  ultimo: true,
};

/**
 * Monta a sequência de passos com base no perfil do usuário.
 * @param {TutorialPerfil} perfil - Perfil do usuário
 * @returns {Passo[]} Sequência de passos para o tutorial
 */
function montarPassos(perfil) {
  const { plano = 'Individual', isGuest = false } = perfil;

  // Tutorial simplificado para convidados
  if (isGuest) {
    return [...PASSOS_GUEST, PASSO_FINAL, PASSO_CONCLUSAO];
  }

  // Tutorial completo + steps de convidados para planos Casal/Família
  const passos = [...PASSOS_BASE];
  if (plano === 'Casal' || plano === 'Família') {
    passos.push(...PASSOS_CONVIDADOS);
  }
  passos.push(PASSO_FINAL, PASSO_CONCLUSAO);
  return passos;
}

// ── Estado ──────────────────────────────────────────────────────────────────────
let _passos    = [];
let _passo     = 0;
let _backdrop  = null;
let _spotlight = null;
let _card      = null;
let _ativo     = false;

// ── API pública ─────────────────────────────────────────────────────────────────

/**
 * Inicia o tutorial interativo.
 * @param {TutorialPerfil} [perfil={}] - Perfil do usuário para personalizar os steps
 */
export function iniciarTutorial(perfil = {}) {
  if (_ativo) return;
  _ativo  = true;
  _passo  = 0;
  _passos = montarPassos(perfil);
  _montar();
  _ir(0);
}

function reiniciarTutorial(perfil = {}) {
  _desmontar();
  setTimeout(() => iniciarTutorial(perfil), 300);
}

// ── Montagem / desmontagem ──────────────────────────────────────────────────────
function _montar() {
  _backdrop  = _criarEl('div', 'tut-backdrop');
  _spotlight = _criarEl('div', 'tut-spotlight tut-spot-oculto');
  _card      = _criarEl('div', 'tut-card');
  document.body.append(_backdrop, _spotlight, _card);

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

// ── Navegação entre passos ──────────────────────────────────────────────────────
async function _ir(idx) {
  if (!_ativo) return;
  const p = _passos[idx];
  _passo = idx;

  const paginaAtual = document.querySelector('.page.active')?.id?.replace('Page', '');
  if (p.pagina && paginaAtual !== p.pagina) {
    _navegarPara(p.pagina);
    await _esperar(320);
  }

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

  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _esperar(380);
    spRect = p.seletores ? _unionRect(p.seletores) : alvo.getBoundingClientRect();
  }

  if (spRect && spRect.height > 0) {
    _posSpotlight(spRect);
    _spotlight.classList.remove('tut-spot-oculto');
  } else {
    _spotlight.classList.add('tut-spot-oculto');
  }

  _renderCard(p, idx);
  await _esperar(12);
  _posCard(spRect, p.pos);
}

// ── Spotlight ───────────────────────────────────────────────────────────────────
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

// ── Card ────────────────────────────────────────────────────────────────────────
function _renderCard(p, idx) {
  const total    = _passos.length;
  const primeiro = idx === 0;
  const ultimo   = idx === total - 1 || p.ultimo;

  // Indicador de progresso: dots com estados (feito/ativo/pendente)
  const dots = _passos.map((_, i) => {
    const cls = i < idx ? 'tut-dot tut-done' : i === idx ? 'tut-dot tut-ativo' : 'tut-dot';
    return `<span class="${cls}" aria-hidden="true"></span>`;
  }).join('');

  _card.innerHTML = `
    <div class="tut-top">
      <span class="tut-badge" aria-label="Passo ${idx + 1} de ${total}">Passo ${idx + 1} de ${total}</span>
      <div class="tut-dots" role="progressbar" aria-valuenow="${idx + 1}" aria-valuemin="1" aria-valuemax="${total}">${dots}</div>
    </div>
    <h3 class="tut-titulo">${p.titulo}</h3>
    <p class="tut-texto">${p.texto}</p>
    <div class="tut-acoes">
      <button class="tut-pular-tudo" type="button" aria-label="Pular tutorial">Pular tutorial</button>
      <div class="tut-nav">
        <button class="tut-voltar" type="button" ${primeiro ? 'disabled aria-disabled="true"' : ''} aria-label="Passo anterior">Voltar</button>
        <button class="tut-avancar" type="button" aria-label="${ultimo ? 'Concluir tutorial' : 'Próximo passo'}">${ultimo ? 'Concluir' : 'Prosseguir'}</button>
      </div>
    </div>
  `;

  _card.querySelector('.tut-pular-tudo').onclick = _desmontar;
  _card.querySelector('.tut-voltar').onclick     = () => { if (!primeiro) _ir(_passo - 1); };
  _card.querySelector('.tut-avancar').onclick    = () => { ultimo ? _desmontar() : _ir(_passo + 1); };

  // Navegação por teclado (Escape = pular, ← → = navegar)
  _card.onkeydown = (e) => {
    if (e.key === 'Escape')     { _desmontar(); return; }
    if (e.key === 'ArrowRight' && !ultimo)  { _ir(_passo + 1); return; }
    if (e.key === 'ArrowLeft'  && !primeiro){ _ir(_passo - 1); return; }
  };
  _card.setAttribute('tabindex', '0');
  _card.focus();
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

  // ── Desktop ────────────────────────────────────────────────────────────────
  const CW    = 340;
  const GAP_D = 20;
  const vw    = window.innerWidth;
  const vh    = window.innerHeight;
  const ch    = _card.offsetHeight || 210;

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

// ── Navegação entre seções ──────────────────────────────────────────────────────
function _navegarPara(pagina) {
  const btn = document.querySelector(`[data-page="${pagina}"]`);
  if (btn) { btn.click(); return; }
  if (pagina === 'configuracoes') document.getElementById('mobileSettingsBtn')?.click();
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
function _criarEl(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

function _esperar(ms) {
  return new Promise(r => setTimeout(r, ms));
}
