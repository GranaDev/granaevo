// reminders.js — lembretes do usuário → Radar (radar_notifications)
// ---------------------------------------------------------------------------
// "me lembra de pagar o aluguel dia 5" → INSERT (sob RLS: só o próprio usuário,
// status 'pending') na mesma tabela que o Radar usa. A entrega é o pipeline já
// existente (Vercel Cron → edge send-radar-push → Web Push). Nenhum código novo
// no servidor além do tipo 'lembrete' no CHECK.
//
// É o data-layer ÚNICO de lembretes: o engine do assistente cria/desfaz por aqui,
// e o Calendário (db-calendario.js) lista/cria/exclui pela mesma porta. Fica em
// assistant/ por herança histórica — mas não tem nada de específico do chat.
//
// ── TRÊS MARCOS DE AVISO (2026-07-19) ───────────────────────────────────────
// O usuário pediu: avisar 1 semana antes, 3 dias antes e no dia. Cada marco é
// UMA linha em radar_notifications, com o mesmo pipeline de push. Só criamos os
// marcos que ainda estão no FUTURO (um lembrete para depois de amanhã não gera
// o aviso de "1 semana antes"). As três linhas compartilham a chave-base para
// que excluir/desfazer leve todas juntas; o Calendário mostra só a linha do DIA.
//
// PRIVACIDADE: o texto é do usuário e fica em claro na tabela (como todo payload
// do Radar — o servidor precisa lê-lo para montar o push). Não anexamos nada
// além do que ele digitou.
// ---------------------------------------------------------------------------

import { supabase } from '../../services/supabase-client.js?v=2';

const HORA_DISPARO = 8; // mesma hora dos eventos do Radar

// Marcos de antecedência, em dias. 0 = no próprio dia. A ordem não importa;
// filtramos por "ainda é futuro" na criação.
const MARCOS = [
    { dias: 7, sufixo: ':d7', prefixoBody: 'Semana que vem' },
    { dias: 3, sufixo: ':d3', prefixoBody: 'Em 3 dias'      },
    { dias: 0, sufixo: '',    prefixoBody: 'Hoje'           }, // canônico (a linha do dia)
];

function _slug(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lembrete';
}

function _clamp(s, max) {
    return String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/** As três chaves possíveis de um lembrete (base + marcos). Base = a do dia. */
function _todasAsChaves(base) {
    return MARCOS.map((m) => (base + m.sufixo).slice(0, 120));
}

/**
 * Cria um lembrete com até 3 avisos (7d, 3d e no dia — só os futuros).
 * `dataISO` = "YYYY-MM-DD" (futura, ≤ 60 dias — CHECK no DB).
 * @returns {Promise<{ok:true, dedupeKey:string} | {ok:false, reason:'auth'|'dup'|'cap'|'net'}>}
 *   dedupeKey = a chave-base (a do dia), a que o engine já usa para desfazer.
 */
export async function criarLembrete(texto, dataISO) {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return { ok: false, reason: 'auth' };

    const texClamp = _clamp(texto, 120);
    const base = `lembrete:${_slug(texto)}:${dataISO}`.slice(0, 120);
    const title = _clamp(`Lembrete: ${texClamp}`, 80); // o Calendário lê o texto daqui
    const agora = Date.now();

    const linhas = [];
    for (const m of MARCOS) {
        const fire = new Date(`${dataISO}T00:00:00`);
        fire.setDate(fire.getDate() - m.dias);
        fire.setHours(HORA_DISPARO, 0, 0, 0);
        // Só agenda o marco se ele ainda está por vir. O do dia sempre entra
        // (lembrete é sempre futuro); os antecipados caem fora quando a data
        // está perto demais.
        if (m.dias > 0 && fire.getTime() <= agora) continue;
        const corpo = _clamp(`${m.prefixoBody}: ${texClamp}`, 200) || 'Você pediu pra eu te lembrar.';
        linhas.push({
            user_id:    uid,
            dedupe_key: (base + m.sufixo).slice(0, 120),
            tipo:       'lembrete',
            title,
            body:       corpo,
            url:        '/dashboard#calendario',
            fire_at:    fire.toISOString(),
            status:     'pending',
        });
    }
    if (linhas.length === 0) return { ok: false, reason: 'net' }; // não deveria ocorrer

    const { error } = await supabase.from('radar_notifications').insert(linhas);
    if (error) {
        const msg = String(error.message || '');
        if (/duplicate|unique/i.test(msg)) return { ok: false, reason: 'dup' };
        if (/limite de agendamentos/i.test(msg)) return { ok: false, reason: 'cap' };
        return { ok: false, reason: 'net' };
    }
    return { ok: true, dedupeKey: base };
}

/**
 * Lembretes pendentes do usuário, para o Calendário. Devolve UMA entrada por
 * lembrete (a linha do dia — ignora os avisos antecipados :d7/:d3).
 * @returns {Promise<Array<{id:string, base:string, texto:string, dataISO:string}>>}
 */
export async function listarLembretes() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) return [];

    const { data, error } = await supabase.from('radar_notifications')
        .select('id, dedupe_key, title, fire_at')
        .eq('tipo', 'lembrete')
        .eq('status', 'pending');
    if (error || !Array.isArray(data)) return [];

    const out = [];
    for (const row of data) {
        const key = String(row.dedupe_key || '');
        if (key.endsWith(':d7') || key.endsWith(':d3')) continue; // aviso antecipado
        const fire = new Date(row.fire_at);
        if (isNaN(fire.getTime())) continue;
        const dataISO = `${fire.getFullYear()}-${String(fire.getMonth() + 1).padStart(2, '0')}-${String(fire.getDate()).padStart(2, '0')}`;
        const texto = String(row.title || '').replace(/^Lembrete:\s*/, '') || 'Lembrete';
        out.push({ id: row.id, base: key, texto, dataISO });
    }
    return out;
}

/** Exclui um lembrete inteiro (a linha do dia + os avisos :d7/:d3). */
export async function excluirLembrete(base) {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid || !base) return false;
    const { error } = await supabase.from('radar_notifications')
        .delete()
        .eq('user_id', uid)
        .eq('status', 'pending')
        .in('dedupe_key', _todasAsChaves(base));
    return !error;
}

/** Desfaz um lembrete recém-criado (engine passa a chave-base). Alias de exclusão. */
export async function desfazerLembrete(base) {
    return excluirLembrete(base);
}

/** O aparelho está apto a receber o push? (permissão concedida) */
export function pushLiberado() {
    try { return typeof Notification !== 'undefined' && Notification.permission === 'granted'; }
    catch { return false; }
}
