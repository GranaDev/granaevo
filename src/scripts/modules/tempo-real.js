// tempo-real.js — a campainha da conta
// ---------------------------------------------------------------------------
// Passo 37 · Camada 1. Ouve "a conta mudou, nos perfis X" e avisa quem chamou.
// NÃO traz dado: quem ouve busca pelo caminho normal, que autentica e decifra no
// servidor. Nenhum centavo trafega por aqui.
//
// ── POR QUE ESTE MÓDULO É CARREGADO SOB DEMANDA ─────────────────────────────
// O realtime-js pesa ~14,4 KB gzip e foi ARRANCADO do bundle de boot no Passo 8,
// porque o app não usava. Voltar ao boot desfaria aquele ganho para todo mundo —
// inclusive para quem só abre a landing. Aqui ele entra depois que o dashboard
// já pintou, e só para quem está logado.
//
// O apelido `granaevo:realtime` existe por causa de uma armadilha: o
// `@supabase/realtime-js` está aliasado para um STUB no vite.config, e o alias
// do Rollup casa por prefixo — então até um caminho profundo cairia no stub. O
// resultado seria tempo real funcionando em desenvolvimento e MUDO em produção.
//
// ── SEGURANÇA ──────────────────────────────────────────────────────────────
// `private: true` não é opcional. A autorização do Realtime (a política
// `conta_broadcast_ouvir`, que espelha o `user_data_select`) só se aplica a
// canal PRIVADO. Num canal público, qualquer um que soubesse o uuid da conta
// ouviria — e uuid não é segredo. O servidor também marca a mensagem como
// privada, então as duas pontas exigem autorização.
//
// E este cliente só ESCUTA. Não existe política de INSERT em
// `realtime.messages`, então nem que quisesse ele conseguiria emitir um aviso.
// ---------------------------------------------------------------------------

const RECONECTA_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

let _cliente = null;
let _canal   = null;
let _tentativa = 0;
let _parado = false;

/**
 * Diagnóstico em produção: `__tempoReal` no console.
 *
 * Existe porque este recurso falha CALADO — canal recusado, token não aplicado,
 * aviso filtrado: nenhum deles aparece na tela, e `console.*` não sobrevive ao
 * build (`drop_console: true` no vite.config). Atribuição a um global sobrevive.
 *
 * Sem valor nenhum do usuário: estado, contagem e motivo.
 */
function _diag(campo, valor) {
    try {
        if (!window.__tempoReal) window.__tempoReal = { estado: 'nao_iniciado', avisos: 0, ultimo: null };
        window.__tempoReal[campo] = valor;
    } catch { /* sem window (teste) */ }
}

/**
 * Id desta ABA. Vai junto de cada save e volta no aviso, para a aba de origem
 * ignorar o próprio eco — sem isso, todo save faria a própria tela recarregar.
 * Por aba, não por usuário: duas abas do mesmo login precisam se ouvir.
 */
export const CLIENT_ID = (() => {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch { /* contexto inseguro */ }
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
})();

/**
 * Liga a campainha.
 *
 * @param {object}   opts
 * @param {string}   opts.url        URL do projeto Supabase (wss derivado dela).
 * @param {string}   opts.apikey     Chave publicável — identifica o projeto, não o usuário.
 * @param {string}   opts.conta      Id do DONO da conta (o tópico é `conta:<id>`).
 * @param {Function} opts.token      () => Promise<string|null> — JWT válido, buscado a cada (re)conexão.
 * @param {Function} opts.aoMudar    ({perfis, em}) => void — não é chamado para o próprio eco.
 * @param {Function} [opts.aoEstado] ('ligado'|'caiu'|'sem_permissao') => void
 * @returns {Promise<boolean>} true se assinou.
 */
export async function ligar({ url, apikey, conta, token, aoMudar, aoEstado, aoPresenca, meuPerfil }) {
    if (!url || !apikey || !conta || typeof token !== 'function') { _diag('estado', 'faltou_config'); return false; }
    _parado = false;
    _diag('conta', String(conta).slice(0, 8) + '…');

    const jwt = await token();
    if (!jwt) { _diag('estado', 'sem_token'); return false; }

    // Importado aqui dentro, não no topo: é este `await import` que mantém os
    // 14,4 KB fora do boot.
    const { RealtimeClient } = await import('granaevo:realtime');

    if (_cliente) desligar();

    _cliente = new RealtimeClient(`${String(url).replace(/^http/, 'ws')}/realtime/v1`, {
        params: { apikey },
        // O pacote chama isto sempre que precisa de token — inclusive ao
        // reconectar. Melhor que fixar um JWT: canal privado com token expirado
        // é recusado, e a recusa não se resolve tentando de novo.
        accessToken: async () => (await token()) ?? null,
        // A reconexão é nossa (abaixo): a do pacote não conhece nossa política
        // de recuo nem distingue queda de recusa.
        reconnectAfterMs: () => 1e9,
    });

    // `setAuth` é ASSÍNCRONO. Sem o await, o canal entrava antes do token ser
    // aplicado — e canal privado sem token é recusado pela autorização. O
    // sintoma é o pior possível: nenhum erro, nenhum aviso, a campainha
    // simplesmente nunca toca.
    await _cliente.setAuth(jwt);

    _canal = _cliente.channel(`conta:${conta}`, { config: { private: true } });

    _canal.on('broadcast', { event: 'mudou' }, (msg) => {
        const p = msg?.payload ?? {};
        // O próprio eco. Sem este corte, cada save que a aba faz voltaria como
        // "alguém mudou" e ela recarregaria sozinha, em looping.
        if (p.origem && p.origem === CLIENT_ID) { _diag('ultimo', 'proprio_eco'); return; }
        _diag('avisos', (window.__tempoReal?.avisos ?? 0) + 1);
        _diag('ultimo', `mudou perfis=${(p.perfis || []).length}`);
        try {
            aoMudar?.({ perfis: Array.isArray(p.perfis) ? p.perfis.map(String) : [], em: p.em ?? null });
        } catch { /* o ouvinte quebrar não pode derrubar o canal */ }
    });

    // ── PRESENÇA ───────────────────────────────────────────────────────────
    // O conteúdo da presença é escrito pelo CLIENTE, então não dá para confiar
    // nele. Mandamos só o id do perfil; quem recebe resolve o nome localmente.
    // Um membro adulterado só consegue afirmar ser outro perfil DA PRÓPRIA
    // CONTA — que ele já enxerga. Nome, e-mail e texto livre não entram no fio.
    if (typeof aoPresenca === 'function') {
        _canal.on('presence', { event: 'sync' }, () => {
            const ids = new Set();
            try {
                for (const lista of Object.values(_canal.presenceState() ?? {})) {
                    for (const m of (lista ?? [])) {
                        // Aceita SÓ o campo esperado, com tipo e tamanho travados.
                        if (typeof m?.p === 'string' && m.p) ids.add(m.p.slice(0, 64));
                    }
                }
            } catch { /* estado malformado: melhor lista vazia que erro */ }
            try { aoPresenca([...ids]); } catch { /* o ouvinte não derruba o canal */ }
        });
    }

    return new Promise((resolve) => {
        let respondido = false;
        const responder = (v) => { if (!respondido) { respondido = true; resolve(v); } };

        _canal.subscribe((estado, erro) => {
            if (estado === 'SUBSCRIBED') {
                _tentativa = 0;
                _diag('estado', 'ligado');
                aoEstado?.('ligado');
                // Anuncia a própria presença DEPOIS de entrar no canal — antes
                // disso não há canal para escrever.
                if (typeof meuPerfil === 'function') {
                    const meu = String(meuPerfil() ?? '');
                    if (meu) Promise.resolve(_canal.track({ p: meu.slice(0, 64) })).catch(() => {});
                }
                responder(true);
                return;
            }
            if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
                // Recusa de autorização não se resolve tentando de novo: a
                // política negou, e insistir só gera ruído. Cai para o caminho
                // lento (recarregar a página) sem barulho para o usuário.
                const semPermissao = /unauthorized|not authorized|permission/i.test(String(erro?.message ?? erro ?? ''));
                _diag('estado', semPermissao ? 'sem_permissao' : `caiu:${estado}`);
                _diag('erro', String(erro?.message ?? erro ?? '').slice(0, 120) || null);
                aoEstado?.(semPermissao ? 'sem_permissao' : 'caiu');
                responder(false);
                if (!semPermissao) _reconectar({ url, apikey, conta, token, aoMudar, aoEstado });
            }
        });
    });
}

function _reconectar(opts) {
    if (_parado) return;
    const espera = RECONECTA_MS[Math.min(_tentativa, RECONECTA_MS.length - 1)];
    _tentativa++;
    setTimeout(() => {
        if (_parado) return;
        // Religa do zero para pegar um JWT novo: o antigo pode ter expirado, e é
        // por isso que a reconexão do pacote foi desativada.
        ligar(opts).catch(() => {});
    }, espera);
}

/** Desliga e solta o socket. Chamado no logout e ao trocar de conta. */
export function desligar() {
    _parado = true;
    try { _canal?.unsubscribe(); } catch { /* já caiu */ }
    try { _cliente?.disconnect(); } catch { /* já caiu */ }
    _canal = null;
    _cliente = null;
    _tentativa = 0;
}

/** Para diagnóstico e teste: está ouvindo? */
export function ligado() {
    return _canal?.state === 'joined';
}

// ── A ponte com a TELA ──────────────────────────────────────────────────────
// Filtro por perfil, adiamento enquanto há formulário aberto e o registro do
// diagnóstico moram AQUI, e não na página, por um motivo medido: o
// `dashboard.js` bateu 40,0/40 KB e reprovou o build da Vercel. Este código só
// existe para quem tem tempo real ligado — não pertence ao pacote que bloqueia a
// primeira pintura da tela.
//
// A página fica com o que só ela sabe: onde estão os dados e como repintar.

let _pendente = false;
let _ouvindoVisibilidade = false;
let _ultimoAoMudar = null;

/**
 * @param {object}   o
 * @param {Function} o.perfilAtual  () => string — id do perfil na tela.
 * @param {Function} o.ocupado      () => boolean — há formulário aberto?
 * @param {Function} o.recarregar   () => Promise<void> — busca e repinta.
 * @returns {Promise<{reaplicarPendente: Function}>}
 */
export async function ligarNaTela({ url, apikey, conta, token, perfilAtual, ocupado, recarregar, aoPresenca }) {
    const aplicar = (aviso) => {
        // Formulário aberto: trocar os arrays embaixo de quem está digitando
        // apaga o que a pessoa escreveu — a mesma perda que este passo veio
        // consertar, só que vinda de dentro. Fica pendente, não é descartado.
        if (ocupado?.()) { _pendente = true; _diag('ultimo', 'adiado: formulário aberto'); return; }
        _pendente = false;
        Promise.resolve(recarregar(aviso))
            .then(() => _diag('ultimo', 'aplicado'))
            .catch((e) => _diag('ultimo', `falhou: ${String(e?.message ?? e).slice(0, 60)}`));
    };

    const aoMudar = (aviso) => {
        // Numa conta de família, o lançamento do outro no perfil DELE não deve
        // sacudir a minha tela.
        const meu = perfilAtual?.() ?? '';
        if (aviso.perfis.length && meu && !aviso.perfis.includes(meu)) {
            _diag('ultimo', `ignorado: outro perfil (${aviso.perfis.length})`);
            return;
        }
        aplicar(aviso);
    };
    _ultimoAoMudar = aoMudar;

    await ligar({
        url, apikey, conta, token, aoMudar,
        aoPresenca,
        // Quem eu sou no canal: o perfil que está na tela. Nada além disso.
        meuPerfil: perfilAtual,
    });

    // ── Rede de segurança ao voltar para a aba ──────────────────────────────
    // Navegador suspende websocket em aba de fundo, e nem sempre avisa que
    // caiu. Quem volta para uma aba parada há uma hora não pode confiar que a
    // campainha continuou tocando.
    //
    // Duas coisas ao ganhar visibilidade: religa se o canal não estiver de pé, e
    // recarrega de qualquer forma. O refetch é barato e é a única garantia de
    // que a tela não está mostrando ontem.
    if (typeof document !== 'undefined' && !_ouvindoVisibilidade) {
        _ouvindoVisibilidade = true;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || _parado) return;
            if (!ligado()) {
                _diag('estado', 'religando');
                ligar({ url, apikey, conta, token, aoMudar: _ultimoAoMudar }).catch(() => {});
            }
            aplicar();
        });
    }

    return { reaplicarPendente: () => { if (_pendente) aplicar(); } };
}
