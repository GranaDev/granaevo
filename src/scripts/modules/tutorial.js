/**
 * tutorial.js — Sistema de Tutorial Interativo do GranaEvo
 *
 * Técnica de spotlight: o elemento .tut-spotlight é posicionado sobre o alvo
 * com background transparente. O box-shadow com spread gigante (9999px) pinta
 * um overlay escuro sobre TUDO ao redor, revelando apenas a área do spotlight.
 */

// ── Passos do tutorial ─────────────────────────────────────────────────────────

const PASSOS = [
  {
    pagina: null,
    seletor: null,
    titulo: '👋 Bem-vindo ao GranaEvo!',
    texto: 'Que bom ter você aqui! Em menos de 2 minutos vou te mostrar tudo que o <strong>GranaEvo</strong> tem para transformar a sua vida financeira. Vamos lá?',
    pos: 'centro',
  },
  {
    pagina: 'dashboard',
    seletor: '.cards-grid',
    titulo: '📊 Seu Painel Financeiro',
    texto: 'Esses 4 cards são seu resumo instantâneo do mês: <em>Entradas</em>, <em>Saídas</em>, <em>Saldo</em> e <em>Reservas</em>. Uma olhada e você já sabe como estão suas finanças.',
    pos: 'baixo',
  },
  {
    pagina: 'dashboard',
    seletor: '#btnPeriodoDashboard',
    titulo: '📅 Viaje pelo Histórico',
    texto: 'Clique aqui para mudar o mês e explorar seu histórico financeiro. Veja como você evoluiu ao longo do tempo e identifique padrões de gastos.',
    pos: 'baixo',
  },
  {
    pagina: 'dashboard',
    seletor: '#sectionContasFixas',
    titulo: '🗂️ Contas Fixas',
    texto: 'Cadastre suas contas recorrentes — aluguel, internet, academia, streaming... O GranaEvo <em>alerta sobre vencimentos</em> e você marca como paga com um clique.',
    pos: 'cima',
  },
  {
    pagina: 'transacoes',
    seletor: '.transaction-form',
    titulo: '💳 Lançar Transações',
    texto: 'O coração do app. Registre <em>tudo que entra e sai</em>: receitas, gastos, reservas e compras no crédito. Selecione categoria, tipo, descrição e valor.',
    pos: 'baixo',
  },
  {
    pagina: 'transacoes',
    seletor: '#listaMovimentacoes',
    titulo: '📋 Histórico Completo',
    texto: 'Suas movimentações ficam aqui, organizadas e filtráveis por período. Toque em qualquer item para <strong>editar ou excluir</strong>. Simples assim.',
    pos: 'cima',
  },
  {
    pagina: 'reservas',
    seletor: '.reservas-sidebar',
    titulo: '🐷 Reservas — Seus Cofrinhos',
    texto: 'Crie reservas para seus objetivos: viagem dos sonhos, emergência, novo equipamento... Acompanhe o progresso em <em>gráficos em tempo real</em>.',
    pos: 'direita',
  },
  {
    pagina: 'cartoes',
    seletor: null,
    titulo: '💎 Cartões de Crédito',
    texto: 'Gerencie seus cartões, visualize as <strong>faturas detalhadas</strong> com cada compra, acompanhe parcelas e nunca mais seja pego de surpresa na fatura.',
    pos: 'centro',
  },
  {
    pagina: 'graficos',
    seletor: '.graficos-filtros',
    titulo: '📈 Análise Visual',
    texto: 'Transforme números em <em>gráficos inteligentes</em>. Veja distribuição dos gastos, evolução mensal e compare períodos. Clique em "Gerar Gráficos" para explorar.',
    pos: 'baixo',
  },
  {
    pagina: 'relatorios',
    seletor: '.rel-filtros',
    titulo: '📄 Relatórios Detalhados',
    texto: 'Gere relatórios completos com análise por categoria. Perfeito para entender <strong>onde foi seu dinheiro</strong> e planejar o próximo mês com mais inteligência.',
    pos: 'baixo',
  },
  {
    pagina: 'configuracoes',
    seletor: '.cfg-body',
    titulo: '⚙️ Personalize Tudo',
    texto: 'Aqui você altera <strong>nome e senha</strong>, convida familiares para compartilhar a conta, gerencia sua assinatura e pode reiniciar esse tutorial quando quiser.',
    pos: 'cima',
  },
  {
    pagina: null,
    seletor: null,
    titulo: '🚀 Você está pronto!',
    texto: 'Parabéns! Agora você domina o GranaEvo. Comece lançando suas primeiras transações e veja sua vida financeira se transformar. <strong>Boa jornada! 💚</strong>',
    pos: 'centro',
    ultimo: true,
  },
];

// ── Estado ─────────────────────────────────────────────────────────────────────

let _passo    = 0;
let _backdrop = null;
let _spotlight = null;
let _card     = null;
let _ativo    = false;

// ── API pública ────────────────────────────────────────────────────────────────

export function iniciarTutorial() {
  if (_ativo) return;
  _ativo = true;
  _passo = 0;
  _montar();
  _ir(0);
}

// ── Montagem / desmontagem do DOM ──────────────────────────────────────────────

function _montar() {
  _backdrop  = _criarEl('div', 'tut-backdrop');
  _spotlight = _criarEl('div', 'tut-spotlight tut-spot-oculto');
  _card      = _criarEl('div', 'tut-card');
  document.body.append(_backdrop, _spotlight, _card);
}

function _desmontar() {
  if (!_card) return;
  _card.classList.add('tut-saindo');
  setTimeout(() => {
    _backdrop?.remove();
    _spotlight?.remove();
    _card?.remove();
    _backdrop = _spotlight = _card = null;
    _ativo = false;
  }, 230);
}

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

  // Encontrar elemento alvo
  const alvo = p.seletor ? document.querySelector(p.seletor) : null;

  // Posicionar spotlight
  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _esperar(380);
    _posSpotlight(alvo);
    _spotlight.classList.remove('tut-spot-oculto');
  } else {
    _spotlight.classList.add('tut-spot-oculto');
  }

  // Renderizar e posicionar card
  _renderCard(p, idx);
  await _esperar(12);
  _posCard(alvo, p.pos);
}

// ── Spotlight ──────────────────────────────────────────────────────────────────

function _posSpotlight(el) {
  const r   = el.getBoundingClientRect();
  const pad = 10;
  Object.assign(_spotlight.style, {
    top:          r.top    - pad + 'px',
    left:         r.left   - pad + 'px',
    width:        r.width  + pad * 2 + 'px',
    height:       r.height + pad * 2 + 'px',
    borderRadius: _lerBorderRadius(el),
  });
}

function _lerBorderRadius(el) {
  const br = getComputedStyle(el).borderRadius;
  return (br && br !== '0px') ? br : '12px';
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
        <button class="tut-voltar" type="button" ${primeiro ? 'disabled' : ''}>← Voltar</button>
        <button class="tut-avancar" type="button">${ultimo ? 'Concluir 🚀' : 'Pular →'}</button>
      </div>
    </div>
  `;

  _card.querySelector('.tut-pular-tudo').onclick = _desmontar;
  _card.querySelector('.tut-voltar').onclick     = () => { if (!primeiro) _ir(_passo - 1); };
  _card.querySelector('.tut-avancar').onclick    = () => { ultimo ? _desmontar() : _ir(_passo + 1); };
}

function _posCard(alvo, pos) {
  // Resetar classes de seta
  _card.className = 'tut-card';

  // Em mobile o CSS cuida do posicionamento (fixed bottom)
  if (window.innerWidth <= 768) return;

  const CW   = 360;
  const GAP  = 22;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  const ch   = _card.offsetHeight || 240;

  let top = 0, left = 0, seta = '';

  if (!alvo || pos === 'centro') {
    top  = (vh - ch) / 2;
    left = (vw - CW) / 2;
  } else {
    const r  = alvo.getBoundingClientRect();
    const cx = r.left + r.width  / 2;

    switch (pos) {
      case 'baixo':
        top  = r.bottom + GAP;
        left = cx - CW / 2;
        seta = 'tut-seta-cima';
        break;
      case 'cima':
        top  = r.top - ch - GAP;
        left = cx - CW / 2;
        seta = 'tut-seta-baixo';
        break;
      case 'direita':
        top  = Math.max(GAP, r.top);
        left = r.right + GAP;
        seta = 'tut-seta-esq';
        break;
      case 'esquerda':
        top  = Math.max(GAP, r.top);
        left = r.left - CW - GAP;
        seta = 'tut-seta-dir';
        break;
      default:
        top  = (vh - ch) / 2;
        left = (vw - CW) / 2;
    }
  }

  // Clamp dentro da viewport
  left = Math.max(GAP, Math.min(vw - CW - GAP, left));
  top  = Math.max(GAP, Math.min(vh - ch - GAP, top));

  Object.assign(_card.style, {
    top:   top  + 'px',
    left:  left + 'px',
    width: CW   + 'px',
  });

  if (seta) _card.classList.add(seta);
}

// ── Navegação entre seções ─────────────────────────────────────────────────────

function _navegarPara(pagina) {
  // Tenta encontrar qualquer botão com data-page correspondente
  const btn = document.querySelector(`[data-page="${pagina}"]`);
  if (btn) {
    btn.click();
    return;
  }
  // Fallback para configurações no mobile (usa botão específico no topbar)
  if (pagina === 'configuracoes') {
    document.getElementById('mobileSettingsBtn')?.click();
  }
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
