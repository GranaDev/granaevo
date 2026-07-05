// engine.js — orquestrador do Assistente GranaEvo
// ---------------------------------------------------------------------------
// Funil: parser LOCAL (grátis) → se incerto, IA como função → roteia intenção.
// Mantém os perfis em memória (carregados 1x), aplica lançamentos com insert
// otimista + undo, e persiste via dataManager (anti-wipe + debounce + validação
// já embutidos). A IA só recebe texto + rótulos (nomes) — nunca R$.
// ---------------------------------------------------------------------------

import { dataManager } from '../data-manager.js';
import { parseLocal, splitCompound, parseFollowup } from './parser-local.js';
import { parseValorBR } from './money.js';
import { toCommand } from './normalize.js';
import { applyLancamento, undoLancamento, resolveMeta, applyCredito, undoCredito, applyRetirada } from './tx-builder.js';
import { consultarGastos, consultarEntradas, saldoAtual, maioresGastos, ultimasTransacoes, compararMes, mediaMensal, faturaCartao, faltaMeta, relatorio, statusReservas, projecaoMeta,
    contarPorTipoMes, orcamentoRestante, alertaOrcamento, resumoDoDia, diaMaisCaro, assinaturasRecorrentes, metasParadas, streakDias, narrativaMes } from './query.js';
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
    #lastUndo = null;       // fn de desfazer do último lançamento (desfazer por texto)
    #lastQuery = null;      // { consultaAlvo, palavrasChave, periodo } p/ follow-up
    #lastTxInfo = null;     // { profileId, txSnap, cmd } p/ correção inline (B20)

    get ready() { return this.#ready; }

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
        if (tx.categoria === 'saida') {
            const al = alertaOrcamento(p, tx.tipo);
            if (al.alerta) return P.alertaOrcamentoMsg(al);
            const rep = P.insightRepeticao(contarPorTipoMes(p, tx.tipo));
            if (rep) return rep;
        }
        const st = streakDias(p);
        if ([3, 7, 14, 21, 30, 50, 100].includes(st)) return P.streakMsg(st);
        if (tx.categoria === 'saida' && Math.random() < 0.3) {
            const rc = P.reforcoComparativo(compararMes(p));
            if (rc) return rc;
        }
        return null;
    }

    // Detecta uma correção inline de valor ("não, foram 50", "na verdade foi 80"). B20
    #matchCorrecao(text) {
        const t = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (!/^(nao,?\s*(foi|foram|era|e)\b|na verdade|corrige|corrija|ajusta|muda o valor|troca o valor|era pra ser|e pra ser|o certo (e|era))/.test(t)) return null;
        const v = parseValorBR(text);
        return v && v > 0 ? v : null;
    }

    // Refaz o último lançamento (saída/entrada) com um novo valor. B20
    async #corrigirUltimo(novoValor) {
        const info = this.#lastTxInfo;
        if (!info) return { text: 'Não há um lançamento recente pra corrigir.' };
        const profile = this.#profiles.find((p) => String(p.id) === String(info.profileId));
        if (!profile) return { text: 'Não achei o lançamento pra corrigir.' };
        if (!undoLancamento(profile, info.txSnap)) {
            this.#lastTxInfo = null;
            return { text: 'Esse lançamento já mudou — não consegui corrigir. Pode lançar de novo?' };
        }
        const res = applyLancamento(profile, { ...info.cmd, valor: novoValor, _confirmed: true });
        if (!res.ok) { await this.#reload(); return { text: P.SISTEMA.erro() }; }
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) { try { undoLancamento(profile, res.transaction); } catch {} await this.#reload(); return { text: P.SISTEMA.erro() }; }
        const txSnap = { ...res.transaction };
        const base = P.confirmacaoLancamento(res);
        const view = { text: '{{fa-pen}} Corrigido! ' + base.text.replace(/^\{\{fa-check\}\}\s*/, ''), chip: base.chip };
        view.undo = () => this.#undoTx(info.profileId, txSnap);
        this.#lastUndo = view.undo;
        this.#lastTxInfo = { profileId: info.profileId, txSnap, cmd: info.cmd };
        return view;
    }

    // Insights de abertura (1º acesso do dia) — resumo do dia + no máx. mais um.
    // Chamado pela UI no boot, com gating de "1x por dia" feito lá. C25/C29/C30/A7.
    aberturaInsights() {
        const p = this.#active();
        if (!p) return [];
        const out = [];
        const rd = P.resumoDiaMsg(resumoDoDia(p));
        if (rd) out.push(rd);
        const segundo = P.metasParadasMsg(metasParadas(p)) || P.streakMsg(streakDias(p)) || P.curiosidadeMsg(diaMaisCaro(p));
        if (segundo) out.push(segundo);
        return out;
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

    // Processa UMA cláusula: local → (se incerto) IA → roteia.
    async #handleOne(text) {
        const local = parseLocal(text);
        if (local.confianca >= CONF_LOCAL_OK) {
            return this.#route(toCommand(local));
        }

        const ai = await parseWithAI(text, this.#labels());
        if (ai.ok) {
            return this.#route(toCommand({ ...ai.parse, source: 'ia' }));
        }
        if (ai.reason === 'rate') return { text: P.SISTEMA.rate() };
        if (ai.reason === 'auth') return { text: '{{fa-lock}} Sua sessão expirou — faça login de novo.' };

        // IA indisponível/sem parse: se o local tinha um palpite, usa; senão desiste.
        if (local.intencao !== 'desconhecido' && local.confianca >= 0.4) {
            return this.#route(toCommand(local));
        }
        return { text: P.naoEntendiEsperto(local) };
    }

    // ── Roteamento por intenção ────────────────────────────────────────────────
    async #route(cmd) {
        switch (cmd.intent) {
            case 'saudacao': return { text: P.SISTEMA.saudacao(this.#activeName()) };
            case 'ajuda':    return { text: P.SISTEMA.ajuda() };
            case 'desfazer': return this.#desfazerUltimo();
            case 'recusa':      return { text: P.SISTEMA.recusa() };
            case 'privacidade': return { text: P.privacidadeMsg() };

            case 'lancar':
                if (cmd.categoria === 'saida_credito') return this.#doCredito(cmd);
                if (cmd.categoria === 'retirada_reserva') return this.#doRetirada(cmd);
                if (!cmd.categoria || !(cmd.valor > 0)) return { text: P.SISTEMA.semValor() };
                return this.#doLancamento(cmd);

            case 'consultar': {
                const p = this.#active();
                this.#lastQuery = { consultaAlvo: cmd.consultaAlvo, palavrasChave: cmd.palavrasChave || [], periodo: cmd.periodo || 'mes' };
                if (cmd.consultaAlvo === 'saldo')       return { text: P.renderSaldo(saldoAtual(p)) };
                if (cmd.consultaAlvo === 'maior_gasto') return { text: P.renderMaiorGasto(maioresGastos(p, cmd.periodo || 'mes')) };
                if (cmd.consultaAlvo === 'listar')      return { text: P.renderUltimas(ultimasTransacoes(p)) };
                if (cmd.consultaAlvo === 'comparar')    return { text: P.renderComparar(compararMes(p)) };
                if (cmd.consultaAlvo === 'media')       return { text: P.renderMedia(mediaMensal(p)) };
                if (cmd.consultaAlvo === 'fatura')      return { text: P.renderFatura(faturaCartao(p, cmd.cartaoHint)) };
                if (cmd.consultaAlvo === 'falta_meta')  return { text: P.renderFaltaMeta(faltaMeta(p, cmd.metaHint)) };
                if (cmd.consultaAlvo === 'orcamento')   return { text: P.orcamentoRestanteMsg(orcamentoRestante(p)) };
                if (cmd.consultaAlvo === 'assinaturas') return { text: P.assinaturasMsg(assinaturasRecorrentes(p)) };
                if (cmd.consultaAlvo === 'narrativa')   return { text: P.narrativaMesMsg(narrativaMes(p)) };
                if (cmd.consultaAlvo === 'curiosidade') return { text: P.curiosidadeMsg(diaMaisCaro(p)) || 'Ainda não tenho gastos suficientes pra achar um padrão. Continua lançando! {{fa-lightbulb}}' };
                if (cmd.consultaAlvo === 'reserva' || cmd.palavrasChave.includes('reserva')) {
                    return { text: P.renderReservas(statusReservas(p)) };
                }
                if (cmd.consultaAlvo === 'entrada')     return { text: P.renderEntradas(consultarEntradas(p, cmd)) };
                return { text: P.renderConsulta(consultarGastos(p, cmd)) };
            }

            case 'relatorio':
                return { text: P.renderRelatorio(relatorio(this.#active(), cmd.periodo || 'mes')) };

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
            if (res.reason === 'handoff') return { text: P.renderHandoff(res.categoria), handoff: res.categoria };
            return { text: P.SISTEMA.semValor() };
        }

        // Insert otimista já aplicado em memória; persiste. Se falhar o save,
        // desfaz na memória pra não divergir do banco.
        const saved = await dataManager.saveUserData(this.#profiles);
        if (!saved) {
            try { undoLancamento(profile, res.transaction); } catch {}
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
        // Insight opcional pós-lançamento (A6/C23/C24/A7/A9) — no máximo UM, e só quando faz sentido.
        const extra = this.#insightPos(res.transaction);
        return extra ? { multi: [view, { text: extra }] } : view;
    }

    // ── Desfazer por texto ("apaga o último", "errei") ─────────────────────────
    async #desfazerUltimo() {
        if (!this.#lastUndo) return { text: 'Não há nada pra desfazer agora.' };
        const fn = this.#lastUndo;
        this.#lastUndo = null;
        try { return await fn(); } catch { return { text: P.SISTEMA.erro() }; }
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
