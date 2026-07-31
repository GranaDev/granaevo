// mfa-api.js — cliente da verificação em duas etapas (Passo 31 · B-1)
// ---------------------------------------------------------------------------
// POR QUE ESTE ARQUIVO EXISTE SEPARADO DO supabase-client.js
//   Duas razões, e as duas importam:
//
//   1. ORÇAMENTO DE BUNDLE. `supabase-client.js` entra no caminho crítico do
//      dashboard, que vive a 39,8 KB de um teto de 40 KB. Qualquer coisa colocada
//      lá é baixada por todo mundo em toda sessão. Estas funções interessam a
//      duas telas apenas — o login e o painel de Segurança — então moram num
//      chunk que só desce quando alguém realmente vai usar 2FA.
//
//   2. NENHUMA delas usa `supabase.auth.mfa.*`, e isso é deliberado. O `verify`
//      do GoTrue devolve um par access+refresh NOVO (elevado a aal2). Se o
//      cliente falasse direto com o GoTrue, o REFRESH TOKEN cairia no
//      JavaScript — exatamente o que o modelo híbrido httpOnly existe para
//      impedir. Tudo passa pelo BFF /api/auth-session, que retém o refresh no
//      cookie HttpOnly e devolve só o access.
//
// Todas lançam Error com `.status` (HTTP) e, quando o servidor informa,
// `.attemptsLeft`.
// ---------------------------------------------------------------------------

import { callAuthEndpoint, applyGrant } from './supabase-client.js';

async function _post(action, extra = {}, comAuth = false) {
    const res  = await callAuthEndpoint(action, extra, comAuth);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw Object.assign(new Error(data?.error ?? 'mfa_falhou'), {
            status:       res.status,
            attemptsLeft: data?.attempts_left,
        });
    }
    return data;
}

// ── Login (2º passo) ─────────────────────────────────────────────────────────

/**
 * Troca o código de 6 dígitos do app autenticador pela sessão elevada.
 * Só funciona logo após um login que respondeu `mfa_required` — o servidor
 * localiza a sessão pendente pelo cookie `ge_mfa`, que vive 5 minutos.
 */
export async function verifyMfaLogin(code, remember) {
    return applyGrant(await _post('mfa-login-verify', { code, remember: !!remember }));
}

/**
 * Destrava com um código de recuperação, para quem perdeu o autenticador.
 *
 * ⚠️ Em caso de sucesso o 2FA é DESATIVADO: o servidor remove os fatores, porque
 * um código nosso não tem como produzir um JWT `aal2` (só o GoTrue emite, e só
 * mediante TOTP válido). Quem chama É OBRIGADO a avisar o usuário de que a conta
 * voltou a depender apenas da senha.
 */
export async function recoverMfaLogin(recoveryCode, remember) {
    const data = await _post('mfa-login-recovery', { recoveryCode, remember: !!remember });
    await applyGrant(data);
    // `data` vai junto de propósito: a resposta traz a sessão completa (o mesmo
    // sessionPayload do caminho do TOTP, com `user`), e quem chama precisa dela
    // para seguir o login. Devolver só `mfaDisabled` deixava o login sem `data`
    // e ele estourava ao ler `data.user` — ver o comentário em login.js.
    return { data, mfaDisabled: data?.mfa_disabled === true };
}

// ── Gerenciamento (usuário já logado) ────────────────────────────────────────

/** Estado do 2FA: `{ enabled: boolean, factors: [...] }`. */
export async function getMfaStatus() {
    return _post('mfa-status', {}, true);
}

/** Inicia a ativação. Devolve `{ factorId, qrCode, secret, uri }`. */
export async function enrollMfa() {
    return _post('mfa-enroll', {}, true);
}

/**
 * Confirma o fator com o primeiro código do app e liga o 2FA.
 * Devolve `{ recoveryCodes }` — a ÚNICA vez em que eles existem em claro nesta
 * aplicação. A sessão é elevada a aal2 no mesmo passo.
 */
export async function activateMfa(factorId, code) {
    const data = await _post('mfa-activate', { factorId, code }, true);
    if (data?.access_token) await applyGrant(data);
    return { recoveryCodes: Array.isArray(data?.recoveryCodes) ? data.recoveryCodes : [] };
}

/**
 * Desliga o 2FA. Exige a senha: um access token roubado não pode baixar a
 * guarda sozinho — se pudesse, o 2FA protegeria contra tudo menos contra o
 * cenário para o qual ele existe. Mesma regra do Passo 25 (excluir conta).
 */
export async function disableMfa(password) {
    return _post('mfa-disable', { password }, true);
}
