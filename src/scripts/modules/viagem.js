// ----------------------------------------------------------------------------
// viagem.js — Modo viagem: quanto a viagem REALMENTE custou (item 11)
//
// Você volta de viagem e não faz ideia de quanto gastou. O dinheiro saiu em 40
// pedaços — táxi, café, jantar, lembrancinha — e nenhum deles parecia caro. O
// extrato do mês mistura tudo com a vida normal e a conta some. Ao ligar o modo
// viagem o app marca o início; ao desligar, fecha e diz o número.
//
// ── DECISÃO DE MODELAGEM: por que NÃO marcamos as transações ────────────────
// O caminho óbvio seria carimbar `viagemId` em cada transação criada com o modo
// ligado. Três motivos para não fazer isso, em ordem de peso:
//
//  1. TRANSAÇÃO NASCE EM MUITOS LUGARES: db-transacoes, db-cartoes (compra e
//     parcela), assistant/tx-builder, geração de conta fixa e de fatura. Carimbar
//     todas exigiria tocar em cada um — e ESQUECER UM significaria uma viagem que
//     conta errado, silenciosamente e só às vezes.
//  2. O SAVE TEM ALLOW-LIST DE CHAVES (dashboard.js, `dadosPerfil`): campo novo
//     que não esteja lá é DESCARTADO no save seguinte. Marcador em transação é
//     risco no caminho que já causou perda total de dados uma vez.
//  3. NÃO FUNCIONARIA RETROATIVAMENTE: quem esquecer de ligar o modo no aeroporto
//     e lembrar no 2º dia perderia o 1º — e é justamente aí (chegada, táxi,
//     hotel) que está o gasto grande.
//
// Como a regra do produto é "com o modo ligado, TODAS as despesas são da
// viagem", o custo é DERIVÁVEL da janela [início, fim]. Sem carimbo, sem tocar
// no save das transações, funciona para trás e corrigir a data conserta tudo.
//
// ── HONESTIDADE DO NÚMERO ───────────────────────────────────────────────────
// "Todas as despesas" inclui o aluguel que debitou enquanto você estava fora —
// e esse você pagaria de qualquer jeito, viajando ou não. Chamar isso de "custo
// da viagem" infla a conta e o usuário não confia mais. Por isso `analisarViagem`
// separa o gasto em DOIS números: o do período e o que a viagem realmente
// ADICIONOU (fora as fixas/faturas, identificadas por marcador de origem).
//
// 100% puro: sem DOM, sem rede, `hoje` injetável.
// ----------------------------------------------------------------------------

const _MS_DIA = 86_400_000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → Date local (meia-noite), ou null. */
export function isoParaData(iso) {
    if (typeof iso !== 'string' || !ISO_RE.test(iso)) return null;
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (isNaN(dt.getTime())) return null;
    // Rejeita data impossível que o Date "conserta" sozinho (31/02 → 03/03).
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
}

/** Date → 'YYYY-MM-DD' local (nunca toISOString: ele converte para UTC e vira o dia). */
export function dataParaIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Date → 'HH:MM:SS' local — mesmo formato do `hora` gravado em cada transação. */
export function horaDe(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

const HORA_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

// "DD/MM/YYYY" ou "YYYY-MM-DD" → Date (ou null). Mesmo parser dos módulos irmãos.
function _txDate(data) {
    if (typeof data !== 'string') return null;
    let y, m, d;
    if (/^\d{4}-\d{2}-\d{2}/.test(data)) {
        [y, m, d] = data.slice(0, 10).split('-').map(Number);
    } else if (/^\d{2}\/\d{2}\/\d{4}/.test(data)) {
        [d, m, y] = data.slice(0, 10).split('/').map(Number);
    } else {
        return null;
    }
    const dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Instante exato da transação (data + hora), e não só o dia.
 *
 * POR QUE A HORA IMPORTA (bug relatado em 2026-07-16): a 1ª versão comparava só
 * DATAS. Quem lançasse um gasto de manhã, ligasse o modo viagem à tarde e
 * lançasse outro, via os DOIS entrarem na viagem — porque ambos eram "do dia do
 * início". O usuário espera o óbvio: conta o que veio DEPOIS de ativar.
 *
 * Sem `hora` (lançamento importado/antigo) assume 00:00 — o mais conservador:
 * no dia da ativação, isso o deixa ANTES do início e fora da viagem, que é
 * exatamente a expectativa.
 */
function _txInstante(t) {
    const dt = _txDate(t?.data);
    if (!dt) return null;
    const m = typeof t?.hora === 'string' ? HORA_RE.exec(t.hora.trim()) : null;
    if (m) dt.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
    return dt;
}

/** Junta 'YYYY-MM-DD' + 'HH:MM:SS' num Date local. Sem hora → 00:00 do dia. */
function _instante(iso, hora, fallbackFimDoDia = false) {
    const dt = isoParaData(iso);
    if (!dt) return null;
    const m = typeof hora === 'string' ? HORA_RE.exec(hora.trim()) : null;
    if (m) dt.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
    else if (fallbackFimDoDia) dt.setHours(23, 59, 59, 999);
    return dt;
}

/** A viagem ativa do perfil, ou null. Fonte: config.viagem (sanitizada no save). */
export function viagemAtiva(configPerfil) {
    const v = configPerfil?.viagem;
    if (!v || typeof v !== 'object') return null;
    if (v.ativa !== true) return null;
    if (!isoParaData(v.inicio)) return null;
    return v;
}

/**
 * Fecha a janela da viagem, com precisão de HORA.
 *
 * `fim` só existe quando a viagem foi encerrada; até lá o fim é AGORA — uma
 * viagem em curso conta até este instante, não até o infinito.
 *
 * Compatibilidade: viagem gravada antes de existir `inicioHora` cai em 00:00 do
 * dia (o comportamento antigo), em vez de sumir.
 */
function _janela(viagem, hoje) {
    const inicio = _instante(viagem.inicio, viagem.inicioHora);
    if (!inicio) return null;

    const fim = viagem.fim
        ? _instante(viagem.fim, viagem.fimHora, /* fallbackFimDoDia */ true)
        : new Date(hoje);
    if (!fim || fim < inicio) return null;

    return { inicio, fim, diaInicio: isoParaData(viagem.inicio), diaFim: dataParaIso(fim) };
}

/**
 * Quanto a viagem custou.
 *
 * @param {Object} viagem     { inicio:'YYYY-MM-DD', fim?:'YYYY-MM-DD', nome? }
 * @param {Array}  transacoes
 * @param {Date}   hoje
 * @returns {{total, adicional, fixas, dias, porDia, nome, inicio, fim,
 *            emCurso, categorias:Array<{tipo,valor}>, transacoes:number}|null}
 *   total     — tudo que saiu na janela (a regra "todas as despesas")
 *   adicional — o que a viagem ADICIONOU: exclui fixas/faturas/parcelas, que
 *               seriam pagas de qualquer jeito. É o número honesto.
 *   fixas     — a diferença, mostrada à parte para o usuário conferir.
 */
export function analisarViagem(viagem, transacoes, hoje = new Date()) {
    if (!viagem || typeof viagem !== 'object') return null;
    const j = _janela(viagem, hoje);
    if (!j) return null;

    let total = 0;
    let fixas = 0;
    let n = 0;
    const porTipo = new Map();

    for (const t of (transacoes || [])) {
        if (t.categoria !== 'saida' && t.categoria !== 'saida_credito') continue;
        // Instante (data+hora), não só o dia: é o que faz "só o que lancei DEPOIS
        // de ativar" valer de verdade.
        const dt = _txInstante(t);
        if (!dt || dt < j.inicio || dt > j.fim) continue;
        const v = parseFloat(t.valor);
        if (!isFinite(v) || v <= 0) continue;

        total += v;
        n++;

        // Marcador de ORIGEM (id), nunca o rótulo `tipo`: comparar rótulo já foi
        // causa-raiz de bug aqui (previsao-mes e recorrencias, ambos em prod).
        const gerada = t.contaFixaId != null || t.faturaId != null || t.compraId != null;
        if (gerada) { fixas += v; continue; }

        const tipo = (typeof t.tipo === 'string' && t.tipo.trim()) || 'Outros';
        porTipo.set(tipo, (porTipo.get(tipo) || 0) + v);
    }

    // Dias em CALENDÁRIO (não horas/24): sair sexta às 22h e voltar sábado às
    // 9h é uma viagem de 2 dias para quem viajou, mesmo tendo 11h de duração.
    const d0 = new Date(j.inicio.getFullYear(), j.inicio.getMonth(), j.inicio.getDate());
    const d1 = new Date(j.fim.getFullYear(),    j.fim.getMonth(),    j.fim.getDate());
    const dias = Math.round((d1 - d0) / _MS_DIA) + 1;
    const adicional = total - fixas;

    return {
        nome:      (typeof viagem.nome === 'string' && viagem.nome.trim()) || 'Viagem',
        inicio:    j.diaInicio,
        fim:       j.diaFim,
        emCurso:   !viagem.fim,
        dias,
        total,
        adicional,
        fixas,
        porDia:    dias > 0 ? adicional / dias : 0,
        transacoes: n,
        categorias: [...porTipo.entries()]
            .map(([tipo, valor]) => ({ tipo, valor }))
            .sort((a, b) => b.valor - a.valor)
            .slice(0, 6),
    };
}

/**
 * Objeto de viagem novo, pronto para `config.viagem`.
 * Carimba a HORA: sem ela, o gasto que você lançou de manhã entraria numa
 * viagem ligada à tarde — foi o bug relatado na 1ª versão.
 */
export function iniciarViagem(nome, hoje = new Date()) {
    return {
        ativa:      true,
        nome:       String(nome ?? '').trim().slice(0, 60) || 'Viagem',
        inicio:     dataParaIso(hoje),
        inicioHora: horaDe(hoje),
        fim:        null,
        fimHora:    null,
    };
}

/**
 * Encerra a viagem. Devolve o objeto encerrado — quem chama decide se guarda
 * (histórico) ou descarta.
 */
export function encerrarViagem(viagem, hoje = new Date()) {
    if (!viagem || typeof viagem !== 'object') return null;
    // Carimba a hora do encerramento pelo mesmo motivo do início: o que você
    // lançar depois de desligar não é gasto de viagem.
    return { ...viagem, ativa: false, fim: dataParaIso(hoje), fimHora: horaDe(hoje) };
}

// ─────────────────────────── UI (única parte com DOM) ────────────────────────
// Mesma divisão de previsao-mes.js / sugestao-corte.js: motor puro acima,
// render aqui embaixo. Carregado sob demanda pelo botão em Configurações.

const _fmtDia = (iso) => {
    const d = isoParaData(iso);
    return d ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : iso;
};

function _linha(ctx, label, valor, forte) {
    const row = document.createElement('div');
    row.className = 'vg-row' + (forte ? ' vg-row--forte' : '');
    const l = document.createElement('span');
    l.className = 'vg-row-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'vg-row-valor';
    v.textContent = ctx.formatBRL(valor);
    row.appendChild(l);
    row.appendChild(v);
    return row;
}

/** Resumo de uma viagem (em curso ou encerrada) — devolve o nó, ou null. */
function _resumo(ctx, r) {
    if (!r) return null;
    const box = document.createElement('div');
    box.className = 'vg-resumo';

    const head = document.createElement('div');
    head.className = 'vg-resumo-head';
    const nome = document.createElement('div');
    nome.className = 'vg-resumo-nome';
    nome.textContent = r.nome;                       // textContent — nunca innerHTML
    const per = document.createElement('div');
    per.className = 'vg-resumo-periodo';
    per.textContent = `${_fmtDia(r.inicio)} → ${r.emCurso ? 'agora' : _fmtDia(r.fim)} · ${r.dias} ${r.dias === 1 ? 'dia' : 'dias'}`;
    head.appendChild(nome);
    head.appendChild(per);
    box.appendChild(head);

    const destaque = document.createElement('div');
    destaque.className = 'vg-destaque';
    destaque.textContent = ctx.formatBRL(r.adicional);
    box.appendChild(destaque);

    const sub = document.createElement('div');
    sub.className = 'vg-destaque-sub';
    sub.textContent = r.dias > 0 ? `${ctx.formatBRL(r.porDia)} por dia · ${r.transacoes} lançamentos` : '';
    box.appendChild(sub);

    // As contas fixas do período aparecem SEPARADAS de propósito: elas sairiam
    // da conta viajando ou não, e somá-las ao "custo da viagem" seria inflar o
    // número. Mostrar as duas linhas deixa o usuário conferir a conta.
    if (r.fixas > 0) {
        const det = document.createElement('div');
        det.className = 'vg-detalhe';
        det.appendChild(_linha(ctx, 'Gastos da viagem', r.adicional, true));
        det.appendChild(_linha(ctx, 'Contas fixas do período', r.fixas));
        det.appendChild(_linha(ctx, 'Total que saiu no período', r.total));
        box.appendChild(det);

        const nota = document.createElement('div');
        nota.className = 'vg-nota';
        nota.textContent = 'As contas fixas seriam pagas de qualquer jeito — por isso não entram no custo da viagem.';
        box.appendChild(nota);
    }

    if (r.categorias.length > 0) {
        const cats = document.createElement('div');
        cats.className = 'vg-cats';
        for (const c of r.categorias) cats.appendChild(_linha(ctx, c.tipo, c.valor));
        box.appendChild(cats);
    }

    return box;
}

/**
 * Popup do modo viagem. `onFechar` é chamado ao salvar, para a tela de
 * Configurações atualizar o subtítulo do botão.
 */
export function abrirPopupViagem(ctx, onFechar) {
    const salvar = (novaViagem) => {
        // O setter de configPerfil sanitiza na escrita (dashboard.js) — mas o
        // objeto precisa ser NOVO: mutar o antigo não dispara o setter.
        ctx.configPerfil = { ...ctx.configPerfil, viagem: novaViagem };
        // Sem `await` e fecha na hora — mesmo padrão de horas-vida.js.
        // A 1ª versão fazia `await ctx.salvarDados()` ANTES de fechar: o popup
        // congelava durante todo o round-trip de rede, o usuário achava que o
        // clique não pegou e clicava de novo — o que ENFILEIRAVA outro save e
        // deixava tudo mais lento ainda. Bug relatado ("preciso dar 2 ou 3
        // cliques"). O estado já está em memória; o save é assíncrono e o
        // dashboard já tem guardas anti-wipe se ele falhar.
        ctx.salvarDadosUrgente();
        ctx.fecharPopup();
        if (typeof onFechar === 'function') onFechar();
    };

    ctx.criarPopupDOM((popup) => {
        const atual = ctx.configPerfil?.viagem || null;
        const ativa = viagemAtiva(ctx.configPerfil);

        const titulo = document.createElement('h3');
        titulo.textContent = ativa ? 'Viagem em curso' : 'Modo viagem';
        popup.appendChild(titulo);

        const intro = document.createElement('p');
        intro.className = 'vg-intro';
        intro.textContent = ativa
            ? 'Tudo que você gastar até encerrar entra na conta da viagem.'
            : 'Ligue ao sair e desligue ao voltar: o app soma os gastos do período e te diz quanto a viagem custou.';
        popup.appendChild(intro);

        if (ativa) {
            const r = analisarViagem(ativa, ctx.transacoes, new Date());
            const resumo = _resumo(ctx, r);
            if (resumo) popup.appendChild(resumo);

            const btnEncerrar = document.createElement('button');
            btnEncerrar.className = 'btn-primary';
            btnEncerrar.type = 'button';
            btnEncerrar.style.width = '100%';
            btnEncerrar.textContent = 'Encerrar viagem';
            btnEncerrar.addEventListener('click', () => salvar(encerrarViagem(ativa, new Date())));
            popup.appendChild(btnEncerrar);
        } else {
            // Viagem encerrada: mostra o resultado da última antes de oferecer outra.
            if (atual && atual.fim) {
                const r = analisarViagem(atual, ctx.transacoes, new Date());
                const resumo = _resumo(ctx, r);
                if (resumo) {
                    const lbl = document.createElement('div');
                    lbl.className = 'vg-secao-label';
                    lbl.textContent = 'Última viagem';
                    popup.appendChild(lbl);
                    popup.appendChild(resumo);
                }
            }

            const label = document.createElement('label');
            label.className = 'vg-label';
            label.textContent = 'Para onde você vai?';
            label.htmlFor = 'vgNome';
            popup.appendChild(label);

            const input = document.createElement('input');
            input.id = 'vgNome';
            input.className = 'form-input';
            input.type = 'text';
            input.maxLength = 60;
            input.placeholder = 'Ex.: Bahia, Chile, casa da vó';
            popup.appendChild(input);

            const btnIniciar = document.createElement('button');
            btnIniciar.className = 'btn-primary';
            btnIniciar.type = 'button';
            btnIniciar.style.width = '100%';
            btnIniciar.style.marginTop = '10px';
            btnIniciar.textContent = 'Começar viagem hoje';
            btnIniciar.addEventListener('click', () => salvar(iniciarViagem(input.value, new Date())));
            popup.appendChild(btnIniciar);
        }

        const btnFechar = document.createElement('button');
        btnFechar.className = 'btn-cancelar';
        btnFechar.type = 'button';
        btnFechar.style.cssText = 'width:100%; margin-top:10px;';
        btnFechar.textContent = 'Fechar';
        btnFechar.addEventListener('click', ctx.fecharPopup);
        popup.appendChild(btnFechar);
    });
}
