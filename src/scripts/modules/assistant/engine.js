// engine.js — orquestrador do Assistente GranaEvo
// ---------------------------------------------------------------------------
// Funil: parser LOCAL (grátis) → se incerto, IA como função → roteia intenção.
// Mantém os perfis em memória (carregados 1x), aplica lançamentos com insert
// otimista + undo, e persiste via dataManager (anti-wipe + debounce + validação
// já embutidos). A IA só recebe texto + rótulos (nomes) — nunca R$.
// ---------------------------------------------------------------------------

import { dataManager } from '../data-manager.js';
import { parseLocal, splitCompound, parseFollowup, keywordMatch } from './parser-local.js';
import { parseValorBR, parseDataFutura } from './money.js';
import { toCommand } from './normalize.js';
import { applyLancamento, undoLancamento, resolveMeta, applyCredito, undoCredito, applyRetirada,
    resolveContaFixa, applyPagamentoConta, undoPagamentoConta, applyOrcamento, undoOrcamento } from './tx-builder.js';
import { bump } from './stats.js';
import * as Outbox from './outbox.js';
import { criarLembrete, desfazerLembrete, pushLiberado } from './reminders.js';
import { consultarGastos, consultarEntradas, saldoAtual, maioresGastos, ultimasTransacoes, compararMes, mediaMensal, faturaCartao, faltaMeta, relatorio, statusReservas, projecaoMeta,
    contarPorTipoMes, orcamentoRestante, alertaOrcamento, resumoDoDia, diaMaisCaro, assinaturasRecorrentes, metasParadas, streakDias, narrativaMes,
    faturaVencendo, salarioProvavel, fimDeMes, marcoReserva, marcoContagem, conquistasResumo, conquistasHoje } from './query.js';
import { applyLearned, learnMerchant } from './learn.js';
import { parseWithAI } from './assistant-api.js';
import * as P from './phrases.js';

const CONF_LOCAL_OK = 0.7;   // acima disso confiamos no parser local (sem gastar IA)
const LIMITE_CONFIRM = 50000; // lançamentos acima disso pedem confirmação (anti-typo)
const RE_SIM = /^(sim|s|isso|isso ai|confirmo|confirma|pode|pode ser|claro|com certeza|aha|ok|blz|manda|vai)\b/;
const RE_NAO = /^(nao|n|cancela|deixa|esquece|para|nem|negativo)\b/;

class AssistantEngine {
    #profiles = [];
    #activeId = null;
    #ready = false;
    #pendingReserva = null; // { valor, tipo, descricao } aguardando escolha de meta
    #pendingRetirada = null; // { valor } aguardando de qual reserva retirar
    #pendingCredito = null; // { descricao, tipo } aguardando o valor da compra
    #pendingConfirm = null; // { cmd, kind } aguardando "sim/não" de valor alto
    #pendingConta = null;   // { valor } aguardando o NOME da conta fixa a pagar
    #pendingLembrete = null; // { texto } aguardando o QUANDO do lembrete
    #lastUndo = null;       // fn de desfazer do último lançamento (desfazer por texto)
    #lastQuery = null;      // { consultaAlvo, palavrasChave, periodo } p/ follow-up
    #lastTxInfo = null;     // { profileId, txSnap, cmd } p/ correção inline (B20)
    #lastLancamentoCmd = null; // último lançamento saida/entrada/reserva (p/ "de novo" — B15)

    get ready() { return this.#ready; }

    // E45: zera TODO estado volátil (pendências, últimos contextos). Chamado no
    // logout/troca de conta pra nenhum valor pendente sobreviver à sessão.
    reset() {
        this.#profiles = [];
        this.#activeId = null;
        this.#ready = false;
        this.#pendingReserva = this.#pendingRetirada = this.#pendingCredito = this.#pendingConfirm = null;
        this.#pendingConta = this.#pendingLembrete = null;
        this.#lastUndo = this.#lastQuery = this.#lastTxInfo = this.#lastLancamentoCmd = null;
    }

    async init() {
        const data = await dataManager.loadUserData();
        this.#profiles = Array.isArray(data?.profiles) ? data.profiles : [];
        this.#restoreActive();
        this.#ready = true;

        // Recarrega ao voltar o foco à aba — reduz risco de sobrescrever
        // edições feitas em outra aba (dashboard). Não bloqueia a UI.
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') this.#reload();
            });
        }
        return { profiles: this.listProfiles(), activeId: this.#activeId };
    }

    async #reload() {
        try {
            const data = await dataManager.loadUserData();
            if (Array.isArray(data?.profiles)) {
                this.#profiles = data.profiles;
                if (!this.#profiles.some((p) => String(p.id) === String(this.#activeId))) {
                    this.#restoreActive();
                }
            }
        } catch { /* transitório — mantém estado atual */ }
    }

    listProfiles() {
        return this.#profiles.map((p) => ({ id: String(p.id), name: p.name || p.nome || 'Perfil' }));
    }

    #profileKey() { return `ge_assistant_profile_${dataManager.userId || 'anon'}`; }

    #restoreActive() {
        let saved = null;
        try { saved = localStorage.getItem(this.#profileKey()); } catch {}
        const exists = this.#profiles.some((p) => String(p.id) === String(saved));
        this.#activeId = exists ? String(saved) : (this.#profiles[0] ? String(this.#profiles[0].id) : null);
    }

    setActiveProfile(id) {
        if (!this.#profiles.some((p) => String(p.id) === String(id))) return false;
        this.#activeId = String(id);
        try { localStorage.setItem(this.#profileKey(), this.#activeId); } catch {}
        this.#pendingReserva = null;
        return true;
    }

    get activeProfileId() { return this.#activeId; }
    #active() { return this.#profiles.find((p) => String(p.id) === String(this.#activeId)) || null; }

    // Rótulos NÃO-sensíveis para dar contexto à IA (nomes, nunca valores).
    #labels() {
        const p = this.#active();
        const nome = (m) => String(m?.nome ?? m?.name ?? m?.titulo ?? '').trim();
        return {
            metaLabels:   Array.isArray(p?.metas) ? p.metas.map(nome).filter(Boolean) : [],
            cartaoLabels: Array.isArray(p?.cartoesCredito) ? p.cartoesCredito.map((c) => String(c?.nomeBanco ?? c?.nome ?? '').trim()).filter(Boolean) : [],
        };
    }

    // Nome do perfil ativo (p/ saudação personalizada — A2). Nunca vai pra IA.
    #activeName() {
        const p = this.#active();
        return String(p?.name ?? p?.nome ?? '').trim();
    }

    // Insight opcional pós-lançamento (A6/C23/C24/A7/A9). Retorna string ou null.
    // No máximo UM por lançamento, por ordem de relevância — para não virar ruído.
    #insightPos(tx) {
        const p = this.#active();
        // A6: meta de reserva recém-completada
        if (tx.categoria === 'reserva' && tx.metaId) {
            const meta = (Array.isArray(p?.metas) ? p.metas : []).find((m) => String(m.id) === String(tx.metaId));
            if (meta) {
                const alvo = Number(meta.objetivo ?? meta.target ?? 0);
                const saved = Number(meta.saved || 0);
                if (alvo > 0 && saved >= alvo && (saved - Number(tx.valor || 0)) < alvo) {
                    return P.metaCompleta(String(meta.descricao ?? meta.nome ?? 'sua meta'), saved);
                }
            }
        }
        // C24: marco de reserva acumulada (cruzou 1k/5k/10k… agora)
        if (tx.categoria === 'reserva') {
            const mr = marcoReserva(p, tx.valor);
            if (mr) return P.marcoReservaMsg(mr);
        }
        // C24: marco de contagem de lançamentos (50º/100º/…)
        const mc = P.marcoContagemMsg(marcoContagem(p));
        if (mc) return mc;
        if (tx.categoria === 'saida') {
            const al = alertaOrcamento(p, tx.tipo);
            if (al.alerta) return P.alertaOrcamentoMsg(al);
            const rep = P.insightRepeticao(contarPorTipoMes(p, tx.tipo));
            if (rep) return rep;
        }
        const st = streakDias(p);
        if ([3, 7, 14, 21, 30, 50, 100].includes(st)) return P.streakMsg(st); // C28
        if (tx.categoria === 'saida' && Math.random() < 0.3) {
            const rc = P.reforcoComparativo(compararMes(p));
            if (rc) return rc;
        }
        return null;
    }

    // Detecta uma correção inline do último lançamento — de VALOR ("não, foram 50")
    // ou de CATEGORIA ("não, foi transporte", "corrige pra farmácia"). B20 + B14.
    // Retorna { valor } | { categoria, tipo, descricao } | null.
    #matchCorrecao(text) {
        const t = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (!/^(nao,?\s*(foi|foram|era|e)\b|na verdade|corrige|corrija|ajusta|muda (o valor|a categoria|pra|para)|troca (o valor|a categoria|pra|para)|era pra ser|e pra ser|o certo (e|era))/.test(t)) return null;
        const v = parseValorBR(text);
        if (v && v > 0) return { valor: v };
        const km = keywordMatch(text); // B14: correção de categoria por palavra-chave
        if (km) return { categoria: km.categoria, tipo: km.tipo, descricao: km.descricao };
        return null;
    }

    // Refaz o último lançamento (saída/entrada) com um novo valor OU nova categoria. B20/B14
    async #corrigirUltimo(corr) {
        const info = this.#lastTxInfo;
        if (!info) return { text: 'Não há um lançamento recente pra corrigir.' };
        const profile = this.#profiles.find((p) => String(p.id) === String(info.profileId));
        if (!profile) return { text: 'Não achei o lançamento pra corrigir.' };
        if (!undoLancamento(profile, info.txSnap)) {
            this.#lastTxInfo = null;
            return { text: 'Esse lançamento já mudou — não consegui corrigir. Pode lançar de novo?' };
        }
        const novoCmd = { ...info.cmd, _confirmed: true, valor: corr.valor != null ? corr.valor : Number(info.txSnap.valor) };
        if (corr.categoria) { novoCmd.categoria = corr.categoria; novoCmd.tipo = corr.tipo; novoCmd.descricao = corr.descricao; }
        const res = applyLancamento(profile, novoCmd);
        if (!res.ok) { await this.#reload(); return { text: P.SISTEMA.erro() }; }
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) { try { undoLancamento(profile, res.transaction); } catch {} await this.#reload(); return { text: P.SISTEMA.erro() }; }
        const txSnap = { ...res.transaction };
        const base = P.confirmacaoLancamento(res);
        const view = { text: '{{fa-pen}} Corrigido! ' + base.text.replace(/^\{\{fa-check\}\}\s*/, ''), chip: base.chip };
        view.undo = () => this.#undoTx(info.profileId, txSnap);
        this.#lastUndo = view.undo;
        this.#lastTxInfo = { profileId: info.profileId, txSnap, cmd: { intent: 'lancar', categoria: novoCmd.categoria, tipo: novoCmd.tipo, descricao: novoCmd.descricao } };
        return view;
    }

    // Insights de abertura (1º acesso do dia). Retorna { messages, quick }:
    //  - messages: até 2 insights (prioridade: urgente → útil → curiosidade)
    //  - quick: chips de AÇÃO contextuais pra mesclar com os starters (C27)
    // Gating de "1x por dia" é feito pela UI. C21/C22/C23/C25/C26/C29/C30/A7.
    aberturaInsights() {
        const p = this.#active();
        if (!p) return { messages: [], quick: [] };
        const cands = [
            P.faturaVencendoMsg(faturaVencendo(p)),   // C21 (urgente)
            P.resumoDiaMsg(resumoDoDia(p)),            // C25 (resumo do dia)
            P.salarioMsg(salarioProvavel(p)),          // C22
            P.conquistasHojeMsg(conquistasHoje(p)),    // C26
            P.fimDeMesMsg(fimDeMes(p)),                // C23
            P.metasParadasMsg(metasParadas(p)),        // C30
        ].filter(Boolean);
        // C29: sobrou folga clara pela média → sugere guardar.
        const orc = orcamentoRestante(p);
        if (orc.temHistorico && orc.restante > 100) cands.push(P.sugestaoReserva(orc.restante));
        // C30: curiosidade rotativa (só entra se ainda houver espaço).
        const cur = P.curiosidadeMsg(diaMaisCaro(p));
        if (cur) cands.push(cur);

        // C27: chip de ação para retomar uma reserva parada.
        const quick = [];
        const paradas = metasParadas(p);
        if (paradas.length) quick.push({ label: `Guardar em ${paradas[0].nome}`, text: `guardar 50 na ${paradas[0].nome}` });

        return { messages: cands.slice(0, 2), quick };
    }

    // F49: contexto p/ ajuda contextual (o que o usuário já tem/usou).
    #ajudaCtx() {
        const p = this.#active();
        const metas = Array.isArray(p?.metas) ? p.metas : [];
        const txs = Array.isArray(p?.transacoes) ? p.transacoes : [];
        return {
            temReserva: metas.length > 0,
            usouReserva: txs.some((t) => t.categoria === 'reserva'),
            temCartao: Array.isArray(p?.cartoesCredito) && p.cartoesCredito.length > 0,
        };
    }

    // C25/F48: chips contextuais por alvo de consulta (retornados na resposta).
    #chipsConsulta(alvo) {
        switch (alvo) {
            case 'saldo':       return [{ label: 'Onde gastei mais', text: 'onde mais gastei' }, { label: 'Quanto posso gastar', text: 'quanto posso gastar esse mês' }];
            case 'maior_gasto': return [{ label: 'Comparar c/ mês passado', text: 'gastei mais que mês passado?' }, { label: 'Minhas assinaturas', text: 'minhas assinaturas' }];
            case 'gasto':       return [{ label: 'Onde gastei mais', text: 'onde mais gastei' }, { label: 'Meu saldo', text: 'meu saldo' }];
            case 'reserva':     return [{ label: 'Quanto falta pra meta', text: 'quanto falta pra minha meta' }, { label: 'Meu saldo', text: 'meu saldo' }];
            default:            return null;
        }
    }

    // ── Entrada principal ────────────────────────────────────────────────────
    async handle(rawText) {
        if (!this.#ready) return { text: P.SISTEMA.erro() };
        const text = String(rawText ?? '').trim();
        if (!text) return { text: P.SISTEMA.naoEntendi() };
        if (!this.#active()) return { text: '{{fa-gear}} Selecione um perfil primeiro nas configurações.' };

        // Confirmação de valor alto pendente (usuário responde sim/não).
        if (this.#pendingConfirm) {
            const t = String(text).toLowerCase();
            if (RE_SIM.test(t)) {
                const pend = this.#pendingConfirm;
                this.#pendingConfirm = null;
                return pend.kind === 'retirada' ? this.#doRetirada(pend.cmd) : this.#doLancamento(pend.cmd);
            }
            if (RE_NAO.test(t)) {
                this.#pendingConfirm = null;
                return { text: P.confirmCancelado() };
            }
            this.#pendingConfirm = null; // resposta não foi sim/não → segue o fluxo
        }

        // Correção inline do último lançamento ("não, foram 50", "na verdade foi 80") — B20
        if (this.#lastTxInfo) {
            const novo = this.#matchCorrecao(text);
            if (novo != null) return this.#corrigirUltimo(novo);
        }

        // Continuação de pagar-conta pendente (usuário respondeu o nome da conta).
        if (this.#pendingConta) {
            const pend = this.#pendingConta;
            this.#pendingConta = null;
            const r = resolveContaFixa(this.#active(), text);
            if (r.status === 'ok') return this.#doPagarConta({ contaResolvida: r.conta, valor: pend.valor });
            if (r.status === 'handoff') return { text: P.contaHandoff(String(r.conta.descricao || 'Conta')), cta: { label: 'Abrir contas', tela: 'transacoes' } };
            // não casou → segue o fluxo normal (pode ter mudado de assunto)
        }

        // Continuação de lembrete pendente (usuário respondeu o quando).
        if (this.#pendingLembrete) {
            const pend = this.#pendingLembrete;
            this.#pendingLembrete = null;
            const dataISO = parseDataFutura(text);
            if (dataISO) return this.#doLembrete({ lembreteTexto: pend.texto, lembreteData: dataISO });
            // sem data → segue o fluxo normal
        }

        // Continuação de crédito pendente (usuário respondeu o valor da compra).
        if (this.#pendingCredito) {
            const v = parseValorBR(text);
            if (v) {
                const pend = this.#pendingCredito;
                this.#pendingCredito = null;
                return this.#doCredito({ categoria: 'saida_credito', valor: v, descricao: pend.descricao, tipo: pend.tipo, parcelas: pend.parcelas });
            }
            this.#pendingCredito = null; // sem valor → mudou de assunto
        }

        // Continuação de retirada pendente (usuário respondeu de qual reserva).
        if (this.#pendingRetirada) {
            const r = resolveMeta(this.#active(), text);
            if (r.status === 'ok') {
                const cmd = { categoria: 'retirada_reserva', valor: this.#pendingRetirada.valor, metaHint: text };
                this.#pendingRetirada = null;
                return this.#doRetirada(cmd);
            }
            this.#pendingRetirada = null;
        }

        // Continuação de reserva pendente (usuário respondeu o nome da meta).
        if (this.#pendingReserva) {
            const r = resolveMeta(this.#active(), text);
            if (r.status === 'ok') {
                const cmd = { ...this.#pendingReserva, metaHint: text };
                this.#pendingReserva = null;
                return this.#doLancamento(cmd);
            }
            // Não casou — segue o fluxo normal (pode ter mudado de assunto).
            this.#pendingReserva = null;
        }

        // Follow-up de consulta ("e no mês passado?", "e transporte?") — reusa
        // o contexto da última consulta, trocando só período/termo.
        if (this.#lastQuery) {
            const fu = parseFollowup(text);
            if (fu.isFollowup) {
                return this.#route({
                    intent: 'consultar',
                    consultaAlvo: this.#lastQuery.consultaAlvo,
                    palavrasChave: fu.palavrasChave.length ? fu.palavrasChave : this.#lastQuery.palavrasChave,
                    periodo: fu.periodo || this.#lastQuery.periodo,
                });
            }
        }

        // Mensagem composta: "gastei 300 no mercado, mas ganhei 120 do pai" →
        // processa cada cláusula e devolve múltiplas respostas (chips).
        const segments = splitCompound(text);
        if (segments.length > 1) {
            const respostas = [];
            for (const seg of segments) respostas.push(await this.#handleOne(seg));
            return { multi: respostas };
        }
        return this.#handleOne(text);
    }

    // Processa UMA cláusula: aprendizado local → parser local → (se incerto) IA.
    async #handleOne(text) {
        const local = parseLocal(text);

        // B12: comerciante já aprendido resolve LOCALMENTE (zero token). Só quando
        // o parser ficou incerto ou o valor está solto (ambíguo) — nunca sobrepõe
        // um parse confiante por palavra-chave.
        if (local.intencao === 'valor_ambiguo' || local.confianca < CONF_LOCAL_OK) {
            const learned = applyLearned(text);
            const v = local.valor ?? parseValorBR(text);
            if (learned && v > 0) {
                return this.#route(toCommand({
                    intencao: 'lancar', categoria: learned.categoria, tipo: learned.tipo,
                    descricao: learned.descricao, valor: v, source: 'local', confianca: 0.9,
                }));
            }
        }

        if (local.confianca >= CONF_LOCAL_OK) {
            bump('local'); // telemetria anônima: resolvido 100% no aparelho
            return this.#route(toCommand(local));
        }

        // Offline: não adianta tentar a IA — usa o palpite local ou explica.
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (!offline) {
            const ai = await parseWithAI(text, this.#labels());
            if (ai.ok) {
                bump('ia_ok');
                const cmd = toCommand({ ...ai.parse, source: 'ia' });
                // B12: aprende o comerciante que a IA resolveu (o parser não sabia).
                if (cmd.intent === 'lancar' && cmd.categoria && cmd.tipo) {
                    try { learnMerchant(text, cmd.categoria, cmd.tipo, cmd.descricao); } catch { /* ignore */ }
                }
                return this.#route(cmd);
            }
            if (ai.reason === 'rate')     return { text: P.SISTEMA.rate() };
            if (ai.reason === 'rate_day') return { text: P.SISTEMA.rateDia() }; // E46
            if (ai.reason === 'auth')     return { text: '{{fa-lock}} Sua sessão expirou — faça login de novo.' };
            bump('ia_fail');
        } else {
            bump('offline');
        }

        // IA indisponível/sem parse: se o local tinha um palpite, usa; senão desiste.
        if (local.intencao !== 'desconhecido' && local.confianca >= 0.4) {
            return this.#route(toCommand(local));
        }
        // F50: não entendi → oferece 3 caminhos com 1 toque (sem gastar IA).
        return {
            text: P.naoEntendiEsperto(local),
            quickReplies: [
                { label: 'Lançar um gasto', text: 'gastei 50 no mercado' },
                { label: 'Ver meu saldo', text: 'meu saldo' },
                { label: 'Resumo do mês', text: 'relatório do mês' },
            ],
        };
    }

    // ── Roteamento por intenção ────────────────────────────────────────────────
    async #route(cmd) {
        const CTA_REL = { label: 'Ver no GranaEvo', tela: 'relatorios' };
        switch (cmd.intent) {
            case 'saudacao': return { text: P.SISTEMA.saudacao(this.#activeName()) };
            case 'ajuda':    return { text: P.ajudaContexto(this.#ajudaCtx()) };   // F49
            case 'desfazer': return this.#desfazerUltimo();
            case 'repetir':  return this.#repetirUltimo();                          // B15
            case 'recusa':      return { text: P.SISTEMA.recusa() };
            case 'privacidade': return { text: P.privacidadeMsg() };

            case 'valor_ambiguo': {                                                // B13
                const v = cmd.valor;
                if (!(v > 0)) return { text: P.SISTEMA.semValor() };
                return {
                    text: P.perguntarGastoOuEntrada(v),
                    quickReplies: [
                        { label: 'Foi um gasto', text: `gastei ${v}` },
                        { label: 'Foi uma entrada', text: `recebi ${v}` },
                    ],
                };
            }

            case 'lancar':
                if (cmd.categoria === 'saida_credito') return this.#doCredito(cmd);
                if (cmd.categoria === 'retirada_reserva') return this.#doRetirada(cmd);
                if (!cmd.categoria || !(cmd.valor > 0)) return { text: P.SISTEMA.semValor() };
                return this.#doLancamento(cmd);

            case 'pagar_conta':      return this.#doPagarConta(cmd);
            case 'definir_orcamento': return this.#doOrcamento(cmd);
            case 'lembrete':         return this.#doLembrete(cmd);

            case 'consultar': {
                const p = this.#active();
                this.#lastQuery = { consultaAlvo: cmd.consultaAlvo, palavrasChave: cmd.palavrasChave || [], periodo: cmd.periodo || 'mes' };
                const chips = this.#chipsConsulta(cmd.consultaAlvo); // C25
                const withChips = (r) => (chips ? { ...r, quickReplies: chips } : r);
                if (cmd.consultaAlvo === 'saldo')       return withChips({ text: P.renderSaldo(saldoAtual(p)) });
                if (cmd.consultaAlvo === 'maior_gasto') return withChips({ text: P.renderMaiorGasto(maioresGastos(p, cmd.periodo || 'mes')), cta: { label: 'Ver gráficos', tela: 'graficos' } }); // F48
                if (cmd.consultaAlvo === 'listar')      return { text: P.renderUltimas(ultimasTransacoes(p)), cta: { label: 'Ver transações', tela: 'transacoes' } };
                if (cmd.consultaAlvo === 'comparar')    return { text: P.renderComparar(compararMes(p)) };
                if (cmd.consultaAlvo === 'media')       return { text: P.renderMedia(mediaMensal(p)) };
                if (cmd.consultaAlvo === 'fatura')      return { text: P.renderFatura(faturaCartao(p, cmd.cartaoHint)), cta: { label: 'Ver cartões', tela: 'cartoes' } }; // F48
                if (cmd.consultaAlvo === 'falta_meta')  return { text: P.renderFaltaMeta(faltaMeta(p, cmd.metaHint)) };
                if (cmd.consultaAlvo === 'orcamento')   return { text: P.orcamentoRestanteMsg(orcamentoRestante(p)) };
                if (cmd.consultaAlvo === 'assinaturas') return { text: P.assinaturasMsg(assinaturasRecorrentes(p)), cta: { label: 'Ver cartões', tela: 'cartoes' } };
                if (cmd.consultaAlvo === 'narrativa')   return { text: P.narrativaMesMsg(narrativaMes(p)), cta: CTA_REL, copiavel: true }; // A1/A5
                if (cmd.consultaAlvo === 'curiosidade') return { text: P.curiosidadeMsg(diaMaisCaro(p)) || 'Ainda não tenho gastos suficientes pra achar um padrão. Continua lançando! {{fa-lightbulb}}' };
                if (cmd.consultaAlvo === 'conquistas')  return { text: P.conquistasMsg(conquistasResumo(p)), cta: { label: 'Ver conquistas', tela: 'configuracoes' } }; // C26
                if (cmd.consultaAlvo === 'reserva' || cmd.palavrasChave.includes('reserva')) {
                    return withChips({ text: P.renderReservas(statusReservas(p)), cta: { label: 'Ver reservas', tela: 'reservas' } });
                }
                if (cmd.consultaAlvo === 'entrada')     return { text: P.renderEntradas(consultarEntradas(p, cmd)) };
                return withChips({ text: P.renderConsulta(consultarGastos(p, cmd)) });
            }

            case 'relatorio': {                                                    // A1/A5/A10
                const p = this.#active();
                const per = cmd.periodo || 'mes';
                const rel = relatorio(p, per);
                const comp = per === 'mes' ? compararMes(p) : null;
                return { text: P.renderRelatorio(rel, comp), cta: CTA_REL, copiavel: rel.count > 0 };
            }

            case 'projecao_meta':
                return { text: P.renderProjecao(projecaoMeta(this.#active(), cmd)) };

            default:
                return { text: P.SISTEMA.naoEntendi() };
        }
    }

    // ── Lançamento com insert otimista + persistência ──────────────────────────
    async #doLancamento(cmd) {
        // Valor muito alto → confirma antes (proteção anti-erro de digitação).
        if (cmd.valor > LIMITE_CONFIRM && !cmd._confirmed) {
            this.#pendingConfirm = { cmd: { ...cmd, _confirmed: true } };
            return { text: P.confirmarValorAlto(cmd) };
        }

        const profile = this.#active();
        const profileId = this.#activeId;
        const res = applyLancamento(profile, cmd);

        if (!res.ok) {
            if (res.reason === 'meta') {
                // Guarda o lançamento pra concluir quando o usuário disser a meta.
                if (res.metaStatus === 'none') return { text: P.escolherMeta([]) };
                this.#pendingReserva = { intent: 'lancar', categoria: 'reserva', valor: cmd.valor, tipo: 'Reserva', descricao: cmd.descricao };
                return { text: P.escolherMeta(res.opcoes) };
            }
            if (res.reason === 'handoff') {
                // F48: handoff sempre com um caminho pro site (tela específica).
                const tela = res.categoria === 'assinatura' ? 'cartoes' : res.categoria === 'retirada_reserva' ? 'reservas' : 'dashboard';
                return { text: P.renderHandoff(res.categoria), handoff: res.categoria, cta: { label: 'Abrir no GranaEvo', tela } };
            }
            return { text: P.SISTEMA.semValor() };
        }

        // Insert otimista já aplicado em memória; persiste. Se falhar o save,
        // desfaz na memória pra não divergir do banco.
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            try { undoLancamento(profile, res.transaction); } catch {}
            // OFFLINE-FIRST: sem rede, o comando (não o estado) vai pra fila e
            // é reaplicado pelo caminho normal quando a conexão voltar.
            if (typeof navigator !== 'undefined' && navigator.onLine === false &&
                Outbox.enqueue(dataManager.userId, profileId, cmd)) {
                return { text: P.offlineEnfileirado(cmd) };
            }
            return { text: P.SISTEMA.erro() };
        }

        // Desfazer amarrado a ESTE lançamento (match por campos, à prova de reload).
        const txSnap = { ...res.transaction };
        const view = P.confirmacaoLancamento(res);
        view.undo = () => this.#undoTx(profileId, txSnap);
        this.#lastUndo = view.undo;
        // Correção inline só p/ saída/entrada (B20) — reserva/crédito têm mecânica própria.
        this.#lastTxInfo = (cmd.categoria === 'saida' || cmd.categoria === 'entrada')
            ? { profileId, txSnap, cmd: { intent: 'lancar', categoria: cmd.categoria, tipo: cmd.tipo, descricao: cmd.descricao } }
            : null;
        // B15: guarda o último lançamento (saida/entrada/reserva) p/ "de novo".
        this.#lastLancamentoCmd = { intent: 'lancar', categoria: cmd.categoria, tipo: cmd.tipo, descricao: cmd.descricao, valor: cmd.valor, metaHint: cmd.metaHint };
        // Insight opcional pós-lançamento (A6/C24/C28/A9) — no máximo UM, e só quando faz sentido.
        const extra = this.#insightPos(res.transaction);
        return extra ? { multi: [view, { text: extra }] } : view;
    }

    // ── Pagar conta fixa ("paguei a conta de luz") ─────────────────────────────
    async #doPagarConta(cmd) {
        const profile = this.#active();
        const profileId = this.#activeId;

        // Conta pode já vir resolvida (continuação do "qual conta?").
        let conta = cmd.contaResolvida || null;
        if (!conta) {
            const r = resolveContaFixa(profile, cmd.contaHint);
            if (r.status === 'none') {
                // Sem conta em aberto que case — se veio valor, cai pra saída comum.
                if (cmd.valor > 0) {
                    return this.#doLancamento({ intent: 'lancar', categoria: 'saida', valor: cmd.valor,
                        tipo: 'Conta fixa', descricao: cmd.contaHint || 'Conta', _confirmed: false });
                }
                return { text: P.contaNaoAchada(cmd.contaHint), cta: { label: 'Ver contas', tela: 'transacoes' } };
            }
            if (r.status === 'handoff') {
                return { text: P.contaHandoff(String(r.conta.descricao || 'Conta')), cta: { label: 'Abrir contas', tela: 'transacoes' } };
            }
            if (r.status === 'ambiguous' || r.status === 'choose') {
                this.#pendingConta = { valor: cmd.valor || null };
                return { text: P.escolherConta(r.opcoes) };
            }
            conta = r.conta;
        }

        if (conta.pago === true) return { text: P.contaJaPaga(String(conta.descricao || 'Conta')) };

        const res = applyPagamentoConta(profile, conta, cmd.valor);
        if (!res.ok) {
            if (res.reason === 'handoff') return { text: P.contaHandoff(String(conta.descricao || 'Conta')), cta: { label: 'Abrir contas', tela: 'transacoes' } };
            if (res.reason === 'ja_paga') return { text: P.contaJaPaga(String(conta.descricao || 'Conta')) };
            return { text: P.SISTEMA.semValor() };
        }

        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            try { undoPagamentoConta(profile, res.transaction, res.snapshot); } catch {}
            await this.#reload();
            return { text: P.SISTEMA.erro() };
        }

        const txSnap = { ...res.transaction };
        const snap = { ...res.snapshot };
        const view = P.contaPaga(res);
        view.undo = async () => {
            const p = this.#profiles.find((x) => String(x.id) === String(profileId));
            if (!p || !undoPagamentoConta(p, txSnap, snap)) return { text: 'Esse pagamento já não está mais aqui.' };
            const ok = await dataManager.saveUserData(this.#profiles);
            if (!ok) { await this.#reload(); return { text: P.SISTEMA.erro() }; }
            return { text: P.desfeito() };
        };
        this.#lastUndo = view.undo;
        this.#lastTxInfo = null; // correção inline não se aplica (mecânica própria)
        return view;
    }

    // ── Definir orçamento ("põe 600 de orçamento pra mercado") ──────────────────
    async #doOrcamento(cmd) {
        if (!cmd.tipo) return { text: P.orcamentoSemTipo() };
        if (!(cmd.valor > 0)) return { text: P.SISTEMA.semValor() };
        const profile = this.#active();
        const profileId = this.#activeId;
        const res = applyOrcamento(profile, cmd.tipo, cmd.valor);
        if (!res.ok) return { text: res.reason === 'sem_tipo' ? P.orcamentoSemTipo() : P.SISTEMA.semValor() };

        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            try { undoOrcamento(profile, res.tipo, res.anterior); } catch {}
            return { text: P.SISTEMA.erro() };
        }
        const view = P.orcamentoDefinido(res);
        view.undo = async () => {
            const p = this.#profiles.find((x) => String(x.id) === String(profileId));
            if (!p || !undoOrcamento(p, res.tipo, res.anterior)) return { text: 'Esse orçamento já mudou.' };
            const ok = await dataManager.saveUserData(this.#profiles);
            if (!ok) { await this.#reload(); return { text: P.SISTEMA.erro() }; }
            return { text: P.desfeito() };
        };
        this.#lastUndo = view.undo;
        return view;
    }

    // ── Lembrete ("me lembra de pagar o aluguel dia 5") → Radar ─────────────────
    async #doLembrete(cmd) {
        const texto = (cmd.lembreteTexto || '').trim();
        if (!texto) { return { text: P.lembreteSemQuando() }; }
        if (!cmd.lembreteData) {
            this.#pendingLembrete = { texto };
            return {
                text: `Beleza — te lembro de *${texto}*. Quando?`,
                quickReplies: [
                    { label: 'Amanhã', text: 'amanhã' },
                    { label: 'Em 3 dias', text: 'daqui a 3 dias' },
                    { label: 'Dia 5', text: 'dia 5' },
                ],
            };
        }
        const r = await criarLembrete(texto, cmd.lembreteData);
        if (!r.ok) {
            if (r.reason === 'dup') return { text: P.lembreteDuplicado() };
            if (r.reason === 'auth') return { text: '{{fa-lock}} Sua sessão expirou — faça login de novo.' };
            return { text: P.lembreteErro() };
        }
        const [y, m, d] = cmd.lembreteData.split('-');
        const view = { text: P.lembreteCriado(texto, `${d}/${m}/${y}`, pushLiberado()), chip: { categoria: 'saida', label: `Lembrete · ${texto}`, undoLabel: 'Cancelar' } };
        view.undo = async () => ({ text: (await desfazerLembrete(r.dedupeKey)) ? P.lembreteDesfeito() : P.SISTEMA.erro() });
        this.#lastUndo = view.undo;
        return view;
    }

    // ── Outbox offline: reaplica lançamentos enfileirados (chamado pela página) ──
    async flushOutbox() {
        if (!this.#ready) return null;
        const uid = dataManager.userId;
        const fila = Outbox.peekAll(uid);
        if (!fila.length) return null;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

        await this.#reload(); // base = verdade do servidor
        const restantes = [];
        let aplicados = 0;
        for (const item of fila) {
            const profile = this.#profiles.find((p) => String(p.id) === String(item.profileId));
            if (!profile) continue; // perfil sumiu → descarta silencioso
            const res = applyLancamento(profile, item.cmd);
            if (!res.ok) continue;  // inválido contra o estado atual → descarta
            const saved = await dataManager.saveUserData(this.#profiles);
            if (!saved) {
                try { undoLancamento(profile, res.transaction); } catch {}
                restantes.push(item); // rede falhou de novo → mantém na fila
                continue;
            }
            aplicados++;
        }
        Outbox.keepOnly(uid, restantes);
        return aplicados > 0 ? { text: P.offlineSincronizado(aplicados) } : null;
    }

    // ── Desfazer por texto ("apaga o último", "errei") ─────────────────────────
    async #desfazerUltimo() {
        if (!this.#lastUndo) return { text: 'Não há nada pra desfazer agora.' };
        const fn = this.#lastUndo;
        this.#lastUndo = null;
        try { return await fn(); } catch { return { text: P.SISTEMA.erro() }; }
    }

    // ── Repetir o último lançamento ("de novo", "mesma coisa") — B15 ────────────
    async #repetirUltimo() {
        const cmd = this.#lastLancamentoCmd;
        if (!cmd) return { text: P.nadaPraRepetir() };
        const profile = this.#active();
        const profileId = this.#activeId;
        // _confirmed: já confirmou da 1ª vez (não repergunta valor alto).
        const res = applyLancamento(profile, { ...cmd, _confirmed: true });
        if (!res.ok) {
            if (res.reason === 'meta') return { text: P.escolherMeta(res.opcoes || []) };
            return { text: P.SISTEMA.erro() };
        }
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) { try { undoLancamento(profile, res.transaction); } catch {} return { text: P.SISTEMA.erro() }; }
        const txSnap = { ...res.transaction };
        const view = P.repetido(res);
        view.undo = () => this.#undoTx(profileId, txSnap);
        this.#lastUndo = view.undo;
        this.#lastTxInfo = (cmd.categoria === 'saida' || cmd.categoria === 'entrada')
            ? { profileId, txSnap, cmd: { intent: 'lancar', categoria: cmd.categoria, tipo: cmd.tipo, descricao: cmd.descricao } }
            : null;
        return view;
    }

    // ── Desfazer um lançamento específico ───────────────────────────────────────
    async #undoTx(profileId, txSnap) {
        const profile = this.#profiles.find((p) => String(p.id) === String(profileId));
        if (!profile) return { text: 'Não encontrei mais esse lançamento (dados já atualizados).' };
        const removed = undoLancamento(profile, txSnap);
        if (!removed) return { text: 'Esse lançamento já não está mais aqui.' };
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            // Save falhou → o servidor ainda tem o estado pré-undo. Ressincroniza
            // recarregando a verdade do banco (evita meta inconsistente em memória).
            await this.#reload();
            return { text: P.SISTEMA.erro() };
        }
        return { text: P.desfeito() };
    }

    // Reservas ativas (com saldo) formatadas p/ o picker da UI.
    #reservasComSaldo() {
        const p = this.#active();
        return (Array.isArray(p?.metas) ? p.metas : [])
            .filter((m) => Number(m.saved || 0) > 0)
            .map((m) => ({ id: String(m.id), nome: String(m.descricao ?? m.nome ?? 'Reserva').trim(), saved: Number(m.saved || 0) }));
    }

    // Chamado pela UI depois que o usuário escolhe a reserva no picker.
    async retirarDe({ valor, metaId }) {
        return this.#doRetirada({ categoria: 'retirada_reserva', valor, metaId });
    }

    // ── Retirada de reserva: mostra o picker (ou aplica se já tem a meta) ────────
    async #doRetirada(cmd) {
        if (!(cmd.valor > 0)) return { text: P.SISTEMA.semValor() };
        // E44: retirada de valor alto → confirma antes (anti-typo em operação destrutiva).
        if (cmd.valor > LIMITE_CONFIRM && !cmd._confirmed) {
            this.#pendingConfirm = { cmd: { ...cmd, _confirmed: true }, kind: 'retirada' };
            return { text: P.confirmarValorAlto({ valor: cmd.valor, descricao: 'retirada de reserva' }) };
        }
        const profile = this.#active();
        const profileId = this.#activeId;

        // Precisa escolher a reserva? (sem id e sem hint claro) → PICKER visual.
        if (!cmd.metaId) {
            const comSaldo = this.#reservasComSaldo();
            if (comSaldo.length === 0) return { text: '{{fa-piggy-bank}} Você não tem reserva com saldo pra retirar.' };
            let precisaEscolher = false;
            if (!cmd.metaHint) {
                precisaEscolher = comSaldo.length > 1;
            } else {
                const r = resolveMeta(profile, cmd.metaHint);
                if (r.status !== 'ok') precisaEscolher = true;
            }
            if (precisaEscolher) {
                return { reservaPicker: comSaldo, retirada: { valor: cmd.valor } };
            }
        }

        const res = applyRetirada(profile, cmd);

        if (!res.ok) {
            if (res.reason === 'meta') {
                const comSaldo = this.#reservasComSaldo();
                if (comSaldo.length === 0) return { text: P.escolherMeta([]) };
                return { reservaPicker: comSaldo, retirada: { valor: cmd.valor } };
            }
            if (res.reason === 'reserva_vazia') return { text: P.reservaVazia(res.meta) };
            if (res.reason === 'excede') return { text: P.retiradaExcede(res.meta, res.disponivel) };
            return { text: P.SISTEMA.semValor() };
        }

        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            try { undoLancamento(profile, res.transaction); } catch {}
            return { text: P.SISTEMA.erro() };
        }
        const txSnap = { ...res.transaction };
        const view = P.confirmacaoRetirada(res);
        view.undo = () => this.#undoTx(profileId, txSnap);
        this.#lastUndo = view.undo; // undoLancamento já reverte a retirada
        return view;
    }

    // ── Crédito: decide o picker ou pede o valor ────────────────────────────────
    async #doCredito(cmd) {
        const profile = this.#active();
        const cards = Array.isArray(profile?.cartoesCredito) ? profile.cartoesCredito : [];
        if (cards.length === 0) return { text: P.semCartao() };

        if (!(cmd.valor > 0)) {
            this.#pendingCredito = { descricao: cmd.descricao, tipo: cmd.tipo, parcelas: cmd.parcelas || null };
            return { text: P.creditoQuantoFoi() };
        }

        // Sinaliza à UI pra abrir o picker. Se as parcelas já vieram no texto
        // ("em 3x"), a UI pula o picker de parcelas e só pede o cartão.
        return {
            creditoCards: cards.map((c) => ({
                id: String(c.id),
                nome: c.nomeBanco || c.nome || 'Cartão',
                congelado: !!c.congelado,
            })),
            credito: { valor: cmd.valor, descricao: cmd.descricao, tipo: cmd.tipo, parcelas: cmd.parcelas || null },
        };
    }

    // Chamado pela UI depois que o usuário escolheu cartão + parcelas.
    async applyCredito({ valor, descricao, tipo, cardId, parcelas }) {
        const profile = this.#active();
        const profileId = this.#activeId;
        const res = applyCredito(profile, { valor, descricao, tipo, cardId, parcelas });
        if (!res.ok) {
            if (res.reason === 'frozen') return { text: P.cartaoCongelado() };
            if (res.reason === 'no_card') return { text: 'Não achei esse cartão.' };
            return { text: P.SISTEMA.erro() };
        }
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            try { undoCredito(profile, res.snapshot); } catch {}
            return { text: P.SISTEMA.erro() };
        }
        const snap = res.snapshot;
        const view = P.confirmacaoCredito(res);
        view.undo = () => this.#undoCredito(profileId, snap);
        this.#lastUndo = view.undo;
        return view;
    }

    async #undoCredito(profileId, snap) {
        const profile = this.#profiles.find((p) => String(p.id) === String(profileId));
        if (!profile) return { text: 'Não encontrei mais essa compra (dados já atualizados).' };
        const removed = undoCredito(profile, snap);
        if (!removed) return { text: 'Essa compra já não está mais aqui.' };
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) { await this.#reload(); return { text: P.SISTEMA.erro() }; }
        return { text: P.desfeito() };
    }
}

export const assistant = new AssistantEngine();
