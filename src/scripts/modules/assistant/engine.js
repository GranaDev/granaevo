// engine.js — orquestrador do Assistente GranaEvo
// ---------------------------------------------------------------------------
// Funil: parser LOCAL (grátis) → se incerto, IA como função → roteia intenção.
// Mantém os perfis em memória (carregados 1x), aplica lançamentos com insert
// otimista + undo, e persiste via dataManager (anti-wipe + debounce + validação
// já embutidos). A IA só recebe texto + rótulos (nomes) — nunca R$.
// ---------------------------------------------------------------------------

import { dataManager } from '../data-manager.js';
import { parseLocal, splitCompound } from './parser-local.js';
import { parseValorBR } from './money.js';
import { toCommand } from './normalize.js';
import { applyLancamento, undoLancamento, resolveMeta, applyCredito, undoCredito } from './tx-builder.js';
import { consultarGastos, consultarEntradas, saldoAtual, relatorio, statusReservas, projecaoMeta } from './query.js';
import { parseWithAI } from './assistant-api.js';
import * as P from './phrases.js';

const CONF_LOCAL_OK = 0.7; // acima disso confiamos no parser local (sem gastar IA)

class AssistantEngine {
    #profiles = [];
    #activeId = null;
    #ready = false;
    #pendingReserva = null; // { valor, tipo, descricao } aguardando escolha de meta
    #pendingCredito = null; // { descricao, tipo } aguardando o valor da compra

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

    // ── Entrada principal ────────────────────────────────────────────────────
    async handle(rawText) {
        if (!this.#ready) return { text: P.SISTEMA.erro() };
        const text = String(rawText ?? '').trim();
        if (!text) return { text: P.SISTEMA.naoEntendi() };
        if (!this.#active()) return { text: '{{fa-gear}} Selecione um perfil primeiro nas configurações.' };

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
        return { text: P.SISTEMA.naoEntendi() };
    }

    // ── Roteamento por intenção ────────────────────────────────────────────────
    async #route(cmd) {
        switch (cmd.intent) {
            case 'saudacao': return { text: P.SISTEMA.saudacao() };
            case 'ajuda':    return { text: P.SISTEMA.ajuda() };

            case 'lancar':
                if (cmd.categoria === 'saida_credito') return this.#doCredito(cmd);
                if (!cmd.categoria || !(cmd.valor > 0)) return { text: P.SISTEMA.semValor() };
                return this.#doLancamento(cmd);

            case 'consultar': {
                const p = this.#active();
                if (cmd.consultaAlvo === 'saldo')   return { text: P.renderSaldo(saldoAtual(p)) };
                if (cmd.consultaAlvo === 'reserva' || cmd.palavrasChave.includes('reserva')) {
                    return { text: P.renderReservas(statusReservas(p)) };
                }
                if (cmd.consultaAlvo === 'entrada') return { text: P.renderEntradas(consultarEntradas(p, cmd)) };
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
