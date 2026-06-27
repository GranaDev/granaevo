/**
 * @module tutorial
 * @description Tutorial interativo do GranaEvo — tour guiado completo.
 *
 * Cobre todas as seções do app (Dashboard, Transações, Assinaturas, Reservas,
 * Cartões, Gráficos, Relatórios, Notificações e Configurações) com navegação
 * por capítulos, retomada de progresso e reposicionamento responsivo.
 *
 * Segurança: todos os textos são estáticos e hardcoded neste módulo.
 * Nenhum dado do usuário é interpolado em innerHTML.
 *
 * Uso:
 *   import { iniciarTutorial } from './tutorial.js';
 *   iniciarTutorial();
 *   iniciarTutorial({ plano: 'Casal' });
 *   iniciarTutorial({ isGuest: true });
 */

const CHAVE_RETOMADA = 'ge_tut_resume';

// ── Passos base ────────────────────────────────────────────────────────────────
const PASSOS_BASE = [
  // ════ INÍCIO ═══════════════════════════════════════════════════
  {
    pagina:   null,
    seletor:  null,
    icon:     'fa-rocket',
    iconColor:'#10b981',
    secao:    null,
    titulo:   'Bem-vindo ao GranaEvo!',
    texto:    'Este é o <strong>tour completo</strong> do app. Em poucos minutos você vai dominar cada recurso — do primeiro lançamento às análises avançadas. Use as <em>setas do teclado</em> para navegar ou toque no ícone de capítulos para ir direto a uma seção.',
    pos:      'centro',
  },
  {
    pagina:    'dashboard',
    seletores: ['.sidebar-nav', '.mobile-bottom-nav'],
    icon:      'fa-compass',
    iconColor: '#6366f1',
    secao:     'Início',
    titulo:    'Navegação Principal',
    texto:     'Tudo está a um toque: <strong>Dashboard, Transações, Reservas, Cartões, Gráficos e Relatórios</strong>. No celular, a barra fica na parte inferior — e você ainda pode ativar a <em>navegação por swipe</em> nas Configurações para deslizar entre seções.',
    pos:       'centro',
  },

  // ════ DASHBOARD ════════════════════════════════════════════════
  {
    pagina:    'dashboard',
    seletores: ['#btnPeriodoDashboard', '#btnPeriodoDashMobile'],
    icon:      'fa-calendar-alt',
    iconColor: '#06b6d4',
    secao:     'Dashboard',
    titulo:    'Viaje no Tempo',
    texto:     'O <strong>seletor de período</strong> muda todo o painel para qualquer mês passado. Quer saber quanto gastou em janeiro? Dois toques e está lá — cards, alertas e contas se ajustam automaticamente.',
    pos:       'baixo',
  },
  {
    pagina:   'dashboard',
    seletores:['.saldo-hero-mobile', '.cards-grid'],
    icon:     'fa-chart-line',
    iconColor:'#10b981',
    secao:    'Dashboard',
    titulo:   'Painel Financeiro',
    texto:    'Seu mês em quatro números: <strong>Entradas, Saídas, Saldo e Reservas</strong> — cada card compara com o mês anterior para você ver a evolução. No celular, o ícone de <em>olho</em> oculta o saldo em locais públicos.',
    pos:      'baixo',
  },
  {
    pagina:   'dashboard',
    seletor:  '.alertas-vencimento',
    icon:     'fa-bell',
    iconColor:'#ef4444',
    secao:    'Dashboard',
    titulo:   'Alertas de Vencimento',
    texto:    'O app vigia suas contas por você: detecta automaticamente o que está <strong>vencido</strong>, vence hoje, em 3 dias ou na semana. Nunca mais pague multa por esquecimento — visualize, pague e marque como concluído em um clique.',
    pos:      'cima',
  },
  {
    pagina:   'dashboard',
    seletor:  '#sectionContasFixas',
    icon:     'fa-file-invoice-dollar',
    iconColor:'#f59e0b',
    secao:    'Dashboard',
    titulo:   'Contas Fixas',
    texto:    'Cadastre o que se repete todo mês — <strong>aluguel, internet, energia, academia</strong>. O app gera os alertas de vencimento sozinho e você marca como paga com um toque. Use <em>"Ver todas"</em> para o histórico completo.',
    pos:      'cima',
  },
  {
    pagina:   'dashboard',
    seletor:  '#widgetOndeFoiDinheiro',
    icon:     'fa-search-dollar',
    iconColor:'#8b5cf6',
    secao:    'Dashboard',
    titulo:   'Onde Foi Meu Dinheiro?',
    texto:    'Análise inteligente que mostra <strong>para onde seus gastos estão indo</strong>: categorias campeãs, gráficos interativos e insights prontos para decisão. Um atalho direto para entender seu padrão de consumo.',
    pos:      'cima',
  },

  // ════ TRANSAÇÕES ═══════════════════════════════════════════════
  {
    pagina:   'transacoes',
    seletor:  '.transaction-form',
    icon:     'fa-plus-circle',
    iconColor:'#10b981',
    secao:    'Transações',
    titulo:   'Lançar Transações',
    texto:    'O coração do app. Registre <strong>Entradas, Saídas e Reservas</strong> em segundos. Para compras parceladas, escolha <strong>Saída no Crédito</strong>, selecione o cartão e as parcelas — o app divide e rastreia <em>cada parcela</em> na fatura certa.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '.transaction-form',
    icon:     'fa-sync-alt',
    iconColor:'#8b5cf6',
    secao:    'Transações',
    titulo:   'Assinaturas Recorrentes',
    texto:    'Netflix, Spotify, academia… escolha a categoria <strong>Assinatura</strong>, vincule o cartão e defina o <strong>dia de cobrança</strong>. O GranaEvo gera a cobrança <em>automaticamente todo mês</em> e soma na fatura — sem você lembrar de nada.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '#btnImportarExtrato',
    icon:     'fa-file-import',
    iconColor:'#06b6d4',
    secao:    'Transações',
    titulo:   'Importar Extrato',
    texto:    'Tem um histórico no banco? <strong>Importe o extrato</strong> e traga dezenas de lançamentos de uma vez, sem digitar nada. Ideal para começar com seus dados reais desde o primeiro dia.',
    pos:      'baixo',
  },
  {
    pagina:    'transacoes',
    seletores: ['.mov-busca-wrap', '#movFiltrosWrapper'],
    icon:      'fa-search',
    iconColor: '#3b82f6',
    secao:     'Transações',
    titulo:    'Busca e Filtros',
    texto:     'Encontre qualquer lançamento pela <strong>busca por descrição</strong>. Os filtros mostram só o que importa: últimos 15, 30 ou 60 dias, um mês específico ou <em>todo o período</em> — perfeito para conferências e auditorias pessoais.',
    pos:       'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '#listaMovimentacoes',
    icon:     'fa-list-ul',
    iconColor:'#3b82f6',
    secao:    'Transações',
    titulo:   'Histórico Completo',
    texto:    'Todas as movimentações em ordem cronológica, guardadas <strong>para sempre</strong>. <strong>Toque</strong> em qualquer item para editar descrição, categoria, valor — ou excluir. Errou um lançamento? Corrige em segundos.',
    pos:      'cima',
  },
  {
    pagina:   'transacoes',
    seletor:  '#orcamentosSection',
    icon:     'fa-wallet',
    iconColor:'#f59e0b',
    secao:    'Transações',
    titulo:   'Orçamentos por Categoria',
    texto:    'Defina <strong>tetos mensais</strong> por tipo de gasto. A barra avisa antes do estouro: <strong style="color:#f59e0b">amarela aos 80%</strong>, <strong style="color:#ef4444">vermelha ao ultrapassar</strong>. É o seu freio de mão automático contra gastos por impulso.',
    pos:      'baixo',
  },

  // ════ RESERVAS ═════════════════════════════════════════════════
  {
    pagina:   'reservas',
    seletor:  '.reservas-sidebar',
    icon:     'fa-piggy-bank',
    iconColor:'#a78bfa',
    secao:    'Reservas',
    titulo:   'Crie Metas e Reservas',
    texto:    'Dê nome e valor-alvo aos seus sonhos: <strong>fundo de emergência, viagem, carro</strong>… O <em>simulador de aportes</em> calcula quanto guardar por mês — com rendimento <strong>CDI</strong> ou taxa personalizada. Já tem dinheiro guardado? Use <em>"Já possuo reservas"</em> para cadastrar sem afetar o saldo.',
    pos:      'direita',
  },
  {
    pagina:   'reservas',
    seletor:  '.reservas-main',
    icon:     'fa-chart-area',
    iconColor:'#a78bfa',
    secao:    'Reservas',
    titulo:   'Acompanhe a Evolução',
    texto:    'Selecione uma reserva e veja o <strong>progresso geral</strong> e a <strong>evolução dos últimos 12 meses</strong> em gráficos. Precisou usar o dinheiro? O botão <em>Retirar</em> devolve o valor ao seu saldo com rastreio completo.',
    pos:      'esquerda',
  },

  // ════ CARTÕES ══════════════════════════════════════════════════
  {
    pagina:   'cartoes',
    seletor:  '#cartoesGrid',
    icon:     'fa-credit-card',
    iconColor:'#ec4899',
    secao:    'Cartões',
    titulo:   'Cartões de Crédito',
    texto:    'Cadastre cartões com <strong>limite e dia de fechamento</strong>. Cada fatura mostra compra a compra, com rastreamento de parcelas e assinaturas. Veja quanto do limite está comprometido — e <em>congele</em> um cartão quando quiser pausar o uso.',
    pos:      'centro',
  },

  // ════ GRÁFICOS ═════════════════════════════════════════════════
  {
    pagina:   'graficos',
    seletor:  '.graficos-filtros',
    icon:     'fa-chart-pie',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Análise Visual',
    texto:    'Transforme números em <strong>gráficos inteligentes</strong>: distribuição por categoria, evolução do saldo e visões <em>Individual, Casal ou Família</em>. Escolha mês e ano, toque em <strong>Gerar Gráficos</strong> e veja seus dados ganharem vida.',
    pos:      'baixo',
  },
  {
    pagina:   'graficos',
    seletor:  '.comparacao-toggle',
    icon:     'fa-balance-scale',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Comparativos de Período',
    texto:    'Ative os <strong>gráficos comparativos</strong> para colocar dois meses lado a lado. Gastou mais ou menos que no mês passado? Em qual categoria? A resposta aparece em segundos — ideal para medir o efeito das suas decisões.',
    pos:      'baixo',
  },

  // ════ RELATÓRIOS ═══════════════════════════════════════════════
  {
    pagina:   'relatorios',
    seletor:  '.rel-filtros',
    icon:     'fa-file-alt',
    iconColor:'#f97316',
    secao:    'Relatórios',
    titulo:   'Relatórios Completos',
    texto:    'Análises profundas de <strong>onde foi seu dinheiro</strong>, evolução patrimonial e histórico financeiro. Escolha o tipo — <em>Individual, Casal, Família ou Visão Geral</em> — selecione o período e gere em um toque.',
    pos:      'baixo',
  },
  {
    pagina:   'relatorios',
    seletor:  '.rel-header-actions',
    icon:     'fa-file-export',
    iconColor:'#f97316',
    secao:    'Relatórios',
    titulo:   'Exporte e Compartilhe',
    texto:    'Leve seus dados para onde quiser: exporte em <strong>CSV, Excel, PDF</strong> ou como <em>apresentação animada</em>. Perfeito para planejar com a família, prestar contas ou guardar um registro mensal.',
    pos:      'baixo',
  },
  {
    pagina:   'relatorios',
    seletor:  null,
    icon:     'fa-trophy',
    iconColor:'#f59e0b',
    secao:    'Relatórios',
    titulo:   'Score Financeiro',
    texto:    'O GranaEvo avalia sua <strong>saúde financeira</strong> e gera uma pontuação baseada em orçamentos cumpridos, reservas, dívidas e fundo de emergência. Todo mês você recebe <em>dicas personalizadas</em> para subir de nível.',
    pos:      'centro',
  },

  // ════ NOTIFICAÇÕES ═════════════════════════════════════════════
  {
    pagina:   'dashboard',
    seletor:  '#btnNotificacoes',
    icon:     'fa-bell',
    iconColor:'#eab308',
    secao:    'Notificações',
    titulo:   'Central de Notificações',
    texto:    'Vencimentos, orçamentos estourando, novidades do app — tudo chega na <strong>central de notificações</strong>. Ative também as <em>notificações push</em> nas Configurações para receber alertas direto no celular, mesmo com o app fechado.',
    pos:      'direita',
  },

  // ════ CONFIGURAÇÕES ════════════════════════════════════════════
  {
    pagina:   'configuracoes',
    seletor:  '.cfg-profile-card',
    icon:     'fa-user-shield',
    iconColor:'#3b82f6',
    secao:    'Configurações',
    titulo:   'Seu Perfil',
    texto:    'Toque no seu <strong>perfil</strong> (ou na foto, em qualquer tela) para alterar <strong>nome e foto</strong> e ver suas <strong>conquistas</strong> e nível. Logo abaixo, você altera a <strong>senha</strong> e alterna entre <strong>perfis</strong> — cada um com dados totalmente separados.',
    pos:      'direita',
  },
  {
    pagina:   'configuracoes',
    seletor:  '#btnToggleTema',
    expandir: '.cfg-list',
    icon:     'fa-sliders-h',
    iconColor:'#6366f1',
    secao:    'Configurações',
    titulo:   'Personalize o App',
    texto:    'Escolha entre tema <strong>claro ou escuro</strong>, instale o GranaEvo como <strong>aplicativo</strong> na tela inicial, ative <strong>notificações push</strong> e a navegação por swipe. O modo offline mantém seus dados acessíveis mesmo sem internet.',
    pos:      'esquerda',
  },
  {
    pagina:   'configuracoes',
    seletor:  '#btnHistoricoBackup',
    expandir: '.cfg-list',
    icon:     'fa-shield-alt',
    iconColor:'#14b8a6',
    secao:    'Configurações',
    titulo:   'Seus Dados, Protegidos',
    texto:    'O <strong>backup automático</strong> guarda os últimos 7 dias — restaure qualquer versão em um toque. Quer recomeçar do zero? <em>Resetar Perfil</em> apaga os dados financeiros, mas cria um backup antes, por segurança.',
    pos:      'esquerda',
  },
  {
    pagina:   'configuracoes',
    seletor:  '#btnGerenciarAssinatura',
    expandir: '.cfg-list',
    icon:     'fa-crown',
    iconColor:'#f59e0b',
    secao:    'Configurações',
    titulo:   'Seu Plano',
    texto:    'Gerencie sua assinatura do GranaEvo: <strong>alterar plano, trocar cartão ou cancelar</strong> — tudo por aqui, sem burocracia. E o botão <em>Como Usar</em> reabre este tour sempre que você precisar.',
    pos:      'esquerda',
  },
];

const PASSOS_CONVIDADOS = [
  {
    pagina:   'configuracoes',
    seletor:  '#btnAlterarEmail',
    expandir: '.cfg-list',
    icon:     'fa-users',
    iconColor:'#10b981',
    secao:    'Configurações',
    titulo:   'Convide sua Família',
    texto:    'Seu plano permite <strong>convidados</strong>: cada um recebe login próprio e acessa o mesmo painel financeiro. Você define as permissões — só visualizar ou também editar — e pode remover o acesso a qualquer momento.',
    pos:      'direita',
  },
];

const PASSOS_GUEST = [
  {
    pagina:   null,
    seletor:  null,
    icon:     'fa-rocket',
    iconColor:'#10b981',
    secao:    null,
    titulo:   'Bem-vindo ao GranaEvo!',
    texto:    'Você foi convidado para acessar esta conta. Dependendo das permissões concedidas, você pode <strong>visualizar e editar</strong> as finanças do grupo. Este tour rápido mostra o essencial.',
    pos:      'centro',
  },
  {
    pagina:    'dashboard',
    seletores: ['.sidebar-nav', '.mobile-bottom-nav'],
    icon:      'fa-compass',
    iconColor: '#6366f1',
    secao:     'Início',
    titulo:    'Navegação Principal',
    texto:     'Tudo está a um toque: <strong>Dashboard, Transações, Reservas, Cartões, Gráficos e Relatórios</strong>. No celular, a barra fica na parte inferior da tela.',
    pos:       'centro',
  },
  {
    pagina:   'dashboard',
    seletores:['.saldo-hero-mobile', '.cards-grid'],
    icon:     'fa-chart-line',
    iconColor:'#10b981',
    secao:    'Dashboard',
    titulo:   'Painel Compartilhado',
    texto:    'Resumo financeiro da conta que você acessa, <strong>atualizado em tempo real</strong>: Entradas, Saídas, Saldo e Reservas. Use o seletor de período para ver qualquer mês.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '.transaction-form',
    icon:     'fa-plus-circle',
    iconColor:'#10b981',
    secao:    'Transações',
    titulo:   'Lançar Transações',
    texto:    'Com permissão de edição, você registra <strong>entradas, saídas, reservas e assinaturas</strong> normalmente. Tudo que você lança aparece na hora para os outros membros do grupo.',
    pos:      'baixo',
  },
  {
    pagina:   'transacoes',
    seletor:  '#listaMovimentacoes',
    icon:     'fa-list-ul',
    iconColor:'#3b82f6',
    secao:    'Transações',
    titulo:   'Histórico do Grupo',
    texto:    'Todas as movimentações em ordem cronológica. Use a <strong>busca por descrição</strong> e os filtros de período para encontrar qualquer lançamento rapidamente.',
    pos:      'cima',
  },
  {
    pagina:   'graficos',
    seletor:  '.graficos-filtros',
    icon:     'fa-chart-pie',
    iconColor:'#06b6d4',
    secao:    'Gráficos',
    titulo:   'Análise Visual',
    texto:    'Gráficos completos da conta compartilhada: distribuição por categoria, evolução mensal e comparativos de período — uma forma clara de entender o <strong>fluxo financeiro do grupo</strong>.',
    pos:      'baixo',
  },
  {
    pagina:   'relatorios',
    seletor:  '.rel-filtros',
    icon:     'fa-file-alt',
    iconColor:'#f97316',
    secao:    'Relatórios',
    titulo:   'Relatórios Completos',
    texto:    'Gere análises detalhadas por período e exporte em <strong>CSV, Excel ou PDF</strong>. Ótimo para acompanhar as finanças do grupo mês a mês.',
    pos:      'baixo',
  },
  {
    pagina:   'configuracoes',
    seletor:  '#btnToggleTema',
    expandir: '.cfg-list',
    icon:     'fa-sliders-h',
    iconColor:'#6366f1',
    secao:    'Configurações',
    titulo:   'Personalize o App',
    texto:    'Escolha entre tema <strong>claro ou escuro</strong>, instale o GranaEvo como app na tela inicial e ative as notificações. O botão <em>Como Usar</em> reabre este tour quando quiser.',
    pos:      'esquerda',
  },
];

const PASSO_CONCLUSAO = {
  pagina:   null,
  seletor:  null,
  icon:     'fa-check-circle',
  iconColor:'#10b981',
  secao:    null,
  titulo:   'Tudo pronto para evoluir!',
  texto:    'Você conhece cada canto do GranaEvo. Comece agora: <strong>lance sua primeira transação</strong>, cadastre suas contas fixas e crie uma reserva. Em poucos dias você terá <em>clareza financeira total</em> — e este tour estará sempre em Configurações → Como Usar.',
  pos:      'centro',
  ultimo:   true,
};

function montarPassos(perfil) {
  const { plano = 'Individual', isGuest = false } = perfil;
  if (isGuest) return [...PASSOS_GUEST, PASSO_CONCLUSAO];
  const passos = [...PASSOS_BASE];
  if (plano === 'Casal' || plano === 'Família') passos.push(...PASSOS_CONVIDADOS);
  passos.push(PASSO_CONCLUSAO);
  return passos;
}

// Capítulos derivados dos passos (1 capítulo por seção, na ordem)
function montarCapitulos(passos) {
  const caps = [];
  passos.forEach((p, i) => {
    const nome = p.secao || (i === 0 ? 'Boas-vindas' : (p.ultimo ? 'Conclusão' : 'Início'));
    const last = caps[caps.length - 1];
    if (!last || last.nome !== nome) caps.push({ nome, inicio: i, qtd: 1 });
    else last.qtd++;
  });
  return caps;
}

// ── Estado ─────────────────────────────────────────────────────────────────────
let _passos    = [];
let _capitulos = [];
let _passo     = 0;
let _direcao   = 'centro';
let _backdrop  = null;
let _spotlight = null;
let _card      = null;
let _ativo     = false;
let _spRectAtual = null;   // rect do spotlight do passo atual (p/ reposicionamento)
let _resizeTimer = null;

// ── API pública ────────────────────────────────────────────────────────────────
export function iniciarTutorial(perfil = {}) {
  if (_ativo) return;
  _ativo     = true;
  _passo     = 0;
  _direcao   = 'centro';
  _passos    = montarPassos(perfil);
  _capitulos = montarCapitulos(_passos);
  _montar();
  _ir(0);
}

// ── Retomada de progresso (sessionStorage — nunca dados sensíveis) ─────────────
function _salvarProgresso(idx) {
  try { sessionStorage.setItem(CHAVE_RETOMADA, String(idx)); } catch { /* storage bloqueado */ }
}
function _lerProgresso() {
  try {
    const v = Number(sessionStorage.getItem(CHAVE_RETOMADA));
    return Number.isInteger(v) && v > 1 && v < _passos.length - 1 ? v : null;
  } catch { return null; }
}
function _limparProgresso() {
  try { sessionStorage.removeItem(CHAVE_RETOMADA); } catch { /* noop */ }
}

// ── Montagem ───────────────────────────────────────────────────────────────────
function _montar() {
  _backdrop  = _el('div', 'tut-backdrop');
  _spotlight = _el('div', 'tut-spotlight tut-spot-oculto');
  _card      = _el('div', 'tut-card');
  document.body.append(_backdrop, _spotlight, _card);

  _backdrop.addEventListener('touchstart', _blk, { passive: false });
  _backdrop.addEventListener('touchmove',  _blk, { passive: false });
  document.addEventListener('wheel',   _blkWheel, { passive: false });
  document.addEventListener('keydown', _teclas, true);
  window.addEventListener('resize', _onResize);
}

function _desmontar(concluiu = false) {
  if (!_card) return;

  if (concluiu) _limparProgresso();
  else if (_passo > 1) _salvarProgresso(_passo);

  _card.classList.add('tut-saindo');
  _spotlight?.classList.add('tut-spot-oculto');

  _backdrop?.removeEventListener('touchstart', _blk);
  _backdrop?.removeEventListener('touchmove',  _blk);
  document.removeEventListener('wheel',   _blkWheel);
  document.removeEventListener('keydown', _teclas, true);
  window.removeEventListener('resize', _onResize);

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

function _teclas(e) {
  if (!_ativo || !_card) return;
  const ultimo   = _passo === _passos.length - 1 || _passos[_passo]?.ultimo;
  const primeiro = _passo === 0;
  if (e.key === 'Escape') {
    // Fecha o menu de capítulos primeiro, se aberto
    const painel = _card.querySelector('.tut-cap-panel');
    if (painel && !painel.classList.contains('js-hidden')) { _toggleCapitulos(false); return; }
    _desmontar();
  }
  else if (e.key === 'ArrowRight' && !ultimo)   _ir(_passo + 1);
  else if (e.key === 'ArrowLeft'  && !primeiro) _ir(_passo - 1);
}

function _onResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!_ativo || !_card) return;
    const p = _passos[_passo];
    const spRect = _resolverRect(p);
    _spRectAtual = spRect;
    if (spRect?.height > 0) _posSpotlight(spRect);
    _posCard(spRect, p.pos, /*semAnimacao*/ true);
  }, 150);
}

// ── Navegação ──────────────────────────────────────────────────────────────────
async function _ir(idx) {
  if (!_ativo) return;
  idx = Math.max(0, Math.min(_passos.length - 1, idx));

  _direcao = idx > _passo ? 'avancar' : (idx < _passo ? 'voltar' : _direcao);

  const p = _passos[idx];
  _passo  = idx;
  if (idx > 1 && !p.ultimo) _salvarProgresso(idx);

  const paginaAtual = document.querySelector('.page.active')?.id?.replace('Page', '');
  if (p.pagina && paginaAtual !== p.pagina) {
    _navPara(p.pagina);
    await _esperarPagina(p.pagina);
  }

  // Aguarda o elemento-alvo existir (seções com conteúdo lazy-loaded)
  await _esperarAlvo(p);

  let spRect = _resolverRect(p);
  const alvo = _resolverAlvo(p);

  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _wait(400);
    spRect = _resolverRect(p);
  }

  _spRectAtual = spRect;
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

// Resolve o elemento principal do passo (considerando `expandir`)
function _resolverAlvo(p) {
  let alvo = null;
  if (p.seletores) {
    alvo = p.seletores.map(s => document.querySelector(s))
      .filter(el => el && el.getBoundingClientRect().height > 0).pop() ?? null;
  } else if (p.seletor) {
    alvo = document.querySelector(p.seletor);
  }
  if (alvo && p.expandir) alvo = alvo.closest(p.expandir) || alvo;
  return alvo;
}

// Resolve o retângulo do spotlight do passo
function _resolverRect(p) {
  if (p.seletores) return _unionRect(p.seletores);
  const alvo = _resolverAlvo(p);
  if (!alvo) return null;
  const r = alvo.getBoundingClientRect();
  return r.height > 0 ? r : null;
}

// Aguarda a página de destino ficar ativa (até ~1.6s)
async function _esperarPagina(pagina) {
  for (let i = 0; i < 16; i++) {
    await _wait(100);
    const atual = document.querySelector('.page.active')?.id?.replace('Page', '');
    if (atual === pagina) { await _wait(180); return; }
  }
}

// Aguarda o alvo existir no DOM (conteúdo lazy — até ~1.2s)
async function _esperarAlvo(p) {
  const sel = p.seletor || (p.seletores && p.seletores[0]);
  if (!sel) return;
  for (let i = 0; i < 8; i++) {
    if (document.querySelector(sel)) return;
    await _wait(150);
  }
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

  const headerRight = _el('div', 'tut-header-right');

  const badge = _el('span', 'tut-badge');
  badge.setAttribute('aria-label', `Passo ${idx + 1} de ${total}`);
  badge.textContent = `${idx + 1} / ${total}`;

  // Botão do menu de capítulos
  const btnCaps = _el('button', 'tut-cap-btn');
  btnCaps.type = 'button';
  btnCaps.innerHTML = '<i class="fas fa-list-ul" aria-hidden="true"></i>';
  btnCaps.setAttribute('aria-label', 'Abrir menu de capítulos');
  btnCaps.setAttribute('aria-expanded', 'false');
  btnCaps.onclick = () => _toggleCapitulos();

  headerRight.appendChild(badge);
  headerRight.appendChild(btnCaps);

  headerMeta.appendChild(secaoEl);
  headerMeta.appendChild(headerRight);
  header.appendChild(progressWrap);
  header.appendChild(headerMeta);

  // Dots = capítulos (1 ponto por seção, clicável)
  const capAtualIdx = _capituloDoPasso(idx);
  const dotsWrap = _el('div', 'tut-dots');
  _capitulos.forEach((cap, ci) => {
    const cls = ci === capAtualIdx ? 'tut-dot tut-dot-ativo' : ci < capAtualIdx ? 'tut-dot tut-dot-feito' : 'tut-dot';
    const dot = _el('button', cls);
    dot.type = 'button';
    dot.setAttribute('aria-label', `Ir para ${cap.nome}`);
    dot.title = cap.nome;
    dot.addEventListener('click', () => { if (ci !== capAtualIdx) _ir(cap.inicio); });
    dotsWrap.appendChild(dot);
  });
  header.appendChild(dotsWrap);

  // Painel de capítulos (oculto por padrão)
  const capPanel = _el('div', 'tut-cap-panel js-hidden');
  capPanel.setAttribute('role', 'menu');
  capPanel.setAttribute('aria-label', 'Capítulos do tutorial');
  _capitulos.forEach((cap, ci) => {
    const item = _el('button', 'tut-cap-item' + (ci === capAtualIdx ? ' tut-cap-item--ativo' : ''));
    item.type = 'button';
    item.setAttribute('role', 'menuitem');

    const icEl = document.createElement('i');
    icEl.className = `fas ${_secaoIcon(cap.nome)}`;
    icEl.setAttribute('aria-hidden', 'true');

    const nomeEl = _el('span', 'tut-cap-nome');
    nomeEl.textContent = cap.nome;

    const qtdEl = _el('span', 'tut-cap-qtd');
    qtdEl.textContent = cap.qtd > 1 ? `${cap.qtd} passos` : '1 passo';

    item.appendChild(icEl);
    item.appendChild(nomeEl);
    item.appendChild(qtdEl);
    item.addEventListener('click', () => { _toggleCapitulos(false); _ir(cap.inicio); });
    capPanel.appendChild(item);
  });
  header.appendChild(capPanel);

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

  // Retomada: no primeiro passo, oferece continuar de onde parou
  if (primeiro) {
    const salvo = _lerProgresso();
    if (salvo) {
      const capSalvo = _capitulos[_capituloDoPasso(salvo)];
      const btnRetomar = _el('button', 'tut-btn-retomar');
      btnRetomar.type = 'button';
      const icR = document.createElement('i');
      icR.className = 'fas fa-history';
      icR.setAttribute('aria-hidden', 'true');
      btnRetomar.appendChild(icR);
      btnRetomar.appendChild(document.createTextNode(
        ` Continuar de onde parei — ${capSalvo ? capSalvo.nome : 'passo ' + (salvo + 1)}`
      ));
      btnRetomar.onclick = () => _ir(salvo);
      body.appendChild(btnRetomar);
    }
  }

  // ── Footer ─────────────────────────────────────────────────────
  const footer = _el('div', 'tut-footer');

  const btnPular = _el('button', 'tut-btn-pular');
  btnPular.type = 'button';
  btnPular.textContent = 'Pular';
  btnPular.setAttribute('aria-label', 'Pular tutorial');
  btnPular.onclick = () => _desmontar();

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
  btnAvancar.onclick = () => ultimo ? _desmontar(true) : _ir(_passo + 1);

  nav.appendChild(btnVoltar);
  nav.appendChild(btnAvancar);
  footer.appendChild(btnPular);
  footer.appendChild(nav);

  _card.appendChild(header);
  _card.appendChild(body);
  _card.appendChild(footer);

  _card.setAttribute('tabindex', '0');
  _card.setAttribute('role', 'dialog');
  _card.setAttribute('aria-modal', 'true');
  _card.setAttribute('aria-label', `Tutorial — ${p.titulo}`);
  requestAnimationFrame(() => _card?.focus());
}

function _capituloDoPasso(idx) {
  let cap = 0;
  _capitulos.forEach((c, ci) => { if (idx >= c.inicio) cap = ci; });
  return cap;
}

function _toggleCapitulos(forcar) {
  const painel = _card?.querySelector('.tut-cap-panel');
  const btn    = _card?.querySelector('.tut-cap-btn');
  if (!painel) return;
  const abrir = typeof forcar === 'boolean' ? forcar : painel.classList.contains('js-hidden');
  painel.classList.toggle('js-hidden', !abrir);
  btn?.setAttribute('aria-expanded', String(abrir));
}

function _secaoIcon(secao) {
  const map = {
    'Boas-vindas':   'fa-rocket',
    'Início':        'fa-compass',
    'Dashboard':     'fa-house',
    'Transações':    'fa-exchange-alt',
    'Reservas':      'fa-piggy-bank',
    'Cartões':       'fa-credit-card',
    'Gráficos':      'fa-chart-pie',
    'Relatórios':    'fa-file-alt',
    'Notificações':  'fa-bell',
    'Configurações': 'fa-cog',
    'Conclusão':     'fa-check-circle',
  };
  return map[secao] || 'fa-circle';
}

// ── Posicionamento do card ─────────────────────────────────────────────────────
function _posCard(spRect, pos, semAnimacao = false) {
  // Reset className e força reflow para reiniciar a animação CSS
  if (!semAnimacao) {
    _card.className = 'tut-card';
    void _card.offsetHeight;
  }

  const isUltimo  = _passo === _passos.length - 1 || _passos[_passo]?.ultimo;
  const isMobile  = window.innerWidth <= 768;
  const GAP       = 12;
  const baseClass = semAnimacao
    ? _card.className.replace(/\btut-seta-\S+/g, '').replace(/\s+/g, ' ').trim()
    : `tut-card tut-entr-${_direcao}${isUltimo ? ' tut-final' : ''}`;

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
      case 'esquerda':
        top  = Math.max(GAP_D, spRect.top);
        left = spRect.left - CW - GAP_D;
        seta = 'tut-seta-dir';
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
