// ---------------------------------------------------------------------------
// config-perfil.js — sanitização do `config` POR PERFIL (viagem, horasVida).
//
// Extraído do dashboard.js (o campo minado do save) em 2026-07-24 para poder
// TESTAR a regra que já mordeu o projeto mais de uma vez: um campo do `config`
// que NÃO seja emitido por esta função é DESCARTADO no save seguinte — a
// "viagem que sumia", porque `dadosPerfil` é allow-list. Cada perfil tem seu
// próprio `config`; esta função é PURA e SEM ESTADO, então sanitizar o perfil A
// e depois o B não pode vazar dado de um para o outro (nada é retido entre
// chamadas). É essa invariante que os testes de regressão travam.
//
// `sanitizeText` é INJETADO (não duplicado) para manter uma única fonte de
// verdade com o sanitizador de texto do dashboard. Ver check-allowlist.mjs.
// ---------------------------------------------------------------------------

const _ISO_DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
const _HORA_RE    = /^\d{2}:\d{2}:\d{2}$/;

export function sanitizarConfigPerfil(cfg, sanitizeText) {
    const limpar = typeof sanitizeText === 'function' ? sanitizeText : (s) => String(s ?? '');
    const clean = Object.create(null);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return clean;

    const hv = cfg.horasVida;
    if (hv && typeof hv === 'object' && !Array.isArray(hv)) {
        const valorHora = Number(hv.valorHora);
        const modosValidos = ['hora', 'dia', 'mes'];
        if (modosValidos.includes(hv.modo) &&
            Number.isFinite(valorHora) && valorHora >= 0.01 && valorHora <= 100_000) {
            const out = {
                ativo:     hv.ativo === true,
                modo:      hv.modo,
                valorHora: Math.round(valorHora * 100) / 100,
            };
            const vb = Number(hv.valorBase);
            if (Number.isFinite(vb) && vb >= 0.01 && vb <= 10_000_000) out.valorBase = Math.round(vb * 100) / 100;
            const hd = Number(hv.horasDia);
            if (Number.isInteger(hd) && hd >= 1 && hd <= 24) out.horasDia = hd;
            const hs = Number(hv.horasSemana);
            if (Number.isInteger(hs) && hs >= 1 && hs <= 120) out.horasSemana = hs;
            clean.horasVida = out;
        }
    }

    // Modo viagem (item 11). Guardado no config — e NÃO como marcador nas
    // transações — porque o custo é derivado da janela [inicio, fim]; ver a
    // decisão de modelagem no topo de modules/viagem.js.
    const vg = cfg.viagem;
    if (vg && typeof vg === 'object' && !Array.isArray(vg) && _ISO_DIA_RE.test(String(vg.inicio || ''))) {
        const out = {
            ativa:  vg.ativa === true,
            nome:   limpar(String(vg.nome ?? '')).slice(0, 60) || 'Viagem',
            inicio: String(vg.inicio),
            fim:    _ISO_DIA_RE.test(String(vg.fim || '')) ? String(vg.fim) : null,
            // A HORA precisa estar aqui: sem ela a whitelist descartava o campo
            // e a viagem voltava a contar o dia inteiro — inclusive o que foi
            // lançado ANTES de ativar (bug relatado em 2026-07-16).
            inicioHora: _HORA_RE.test(String(vg.inicioHora || '')) ? String(vg.inicioHora) : null,
            fimHora:    _HORA_RE.test(String(vg.fimHora || ''))    ? String(vg.fimHora)    : null,
        };
        // Fim antes do início é incoerente: guarda só o início e deixa a viagem
        // em aberto, em vez de persistir uma janela que o motor recusaria.
        if (out.fim !== null && out.fim < out.inicio) { out.fim = null; out.fimHora = null; }
        clean.viagem = out;
    }
    return clean;
}
