// boot-cache.js — cache de boot do dashboard, CIFRADO em repouso.
// ---------------------------------------------------------------------------
// PARA QUE SERVE
// Guarda os KPIs já renderizados do topo (entradas/saídas/saldo/reservas) por
// usuário+perfil, para que o próximo boot pinte os números na hora, enquanto o
// load de rede ainda corre. É a metade "display-only" do Passo 9.
//
// A REGRA QUE NÃO SE AFROUXA
// Isto pinta PIXELS. Nunca alimenta `transacoes`/`metas`/`contasFixas` nem
// qualquer coisa que o save leia. Por construção, um cache velho aqui não tem
// como virar gravação — e é essa impossibilidade, não uma guarda em tempo de
// execução, que impede o incidente de wipe (ver data_wipe_incident_2026_06_23 e
// bug_critico_perfis_viagem_2026_07_18). Se algum dia alguém quiser ler daqui
// para dentro dos arrays, essa mudança é que precisa de revisão, não este arquivo.
//
// POR QUE CIFRADO (mudança de 2026-07-19)
// A v1 gravava `{"sa": 4820.55}` em texto claro no localStorage. O app já cifra
// o histórico do chat com AES-GCM exatamente porque valor financeiro em claro no
// localStorage era errado (ver assistant/crypto-store.js) — mas o SALDO ficava em
// claro. Mesma classe de dado, mesmo tratamento agora: reutilizamos a primitiva
// do assistente (chave AES-GCM NÃO-extraível no IndexedDB, por usuário).
//
// FALLBACK HONESTO: sem WebCrypto/IndexedDB (browser antigo, modo privado), não
// persistimos nada. Perde-se a pintura instantânea; não se perde correção — o
// boot simplesmente espera a rede, como sempre fez.
// ---------------------------------------------------------------------------

import { encryptText, decryptText } from './assistant/crypto-store.js';

const SCHEMA = 2;                       // v1 = texto claro (purgada, ver abaixo)
const PREFIXO_V1 = 'ge_boot_kpi_';      // claro
const PREFIXO = 'ge_bootc_';            // cifrado

function _chave(userId, perfilId) {
    return `${PREFIXO}${userId}_${perfilId}`;
}

/**
 * Apaga as chaves da v1 (KPIs em texto claro). Chamada uma vez por sessão; não
 * há migração de propósito — o dado é reconstruível no primeiro render, e migrar
 * significaria ler e reescrever um valor que não deveria ter sido gravado assim.
 */
export function purgarClaro() {
    try {
        const remover = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(PREFIXO_V1)) remover.push(k);
        }
        remover.forEach((k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } });
        return remover.length;
    } catch (_) { return 0; }
}

// Purga na importação: este módulo só é carregado no boot do dashboard, que é
// exatamente quando as chaves v1 (saldo em claro) precisam sumir do aparelho.
// Fica aqui, e não no dashboard.js, porque lá o orçamento do chunk é de 40 KB.
purgarClaro();

/** Grava os KPIs cifrados. Best-effort: nunca lança, nunca bloqueia o render. */
export async function guardarKpis(userId, perfilId, kpis) {
    if (!userId || !perfilId || !kpis) return false;
    try {
        const payload = JSON.stringify({
            v:  SCHEMA,
            u:  String(userId),
            p:  String(perfilId),
            em: Date.now(),
            e:  Number(kpis.entradas),
            s:  Number(kpis.saidas),
            sa: Number(kpis.saldo),
            r:  Number(kpis.reservas),
        });
        const cifrado = await encryptText(userId, payload);
        if (!cifrado) return false;                  // sem cripto → não persiste
        localStorage.setItem(_chave(userId, perfilId), cifrado);
        return true;
    } catch (_) {
        // QuotaExceeded ou storage bloqueado: limpa a própria chave e desiste.
        try { localStorage.removeItem(_chave(userId, perfilId)); } catch (_) { /* ignore */ }
        return false;
    }
}

/**
 * Lê e decifra os KPIs. Devolve `null` sempre que houver qualquer dúvida:
 * cripto indisponível, schema diferente, ou envelope de OUTRO usuário/perfil.
 * A conferência de `u`/`p` é defesa em profundidade — a chave já os inclui, mas
 * dado de conta trocada na tela é o tipo de erro que assusta o usuário.
 */
export async function lerKpis(userId, perfilId) {
    if (!userId || !perfilId) return null;
    let cifrado;
    try { cifrado = localStorage.getItem(_chave(userId, perfilId)); } catch (_) { return null; }
    if (!cifrado) return null;

    const plano = await decryptText(userId, cifrado);
    if (!plano) return null;                          // chave destruída/corrompido

    let d;
    try { d = JSON.parse(plano); } catch (_) { return null; }
    if (!d || d.v !== SCHEMA) return null;
    if (String(d.u) !== String(userId) || String(d.p) !== String(perfilId)) return null;

    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    return { entradas: num(d.e), saidas: num(d.s), saldo: num(d.sa), reservas: num(d.r) };
}

/** Logout / troca de conta: remove todo cache de boot deste aparelho. */
export function limparTudo() {
    try {
        const remover = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith(PREFIXO) || k.startsWith(PREFIXO_V1))) remover.push(k);
        }
        remover.forEach((k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } });
        return remover.length;
    } catch (_) { return 0; }
}
