// ========== DATA MANAGER - SISTEMA UNIFICADO DE SALVAMENTO ==========
import { supabase, getValidAccessToken, refreshSession as hybridRefresh } from '../services/supabase-client.js?v=2';
import { backfillIds, carimbarNovos, serializarEstavel, COLECOES } from './registro-id.js?v=1';
import { diffColecao, aplicarOperacoes, diffCampos, aplicarCampos, comEndereco } from './diff-registros.js?v=1';
import { captureError } from './error-tracking.js';

// ========== CONSTANTES PRIVADAS ==========
const MAX_PAYLOAD_BYTES  = 4_900_000;
const MAX_PROFILES       = 200;
const MAX_QUEUE_DEPTH    = 3;
const RPC_TIMEOUT_MS     = 15_000;
const DEBOUNCE_DELAY_MS  = 800;
const IS_DEV             = ['localhost', '127.0.0.1'].includes(window.location.hostname);

// Diagnóstico da fase de sombra EM PRODUÇÃO: /dashboard?opsdebug=1.
// Mesmo padrão do `?pwadebug=1` do assistente. Existe porque a pergunta que o
// 37.2a precisa responder — "as operações descrevem o save inteiro, com dados
// REAIS e legados?" — não tem resposta em localhost: lá os dados são novos e já
// nasceram com id. Só imprime CONTAGEM por tipo; nada de valor ou descrição.
// Lido uma vez, no carregamento: navegar dentro do app não desliga.
// ── Carimbos: campos que mudam a cada save por construção ───────────────────
// `lastUpdate` recebe `new Date().toISOString()` toda vez que o dashboard monta
// o perfil, e NINGUÉM o lê — os únicos `.lastUpdate` lidos no código são de
// `meta` (reserva compartilhada), não de perfil.
//
// Medido em produção com `?opsdebug=1`: todo save trazia exatamente um `set` a
// mais, mesmo quando o usuário não tinha mexido em nada. Era este.
//
// Por que precisa sair das operações: no 37.3 o conflito é detectado por campo.
// Um campo que muda sempre faria TODA gravação simultânea colidir — por causa de
// um dado que não carrega intenção nenhuma do usuário. Duas pessoas na mesma
// conta brigariam por um timestamp.
//
// ⚠️ Contrato com o 37.2a: quando o servidor passar a aplicar só operações, ELE
// carimba o `lastUpdate`. Sem isso o campo congela — inofensivo hoje (ninguém
// lê), mas seria uma mentira gravada.
const CARIMBOS = ['lastUpdate'];
const FORA_DAS_OPS = [...COLECOES, ...CARIMBOS];

const OPS_DEBUG = (() => {
    try { return new URLSearchParams(window.location.search).get('opsdebug') === '1'; }
    catch { return false; }
})();
const SUPABASE_BEACON_URL = `${window.location.origin}/api/user-data`;

// ========== VALIDADORES ==========

// ✅ Regex segura para IDs string (path traversal prevention)
const PROFILE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Valida a forma de um perfil.
 * strict=true (padrão, save): valida id, balance e name.
 * strict=false (load): só descarta o que claramente não é um objeto —
 *   dados do banco já foram validados no save; ser estrito no load rejeita
 *   perfis legítimos de antes da migração (id SERIAL inteiro, etc).
 */
function validateProfileShape(profile, { strict = true } = {}) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return 'perfil deve ser um objeto';
    }
    if (!strict) return null;
    const isIntId = Number.isInteger(profile.id) && profile.id > 0;
    const isStrId = typeof profile.id === 'string' && profile.id.trim() !== '';
    if (!isIntId && !isStrId) {
        return 'profile.id ausente ou inválido';
    }
    if (isStrId) {
        const trimmedId = profile.id.trim();
        if (!PROFILE_ID_REGEX.test(trimmedId)) {
            return 'profile.id possui caracteres inválidos (use apenas letras, números, hífen e underscore, máx. 64 chars)';
        }
    }
    if ('balance' in profile && !Number.isFinite(profile.balance)) {
        return 'profile.balance deve ser um número finito (NaN e Infinity não são aceitos)';
    }
    if ('name' in profile && (typeof profile.name !== 'string' || profile.name.length > 256)) {
        return 'profile.name inválido ou muito longo';
    }
    return null;
}

/**
 * Valida array completo de perfis — usado antes de qualquer save.
 */
function validateProfilesArray(profiles) {
    if (!Array.isArray(profiles)) {
        return { ok: false, error: 'profilesData não é um array' };
    }
    if (profiles.length > MAX_PROFILES) {
        return { ok: false, error: `número de perfis (${profiles.length}) excede o limite de ${MAX_PROFILES}` };
    }
    for (let i = 0; i < profiles.length; i++) {
        const err = validateProfileShape(profiles[i]);
        if (err) return { ok: false, error: `perfil [${i}] inválido: ${err}` };
    }
    return { ok: true };
}

// ========== CLASSE ==========
class DataManager {

    // ── Private class fields — invisíveis via console, XSS e extensões ──────
    #userId       = null;
    #userEmail    = null;
    #isSaving     = false;
    #lastSaveTime = null;
    #saveQueue    = Promise.resolve();
    #queueDepth   = 0;
    #debounceTimer   = null;
    #debounceResolve = null;
    #debouncePending = null;

    // Último count de perfis carregado do banco — usado pelo guarda anti-reset.
    // Atualizado em loadUserData(); zerado em reset().
    #lastKnownProfileCount = 0;

    // ── Guarda ANTI-WIPE (conteúdo) ──────────────────────────────────────────
    // O guard de count só bloqueia 0 perfis. Mas a falha real esvazia o CONTEÚDO
    // de um perfil (transações/contas/cartões/metas) mantendo o objeto — passava
    // batido e destruía dados. Estes campos rastreiam:
    //  - #lastLoadOk: o último loadUserData desta sessão foi um sucesso real
    //    (200 com dados parseados), e não um #emptyStructure() de falha transitória.
    //  - #idsWithData: ids de perfis que JÁ tiveram dados (persistido em localStorage
    //    p/ sobreviver a reloads — cobre o caso do 1º load da sessão falhar).
    #lastLoadOk  = false;

    // ── Retrato dos perfis como vieram do servidor (merge por perfil) ───────
    // Guarda id → JSON do perfil no último load/save bem-sucedido. No save,
    // comparar contra isto diz QUAIS perfis este cliente realmente mexeu.
    //
    // Por que aqui e não em cada tela: este é o ponto único por onde todo save
    // do app passa. Pedir a cada chamador que declare o que tocou exigiria
    // auditar dezenas de pontos de mutação — e bastaria um esquecido para o
    // dado de outro membro ser sobrescrito de novo, em silêncio.
    #retrato = new Map();

    #tirarRetrato(profiles) {
        this.#retrato = new Map();
        if (!Array.isArray(profiles)) return;
        for (const p of profiles) {
            try { this.#retrato.set(String(p?.id), JSON.stringify(p)); } catch { /* ciclo: fica de fora e conta como tocado */ }
        }
    }

    /** Ids que mudaram, sumiram ou nasceram desde o último load/save. */
    #perfisTocados(profiles) {
        const tocados = new Set();
        const agora = new Set();
        for (const p of profiles) {
            const id = String(p?.id);
            agora.add(id);
            let json = null;
            try { json = JSON.stringify(p); } catch { /* ignore */ }
            if (json === null || this.#retrato.get(id) !== json) tocados.add(id);
        }
        // Sumiu do array = exclusão. Precisa ser DECLARADA, senão o servidor
        // preserva o perfil (para ele, ausência passou a significar "não mexi").
        for (const id of this.#retrato.keys()) if (!agora.has(id)) tocados.add(id);
        return [...tocados];
    }

    // ── FASE DE SOMBRA (37.1b) ──────────────────────────────────────────────
    // As operações viajam no payload e o servidor as IGNORA. O ganho não é
    // funcional, é de confiança: o cliente aplica o próprio diff sobre o retrato
    // e confere que o resultado é idêntico ao estado atual. Se bater sempre, em
    // produção, com dados reais, então a derivação está certa — e só aí o
    // servidor passa a aplicar operações em vez de substituir tudo (37.2a).
    //
    // Ligar o servidor direto seria apostar que o diff está certo num caminho
    // que grava todo o dinheiro do app.
    #opsAvisado = false;

    /**
     * Tudo no perfil que NÃO é coleção nem carimbo: nome, foto, config,
     * orçamentos, conquistas, saldo. É o que vira operação `set`/`unset`.
     */
    #restoDoPerfil(p) {
        const out = {};
        if (!p || typeof p !== 'object') return out;
        for (const k of Object.keys(p)) if (!FORA_DAS_OPS.includes(k)) out[k] = p[k];
        return out;
    }

    #derivarOperacoes(profiles, tocados) {
        const alvo = new Set(tocados.map(String));
        const ops = [];
        const motivos = new Set();
        let completo = true;

        for (const p of profiles) {
            const id = String(p?.id);
            if (!alvo.has(id)) continue;

            let antes = null;
            const bruto = this.#retrato.get(id);
            if (bruto !== undefined) { try { antes = JSON.parse(bruto); } catch { /* retrato ilegível */ } }
            // Sem retrato: perfil que nasceu nesta sessão. Tudo nele é inserção —
            // e o "resto" abaixo vai acusar isso, porque perfil novo não é
            // descritível só por operações de coleção.
            const base = (antes && typeof antes === 'object') ? antes : {};

            for (const col of COLECOES) {
                const d = diffColecao(base[col], p?.[col]);
                if (d.ok !== true) { completo = false; motivos.add(`${col}:${d.motivo}`); continue; }

                // O AUTOTESTE. É ele que transforma a sombra em prova.
                const refeito = aplicarOperacoes(base[col] || [], d);
                if (serializarEstavel(refeito) !== serializarEstavel(p?.[col] || [])) {
                    completo = false; motivos.add(`${col}:reconstrucao_divergente`); continue;
                }
                ops.push(...comEndereco(d.ops, id, col));
            }

            // Campos fora das coleções (nome, foto, config, orçamentos,
            // conquistas, saldo). Sem eles, um perfil que só foi RENOMEADO
            // geraria zero operações — e aplicar zero operações devolveria o nome
            // antigo. Um `set` por chave, para duas pessoas mexendo em campos
            // diferentes não se atropelarem.
            const dc = diffCampos(base, p, FORA_DAS_OPS);
            if (dc.ok !== true) { completo = false; motivos.add(`perfil:${dc.motivo}`); continue; }

            const refeitoCampos = aplicarCampos(this.#restoDoPerfil(base), dc);
            if (serializarEstavel(refeitoCampos) !== serializarEstavel(this.#restoDoPerfil(p))) {
                completo = false; motivos.add('perfil:reconstrucao_divergente'); continue;
            }
            ops.push(...comEndereco(dc.ops, id, null));
        }

        // Divergência é a notícia; acordo é o esperado. Uma vez por sessão, para
        // um defeito sistemático não virar enxurrada. Sem id de perfil e sem
        // conteúdo: só o motivo e a contagem.
        if (!completo && !this.#opsAvisado) {
            this.#opsAvisado = true;
            try {
                captureError(new Error('ops_sombra_divergente'), {
                    motivos: [...motivos].join(','),
                    perfis_tocados: tocados.length,
                    operacoes: ops.length,
                });
            } catch { /* telemetria nunca derruba o save */ }
        }
        if (IS_DEV || OPS_DEBUG) {
            // Contagem POR TIPO, não a lista: `{edit: 900}` num save em que o
            // usuário só lançou uma transação denuncia na hora que o allowlist
            // está reescrevendo registro antigo — e é justamente o que precisa
            // ser respondido antes de o servidor confiar nas operações.
            const porTipo = {};
            for (const o of ops) porTipo[o.op] = (porTipo[o.op] || 0) + 1;

            // Em PRODUÇÃO isto tem de ser uma ATRIBUIÇÃO, não um console.log:
            // o build roda terser com `drop_console: true`, que apaga toda
            // chamada a console.* do bundle. Um log aqui não seria "difícil de
            // achar" — ele simplesmente não existe no arquivo que roda.
            // Atribuir a um global é código comum e sobrevive à minificação.
            if (OPS_DEBUG) {
                if (!Array.isArray(window.__sombra)) window.__sombra = [];
                if (window.__sombra.length < 20) {
                    window.__sombra.push({
                        save: window.__sombra.length + 1,
                        n: ops.length, ...porTipo,
                        completo,
                        motivos: [...motivos].join(', ') || '—',
                    });
                }
            }
            if (IS_DEV) {
                console.log(
                    `🔬 [SOMBRA] ${ops.length} operação(ões)`, porTipo,
                    `· completo=${completo}`, completo ? '' : `· ${[...motivos].join(', ')}`,
                );
            }
        }

        return { ops, completo };
    }
    #idsWithData = new Set();

    // ── Getter público — somente leitura ─────────────────────────────────────
    get userId() {
        return this.#userId;
    }

    async #getAuthToken() {
        // Garante token válido (renova via cookie HttpOnly se perto de expirar)
        return getValidAccessToken();
    }

    // ============================ //
    //        INICIALIZAÇÃO         //
    // ============================ //

    async initialize(userId, userEmail) {
        if (!userId || typeof userId !== 'string' || userId.trim() === '') {
            console.error('❌ [DATA-MANAGER] userId inválido na inicialização — deve ser string não-vazia');
            return false;
        }
        if (!userEmail || typeof userEmail !== 'string' || userEmail.trim() === '') {
            console.error('❌ [DATA-MANAGER] userEmail inválido na inicialização — deve ser string não-vazia');
            return false;
        }

        // ✅ Define ANTES de qualquer await para evitar race conditions
        this.#userId    = userId.trim();
        this.#userEmail = userEmail.trim();

        // Restaura a memória de "perfis que tinham dados" do último login neste
        // browser — arma o anti-wipe já no 1º save, mesmo se o 1º load falhar.
        this.#loadPersistedDataFlags();

        if (IS_DEV) {
            console.log('📦 [DATA-MANAGER] Inicializado com sucesso.');
            console.log('👤 UserID definido:', !!this.#userId);
            console.log('📧 Email definido:',  !!this.#userEmail);
        }

        return true;
    }

    /**
     * Limpa estado interno ao deslogar.
     * Cancela debounce pendente antes de limpar.
     */
    reset() {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer   = null;
            this.#debouncePending = null;
            if (this.#debounceResolve) {
                this.#debounceResolve(false);
                this.#debounceResolve = null;
            }
        }
        this.#userId               = null;
        this.#userEmail            = null;
        this.#isSaving             = false;
        this.#lastSaveTime         = null;
        this.#queueDepth           = 0;
        this.#saveQueue            = Promise.resolve();
        this.#lastKnownProfileCount = 0;
        // NÃO limpa o localStorage de #idsWithData — a memória do que tinha dados
        // deve sobreviver ao logout p/ proteger o próximo login no mesmo browser.
        this.#lastLoadOk           = false;
        this.#retrato              = new Map();
        this.#idsWithData          = new Set();
        if (IS_DEV) console.log('🔒 [DATA-MANAGER] Estado limpo — usuário deslogado');
    }

    // ============================ //
    //     CARREGAR DADOS           //
    // ============================ //

    async loadUserData() {
        try {
            // Pessimista por padrão: só vira true num sucesso real (200 + parse).
            // Qualquer #emptyStructure() de falha transitória deixa isto false,
            // o que ARMA o guarda anti-wipe nos saves subsequentes.
            this.#lastLoadOk = false;

            if (!this.#userId) {
                console.error('❌ [DATA-MANAGER] userId não definido — faça initialize() primeiro');
                return this.#emptyStructure();
            }

            if (IS_DEV) {
                console.log('📥 [DATA-MANAGER] Carregando dados do Supabase...');
                console.log('🔑 [DATA-MANAGER] User ID:', this.#userId);
            }

            const token = await this.#getAuthToken();
            if (!token) {
                console.error('❌ [DATA-MANAGER] Sessão inativa — faça login novamente');
                return this.#emptyStructure();
            }

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
            let resp;
            try {
                resp = await fetch('/api/user-data', {
                    headers: { 'Authorization': `Bearer ${token}` },
                    signal,
                });
            } finally {
                cleanup();
            }

            // Proxy indisponível — retorna estrutura vazia SEM sobrescrever o banco.
            // O registro existe no banco; o erro é temporário (deploy, proxy, rede).
            if (!resp.ok) {
                if (resp.status === 404) {
                    // Pode ser um usuário genuinamente novo — retorna vazio.
                    // O upsert em saveUserData criará o registro no primeiro save.
                    if (IS_DEV) console.log('⚠️ [DATA-MANAGER] Nenhum dado encontrado (404)');
                } else {
                    console.error(`❌ [DATA-MANAGER] Erro ao carregar: HTTP ${resp.status}`);
                }
                return this.#emptyStructure();
            }

            const result = await resp.json();

            if (!result?.data_json) {
                console.warn('⚠️ [DATA-MANAGER] data_json vazio, retornando estrutura padrão');
                return this.#emptyStructure();
            }

            const userData = result.data_json;

            if (!Array.isArray(userData.profiles)) userData.profiles = [];
            if (!userData.version)                  userData.version  = '1.0';

            // No load, usa validateProfileShape com strict:false — não valida id/balance
            // para não rejeitar perfis legítimos gravados antes da migração de segurança.
            const validProfiles = [];
            for (let i = 0; i < userData.profiles.length; i++) {
                const err = validateProfileShape(userData.profiles[i], { strict: false });
                if (err) {
                    console.warn(`⚠️ [DATA-MANAGER] Perfil [${i}] ignorado no load: ${err}`);
                } else {
                    validProfiles.push(userData.profiles[i]);
                }
            }
            userData.profiles = validProfiles;

            // Atualiza referência para o guarda anti-reset no próximo save
            this.#lastKnownProfileCount = userData.profiles.length;

            // Load real bem-sucedido: confia no estado e memoriza quem tinha dados.
            this.#lastLoadOk = true;
            this.#rememberProfilesWithData(userData.profiles);

            // Identidade dos registros antigos, ANTES do retrato. Registro gravado
            // antes do Passo 37 não tem `id`; sem um, não existe "editei ESTE
            // lançamento" — só "aqui está tudo", que é o que faz uma aba apagar a
            // outra. O id é DERIVADO dos campos justamente para que dois clientes
            // que leem a mesma linha cheguem ao mesmo nome.
            //
            // A ordem importa: depois do retrato, o perfil inteiro apareceria como
            // "tocado" no save seguinte, e o merge por perfil viraria enfeite
            // (declarar tudo = substituir tudo).
            const derivados = backfillIds(userData.profiles);
            this.#tirarRetrato(userData.profiles);
            if (IS_DEV && derivados > 0) {
                console.log(`🔖 [DATA-MANAGER] ${derivados} registro(s) antigo(s) ganharam id`);
            }

            if (IS_DEV) {
                console.log('✅ [DATA-MANAGER] Dados carregados:', {
                    profiles: userData.profiles.length,
                    version:  userData.version
                });
            }

            return userData;

        } catch (err) {
            if (err?.name === 'AbortError') {
                console.error('❌ [DATA-MANAGER] Timeout ao carregar dados (>15s)');
            } else {
                console.error('❌ [DATA-MANAGER] Erro crítico ao carregar dados:', err?.message ?? err);
            }
            return this.#emptyStructure();
        }
    }

    // ============================ //
    //     SALVAR (com debounce)    //
    // ============================ //

    async saveUserData(profilesData) {
        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [DATA-MANAGER] ${validation.error} — save rejeitado antes da fila`);
            return false;
        }

        // ✅ Debounce: coalescing de saves rápidos → apenas o último chega ao banco
        return new Promise((resolve) => {
            this.#debouncePending = profilesData;

            if (this.#debounceTimer !== null) {
                if (this.#debounceResolve) this.#debounceResolve(false);
                this.#debounceResolve = resolve;
                clearTimeout(this.#debounceTimer);
            } else {
                this.#debounceResolve = resolve;
            }

            this.#debounceTimer = setTimeout(() => {
                this.#debounceTimer = null;
                const pendingData    = this.#debouncePending;
                const pendingResolve = this.#debounceResolve;
                this.#debouncePending  = null;
                this.#debounceResolve  = null;

                this.#enqueue(() => this.#doSaveUserData(pendingData))
                    .then(pendingResolve)
                    .catch(() => pendingResolve(false));

            }, DEBOUNCE_DELAY_MS);
        });
    }

    /**
     * Save imediato — ignora o debounce.
     * Use em situações urgentes: beforeunload, fechar modal, troca de aba.
     */
    async saveUserDataNow(profilesData) {
        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
            if (this.#debounceResolve) {
                this.#debounceResolve(false);
                this.#debounceResolve = null;
            }
            this.#debouncePending = null;
        }
        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [DATA-MANAGER] ${validation.error} — saveNow rejeitado`);
            return false;
        }
        return this.#enqueue(() => this.#doSaveUserData(profilesData));
    }

    async #doSaveUserData(profilesData) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] Não é possível salvar: UserID não definido');
            return false;
        }

        // Guarda anti-reset: bloqueia save que zeraria dados existentes.
        // Cenário coberto: bug no frontend esvaziou o array em memória e o
        // debounce-save tentaria sobrescrever dados reais com array vazio.
        // Não bloqueia deleção legítima de 1 perfil (threshold > 1).
        if (this.#lastKnownProfileCount > 1 && profilesData.length === 0) {
            console.error(
                `❌ [DATA-MANAGER] BLOQUEIO ANTI-RESET: save de 0 perfis rejeitado ` +
                `(último load: ${this.#lastKnownProfileCount} perfis). ` +
                `Use restauração de backup se os dados foram perdidos.`
            );
            return false;
        }

        // Guarda ANTI-WIPE (conteúdo): cobre o caso em que o array de perfis NÃO
        // está vazio, mas um perfil que tinha dados está sendo esvaziado após um
        // load malsucedido (transações/contas/cartões/metas zerados em memória).
        if (this.isDestructiveSave(profilesData)) {
            console.error(
                '❌ [DATA-MANAGER] BLOQUEIO ANTI-WIPE: save esvaziaria um perfil que ' +
                'tinha dados, após um load malsucedido — rejeitado para não destruir ' +
                'dados reais no banco. Recarregue a página antes de tentar de novo.'
            );
            return false;
        }

        this.#isSaving = true;
        document.dispatchEvent(new CustomEvent('ge:save-start'));

        try {
            // Rede de segurança da identidade: o que nasceu nesta sessão e escapou
            // de receber id na criação ganha um agora. São mais de dez lugares que
            // criam transação — um esquecido não daria erro, só voltaria a perder o
            // dado da outra aba em silêncio.
            //
            // Carimba no ORIGINAL, não no clone: o id precisa ficar na memória que a
            // tela segura. Carimbado só no clone, o mesmo registro sortearia um id
            // diferente no save seguinte e apareceria como "apagou e criou outro".
            carimbarNovos(profilesData);

            // Deep clone — imunidade a mutação externa durante operações assíncronas
            const safeProfiles = structuredClone(profilesData);

            // ✅ userId e email NÃO vão no payload — servidor identifica via JWT.
            //    Apenas dados estruturais são enviados ao banco.
            // Merge por perfil: declara o que ESTE cliente realmente mexeu, para
            // o servidor preservar o trabalho dos outros membros da conta.
            // Calculado contra o retrato do último load/save — nenhuma tela
            // precisa declarar nada, e nenhuma pode esquecer de declarar.
            const tocados = this.#perfisTocados(safeProfiles);

            const sombra = this.#derivarOperacoes(safeProfiles, tocados);

            // ── SAVE QUE NÃO TEM NADA A DIZER NÃO É ENVIADO ─────────────────
            // O dashboard salva a cada 30 segundos, incondicionalmente. Uma aba
            // parada, que não mudou nada, mandava a visão dela do mundo — de 30
            // segundos atrás — por cima do que a outra aba acabou de gravar.
            //
            // Era a máquina do Lost Update: não bastava lançar nas duas abas ao
            // mesmo tempo; bastava DEIXAR uma aberta. E ela reaparecia a cada
            // meio minuto, para sempre.
            //
            // Só é seguro pular porque `completo` significa que as operações
            // descrevem TUDO que mudou. Zero operações num save completo é uma
            // afirmação forte: "não mexi em nada". Se algo escapou da derivação,
            // `completo` é falso e o save segue normalmente.
            if (sombra.completo && sombra.ops.length === 0) {
                if (IS_DEV || OPS_DEBUG) {
                    if (OPS_DEBUG) {
                        if (!Array.isArray(window.__sombra)) window.__sombra = [];
                        if (window.__sombra.length < 20) {
                            window.__sombra.push({ save: window.__sombra.length + 1, n: 0, enviado: false });
                        }
                    }
                    if (IS_DEV) console.log('🔇 [DATA-MANAGER] save pulado: nada mudou');
                }
                this.#lastSaveTime = new Date();
                document.dispatchEvent(new CustomEvent('ge:save-done'));
                return true;
            }

            const dataToSave = {
                version:  '1.0',
                profiles: safeProfiles,
                touched_profile_ids: tocados,
                profile_ops:  sombra.ops,
                ops_completo: sombra.completo,
                // A VIRADA (37.2a): declara que este cliente sabe sincronizar por
                // operação. A Edge só age quando as três chegam — e é ela que
                // exige `ops_completo`, então mandar isto sempre é honesto: diz
                // "eu sei", não "pode aplicar".
                //
                // O interruptor mora AQUI, no cliente, de propósito: desligar é um
                // deploy do front (rápido, reversível pela Vercel) em vez de um
                // redeploy da Edge no meio de um incidente.
                ops_aplicar: true,
                metadata: {
                    lastSync:      new Date().toISOString(),
                    totalProfiles: safeProfiles.length
                }
            };

            let serialized;
            try {
                serialized = JSON.stringify(dataToSave);
            } catch (serErr) {
                console.error('❌ [DATA-MANAGER] Falha ao serializar dados:', serErr?.message);
                return false;
            }

            // A sombra NUNCA pode ser o motivo de um save falhar. Numa conta com
            // milhares de transações, o primeiro save da sessão descreve todas
            // elas — e o payload passa a carregar o estado E as operações. Se
            // isso estourar o teto, a sombra sai e o save segue como sempre foi.
            if (serialized.length > MAX_PAYLOAD_BYTES && dataToSave.profile_ops.length > 0) {
                delete dataToSave.profile_ops;
                dataToSave.ops_completo = false;
                serialized = JSON.stringify(dataToSave);
                if (IS_DEV) console.warn('🔬 [DATA-MANAGER] sombra descartada: payload no limite');
            }

            if (serialized.length > MAX_PAYLOAD_BYTES) {
                console.error('❌ [DATA-MANAGER] Payload excede 4.9MB — salvamento abortado');
                return false;
            }

            if (IS_DEV) {
                console.log('💾 [DATA-MANAGER] Salvando dados...');
                console.log('📊 Perfis:', safeProfiles.length);
                console.log('📦 Tamanho:', serialized.length, 'bytes');
            }

            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
            let saveResp;
            try {
                let saveToken = await this.#getAuthToken();
                saveResp = await fetch('/api/user-data', {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': saveToken ? `Bearer ${saveToken}` : '',
                    },
                    body:   serialized,
                    signal,
                });

                // 403 da Edge Function — JWT pode ter expirado entre a leitura e o fetch.
                // Tenta uma vez com token refrescado via cookie HttpOnly antes de desistir.
                if (saveResp.status === 403) {
                    const grant = await hybridRefresh().catch(() => null);
                    saveToken = grant?.access_token ?? null;
                    if (saveToken) {
                        const { signal: sig2, cleanup: cl2 } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
                        try {
                            saveResp = await fetch('/api/user-data', {
                                method:  'POST',
                                headers: {
                                    'Content-Type':  'application/json',
                                    'Authorization': `Bearer ${saveToken}`,
                                },
                                body:   serialized,
                                signal: sig2,
                            });
                        } finally { cl2(); }
                    }
                }
            } finally {
                cleanup();
            }

            if (!saveResp.ok) {
                const errText = await saveResp.text().catch(() => '');
                console.error('❌ [DATA-MANAGER] Erro ao salvar no banco:', saveResp.status, errText);
                document.dispatchEvent(new CustomEvent('ge:save-error'));
                return false;
            }

            // O que o SERVIDOR decidiu fazer com as operações. Sem isto, "por que
            // meu save não usou operações?" só se responde por log do servidor —
            // que o dono não vê. Só motivo e contagens; nada do dinheiro dele.
            if (OPS_DEBUG) {
                const eco = await saveResp.clone().json().catch(() => null);
                if (!Array.isArray(window.__sombra)) window.__sombra = [];
                const ultima = window.__sombra[window.__sombra.length - 1];
                if (ultima && ultima.enviado !== false) {
                    ultima.servidor = eco?.ops?.via === true ? `✅ ${eco.ops.motivo}` : `❌ ${eco?.ops?.motivo ?? '?'}`;
                }
            }

            this.#lastSaveTime = new Date();
            // O que acabou de subir vira o novo retrato: sem isto, o MESMO
            // perfil seria declarado como tocado em todo save seguinte, e a
            // proteção viraria enfeite (declarar tudo = substituir tudo).
            this.#tirarRetrato(safeProfiles);
            document.dispatchEvent(new CustomEvent('ge:save-done'));
            return true;

        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro crítico ao salvar:', err?.message ?? err);
            document.dispatchEvent(new CustomEvent('ge:save-error'));
            return false;

        } finally {
            this.#isSaving = false;
        }
    }

    // ============================ //
    //   SALVAR PERFIL ESPECÍFICO   //
    // ============================ //

    async saveProfileData(dadosPerfil) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] saveProfileData: UserID não definido — faça initialize() primeiro');
            return false;
        }
        const validationError = validateProfileShape(dadosPerfil);
        if (validationError) {
            console.error('❌ [DATA-MANAGER] Perfil inválido:', validationError);
            return false;
        }
        return this.#enqueue(() => this.#doSaveProfileData(dadosPerfil));
    }

    async #doSaveProfileData(dadosPerfil) {
        if (!this.#userId) {
            console.error('❌ [DATA-MANAGER] Não é possível salvar perfil: UserID não definido');
            return false;
        }

        let safeProfile;
        try {
            safeProfile = structuredClone(dadosPerfil);
        } catch (cloneErr) {
            console.error('❌ [DATA-MANAGER] Falha ao clonar perfil:', cloneErr?.message);
            return false;
        }

        try {
            // Carrega o estado atual, atualiza apenas o perfil específico, salva tudo
            const userData = await this.loadUserData();

            const idx = userData.profiles.findIndex(
                p => String(p.id) === String(safeProfile.id)
            );

            if (idx !== -1) {
                userData.profiles[idx] = safeProfile;
            } else {
                userData.profiles.push(safeProfile);
            }

            // ✅ Chama diretamente #doSaveUserData (já estamos dentro da fila)
            return await this.#doSaveUserData(userData.profiles);

        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro ao salvar perfil:', err?.message ?? err);
            return false;
        }
    }

    // ============================================================= //
    //  SALVAMENTO IMEDIATO (beforeunload / troca de aba)           //
    //  Usa fetch com keepalive=true para manter o JWT no header.   //
    //  navigator.sendBeacon não suporta headers customizados,      //
    //  então retornaria 401 — abordagem correta é keepalive.       //
    // ============================================================= //

    async saveImmediate(profilesData) {
        if (!this.#userId) return false;

        if (this.#debounceTimer !== null) {
            clearTimeout(this.#debounceTimer);
            this.#debounceTimer = null;
            if (this.#debounceResolve) {
                this.#debounceResolve(false);
                this.#debounceResolve = null;
            }
            this.#debouncePending = null;
        }

        const validation = validateProfilesArray(profilesData);
        if (!validation.ok) {
            console.error(`❌ [SAVE-IMMEDIATE] ${validation.error} — cancelado`);
            return false;
        }

        if (this.isDestructiveSave(profilesData)) {
            console.error('❌ [SAVE-IMMEDIATE] BLOQUEIO ANTI-WIPE — perfil com dados seria esvaziado após load falho. Cancelado.');
            return false;
        }

        // Identidade e declaração do que foi tocado valem AQUI TAMBÉM. Este
        // caminho mandava só `{profiles}` — e, para a Edge, corpo sem
        // `touched_profile_ids` significa "substitua tudo" (compatibilidade com
        // clientes antigos). Ou seja: fechar a aba desligava o merge por perfil e
        // sobrescrevia o trabalho dos outros membros da conta. Mesmo defeito que
        // o Passo 37 ataca, escondido no caminho do unload.
        carimbarNovos(profilesData);

        let payload;
        try {
            payload = JSON.stringify({
                profiles: profilesData,
                touched_profile_ids: this.#perfisTocados(profilesData),
            });
        } catch (serErr) {
            console.error('❌ [SAVE-IMMEDIATE] Falha ao serializar:', serErr?.message);
            return false;
        }

        // keepalive tem limite de ~64KB no browser; acima disso não envia.
        if (payload.length > 60_000) {
            console.warn('⚠️ [SAVE-IMMEDIATE] Payload excede 60KB — abortado');
            return false;
        }

        const token = await this.#getAuthToken();
        if (!token) {
            console.error('❌ [SAVE-IMMEDIATE] Sem token JWT — abortado');
            return false;
        }

        try {
            // keepalive: true garante que o browser completa o request mesmo após
            // o unload da página — equivalente funcional ao sendBeacon com headers.
            const resp = await fetch(SUPABASE_BEACON_URL, {
                method:    'POST',
                keepalive: true,
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: payload,
            });

            if (IS_DEV) {
                console.log(resp.ok
                    ? '✅ [SAVE-IMMEDIATE] Enviado com sucesso'
                    : `❌ [SAVE-IMMEDIATE] HTTP ${resp.status}`
                );
            }

            return resp.ok;
        } catch (err) {
            if (IS_DEV) console.error('❌ [SAVE-IMMEDIATE] Erro de rede:', err?.message);
            return false;
        }
    }

    // ============================ //
    //     EXPORTAR BACKUP LOCAL    //
    // ============================ //

    async exportUserData() {
        let url;
        try {
            const data = await this.loadUserData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            url = URL.createObjectURL(blob);

            const safeEmail = (this.#userEmail ?? 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
            const dateStr   = new Date().toISOString().slice(0, 10);

            const a = document.createElement('a');
            a.href     = url;
            a.download = `granaevo_backup_${safeEmail}_${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            if (IS_DEV) console.log('✅ Backup exportado com sucesso!');

        } catch (err) {
            console.error('❌ [EXPORT] Falha ao exportar backup:', err?.message ?? err);
        } finally {
            if (url) URL.revokeObjectURL(url);
        }
    }

    // ============================ //
    //    STATUS (sem dados PII)    //
    // ============================ //

    getStatus() {
        return Object.freeze({
            initialized:  !!this.#userId,
            isSaving:     this.#isSaving,
            queueDepth:   this.#queueDepth,
            debouncing:   this.#debounceTimer !== null,
            lastSaveTime: this.#lastSaveTime
        });
    }

    // ============================ //
    //     PRIVADOS — UTILITÁRIOS   //
    // ============================ //

    #enqueue(fn) {
        if (this.#queueDepth >= MAX_QUEUE_DEPTH) {
            console.warn(`⚠️ [DATA-MANAGER] Fila cheia (${this.#queueDepth}/${MAX_QUEUE_DEPTH}) — save descartado`);
            return Promise.resolve(false);
        }
        this.#queueDepth++;
        this.#saveQueue = this.#saveQueue
            .then(() => fn())
            .finally(() => { this.#queueDepth--; });
        return this.#saveQueue;
    }

    #makeAbortSignal(timeoutMs) {
        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), timeoutMs);
        return {
            signal:  controller.signal,
            cleanup: () => clearTimeout(timer)
        };
    }

    async #createInitialRecord() {
        const initialData = this.#emptyStructure();
        try {
            const { signal, cleanup } = this.#makeAbortSignal(RPC_TIMEOUT_MS);
            let resp;
            try {
                const initToken = await this.#getAuthToken();
                resp = await fetch('/api/user-data', {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': initToken ? `Bearer ${initToken}` : '',
                    },
                    body:   JSON.stringify({ profiles: [] }),
                    signal,
                });
            } finally {
                cleanup();
            }
            if (IS_DEV) {
                if (resp.ok) console.log('✅ [DATA-MANAGER] Registro inicial criado com sucesso!');
                else         console.error('❌ [DATA-MANAGER] Erro ao criar registro inicial:', resp.status);
            }
        } catch (err) {
            console.error('❌ [DATA-MANAGER] Erro crítico ao criar registro:', err?.message ?? err);
        }
        return initialData;
    }

    #emptyStructure() {
        return { version: '1.0', profiles: [] };
    }

    // ============================ //
    //   ANTI-WIPE (CONTEÚDO)       //
    // ============================ //

    #dataFlagsKey() {
        return `ge_hasdata_${this.#userId}`;
    }

    // Um perfil "tem dados" se qualquer coleção financeira não está vazia.
    #profileHasData(p) {
        if (!p || typeof p !== 'object') return false;
        const nonEmpty = (k) => Array.isArray(p[k]) && p[k].length > 0;
        return nonEmpty('transacoes')     || nonEmpty('metas') ||
               nonEmpty('contasFixas')    || nonEmpty('cartoesCredito') ||
               nonEmpty('assinaturas');
    }

    // Memoriza (RAM + localStorage) ids de perfis que vieram COM dados num load
    // bem-sucedido. Persistir cobre o caso do 1º load da sessão já falhar.
    #rememberProfilesWithData(profiles) {
        for (const p of profiles) {
            if (this.#profileHasData(p)) this.#idsWithData.add(String(p.id));
        }
        try {
            localStorage.setItem(this.#dataFlagsKey(), JSON.stringify([...this.#idsWithData]));
        } catch { /* localStorage indisponível — degrada para só-RAM */ }
    }

    #loadPersistedDataFlags() {
        try {
            const raw = localStorage.getItem(this.#dataFlagsKey());
            if (!raw) return;
            const ids = JSON.parse(raw);
            if (Array.isArray(ids)) for (const id of ids) this.#idsWithData.add(String(id));
        } catch { /* ignore */ }
    }

    /**
     * Guarda ANTI-WIPE. true se o save esvaziaria um perfil que JÁ teve dados,
     * num momento em que o último load NÃO foi sucesso real — sinal de que a
     * memória está zerada por falha transitória e persistir destruiria o banco.
     * Se o último load foi OK, confia no estado (permite esvaziamento legítimo).
     * Público para o beforeunload do dashboard (POST cru) também poder consultar.
     */
    /**
     * O último loadUserData foi um sucesso REAL (200 + parse), e não um
     * #emptyStructure() de falha transitória (offline, proxy fora, timeout)?
     *
     * Público desde 2026-07-20 (RF-06, offline de leitura): sem isto o dashboard
     * não distinguia "o usuário não tem dados" de "a rede não respondeu" — e
     * renderizava R$ 0,00 offline, o que parece perda de dados.
     */
    get lastLoadOk() {
        return this.#lastLoadOk;
    }

    isDestructiveSave(profilesData) {
        if (this.#lastLoadOk) return false;
        if (!Array.isArray(profilesData)) return false;
        for (const p of profilesData) {
            if (p && this.#idsWithData.has(String(p.id)) && !this.#profileHasData(p)) {
                return true;
            }
        }
        return false;
    }
}

// ========== INSTÂNCIA GLOBAL ==========
const dataManagerInstance = new DataManager();

// Exposição global da instância: necessária em PRODUÇÃO também porque o
// graficos.js (script clássico em public/, não importa ESM) captura
// window.dataManager para gerar gráficos compartilhados (casal/família).
// Não é vazamento: são os dados do próprio usuário, já client-side.
window.dataManager = dataManagerInstance;

// Helper de debug verboso APENAS em desenvolvimento.
if (IS_DEV) {
    window.debugDataManager = () => {
        console.log('=== DATA MANAGER STATUS ===');
        console.log(dataManagerInstance.getStatus());
        console.log('==========================');
    };
}

export const dataManager = dataManagerInstance;