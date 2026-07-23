/**
 * GranaEvo — verify-guest-invite
 *
 * Fluxo:
 *   step=verify → valida email + código (hash SHA-256) → retorna guestName/ownerName
 *   step=create → valida código novamente + cria conta Auth + vincula account_members
 *
 * Segurança:
 *   - Proxy secret (previne chamada direta bypassando Vercel)
 *   - Rate limit por IP e email (check_rate_limit RPC)
 *   - Código armazenado como SHA-256 — nunca em texto puro
 *   - Convite expira em 12h e é marcado used=true após uso (anti-replay)
 *   - Limite de 5 tentativas erradas por convite (anti-brute-force)
 *   - Resposta com delay mínimo 400ms (anti-timing)
 */

import { createClient }         from 'https://esm.sh/@supabase/supabase-js@2.49.2'
import { CURRENT_TERMS_VERSION } from '../_shared/terms.ts'

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS)
// com fallback na service_role legada — rollback = redeploy do commit anterior
// enquanto a legada existir. Migração de API keys 2026-07-23.
function getSecretKey(): string {
    try {
        const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')?.default
        if (typeof k === 'string' && k.startsWith('sb_secret_')) return k
    } catch { /* env ausente/inválida → usa a legada */ }
    console.warn('[keys] SUPABASE_SECRET_KEYS indisponível — usando service_role legada (fallback)')
    return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

const ALLOWED_ORIGINS = new Set([
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://granaevo.vercel.app',
])
const MIN_RESP_MS             = 400
const PASSWORD_MIN            = 10
const PASSWORD_MAX            = 128
const MAX_ATTEMPTS_PER_INVITE = 5
const MAX_RATE_LIMIT          = 10

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCorsHeaders(req: Request): Record<string, string> {
    const origin  = req.headers.get('origin') ?? ''
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : ''
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-secret',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin',
    }
}

function timingSafeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder()
    const aB  = enc.encode(a)
    const bB  = enc.encode(b)
    const len = Math.max(aB.length, bB.length)
    let diff  = aB.length ^ bB.length
    for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
    return diff === 0
}

function getClientIp(req: Request): string {
    return (
        req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
        req.headers.get('x-real-ip') ??
        'unknown'
    )
}

async function hashCode(code: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim().toLowerCase()))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function ok(cors: Record<string, string>, body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 200,
    })
}

function err(cors: Record<string, string>, message: string, status = 400) {
    return new Response(JSON.stringify({ success: false, error: message }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status,
    })
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
    const cors = getCorsHeaders(req)

    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

    const startTime = Date.now()
    async function respond(res: Response): Promise<Response> {
        const elapsed = Date.now() - startTime
        if (elapsed < MIN_RESP_MS) await new Promise(r => setTimeout(r, MIN_RESP_MS - elapsed))
        return res
    }

    // 1. Verifica proxy secret — bloqueia chamadas diretas à edge function
    const proxySecret = Deno.env.get('PROXY_SECRET')
    if (!proxySecret) {
        console.error('[verify-guest-invite] PROXY_SECRET ausente')
        return respond(err(cors, 'Configuração interna inválida.', 500))
    }
    if (!timingSafeEqual(req.headers.get('x-proxy-secret') ?? '', proxySecret)) {
        console.warn('[verify-guest-invite] Proxy secret inválido')
        return respond(err(cors, 'Requisição inválida.', 400))
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL')!,
            getSecretKey(),
        )
        const clientIp = getClientIp(req)

        // 2. Parse body
        let parsed: Record<string, unknown>
        try { parsed = await req.json() }
        catch { return respond(err(cors, 'Requisição inválida.')) }

        const {
            step, email, code, password, acceptedTerms, invitationId
        } = parsed as {
            step?: string; email?: string; code?: string | number
            password?: string; acceptedTerms?: boolean; invitationId?: string
        }

        // 3. Validação de entrada
        const emailNorm = (email ?? '').replace(/\x00/g, '').toLowerCase().trim()
        if (!emailNorm || !/^[^\x00-\x1F\x7F\s@]{1,64}@[^\x00-\x1F\x7F\s@]+\.[^\x00-\x1F\x7F\s@]{2,}$/.test(emailNorm)) {
            return respond(err(cors, 'Email inválido.'))
        }
        const codeTrimmed = String(code ?? '').trim()
        if (!/^\d{6}$/.test(codeTrimmed)) {
            return respond(err(cors, 'Código inválido.'))
        }

        // 4. Rate limit por IP (fail-open em erro de DB)
        const { data: ipOk } = await supabaseAdmin.rpc('check_rate_limit', {
            p_key: `invite:ip:${clientIp}`,
            p_max: MAX_RATE_LIMIT,
            p_window_seconds: 15 * 60,
        })
        if (ipOk === false) return respond(err(cors, 'Muitas tentativas. Aguarde 15 minutos.', 429))

        // 5. Rate limit por email
        const { data: emailOk } = await supabaseAdmin.rpc('check_rate_limit', {
            p_key: `invite:email:${emailNorm}`,
            p_max: MAX_RATE_LIMIT,
            p_window_seconds: 15 * 60,
        })
        if (emailOk === false) return respond(err(cors, 'Muitas tentativas para este email.', 429))

        // 6. Hash do código para comparação no banco
        const codeHash = await hashCode(codeTrimmed)

        // 7. Busca convite válido (não usado, não expirado)
        const invIdSafe = typeof invitationId === 'string'
            ? invitationId.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64)
            : null

        let query = supabaseAdmin
            .from('guest_invitations')
            .select('id, owner_user_id, owner_email, owner_name, guest_name, guest_email, code_hash, verification_attempts, used, expires_at')
            .eq('guest_email', emailNorm)
            .eq('used', false)
            .gt('expires_at', new Date().toISOString())
        if (invIdSafe) query = query.eq('id', invIdSafe)

        const { data: invitation, error: invError } = await query
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (invError || !invitation) {
            console.warn('[verify-guest-invite] Convite não encontrado para', emailNorm.slice(0, 10))
            return respond(err(cors, 'Código inválido ou expirado.'))
        }

        // 8. Limite de tentativas erradas por convite
        if ((invitation.verification_attempts ?? 0) >= MAX_ATTEMPTS_PER_INVITE) {
            return respond(err(cors, 'Muitas tentativas incorretas. Este convite foi bloqueado por segurança.'))
        }

        // 9. Verifica código (hash SHA-256)
        if (invitation.code_hash !== codeHash) {
            await supabaseAdmin
                .from('guest_invitations')
                .update({ verification_attempts: (invitation.verification_attempts ?? 0) + 1 })
                .eq('id', invitation.id)
            console.warn('[verify-guest-invite] Código incorreto para convite', invitation.id.slice(0, 8))
            return respond(err(cors, 'Código inválido ou expirado.'))
        }

        // ── STEP: verify ──────────────────────────────────────────────────────
        if (step === 'verify') {
            return respond(ok(cors, {
                success:   true,
                guestName: invitation.guest_name,
                ownerName: invitation.owner_name ?? '',
            }))
        }

        // ── STEP: create ──────────────────────────────────────────────────────
        if (step === 'create') {

            if (!password || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
                return respond(err(cors, `A senha deve ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`))
            }
            if (!acceptedTerms) {
                return respond(err(cors, 'Aceite os Termos de Uso para continuar.'))
            }

            // Verifica se já é membro ativo (de qualquer conta)
            const { data: activeMember } = await supabaseAdmin
                .from('account_members')
                .select('id')
                .eq('member_email', emailNorm)
                .eq('is_active', true)
                .maybeSingle()

            if (activeMember) {
                return respond(err(cors, 'Este email já é convidado ativo em uma conta.'))
            }

            // Re-invite: membro desativado do mesmo dono → reativa sem criar nova conta
            const { data: inactiveMember } = await supabaseAdmin
                .from('account_members')
                .select('id, member_user_id')
                .eq('member_email', emailNorm)
                .eq('owner_user_id', invitation.owner_user_id)
                .eq('is_active', false)
                .maybeSingle()

            if (inactiveMember) {
                const { error: reactivateErr } = await supabaseAdmin
                    .from('account_members')
                    .update({ is_active: true, removed_at: null, joined_at: new Date().toISOString() })
                    .eq('id', inactiveMember.id)

                if (reactivateErr) {
                    console.error('[verify-guest-invite] Erro ao reativar membro:', reactivateErr)
                    return respond(err(cors, 'Erro ao restaurar acesso. Tente novamente.'))
                }

                await supabaseAdmin
                    .from('guest_invitations')
                    .update({ used: true, used_at: new Date().toISOString() })
                    .eq('id', invitation.id)

                return respond(ok(cors, {
                    success:     true,
                    reactivated: true,
                    message:     'Acesso restaurado! Faça login com sua senha atual.',
                }))
            }

            // [FIX-ORFAO] NÃO bloqueamos com base em "existe convite usado para este
            // email". Esse heurística assumia "convite usado ⟹ conta existe", o que é
            // falso quando a conta foi apagada depois (estado órfão): o convidado ficava
            // preso — reset de senha retorna neutro (sem conta) e o onboarding travava
            // aqui. A fonte de verdade é o createUser abaixo: se a conta realmente
            // existir, ele retorna email_exists e devolvemos a mensagem de "use
            // recuperação"; se não existir (órfão), recria a conta normalmente.
            // O anti-replay continua garantido: um convite usado nem é localizado como
            // válido (filtro .eq('used', false) na busca do convite).

            // Cria usuário no Supabase Auth
            const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
                email:         emailNorm,
                password,
                email_confirm: true,
                user_metadata: {
                    name:          invitation.guest_name,
                    is_guest:      true,
                    owner_user_id: invitation.owner_user_id,
                },
            })

            if (createError) {
                console.error('[verify-guest-invite] Erro ao criar usuário:', createError.message)
                if (createError.message?.includes('already') || createError.code === 'email_exists') {
                    return respond(err(cors, 'Este email já possui login cadastrado. Use a recuperação de senha se necessário.'))
                }
                return respond(err(cors, 'Erro ao criar conta. Tente novamente.'))
            }

            if (!newUser?.user) {
                return respond(err(cors, 'Erro inesperado. Tente novamente.'))
            }

            // Vincula convidado ao dono em account_members
            const { error: memberError } = await supabaseAdmin
                .from('account_members')
                .insert({
                    owner_user_id:  invitation.owner_user_id,
                    owner_email:    invitation.owner_email,
                    member_user_id: newUser.user.id,
                    member_email:   emailNorm,
                    member_name:    invitation.guest_name,
                    invitation_id:  invitation.id,
                    joined_at:      new Date().toISOString(),
                    is_active:      true,
                })

            if (memberError) {
                console.error('[verify-guest-invite] Erro ao vincular membro:', memberError.message)
                // Rollback: remove usuário criado para não deixar órfão no Auth
                await supabaseAdmin.auth.admin.deleteUser(newUser.user.id)
                return respond(err(cors, 'Erro ao vincular conta ao anfitrião. Tente novamente.'))
            }

            // Registra aceite de termos
            await supabaseAdmin
                .from('terms_acceptance')
                .insert({
                    user_id:       newUser.user.id,
                    email:         emailNorm,
                    accepted:      true,
                    ip_address:    clientIp,
                    user_agent:    null,
                    terms_version: CURRENT_TERMS_VERSION,
                })
                .then(({ error }) => {
                    if (error) console.warn('[verify-guest-invite] terms_acceptance error:', error.message)
                })

            // Marca convite como usado (anti-replay)
            await supabaseAdmin
                .from('guest_invitations')
                .update({ used: true, used_at: new Date().toISOString() })
                .eq('id', invitation.id)

            console.log('[verify-guest-invite] Conta criada:', newUser.user.id.slice(0, 8), '→ dono:', invitation.owner_user_id.slice(0, 8))

            return respond(ok(cors, {
                success: true,
                message: 'Conta criada com sucesso! Faça login para acessar.',
            }))
        }

        return respond(err(cors, 'Step inválido. Use "verify" ou "create".'))

    } catch (error: unknown) {
        console.error('[verify-guest-invite] Erro inesperado:', error)
        return respond(err(cors, 'Erro interno. Tente novamente.', 500))
    }
})
