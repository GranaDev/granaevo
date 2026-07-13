// outbox.js — fila de lançamentos feitos SEM internet (offline-first)
// ---------------------------------------------------------------------------
// O parser local funciona 100% offline; só o SAVE precisa de rede. Quando o
// save falha e o aparelho está offline, o comando canônico (já validado pelo
// normalize) entra nesta fila. Ao voltar a conexão (evento 'online' ou próximo
// boot), o engine reaplica cada comando pelo MESMO caminho de sempre
// (applyLancamento → dataManager.saveUserData, com anti-wipe intacto).
//
// Regras de integridade:
//  • Só comandos de lançamento simples (entrada/saida/reserva) entram na fila —
//    crédito/retirada dependem de estado fresco (cartão/meta) e não enfileiram.
//  • A fila guarda o COMANDO (intenção), não o estado — o replay reaplica sobre
//    os dados mais recentes do servidor, sem risco de sobrescrever nada.
//  • Cap pequeno (20) e por usuário; limpo no logout.
// ---------------------------------------------------------------------------

const MAX = 20;

function _key(userId) { return `ge_asst_outbox_${userId || 'anon'}`; }

function _read(userId) {
    try {
        const arr = JSON.parse(localStorage.getItem(_key(userId)) || '[]');
        return Array.isArray(arr) ? arr.slice(0, MAX) : [];
    } catch { return []; }
}

function _write(userId, arr) {
    try { localStorage.setItem(_key(userId), JSON.stringify(arr.slice(0, MAX))); } catch { /* ignore */ }
}

const CATEGORIAS_OK = ['entrada', 'saida', 'reserva'];

/** Enfileira um comando de lançamento (retorna false se não elegível/cheio). */
export function enqueue(userId, profileId, cmd) {
    if (!cmd || cmd.intent !== 'lancar' || !CATEGORIAS_OK.includes(cmd.categoria)) return false;
    if (!(Number(cmd.valor) > 0)) return false;
    const fila = _read(userId);
    if (fila.length >= MAX) return false;
    fila.push({
        profileId: String(profileId),
        cmd: {
            intent: 'lancar',
            categoria: cmd.categoria,
            valor: Number(cmd.valor),
            tipo: cmd.tipo ?? null,
            descricao: cmd.descricao ?? null,
            metaHint: cmd.metaHint ?? null,
            dataOverride: cmd.dataOverride ?? null,
            _confirmed: true,
        },
        queuedAt: Date.now(),
    });
    _write(userId, fila);
    return true;
}

/** Lê a fila (para o flush do engine). */
export function peekAll(userId) { return _read(userId); }

/** Substitui a fila pelos itens que AINDA não foram aplicados. */
export function keepOnly(userId, restantes) { _write(userId, restantes); }

/** Tamanho atual da fila. */
export function size(userId) { return _read(userId).length; }

/** Limpa a fila (logout). */
export function clearOutbox(userId) {
    try { localStorage.removeItem(_key(userId)); } catch { /* ignore */ }
}
