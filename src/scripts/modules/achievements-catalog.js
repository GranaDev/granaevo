// achievements-catalog.js — APRESENTAÇÃO das conquistas (lazy).
// ----------------------------------------------------------------------------
// Título, descrição, ícone, categoria e barra de progresso de cada conquista,
// casados por `id` com o catálogo de avaliação em achievements.js.
//
// Por que separado: achievements.js é importado ESTATICAMENTE pelo dashboard
// (chunk crítico, orçamento gzip apertado). Os textos longos em PT-BR são o que
// mais pesa no gzip, então moram aqui — carregado só na tela de Configurações
// (via achievements-ui.js) e, sob demanda, pelo toast (import() em achievements.js).
//
// Tudo aqui é estático e renderizado com DOM seguro (textContent) na UI.
// ----------------------------------------------------------------------------

import { metrics, ACHIEVEMENTS, RARITY } from './achievements.js?v=2';

// Formatação BRL de fallback (a UI passa a do dashboard quando disponível).
function _brl(v) {
    try { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    catch { return 'R$ ' + Math.round(v); }
}

// ===================== ESCADA DE NÍVEIS / TÍTULOS =====================
// Títulos descontraídos, ganhos por XP acumulado. O XP máximo do catálogo
// passa de ~1900; o topo ("Lenda das Finanças") é alcançável sem precisar das
// conquistas quase impossíveis (R$1M, 500 transações). Fica aqui (lazy) porque
// nível/XP só são exibidos na tela de Configurações, nunca no dashboard.
export const LEVELS = Object.freeze([
    { nivel: 1,  titulo: 'Iniciante',                xp: 0    },
    { nivel: 2,  titulo: 'Pé-de-Meia',               xp: 40   },
    { nivel: 3,  titulo: 'Poupador',                 xp: 100  },
    { nivel: 4,  titulo: 'Organizado',               xp: 180  },
    { nivel: 5,  titulo: 'Economista',               xp: 280  },
    { nivel: 6,  titulo: 'Disciplinado',             xp: 400  },
    { nivel: 7,  titulo: 'Estrategista',             xp: 540  },
    { nivel: 8,  titulo: 'Investidor',               xp: 700  },
    { nivel: 9,  titulo: 'Mestre das Finanças',      xp: 880  },
    { nivel: 10, titulo: 'Tubarão dos Investimentos',xp: 1080 },
    { nivel: 11, titulo: 'Magnata',                  xp: 1300 },
    { nivel: 12, titulo: 'Lenda das Finanças',       xp: 1550 },
    // Degraus novos (2026-07): com as conquistas de reserva compartilhada,
    // parcelamento e desafios, o teto de XP subiu — sem estes o jogador ficaria
    // travado no 12 com XP sobrando, que é a pior sensação possível num sistema
    // de progressão. O espaçamento cresce (+270, +290, …) para o topo continuar
    // sendo uma conquista de longo prazo, não um degrau que se sobe sem querer.
    { nivel: 13, titulo: 'Guardião do Patrimônio',   xp: 1820 },
    { nivel: 14, titulo: 'Arquiteto Financeiro',     xp: 2110 },
    { nivel: 15, titulo: 'Mente Milionária',         xp: 2420 },
    // 2580 de ~2865 XP possíveis (~90%): exige quase tudo, mas deixa folga real.
    // A 2750 o topo virava "conquistou 96% do catálogo" — quem perdesse duas
    // épicas ficaria travado para sempre, e nível inalcançável desmotiva mais do
    // que não existir.
    { nivel: 16, titulo: 'Imortal das Finanças',     xp: 2580 },
]);

/** Soma de XP + nível/título derivados do mapa de desbloqueios.
 *  Itera o CATÁLOGO (ids confiáveis), nunca as chaves do mapa do cliente. */
export function computeLevel(unlocked) {
    unlocked = unlocked && typeof unlocked === 'object' ? unlocked : {};
    let xp = 0;
    for (const a of ACHIEVEMENTS) {
        if (unlocked[a.id]) xp += RARITY[a.rarity].xp;
    }
    let lvl = LEVELS[0], next = null;
    for (let i = 0; i < LEVELS.length; i++) {
        if (xp >= LEVELS[i].xp) { lvl = LEVELS[i]; next = LEVELS[i + 1] || null; }
    }
    const base = lvl.xp;
    const ceil = next ? next.xp : lvl.xp;
    const pct  = next ? Math.min(100, Math.round(((xp - base) / (ceil - base)) * 100)) : 100;
    return {
        xp,
        nivel: lvl.nivel,
        titulo: lvl.titulo,
        proxTitulo: next ? next.titulo : null,
        xpFalta: next ? (ceil - xp) : 0,
        pct,
    };
}

// ===================== CATEGORIAS (agrupamento / filtro na UI) =====================
export const CATEGORIES = Object.freeze([
    { key: 'inicio',      label: 'Primeiros Passos', icon: 'fa-rocket' },
    { key: 'patrimonio',  label: 'Patrimônio',       icon: 'fa-sack-dollar' },
    { key: 'reservas',    label: 'Reservas & Metas', icon: 'fa-bullseye' },
    { key: 'habito',      label: 'Hábito & Disciplina', icon: 'fa-fire' },
    { key: 'organizacao', label: 'Organização',      icon: 'fa-folder-open' },
    // Estas 3 já eram usadas por conquistas do catálogo mas NÃO estavam
    // declaradas aqui — e a UI só renderiza o que está em CATEGORIES
    // (achievements-ui.js: `items.filter(i => i.cat === catDef.key)`), então
    // essas conquistas existiam e nunca apareciam para ninguém.
    { key: 'cartoes',     label: 'Cartões & Faturas', icon: 'fa-credit-card' },
    { key: 'desafios',    label: 'Desafios',         icon: 'fa-dumbbell' },
    { key: 'uso',         label: 'Jornada',          icon: 'fa-hourglass-half' },
    { key: 'secretas',    label: 'Secretas',         icon: 'fa-user-secret' },
]);

// ===================== APRESENTAÇÃO (id → { titulo, desc, icon, cat, progresso? }) =====================
export const PRESENT = Object.freeze({
    // ---- Primeiros passos ----
    primeiro_perfil:     { cat: 'inicio', icon: 'fa-building-columns', titulo: 'Primeiro Passo',   desc: 'Criou seu primeiro perfil no GranaEvo.' },
    primeira_transacao:  { cat: 'inicio', icon: 'fa-pen-to-square', titulo: 'Mãos à Obra',      desc: 'Registrou sua primeira transação.' },
    primeira_entrada:    { cat: 'inicio', icon: 'fa-money-bill', titulo: 'Primeiro Trocado', desc: 'Registrou sua primeira entrada de dinheiro.' },
    primeira_saida:      { cat: 'inicio', icon: 'fa-receipt', titulo: 'Primeiro Gasto',   desc: 'Registrou sua primeira saída de dinheiro.' },
    primeiro_cartao:     { cat: 'inicio', icon: 'fa-credit-card', titulo: 'Plástico na Mesa', desc: 'Cadastrou seu primeiro cartão de crédito.' },
    primeira_reserva:    { cat: 'inicio', icon: 'fa-bullseye', titulo: 'Sonhador',         desc: 'Criou sua primeira meta / reserva.' },
    primeira_conta:      { cat: 'inicio', icon: 'fa-calendar-days', titulo: 'Contas em Dia',    desc: 'Cadastrou sua primeira conta fixa.' },
    primeira_assinatura: { cat: 'inicio', icon: 'fa-arrows-rotate', titulo: 'Vida Recorrente',  desc: 'Cadastrou uma assinatura recorrente.' },
    orcamento_definido:  { cat: 'inicio', icon: 'fa-sliders', titulo: 'Planejador',       desc: 'Definiu um orçamento para alguma categoria.' },
    quebrou_cofre:       { cat: 'inicio', icon: 'fa-piggy-bank', titulo: 'Quebrou o Cofre',  desc: 'Fez sua primeira retirada de uma reserva.' },

    // ---- Patrimônio ----
    patrimonio_1k:   { cat: 'patrimonio', icon: 'fa-coins', titulo: 'Primeiro Mil',     desc: 'Acumulou R$ 1.000 de patrimônio (saldo + reservas).', progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 1000,    fmt: _brl }) },
    patrimonio_10k:  { cat: 'patrimonio', icon: 'fa-sack-dollar', titulo: 'Cinco Dígitos',    desc: 'Alcançou R$ 10.000 de patrimônio.',                   progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 10000,   fmt: _brl }) },
    patrimonio_50k:  { cat: 'patrimonio', icon: 'fa-trophy', titulo: 'Meio Caminho',     desc: 'Alcançou R$ 50.000 de patrimônio.',                   progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 50000,   fmt: _brl }) },
    patrimonio_100k: { cat: 'patrimonio', icon: 'fa-crown', titulo: 'Seis Dígitos',     desc: 'Alcançou R$ 100.000 de patrimônio.',                  progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 100000,  fmt: _brl }) },
    patrimonio_250k: { cat: 'patrimonio', icon: 'fa-chess-rook', titulo: 'Patrimônio Sólido',desc: 'Alcançou R$ 250.000 de patrimônio.',                  progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 250000,  fmt: _brl }) },
    patrimonio_500k: { cat: 'patrimonio', icon: 'fa-gem', titulo: 'Quase Milionário', desc: 'Alcançou R$ 500.000 de patrimônio.',                  progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 500000,  fmt: _brl }) },
    patrimonio_1m:   { cat: 'patrimonio', icon: 'fa-medal', titulo: 'Primeiro Milhão',  desc: 'Alcançou R$ 1.000.000 de patrimônio. Lenda!',         progresso: (s) => ({ atual: metrics.patrimonio(s), alvo: 1000000, fmt: _brl }) },

    // ---- Reservas / metas ----
    reserva_5k:            { cat: 'reservas', icon: 'fa-shield-halved', titulo: 'Colchão de Segurança', desc: 'Juntou R$ 5.000 somando todas as reservas.',  progresso: (s) => ({ atual: metrics.reservado(s), alvo: 5000,  fmt: _brl }) },
    reserva_20k:           { cat: 'reservas', icon: 'fa-building-columns', titulo: 'Cofre Cheio',          desc: 'Juntou R$ 20.000 somando todas as reservas.', progresso: (s) => ({ atual: metrics.reservado(s), alvo: 20000, fmt: _brl }) },
    meta_concluida:        { cat: 'reservas', icon: 'fa-circle-check', titulo: 'Objetivo Alcançado',   desc: 'Concluiu uma meta (juntou 100% do objetivo).' },
    duas_metas_concluidas: { cat: 'reservas', icon: 'fa-medal', titulo: 'Realizador em Série',  desc: 'Concluiu 2 metas. Foco total!' },
    meta_grande:           { cat: 'reservas', icon: 'fa-mountain', titulo: 'Grande Conquista',     desc: 'Concluiu uma meta de R$ 10.000 ou mais.' },
    tres_metas:            { cat: 'reservas', icon: 'fa-dice', titulo: 'Multi-Metas',          desc: 'Mantém 3 reservas ativas ao mesmo tempo.',    progresso: (s) => ({ atual: s.metas.length, alvo: 3 }) },
    cinco_metas:           { cat: 'reservas', icon: 'fa-star', titulo: 'Colecionador de Sonhos',desc: 'Mantém 5 reservas ativas ao mesmo tempo.',   progresso: (s) => ({ atual: s.metas.length, alvo: 5 }) },
    reserva_emergencia:    { cat: 'reservas', icon: 'fa-fire-extinguisher', titulo: 'Blindado',             desc: 'Suas reservas cobrem 3x seu gasto mensal médio.' },

    // ---- Hábito / consistência ----
    dez_transacoes:         { cat: 'habito', icon: 'fa-chart-simple', titulo: 'Contador',         desc: 'Registrou 10 transações.',                       progresso: (s) => ({ atual: s.transacoes.length, alvo: 10 }) },
    vinte_cinco_transacoes: { cat: 'habito', icon: 'fa-gear', titulo: 'Engrenando',       desc: 'Registrou 25 transações. Pegando o ritmo!',      progresso: (s) => ({ atual: s.transacoes.length, alvo: 25 }) },
    cinquenta_transacoes:   { cat: 'habito', icon: 'fa-clipboard-list', titulo: 'Constante',        desc: 'Registrou 50 transações.',                       progresso: (s) => ({ atual: s.transacoes.length, alvo: 50 }) },
    cem_transacoes:         { cat: 'habito', icon: 'fa-book', titulo: 'Maratonista',      desc: 'Registrou 100 transações. Que disciplina!',      progresso: (s) => ({ atual: s.transacoes.length, alvo: 100 }) },
    mes_positivo:           { cat: 'habito', icon: 'fa-arrow-trend-up', titulo: 'No Azul',          desc: 'Fechou um mês com entradas maiores que saídas.' },
    tres_meses_positivos:   { cat: 'habito', icon: 'fa-clover', titulo: 'Trinca Verde',     desc: 'Fechou 3 meses no azul (entradas > saídas).' },
    economia_30:            { cat: 'habito', icon: 'fa-scissors', titulo: 'Economia de Mestre',desc: 'Economizou 30% da sua renda em um mês.' },
    economia_50:            { cat: 'habito', icon: 'fa-cube', titulo: 'Pão-Duro Lendário',desc: 'Economizou 50% da sua renda em um mês. Impressionante!' },
    tres_meses:             { cat: 'habito', icon: 'fa-fire', titulo: 'Disciplina',       desc: 'Registrou movimentações em 3 meses diferentes.', progresso: (s) => ({ atual: metrics.mesesAtivos(s), alvo: 3 }) },
    seis_meses:             { cat: 'habito', icon: 'fa-calendar-days', titulo: 'Veterano',         desc: 'Acompanhou suas finanças por 6 meses diferentes.',progresso: (s) => ({ atual: metrics.mesesAtivos(s), alvo: 6 }) },
    doze_meses:             { cat: 'habito', icon: 'fa-ribbon', titulo: 'Ano Completo',     desc: 'Acompanhou suas finanças por 12 meses diferentes.',progresso: (s) => ({ atual: metrics.mesesAtivos(s), alvo: 12 }) },
    duzentas_transacoes:    { cat: 'habito', icon: 'fa-mountain', titulo: 'Imparável',        desc: 'Registrou 200 transações.',                       progresso: (s) => ({ atual: s.transacoes.length, alvo: 200 }) },
    seis_meses_positivos:   { cat: 'habito', icon: 'fa-gem', titulo: 'Semestre de Ouro', desc: 'Fechou 6 meses no azul (entradas > saídas).' },

    // ---- Desafios ----
    primeiro_desafio: { cat: 'habito', icon: 'fa-dumbbell', titulo: 'Desafiante',          desc: 'Venceu seu primeiro desafio financeiro.' },
    tres_desafios:    { cat: 'habito', icon: 'fa-fire', titulo: 'Trio de Vitórias',    desc: 'Venceu 3 desafios financeiros.' },
    dez_desafios:     { cat: 'habito', icon: 'fa-crown', titulo: 'Rei dos Desafios',    desc: 'Venceu 10 desafios financeiros. Disciplina de ferro!' },

    // ---- Organização ----
    tres_cartoes:     { cat: 'organizacao', icon: 'fa-briefcase', titulo: 'Carteira Cheia',      desc: 'Cadastrou 3 cartões de crédito.',          progresso: (s) => ({ atual: s.cartoesCredito.length, alvo: 3 }) },
    cinco_cartoes:    { cat: 'organizacao', icon: 'fa-box-archive', titulo: 'Magnata do Plástico', desc: 'Cadastrou 5 cartões de crédito.',          progresso: (s) => ({ atual: s.cartoesCredito.length, alvo: 5 }) },
    tres_contas:      { cat: 'organizacao', icon: 'fa-house', titulo: 'Casa Organizada',     desc: 'Cadastrou 3 contas fixas.',                progresso: (s) => ({ atual: s.contasFixas.length, alvo: 3 }) },
    cinco_contas:     { cat: 'organizacao', icon: 'fa-building-columns', titulo: 'Gestor da Casa',      desc: 'Cadastrou 5 contas fixas.',                progresso: (s) => ({ atual: s.contasFixas.length, alvo: 5 }) },
    tres_assinaturas: { cat: 'organizacao', icon: 'fa-tv', titulo: 'Assinante VIP',       desc: 'Cadastrou 3 assinaturas recorrentes.',     progresso: (s) => ({ atual: (s.assinaturas || []).length, alvo: 3 }) },
    orcamento_3:      { cat: 'organizacao', icon: 'fa-ruler-combined', titulo: 'Orçamentista',        desc: 'Definiu orçamento para 3 categorias.' },
    orcamento_5:      { cat: 'organizacao', icon: 'fa-calculator', titulo: 'Mestre do Orçamento', desc: 'Definiu orçamento para 5 categorias.' },
    orcamento_10:     { cat: 'organizacao', icon: 'fa-chess-rook', titulo: 'Controle Total',      desc: 'Definiu orçamento para 10 categorias.' },

    // ---- Secretas ----
    consciente:     { cat: 'secretas', icon: 'fa-briefcase', titulo: 'Preço da Vida',     desc: 'Ativou o Horas de Vida — agora cada gasto mostra seu custo real.' },
    economia_70:    { cat: 'secretas', icon: 'fa-shield-halved', titulo: 'Monge Financeiro',  desc: 'Economizou 70% da sua renda em um mês. Zen absoluto.' },
    coruja:         { cat: 'secretas', icon: 'fa-moon', titulo: 'Coruja Financeira', desc: 'Registrou uma transação na madrugada (0h–4h).' },
    madrugador:     { cat: 'secretas', icon: 'fa-sun', titulo: 'Madrugador',        desc: 'Registrou uma transação bem cedo (5h–8h).' },
    ano_novo:       { cat: 'secretas', icon: 'fa-champagne-glasses', titulo: 'Ano Novo, Vida Nova',desc: 'Registrou uma transação em 1º de janeiro.' },
    fim_de_semana:  { cat: 'secretas', icon: 'fa-calendar-week', titulo: 'Sábado de Contas',  desc: 'Registrou uma transação num fim de semana.' },
    dedicado:       { cat: 'secretas', icon: 'fa-dumbbell', titulo: 'Dedicação Total',   desc: 'Registrou 250 transações. Você vive o GranaEvo!' },
    quinhentas:     { cat: 'secretas', icon: 'fa-trophy', titulo: 'Quinhentas!',       desc: 'Registrou 500 transações. Lenda do registro!' },
    colecionador:   { cat: 'secretas', icon: 'fa-medal', titulo: 'Colecionador',      desc: 'Desbloqueou 20 conquistas. Caçador nato!' },
    cacador:        { cat: 'secretas', icon: 'fa-bullseye', titulo: 'Caçador de Troféus', desc: 'Desbloqueou 35 conquistas. Quase lá!' },
    perfeccionista: { cat: 'secretas', icon: 'fa-star', titulo: 'Perfeccionista',    desc: 'Desbloqueou TODAS as outras conquistas. Lenda viva!' },

    // ---- Reserva compartilhada e parcelamento (2026-07) ----
    reserva_familia:      { cat: 'reservas', icon: 'fa-users',        titulo: 'Cofre da Família',   desc: 'Criou uma reserva compartilhada com quem mora com você.' },
    familia_unida:        { cat: 'reservas', icon: 'fa-hands-holding-circle', titulo: 'Família Unida', desc: 'Duas pessoas ou mais já colocaram dinheiro na mesma reserva.' },
    primeira_parcela:     { cat: 'cartoes',  icon: 'fa-layer-group',  titulo: 'Parcelado',          desc: 'Registrou sua primeira compra parcelada no cartão.' },
    parcelamento_quitado: { cat: 'cartoes',  icon: 'fa-circle-check', titulo: 'Quitado!',           desc: 'Pagou todas as parcelas de uma compra. Dívida zerada.' },

    // ---- Novos degraus ----
    cinco_desafios: { cat: 'desafios', icon: 'fa-medal',         titulo: 'Desafiante',       desc: 'Venceu 5 desafios financeiros.' },
    dez_metas:      { cat: 'reservas', icon: 'fa-list-check',    titulo: 'Multi-Reservas',   desc: 'Mantém 10 reservas ao mesmo tempo.' },
    reserva_50k:    { cat: 'reservas', icon: 'fa-vault',         titulo: 'Meio Caminho',     desc: 'Acumulou R$ 50 mil guardados em reservas.' },
    mil_transacoes: { cat: 'uso',      icon: 'fa-infinity',      titulo: 'Mil Registros',    desc: 'Registrou 1.000 transações. Disciplina de outro nível.' },
    veterano:       { cat: 'uso',      icon: 'fa-hourglass-end', titulo: 'Veterano',         desc: 'Dois anos de finanças registradas no GranaEvo.' },
});

/** Apresentação de uma conquista por id, ou null. (hasOwnProperty: defesa.) */
export function getPresent(id) {
    return Object.prototype.hasOwnProperty.call(PRESENT, id) ? PRESENT[id] : null;
}
