/**
 * @module tutorial
 * @description Central de Aprendizado do GranaEvo — hub de categorias + tours guiados.
 *
 * Modelo:
 *  - HUB: tela inicial onde o usuário escolhe O QUE aprender (Dashboard,
 *    Transações, Reservas, Cartões, Gráficos, Relatórios, Notificações,
 *    Configurações, Perfil) — ou faz o Tour Completo / Trilha Essencial.
 *  - SEQUÊNCIA: um tour guiado (spotlight + card) sobre os passos escolhidos.
 *    Categorias retornam ao hub ao final; Completo/Essencial encerram.
 *
 * Cada categoria aprofunda não só o COMO (mecânica do app) mas o PORQUÊ
 * (importância da ferramenta) e dicas práticas, via blocos `dica`.
 *
 * Segurança: todos os textos são estáticos e hardcoded neste módulo. Nenhum
 * dado do usuário é interpolado em innerHTML (o plano entra só em texto fixo).
 *
 * Uso:
 *   import { iniciarTutorial } from './tutorial.js';
 *   iniciarTutorial();                              // abre o HUB
 *   iniciarTutorial({ plano: 'Casal' });            // HUB adaptado ao plano
 *   iniciarTutorial({ trilha: 'essencial' });       // trilha rápida p/ novo usuário
 *   iniciarTutorial({ isGuest: true });             // HUB reduzido p/ convidados
 */

// ─────────────────────────────────────────────────────────────────────────────
//  CATÁLOGO DE CATEGORIAS
//  Cada passo: { pagina, seletor|seletores, expandir?, icon, iconColor, titulo,
//                texto, pos, dica? }.  `secao` é injetado a partir da categoria.
// ─────────────────────────────────────────────────────────────────────────────
function montarCatalogo(perfil) {
  const { plano = 'Individual', isGuest = false } = perfil;
  const planoCompartilhado = plano === 'Casal' || plano === 'Família';

  // Texto do passo "Convidar" muda conforme o plano do usuário
  const textoConvite = isGuest
    ? 'Os convites são gerenciados pelo <strong>titular da conta</strong>. Como convidado, você já compartilha o mesmo painel — tudo o que o grupo lança aparece para você em tempo real.'
    : planoCompartilhado
      ? `Seu <strong>Plano ${plano}</strong> permite convidar pessoas: cada convidado recebe um login próprio e acessa o <strong>mesmo painel</strong>. Você define se ele pode só visualizar ou também editar — e remove o acesso quando quiser.`
      : 'Quer dividir as finanças com alguém? Os planos <strong>Casal</strong> e <strong>Família</strong> liberam convidados com login próprio sobre o mesmo painel. Faça o upgrade em Gerenciar Assinatura.';

  return [
    // ═══════════════ DASHBOARD ═══════════════
    {
      id: 'dashboard', nome: 'Dashboard', icon: 'fa-house', cor: '#06b6d4',
      resumo: 'Sua central financeira: tudo de relance.',
      passos: [
        {
          pagina: 'dashboard', seletor: null, pos: 'centro',
          icon: 'fa-house', iconColor: '#06b6d4',
          titulo: 'O Dashboard é seu painel de comando',
          texto: 'É a primeira tela que você vê — um resumo vivo do seu mês. Aqui você sente, em segundos, se está no azul ou no vermelho, o que vence em breve e para onde o dinheiro está indo.',
          dica: 'Crie o hábito de abrir o Dashboard 1x ao dia. Clareza diária é o que separa quem controla o dinheiro de quem é controlado por ele.',
        },
        {
          pagina: 'dashboard', seletores: ['.sidebar-nav', '.mobile-bottom-nav'], pos: 'centro',
          icon: 'fa-compass', iconColor: '#6366f1',
          titulo: 'Navegação principal',
          texto: 'Tudo a um toque: <strong>Dashboard, Transações, Reservas, Cartões, Gráficos e Relatórios</strong>. No celular a barra fica embaixo — e você pode ativar a <em>navegação por swipe</em> nas Configurações para deslizar entre as seções.',
        },
        {
          pagina: 'dashboard', seletores: ['#btnPeriodoDashboard', '#btnPeriodoDashMobile'], pos: 'baixo',
          icon: 'fa-calendar-alt', iconColor: '#06b6d4',
          titulo: 'Viaje no tempo',
          texto: 'O <strong>seletor de período</strong> reconstrói todo o painel para qualquer mês passado. Quer saber quanto gastou em janeiro? Dois toques e os cards, alertas e contas se ajustam sozinhos.',
        },
        {
          pagina: 'dashboard', seletores: ['.saldo-hero-mobile', '.cards-grid'], pos: 'baixo',
          icon: 'fa-chart-line', iconColor: '#10b981',
          titulo: 'Seu mês em quatro números',
          texto: '<strong>Entradas, Saídas, Saldo e Reservas</strong> — e cada card compara com o mês anterior, então você vê a evolução, não só o número. No celular, o ícone de <em>olho</em> oculta o saldo em locais públicos.',
        },
        {
          pagina: 'dashboard', seletor: '.alertas-vencimento', pos: 'cima',
          icon: 'fa-bell', iconColor: '#ef4444',
          titulo: 'Alertas de vencimento',
          texto: 'O app vigia suas contas por você: detecta o que está <strong>vencido</strong>, vence hoje, em 3 dias ou na semana. Visualize, pague e marque como concluído em um clique.',
          dica: 'Uma única multa por atraso costuma custar mais que meses de mensalidade do app. Marcar as contas como pagas mantém os alertas precisos.',
        },
        {
          pagina: 'dashboard', seletor: '#sectionContasFixas', pos: 'cima',
          icon: 'fa-file-invoice-dollar', iconColor: '#f59e0b',
          titulo: 'Contas fixas',
          texto: 'Cadastre o que se repete todo mês — <strong>aluguel, internet, energia, academia</strong>. O app gera os alertas sozinho e você marca como paga com um toque. Use <em>"Ver todas"</em> para o histórico completo.',
        },
        {
          pagina: 'dashboard', seletor: '#widgetOndeFoiDinheiro', pos: 'cima',
          icon: 'fa-search-dollar', iconColor: '#8b5cf6',
          titulo: 'Onde foi meu dinheiro?',
          texto: 'Uma análise pronta de <strong>para onde seus gastos estão indo</strong>: categorias campeãs, gráficos interativos e insights. O atalho mais rápido para entender seu padrão de consumo.',
        },
      ],
    },

    // ═══════════════ TRANSAÇÕES ═══════════════
    {
      id: 'transacoes', nome: 'Transações', icon: 'fa-exchange-alt', cor: '#10b981',
      resumo: 'O coração do app: registre tudo que entra e sai.',
      passos: [
        {
          pagina: 'transacoes', seletor: null, pos: 'centro',
          icon: 'fa-exchange-alt', iconColor: '#10b981',
          titulo: 'Transações: o coração do GranaEvo',
          texto: 'Cada real que entra ou sai vira uma transação. É o registro que alimenta os cards, os gráficos, os orçamentos e o score. Quanto mais fiel, mais o app trabalha por você.',
          dica: 'Não precisa lançar tudo de uma vez. Comece pelos gastos maiores e pegue o hábito — em poucos dias vira automático.',
        },
        {
          pagina: 'transacoes', seletor: '.transaction-form', pos: 'baixo',
          icon: 'fa-plus-circle', iconColor: '#10b981',
          titulo: 'Lançar entradas e saídas',
          texto: 'Registre <strong>Entradas, Saídas e Reservas</strong> em segundos. Para compras parceladas, escolha <strong>Saída no Crédito</strong>, selecione o cartão e as parcelas — o app divide e rastreia <em>cada parcela</em> na fatura certa.',
        },
        {
          pagina: 'transacoes', seletor: '.transaction-form', pos: 'baixo',
          icon: 'fa-sync-alt', iconColor: '#8b5cf6',
          titulo: 'Assinaturas recorrentes',
          texto: 'Netflix, Spotify, academia… escolha a categoria <strong>Assinatura</strong>, vincule o cartão e defina o <strong>dia de cobrança</strong>. O app gera a cobrança <em>automaticamente todo mês</em> — sem você lembrar de nada.',
          dica: 'Cadastrar todas as assinaturas costuma ser um choque de realidade. É o jeito mais fácil de descobrir aquele R$ 39,90 que você nem lembrava que pagava.',
        },
        {
          pagina: 'transacoes', seletor: '#btnImportarExtrato', pos: 'baixo',
          icon: 'fa-file-import', iconColor: '#06b6d4',
          titulo: 'Importar extrato',
          texto: 'Tem histórico no banco? <strong>Importe o extrato</strong> e traga dezenas de lançamentos de uma vez, sem digitar. Ideal para começar com seus dados reais desde o primeiro dia.',
        },
        {
          pagina: 'transacoes', seletores: ['.mov-busca-wrap', '#movFiltrosWrapper'], pos: 'baixo',
          icon: 'fa-search', iconColor: '#3b82f6',
          titulo: 'Busca e filtros',
          texto: 'Ache qualquer lançamento pela <strong>busca por descrição</strong>. Os filtros mostram só o que importa: últimos 15, 30 ou 60 dias, um mês específico ou <em>todo o período</em>.',
        },
        {
          pagina: 'transacoes', seletor: '#listaMovimentacoes', pos: 'cima',
          icon: 'fa-pen-to-square', iconColor: '#3b82f6',
          titulo: 'Errou? É só editar',
          texto: 'Todo o histórico fica guardado em ordem. <strong>Toque em qualquer item</strong> para editar descrição, categoria e valor — ou excluir. Nenhum erro é permanente: corrija em segundos e os números se reajustam.',
          dica: 'Não tenha medo de lançar errado. Editar é instantâneo, e um histórico imperfeito vale muito mais que um histórico vazio.',
        },
        {
          pagina: 'transacoes', seletor: '#orcamentosSection', pos: 'baixo',
          icon: 'fa-wallet', iconColor: '#f59e0b',
          titulo: 'Orçamentos por categoria',
          texto: 'Defina <strong>tetos mensais</strong> por tipo de gasto. A barra avisa antes do estouro: <strong style="color:#f59e0b">amarela aos 80%</strong>, <strong style="color:#ef4444">vermelha ao ultrapassar</strong>.',
          dica: 'Comece com 1 ou 2 categorias que costumam fugir do controle (delivery, lazer). Limitar tudo de uma vez desanima — limitar o essencial funciona.',
        },
      ],
    },

    // ═══════════════ RESERVAS ═══════════════
    {
      id: 'reservas', nome: 'Reservas', icon: 'fa-piggy-bank', cor: '#a78bfa',
      resumo: 'Metas, fundo de emergência e o poder de guardar.',
      passos: [
        {
          pagina: 'reservas', seletor: null, pos: 'centro',
          icon: 'fa-piggy-bank', iconColor: '#a78bfa',
          titulo: 'Por que reservar muda tudo',
          texto: 'Reserva é dinheiro com destino: o <strong>fundo de emergência</strong> que te protege de um imprevisto e as <strong>metas</strong> que transformam sonhos em plano. Sem reserva, qualquer susto vira dívida.',
          dica: 'A regra de ouro: monte primeiro um fundo de emergência de 3 a 6 meses dos seus custos fixos. Só depois parta para metas como viagem ou carro.',
        },
        {
          pagina: 'reservas', seletor: '.reservas-sidebar', pos: 'direita',
          icon: 'fa-bullseye', iconColor: '#a78bfa',
          titulo: 'Crie metas com o simulador',
          texto: 'Dê nome e valor-alvo ao seu objetivo. O <em>simulador de aportes</em> calcula quanto guardar por mês — com rendimento <strong>CDI</strong> ou taxa personalizada. Já tem dinheiro guardado? Use <em>"Já possuo reservas"</em> para cadastrar sem afetar seu saldo.',
        },
        {
          pagina: 'reservas', seletor: '.reservas-main', pos: 'esquerda',
          icon: 'fa-chart-area', iconColor: '#a78bfa',
          titulo: 'Acompanhe a evolução',
          texto: 'Selecione uma reserva e veja o <strong>progresso geral</strong> e a <strong>evolução dos últimos 12 meses</strong> em gráficos. Ver a barra subir mês a mês é o que mantém a disciplina viva.',
        },
        {
          pagina: 'reservas', seletores: ['#btnGuardar', '#btnAjustar', '#btnRetirar'], pos: 'cima',
          icon: 'fa-sliders-h', iconColor: '#10b981',
          titulo: 'Guardar, ajustar e retirar',
          texto: 'Com uma reserva selecionada, você tem três ações: <strong>Guardar Dinheiro</strong> (faz um aporte e desconta do saldo), <strong>Ajustar Valor</strong> (corrige o total guardado ou muda a meta sem mexer no saldo) e <strong>Retirar</strong> (devolve o dinheiro ao saldo, com rastreio completo).',
          dica: 'Use "Ajustar Valor" quando o saldo real da sua poupança diverge do app — ele só acerta o número. "Retirar" é para quando você realmente vai usar o dinheiro.',
        },
      ],
    },

    // ═══════════════ CARTÕES ═══════════════
    {
      id: 'cartoes', nome: 'Cartões', icon: 'fa-credit-card', cor: '#ec4899',
      resumo: 'Faturas, limites e parcelas sob controle.',
      passos: [
        {
          pagina: 'cartoes', seletor: null, pos: 'centro',
          icon: 'fa-credit-card', iconColor: '#ec4899',
          titulo: 'Cartões sem sustos',
          texto: 'O cartão é ótimo servo e péssimo patrão. Aqui você enxerga cada fatura por dentro — antes de ela chegar — para que o crédito trabalhe a seu favor, não contra.',
          dica: 'A pergunta certa antes de parcelar não é "cabe na parcela?", e sim "essa parcela vai estar competindo com o quê nos próximos meses?".',
        },
        {
          pagina: 'cartoes', seletor: '#cartoesGrid', pos: 'centro',
          icon: 'fa-credit-card', iconColor: '#ec4899',
          titulo: 'Seus cartões de crédito',
          texto: 'Cadastre cartões com <strong>limite e dia de fechamento</strong>. Cada fatura mostra compra a compra, com rastreamento de parcelas e assinaturas. Veja quanto do limite está comprometido — e <em>congele</em> um cartão para pausar o uso.',
        },
      ],
    },

    // ═══════════════ GRÁFICOS ═══════════════
    {
      id: 'graficos', nome: 'Gráficos', icon: 'fa-chart-pie', cor: '#06b6d4',
      resumo: 'Seus números viram imagem e fazem sentido.',
      passos: [
        {
          pagina: 'graficos', seletor: null, pos: 'centro',
          icon: 'fa-chart-pie', iconColor: '#06b6d4',
          titulo: 'Ver para entender',
          texto: 'Números numa tabela escondem padrões; um gráfico os revela na hora. É aqui que você descobre que "saiu mais que entrou" tem nome, categoria e tendência.',
        },
        {
          pagina: 'graficos', seletor: '.graficos-filtros', pos: 'baixo',
          icon: 'fa-chart-pie', iconColor: '#06b6d4',
          titulo: 'Gere sua análise visual',
          texto: 'Escolha mês e ano, a visão (<em>Individual, Casal ou Família</em>) e toque em <strong>Gerar Gráficos</strong>: distribuição por categoria, evolução do saldo e muito mais ganham vida.',
        },
        {
          pagina: 'graficos', seletor: '.comparacao-toggle', pos: 'baixo',
          icon: 'fa-balance-scale', iconColor: '#06b6d4',
          titulo: 'Comparativos de período',
          texto: 'Ative os <strong>gráficos comparativos</strong> para colocar dois meses lado a lado. Gastou mais ou menos? Em qual categoria? Ideal para medir o efeito das suas decisões.',
          dica: 'Compare sempre o mês atual com o mesmo mês do ano passado: revela gastos sazonais (festas, impostos, matrícula) que o mês anterior esconde.',
        },
      ],
    },

    // ═══════════════ RELATÓRIOS ═══════════════
    {
      id: 'relatorios', nome: 'Relatórios', icon: 'fa-file-alt', cor: '#f97316',
      resumo: 'Análises profundas, score e exportação.',
      passos: [
        {
          pagina: 'relatorios', seletor: null, pos: 'centro',
          icon: 'fa-file-alt', iconColor: '#f97316',
          titulo: 'O retrato completo das suas finanças',
          texto: 'Enquanto os gráficos mostram um recorte, os relatórios costuram a história inteira: onde foi seu dinheiro, como seu patrimônio evolui e quão saudável está sua vida financeira.',
        },
        {
          pagina: 'relatorios', seletor: '.rel-filtros', pos: 'baixo',
          icon: 'fa-file-alt', iconColor: '#f97316',
          titulo: 'Gere relatórios completos',
          texto: 'Escolha o tipo — <em>Individual, Casal, Família ou Visão Geral</em> — selecione o período e gere em um toque. Análises profundas de gastos, evolução patrimonial e histórico.',
        },
        {
          pagina: 'relatorios', seletor: '.rel-header-actions', pos: 'baixo',
          icon: 'fa-file-export', iconColor: '#f97316',
          titulo: 'Exporte e compartilhe',
          texto: 'Leve seus dados para onde quiser: <strong>CSV, Excel, PDF</strong> ou uma <em>apresentação animada</em>. Perfeito para planejar com a família, prestar contas ou guardar um registro mensal.',
        },
        {
          pagina: 'relatorios', seletor: null, pos: 'centro',
          icon: 'fa-trophy', iconColor: '#f59e0b',
          titulo: 'Score financeiro',
          texto: 'O app avalia sua <strong>saúde financeira</strong> com base em orçamentos cumpridos, reservas, dívidas e fundo de emergência — e gera uma pontuação com <em>dicas personalizadas</em> para subir de nível.',
          dica: 'Trate o score como um jogo cooperativo com você mesmo: a meta não é a nota perfeita, é vê-la subir um pouquinho a cada mês.',
        },
      ],
    },

    // ═══════════════ NOTIFICAÇÕES ═══════════════
    {
      id: 'notificacoes', nome: 'Notificações', icon: 'fa-bell', cor: '#eab308',
      resumo: 'O app te avisa antes do problema acontecer.',
      passos: [
        {
          pagina: 'dashboard', seletor: '#btnNotificacoes', pos: 'esquerda',
          icon: 'fa-bell', iconColor: '#eab308',
          titulo: 'Central de notificações',
          texto: 'Vencimentos, orçamentos estourando, novidades do app — tudo chega aqui. É a forma do GranaEvo te cutucar no momento certo, antes do prejuízo.',
        },
        {
          pagina: 'configuracoes', seletor: '#btnTogglePush', expandir: '.cfg-list', pos: 'esquerda',
          icon: 'fa-bell', iconColor: '#0ea5e9',
          titulo: 'Notificações push no celular',
          texto: 'Ative as <strong>notificações push</strong> nas Configurações para receber alertas direto no celular, <em>mesmo com o app fechado</em>. Assim você nunca depende de lembrar de abrir o app.',
          dica: 'Push é o que transforma o app de "lugar que eu visito" em "assistente que me avisa". Vale muito a pena ativar.',
        },
      ],
    },

    // ═══════════════ CONFIGURAÇÕES ═══════════════
    {
      id: 'configuracoes', nome: 'Configurações', icon: 'fa-cog', cor: '#6366f1',
      resumo: 'Conta, convidados, tema, backup e plano.',
      passos: [
        {
          pagina: 'configuracoes', seletor: null, pos: 'centro',
          icon: 'fa-cog', iconColor: '#6366f1',
          titulo: 'O app do seu jeito',
          texto: 'Aqui você cuida da conta, da segurança, da aparência e dos seus dados. Vale conhecer cada opção uma vez — depois é só ajustar quando precisar.',
        },
        {
          pagina: 'configuracoes', seletor: '#btnAlterarSenha', expandir: '.cfg-list', pos: 'direita',
          icon: 'fa-user-shield', iconColor: '#8b5cf6',
          titulo: 'Conta e segurança',
          texto: 'Altere sua <strong>senha</strong> quando quiser e use <strong>Trocar Perfil</strong> para alternar entre perfis da mesma conta. Cada perfil tem dados totalmente separados — ótimo para separar finanças pessoais e do negócio.',
        },
        {
          pagina: 'configuracoes', seletor: '#btnAlterarEmail', expandir: '.cfg-list', pos: 'direita',
          icon: 'fa-user-plus', iconColor: '#10b981',
          titulo: 'Convidar usuário',
          texto: textoConvite,
          dica: planoCompartilhado
            ? 'Finanças em casal/família funcionam melhor quando todos enxergam o mesmo painel. Transparência evita a maior parte das brigas por dinheiro.'
            : null,
        },
        {
          pagina: 'configuracoes', seletor: '#btnToggleTema', expandir: '.cfg-list', pos: 'esquerda',
          icon: 'fa-sliders-h', iconColor: '#6366f1',
          titulo: 'Personalize o app',
          texto: 'Alterne entre tema <strong>claro ou escuro</strong>, <strong>instale o GranaEvo</strong> na tela inicial como aplicativo, ative <strong>push</strong> e a <strong>navegação por swipe</strong>. O modo offline mantém seus dados acessíveis mesmo sem internet.',
        },
        {
          pagina: 'configuracoes', seletor: '#btnHistoricoBackup', expandir: '.cfg-list', pos: 'esquerda',
          icon: 'fa-shield-alt', iconColor: '#14b8a6',
          titulo: 'Seus dados, protegidos',
          texto: 'O <strong>backup automático</strong> guarda os últimos 7 dias — restaure qualquer versão em um toque. Quer recomeçar? <em>Resetar Perfil</em> apaga os dados financeiros, mas cria um backup antes, por segurança.',
        },
        {
          pagina: 'configuracoes', seletor: '#btnGerenciarAssinatura', expandir: '.cfg-list', pos: 'esquerda',
          icon: 'fa-crown', iconColor: '#f59e0b',
          titulo: 'Seu plano e este guia',
          texto: 'Gerencie a assinatura — <strong>alterar plano, trocar cartão ou cancelar</strong> — em Gerenciar Assinatura. E o botão <em>Como Usar</em> reabre esta Central de Aprendizado sempre que precisar.',
        },
      ],
    },

    // ═══════════════ PERFIL ═══════════════
    {
      id: 'perfil', nome: 'Perfil', icon: 'fa-user-circle', cor: '#f59e0b',
      resumo: 'Sua foto, seus níveis e suas conquistas.',
      passos: [
        {
          pagina: 'dashboard', seletores: ['#userPhotoBtn', '#mobileUserPhoto'], pos: 'esquerda',
          icon: 'fa-user-circle', iconColor: '#f59e0b',
          titulo: 'Sua foto abre o hub de perfil',
          texto: 'Toque na sua <strong>foto de perfil</strong> para abrir o hub: trocar a imagem, alternar entre perfis e acessar seu progresso. É o seu canto pessoal dentro do app.',
        },
        {
          pagina: 'dashboard', seletores: ['#userPhotoBtn', '#mobileUserPhoto'], pos: 'esquerda',
          icon: 'fa-medal', iconColor: '#f59e0b',
          titulo: 'Níveis e títulos',
          texto: 'Usar o app com consistência rende <strong>XP</strong> e faz você subir de nível — de <em>Iniciante</em> a <em>Lenda das Finanças</em>. Não é só enfeite: é um termômetro lúdico de quão ativo você está cuidando do seu dinheiro.',
        },
        {
          pagina: 'dashboard', seletores: ['#userPhotoBtn', '#mobileUserPhoto'], pos: 'esquerda',
          icon: 'fa-trophy', iconColor: '#fbbf24',
          titulo: 'Conquistas',
          texto: 'Dentro do hub de perfil você encontra as <strong>Conquistas</strong>: dezenas de marcos para desbloquear, das mais <em>comuns</em> às <em>lendárias</em> — primeira reserva, primeiro milhão, contas sempre em dia… Cada uma conta uma parte da sua jornada.',
          dica: 'Conquistas existem para tornar o hábito divertido. Use-as como pequenas metas: bater uma de cada vez é mais leve do que mirar tudo de uma vez.',
        },
      ],
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRILHA ESSENCIAL — primeiro contato, curta e certeira
// ─────────────────────────────────────────────────────────────────────────────
function montarEssencial(perfil) {
  const { isGuest = false } = perfil;
  const passos = [
    {
      pagina: null, seletor: null, pos: 'centro', secao: null,
      icon: 'fa-rocket', iconColor: '#10b981',
      titulo: isGuest ? 'Bem-vindo ao GranaEvo!' : 'Vamos começar pelo essencial',
      texto: isGuest
        ? 'Você foi convidado para acompanhar as finanças do grupo. Este guia rápido mostra o básico em poucos passos — depois você pode se aprofundar quando quiser.'
        : 'Em menos de um minuto você vai dominar o básico: lançar, organizar e guardar. O resto você aprofunda quando quiser, categoria por categoria.',
    },
    {
      pagina: 'dashboard', seletores: ['.sidebar-nav', '.mobile-bottom-nav'], pos: 'centro', secao: 'Início',
      icon: 'fa-compass', iconColor: '#6366f1',
      titulo: 'Navegação',
      texto: 'Tudo a um toque: <strong>Dashboard, Transações, Reservas, Cartões, Gráficos e Relatórios</strong>. No celular, a barra fica na parte inferior da tela.',
    },
    {
      pagina: 'transacoes', seletor: '.transaction-form', pos: 'baixo', secao: 'Transações',
      icon: 'fa-plus-circle', iconColor: '#10b981',
      titulo: 'Lance sua primeira transação',
      texto: 'Registre <strong>entradas e saídas</strong> em segundos. É o gesto que alimenta todo o resto do app. Errou? Toque no item no histórico e edite — nada é permanente.',
    },
    {
      pagina: 'dashboard', seletor: '#sectionContasFixas', pos: 'cima', secao: 'Contas',
      icon: 'fa-file-invoice-dollar', iconColor: '#f59e0b',
      titulo: 'Cadastre suas contas fixas',
      texto: 'Aluguel, internet, energia… o que se repete todo mês. O app gera os <strong>alertas de vencimento</strong> sozinho para você nunca mais pagar multa por esquecimento.',
    },
    {
      pagina: 'reservas', seletor: '.reservas-sidebar', pos: 'direita', secao: 'Reservas',
      icon: 'fa-piggy-bank', iconColor: '#a78bfa',
      titulo: 'Crie uma reserva',
      texto: 'Dê nome e valor a um objetivo e o <em>simulador</em> calcula quanto guardar por mês.',
      dica: 'Comece pelo fundo de emergência: 3 a 6 meses dos seus custos fixos. É a reserva que te protege de transformar qualquer imprevisto em dívida.',
    },
  ];

  passos.push({
    pagina: null, seletor: null, pos: 'centro', secao: null, ultimo: true,
    icon: 'fa-circle-check', iconColor: '#10b981',
    titulo: 'Pronto para evoluir!',
    texto: 'Esse era o essencial. Quando quiser <strong>se aprofundar</strong> em qualquer área — Reservas, Cartões, Gráficos, Perfil e mais — abra a Central de Aprendizado em <em>Configurações → Como Usar</em>.',
  });
  return passos;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Passos de encerramento
// ─────────────────────────────────────────────────────────────────────────────
function passoFimCategoria(catNome) {
  return {
    pagina: null, seletor: null, pos: 'centro', ultimo: true,
    icon: 'fa-circle-check', iconColor: '#10b981',
    titulo: `Guia de ${catNome} concluído!`,
    texto: 'Você dominou esta seção. Volte ao menu para explorar outra categoria — ou comece a aplicar agora mesmo.',
    voltarHub: true,
  };
}

const PASSO_CONCLUSAO_COMPLETO = {
  pagina: null, seletor: null, pos: 'centro', secao: null, ultimo: true,
  icon: 'fa-circle-check', iconColor: '#10b981',
  titulo: 'Você conhece cada canto do GranaEvo!',
  texto: 'Agora é com você: <strong>lance, organize e guarde</strong>. Em poucos dias você terá clareza financeira total — e esta Central de Aprendizado estará sempre em <em>Configurações → Como Usar</em>.',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Estado
// ─────────────────────────────────────────────────────────────────────────────
let _catalogo  = [];
let _perfil    = {};
let _modo      = 'hub';     // 'hub' | 'seq'
let _seqTipo   = null;      // 'categoria' | 'completo' | 'essencial'
let _passos    = [];
let _passo     = 0;
let _direcao   = 'centro';
let _backdrop  = null;
let _spotlight = null;
let _card      = null;
let _ativo     = false;
let _spRectAtual = null;
let _resizeTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
//  API pública
// ─────────────────────────────────────────────────────────────────────────────
export function iniciarTutorial(perfil = {}) {
  if (_ativo) return;
  _ativo    = true;
  _perfil   = perfil || {};
  _catalogo = montarCatalogo(_perfil);
  _montar();

  if (perfil.trilha === 'essencial') {
    _rodarEssencial();
  } else {
    _abrirHub();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Montagem / desmontagem
// ─────────────────────────────────────────────────────────────────────────────
function _montar() {
  _backdrop  = _el('div', 'tut-backdrop');
  _spotlight = _el('div', 'tut-spotlight tut-spot-oculto');
  // anel de pulso (GPU-only: anima transform/opacity, nunca box-shadow)
  _spotlight.appendChild(_el('span', 'tut-spot-ring'));
  _card      = _el('div', 'tut-card');
  document.body.append(_backdrop, _spotlight, _card);

  _backdrop.addEventListener('touchstart', _blk, { passive: false });
  _backdrop.addEventListener('touchmove',  _blk, { passive: false });
  document.addEventListener('wheel',   _blkWheel, { passive: false });
  document.addEventListener('keydown', _teclas, true);
  window.addEventListener('resize', _onResize);
}

function _desmontar() {
  if (!_card) return;

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
  }, 260);
}

function _blk(e)      { e.preventDefault(); }
function _blkWheel(e) { if (!e.target.closest('.tut-card')) e.preventDefault(); }

function _teclas(e) {
  if (!_ativo || !_card) return;
  if (e.key === 'Escape') {
    if (_modo === 'seq') { _abrirHub(); return; }
    _desmontar();
    return;
  }
  if (_modo !== 'seq') return;
  const ultimo   = _passo === _passos.length - 1 || _passos[_passo]?.ultimo;
  const primeiro = _passo === 0;
  if (e.key === 'ArrowRight' && !ultimo)   _ir(_passo + 1);
  else if (e.key === 'ArrowLeft' && !primeiro) _ir(_passo - 1);
}

function _onResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!_ativo || !_card) return;
    if (_modo === 'hub') { _posCard(null, 'centro', true); return; }
    const p = _passos[_passo];
    const spRect = _resolverRect(p);
    _spRectAtual = spRect;
    if (spRect?.height > 0) _posSpotlight(spRect);
    _posCard(spRect, p.pos, /*semAnimacao*/ true);
  }, 150);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUB — escolha de categorias
// ─────────────────────────────────────────────────────────────────────────────
function _abrirHub() {
  _modo    = 'hub';
  _seqTipo = null;
  _direcao = 'centro';
  _spotlight?.classList.add('tut-spot-oculto');
  _renderHub();
  requestAnimationFrame(() => { _posCard(null, 'centro'); });
}

function _renderHub() {
  _card.innerHTML = '';
  _card.style.removeProperty('--tut-color');

  const head = _el('div', 'tut-hub-head');
  const kicker = _el('span', 'tut-hub-kicker');
  kicker.innerHTML = '<i class="fas fa-graduation-cap" aria-hidden="true"></i> Central de Aprendizado';
  const h2 = _el('h2', 'tut-hub-title');
  h2.textContent = 'O que você quer aprender?';
  const sub = _el('p', 'tut-hub-sub');
  sub.textContent = 'Escolha uma área para um guia aprofundado — ou faça o tour completo de uma vez.';
  head.append(kicker, h2, sub);

  const grid = _el('div', 'tut-hub-grid');
  _catalogo.forEach((cat, i) => {
    const btn = _el('button', 'tut-hub-cat');
    btn.type = 'button';
    btn.style.setProperty('--cat-cor', cat.cor);
    btn.style.setProperty('--cat-delay', (i * 32) + 'ms');

    const ic = _el('span', 'tut-hub-cat-icon');
    const i1 = document.createElement('i');
    i1.className = `fas ${cat.icon}`;
    i1.setAttribute('aria-hidden', 'true');
    ic.appendChild(i1);

    const txt = _el('span', 'tut-hub-cat-txt');
    const nm = _el('span', 'tut-hub-cat-nome');
    nm.textContent = cat.nome;
    const rs = _el('span', 'tut-hub-cat-resumo');
    rs.textContent = cat.resumo;
    txt.append(nm, rs);

    const arrow = document.createElement('i');
    arrow.className = 'fas fa-chevron-right tut-hub-cat-seta';
    arrow.setAttribute('aria-hidden', 'true');

    btn.append(ic, txt, arrow);
    btn.addEventListener('click', () => _rodarCategoria(cat.id));
    grid.appendChild(btn);
  });

  const ctas = _el('div', 'tut-hub-ctas');
  const cTour = _el('button', 'tut-hub-cta tut-hub-cta--primaria');
  cTour.type = 'button';
  cTour.innerHTML = '<i class="fas fa-route" aria-hidden="true"></i> Fazer o Tour Completo';
  cTour.addEventListener('click', _rodarCompleto);

  const cEss = _el('button', 'tut-hub-cta');
  cEss.type = 'button';
  cEss.innerHTML = '<i class="fas fa-bolt" aria-hidden="true"></i> Trilha Essencial (rápida)';
  cEss.addEventListener('click', _rodarEssencial);

  ctas.append(cTour, cEss);

  const footer = _el('div', 'tut-hub-footer');
  const btnFechar = _el('button', 'tut-btn-pular');
  btnFechar.type = 'button';
  btnFechar.textContent = 'Fechar';
  btnFechar.addEventListener('click', () => _desmontar());
  footer.appendChild(btnFechar);

  _card.append(head, grid, ctas, footer);

  _card.setAttribute('tabindex', '0');
  _card.setAttribute('role', 'dialog');
  _card.setAttribute('aria-modal', 'true');
  _card.setAttribute('aria-label', 'Central de Aprendizado do GranaEvo');
  requestAnimationFrame(() => _card?.focus());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sequências (categoria / completo / essencial)
// ─────────────────────────────────────────────────────────────────────────────
function _injetarSecao(passos, secao) {
  return passos.map(p => ({ ...p, secao: p.secao ?? secao }));
}

function _rodarCategoria(id) {
  const cat = _catalogo.find(c => c.id === id);
  if (!cat) { _abrirHub(); return; }
  _seqTipo = 'categoria';
  _passos  = [..._injetarSecao(cat.passos, cat.nome), passoFimCategoria(cat.nome)];
  _iniciarSeq();
}

function _rodarCompleto() {
  _seqTipo = 'completo';
  const passos = [];
  _catalogo.forEach(cat => passos.push(..._injetarSecao(cat.passos, cat.nome)));
  passos.push(PASSO_CONCLUSAO_COMPLETO);
  _passos = passos;
  _iniciarSeq();
}

function _rodarEssencial() {
  _seqTipo = 'essencial';
  _passos  = montarEssencial(_perfil);
  _iniciarSeq();
}

function _iniciarSeq() {
  _modo    = 'seq';
  _passo   = 0;
  _direcao = 'centro';
  _ir(0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Navegação de passos
// ─────────────────────────────────────────────────────────────────────────────
async function _ir(idx) {
  if (!_ativo || _modo !== 'seq') return;
  idx = Math.max(0, Math.min(_passos.length - 1, idx));
  _direcao = idx > _passo ? 'avancar' : (idx < _passo ? 'voltar' : _direcao);

  const p = _passos[idx];
  _passo  = idx;

  // Esconde o spotlight durante a transição (o fade mascara o reposicionamento)
  _spotlight.classList.add('tut-spot-oculto');

  const paginaAtual = document.querySelector('.page.active')?.id?.replace('Page', '');
  if (p.pagina && paginaAtual !== p.pagina) {
    _navPara(p.pagina);
    await _esperarPagina(p.pagina);
  }

  await _esperarAlvo(p);

  const alvo = _resolverAlvo(p);
  if (alvo) {
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await _wait(360);
  }

  // Passo ainda é o atual? (usuário pode ter navegado durante o await)
  if (!_ativo || _modo !== 'seq' || _passos[_passo] !== p) return;

  const spRect = _resolverRect(p);
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

function _finalizarSeq() {
  if (_seqTipo === 'categoria') _abrirHub();
  else _desmontar();
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

function _resolverRect(p) {
  if (p.seletores) return _unionRect(p.seletores);
  const alvo = _resolverAlvo(p);
  if (!alvo) return null;
  const r = alvo.getBoundingClientRect();
  return r.height > 0 ? r : null;
}

async function _esperarPagina(pagina) {
  for (let i = 0; i < 16; i++) {
    await _wait(100);
    const atual = document.querySelector('.page.active')?.id?.replace('Page', '');
    if (atual === pagina) { await _wait(160); return; }
  }
}

async function _esperarAlvo(p) {
  const sel = p.seletor || (p.seletores && p.seletores[0]);
  if (!sel) return;
  for (let i = 0; i < 8; i++) {
    if (document.querySelector(sel)) return;
    await _wait(150);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Spotlight  (geometria instantânea — só opacidade transiciona; pulso = anel)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
//  Card de passo
// ─────────────────────────────────────────────────────────────────────────────
function _renderCard(p, idx) {
  const total    = _passos.length;
  const primeiro = idx === 0;
  const ultimo   = idx === total - 1 || p.ultimo;
  const pct      = Math.round(((idx + 1) / total) * 100);
  const iconColor = p.iconColor || '#10b981';

  _card.innerHTML = '';
  _card.style.setProperty('--tut-color', iconColor);

  // ── Header ──
  const header = _el('div', 'tut-header');

  const progressWrap = _el('div', 'tut-progress-wrap');
  const progressBar  = _el('div', 'tut-progress-bar');
  progressBar.style.width = pct + '%';
  progressBar.style.background = iconColor;
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

  const btnHome = _el('button', 'tut-home-btn');
  btnHome.type = 'button';
  btnHome.innerHTML = '<i class="fas fa-grip" aria-hidden="true"></i>';
  btnHome.title = 'Voltar ao menu de categorias';
  btnHome.setAttribute('aria-label', 'Voltar ao menu de categorias');
  btnHome.addEventListener('click', () => _abrirHub());

  headerRight.append(badge, btnHome);
  headerMeta.append(secaoEl, headerRight);
  header.append(progressWrap, headerMeta);

  // ── Body ──
  const body = _el('div', 'tut-body');

  const stepNum = _el('span', 'tut-step-num');
  stepNum.textContent = String(idx + 1).padStart(2, '0');
  stepNum.setAttribute('aria-hidden', 'true');
  body.appendChild(stepNum);

  const iconWrap = _el('div', 'tut-icon-wrap');
  iconWrap.style.background  = iconColor + '18';
  iconWrap.style.borderColor = iconColor + '40';
  iconWrap.style.boxShadow   = `0 4px 24px ${_hexToRgba(iconColor, 0.28)}`;
  const iconEl = document.createElement('i');
  iconEl.className = `fas ${p.icon || 'fa-star'}`;
  iconEl.style.color = iconColor;
  iconEl.setAttribute('aria-hidden', 'true');
  iconWrap.appendChild(iconEl);

  const titulo = _el('h3', 'tut-titulo');
  titulo.textContent = p.titulo;

  const texto = _el('p', 'tut-texto');
  texto.innerHTML = p.texto; // HTML estático hardcoded — safe

  body.append(iconWrap, titulo, texto);

  // Bloco de dica (importância / boa prática)
  if (p.dica) {
    const dica = _el('div', 'tut-dica');
    const di = document.createElement('i');
    di.className = 'fas fa-lightbulb';
    di.setAttribute('aria-hidden', 'true');
    const ds = _el('span', 'tut-dica-txt');
    ds.innerHTML = p.dica; // estático — safe
    dica.append(di, ds);
    body.appendChild(dica);
  }

  // ── Footer ──
  const footer = _el('div', 'tut-footer');

  const btnPular = _el('button', 'tut-btn-pular');
  btnPular.type = 'button';
  btnPular.textContent = _seqTipo === 'categoria' ? 'Menu' : 'Sair';
  btnPular.setAttribute('aria-label', _seqTipo === 'categoria' ? 'Voltar ao menu' : 'Sair do tutorial');
  btnPular.onclick = () => (_seqTipo === 'categoria' ? _abrirHub() : _desmontar());

  const nav = _el('div', 'tut-nav');

  const btnVoltar = _el('button', 'tut-btn-voltar');
  btnVoltar.type = 'button';
  btnVoltar.innerHTML = '<i class="fas fa-arrow-left" aria-hidden="true"></i>';
  btnVoltar.setAttribute('aria-label', 'Passo anterior');
  if (primeiro) { btnVoltar.disabled = true; btnVoltar.setAttribute('aria-disabled', 'true'); }
  btnVoltar.onclick = () => { if (!primeiro) _ir(_passo - 1); };

  const btnAvancar = _el('button', 'tut-btn-avancar');
  btnAvancar.type = 'button';
  if (ultimo) {
    btnAvancar.classList.add('tut-btn-avancar--concluir');
    if (p.voltarHub) {
      btnAvancar.innerHTML = '<i class="fas fa-grip" aria-hidden="true"></i> Voltar ao menu';
      btnAvancar.setAttribute('aria-label', 'Voltar ao menu de categorias');
    } else {
      btnAvancar.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> Concluir';
      btnAvancar.setAttribute('aria-label', 'Concluir tutorial');
    }
  } else {
    btnAvancar.innerHTML = 'Próximo <i class="fas fa-arrow-right" aria-hidden="true"></i>';
    btnAvancar.setAttribute('aria-label', 'Próximo passo');
  }
  btnAvancar.onclick = () => (ultimo ? _finalizarSeq() : _ir(_passo + 1));

  nav.append(btnVoltar, btnAvancar);
  footer.append(btnPular, nav);

  _card.append(header, body, footer);

  _card.setAttribute('tabindex', '0');
  _card.setAttribute('role', 'dialog');
  _card.setAttribute('aria-modal', 'true');
  _card.setAttribute('aria-label', `Tutorial — ${p.titulo}`);
  requestAnimationFrame(() => _card?.focus());
}

function _secaoIcon(secao) {
  const map = {
    'Início':        'fa-compass',
    'Contas':        'fa-file-invoice-dollar',
    'Dashboard':     'fa-house',
    'Transações':    'fa-exchange-alt',
    'Reservas':      'fa-piggy-bank',
    'Cartões':       'fa-credit-card',
    'Gráficos':      'fa-chart-pie',
    'Relatórios':    'fa-file-alt',
    'Notificações':  'fa-bell',
    'Configurações': 'fa-cog',
    'Perfil':        'fa-user-circle',
  };
  return map[secao] || 'fa-circle';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Posicionamento do card
// ─────────────────────────────────────────────────────────────────────────────
function _posCard(spRect, pos, semAnimacao = false) {
  const isHub = _modo === 'hub';

  if (!semAnimacao) {
    _card.className = 'tut-card';
    void _card.offsetHeight; // força reflow p/ reiniciar a animação
  }

  const isMobile = window.innerWidth <= 768;
  const isUltimo = _modo === 'seq' && (_passo === _passos.length - 1 || _passos[_passo]?.ultimo);
  const GAP      = 12;

  const baseClass = semAnimacao
    ? _card.className.replace(/\btut-seta-\S+/g, '').replace(/\s+/g, ' ').trim()
    : `tut-card${isHub ? ' tut-card--hub' : ''} tut-entr-${isHub ? 'centro' : _direcao}${isUltimo ? ' tut-final' : ''}`;

  // ── Hub ou passo central: centralizado ──
  // (centragem por `top` — nunca por transform, que conflita com a animação de entrada)
  if (isHub || !spRect || pos === 'centro') {
    if (isMobile) {
      Object.assign(_card.style, {
        position: 'fixed',
        left:  GAP + 'px',
        right: GAP + 'px',
        width: (window.innerWidth - GAP * 2) + 'px',
        transform: '',
      });
      const ch = _card.offsetHeight || 300;
      _card.style.top    = Math.max(GAP, (window.innerHeight - ch) / 2) + 'px';
      _card.style.bottom = 'auto';
    } else {
      const CW = isHub ? Math.min(540, window.innerWidth - GAP * 2) : 400;
      const ch = _card.offsetHeight || 300;
      Object.assign(_card.style, {
        position: 'fixed',
        left: ((window.innerWidth - CW) / 2) + 'px',
        top:  Math.max(GAP, (window.innerHeight - ch) / 2) + 'px',
        width: CW + 'px',
        right: '', bottom: '', transform: '',
      });
    }
    _card.className = baseClass;
    return;
  }

  // ── Mobile (passo com alvo): ancora em cima/baixo ──
  if (isMobile) {
    Object.assign(_card.style, {
      position: 'fixed',
      left:  GAP + 'px',
      right: GAP + 'px',
      width: (window.innerWidth - GAP * 2) + 'px',
      top: '', bottom: '', transform: '',
    });
    const elCenter = spRect ? (spRect.top + spRect.height / 2) : 0;
    if (spRect && elCenter > window.innerHeight * 0.5) {
      _card.style.top = (GAP + 8) + 'px';
      _card.style.bottom = 'auto';
    } else {
      _card.style.bottom = '84px';
      _card.style.top = 'auto';
    }
    _card.className = baseClass;
    return;
  }

  // ── Desktop (passo com alvo): ao lado do spotlight ──
  const CW    = 400;
  const GAP_D = 24;
  const vw    = window.innerWidth;
  const vh    = window.innerHeight;
  const ch    = _card.offsetHeight || 290;
  const cx    = spRect.left + spRect.width / 2;

  let top = 0, left = 0, seta = '';
  switch (pos) {
    case 'baixo':
      top = spRect.bottom + GAP_D; left = cx - CW / 2; seta = 'tut-seta-cima'; break;
    case 'cima':
      top = spRect.top - ch - GAP_D; left = cx - CW / 2; seta = 'tut-seta-baixo'; break;
    case 'direita':
      top = Math.max(GAP_D, spRect.top); left = spRect.right + GAP_D; seta = 'tut-seta-esq'; break;
    case 'esquerda':
      top = Math.max(GAP_D, spRect.top); left = spRect.left - CW - GAP_D; seta = 'tut-seta-dir'; break;
    default:
      top = (vh - ch) / 2; left = (vw - CW) / 2;
  }

  left = Math.max(GAP_D, Math.min(vw - CW - GAP_D, left));
  top  = Math.max(GAP_D, Math.min(vh - ch - GAP_D, top));

  Object.assign(_card.style, {
    position: 'fixed', top: top + 'px', left: left + 'px', width: CW + 'px',
    right: '', bottom: '', transform: '',
  });
  _card.className = `${baseClass}${seta ? ' ' + seta : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Navegação entre seções do app
// ─────────────────────────────────────────────────────────────────────────────
function _navPara(pagina) {
  const btn = document.querySelector(`[data-page="${pagina}"]`);
  if (btn) { btn.click(); return; }
  if (pagina === 'configuracoes') document.getElementById('mobileSettingsBtn')?.click();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
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
