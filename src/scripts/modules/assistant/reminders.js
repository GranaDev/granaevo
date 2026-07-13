// reminders.js — lembretes do usuário via chat → Radar (radar_notifications)
// ---------------------------------------------------------------------------
// "me lembra de pagar o aluguel dia 5" → INSERT (sob RLS: só o próprio usuário,
// status 'pending') na mesma tabela que o Radar usa. A entrega é o pipeline já
// existente (Vercel Cron → edge send-radar-push → Web Push). Nenhum código novo
// no servidor além do tipo 'lembrete' no CHECK.
//
// PRIVACIDADE: o texto do lembrete é escolhido pelo usuário e fica em claro na
// tabela (como todo payload do Radar). Por isso NÃO anexamos nada além do que
// ele digitou — sem valores derivados, sem contexto extra.
// ---------------------------------------------------------------------------

import { supabase } from '../../services/supabase-client.js?v=2';

const HORA_DISPARO = 8; // mesma hora dos eventos do Radar

function _slug(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lembrete';
}

function _clamp(s, max) {
    return String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/**
 * Cria um lembrete. `dataISO` = "YYYY-MM-DD" (futura, ≤ 60 dias — CHECK no DB).
 * @returns {Promise<{ok:true, dedupeKey:string} | {ok:false, reason:'auth'|'dup'|'cap'|'net'}>}
 */
export async function criarLembrete(texto, dataISO) {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return { ok: false, reason: 'auth' };

    const corpo = _clamp(texto, 180) || 'Você pediu pra eu te lembrar.';
    const dedupeKey = `lembrete:${_slug(texto)}:${dataISO}`;
    const fire = new Date(`${dataISO}T00:00:00`);
    fire.setHours(HORA_DISPARO, 0, 0, 0);

    const { error } = await supabase.from('radar_notifications').insert({
        user_id: uid,
        dedupe_key: dedupeKey.slice(0, 120),
        tipo: 'lembrete',
        title: _clamp(`Lembrete: ${texto}`, 80),
        body: corpo,
        url: '/dashboard',
        fire_at: fire.toISOString(),
        status: 'pending',
    });

    if (error) {
        const msg = String(error.message || '');
        if (/duplicate|unique/i.test(msg)) return { ok: false, reason: 'dup' };
        if (/limite de agendamentos/i.test(msg)) return { ok: false, reason: 'cap' };
        return { ok: false, reason: 'net' };
    }
    return { ok: true, dedupeKey: dedupeKey.slice(0, 120) };
}

/** Desfaz um lembrete recém-criado (RLS: só linhas 'pending' do próprio usuário). */
export async function desfazerLembrete(dedupeKey) {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return false;
    const { error } = await supabase.from('radar_notifications')
        .delete()
        .eq('user_id', uid)
        .eq('dedupe_key', dedupeKey)
        .eq('status', 'pending');
    return !error;
}

/** O aparelho está apto a receber o push? (permissão concedida) */
export function pushLiberado() {
    try { return typeof Notification !== 'undefined' && Notification.permission === 'granted'; }
    catch { return false; }
}
