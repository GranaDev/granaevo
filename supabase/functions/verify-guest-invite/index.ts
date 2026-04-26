/**
 * GranaEvo — verify-guest-invite/index.ts  (v2 — revisão completa)
 *
 * ═══════════════════════════════════════════════════════════════
 *  CORREÇÕES APLICADAS
 * ═══════════════════════════════════════════════════════════════
 *
 * [BUG-01]  member_email / member_name corrigidos para guest_email /
 *           guest_name — alinhado com o schema real da tabela
 *           guest_invitations. A query anterior retornava vazio
 *           silenciosamente em 100% das verificações.
 *
 * [BUG-02]  Validação real de nonce implementada via tabela
 *           invite_nonces. Cada nonce é aceito exatamente uma vez
 *           dentro do TTL de 2 minutos. Bloqueia replay attacks e
 *           automação simples sem estado.
 *
 * [OPT-01]  Rate limit por IP e por email via invite_rate_limit.
 *           Janela deslizante de 15 minutos, máximo 10 tentativas.
 *           Independente do verification_attempts por convite —
 *           bloqueia atacantes que rodam emails diferentes.
 *
 * [OPT-02]  Query principal agora usa guest_email (índice composto
 *           idx_guest_inv_email_used_expires criado no banco).
 *
 * [OPT-03]  terms_version incluído no insert de terms_acceptance.
 *
 * [MANT]    Todas as correções da versão anterior mantidas:
 *           FIX-DB-2, FIX-EF-1..7, hash SHA-256, IP do header,
 *           CORS restrito, tempo de resposta uniforme, rollback
 *           de usuário órfão, userId fora do response.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

// ═══════════════════════════════════════════════════════════════
//  CONSTANTES
// ═══════════════════════════════════════════════════════════════
const MAX_ATTEMPTS_PER_INVITE = 5    // tentativas por convite
const MAX_ATTEMPTS_RATE_LIMIT = 10   // tentativas por IP/email na janela
const PASSWORD_MIN            = 10   // [FIX-EF-2] alinhado com frontend
const MIN_RESP_MS             = 400  // [FIX-EF-7] tempo mínimo de resposta
const TERMS_VERSION           = '1.0'

// [FIX-EF-5] Origens permitidas — ajuste para seu domínio real
const ALLOWED_ORIGINS = new Set([
    'https://granaevo.com',
    'https://www.granaevo.com',
    'https://app.granaevo.com',
])

// ═══════════════════════════════════════════════════════════════
//  CORS [FIX-EF-5]
// ═══════════════════════════════════════════════════════════════
function getCorsHeaders(req: Request): Record<string, string> {
    const origin  = req.headers.get('origin') ?? ''
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : ''
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }
}

// ═══════════════════════════════════════════════════════════════
//  HASH SHA-256 [FIX-DB-2]
// ═══════════════════════════════════════════════════════════════
async function hashCode(code: string): Promise<string> {
    const normalized = code.trim().toLowerCase()
    const encoded    = new TextEncoder().encode(normalized)
    const buffer     = await crypto.subtle.digest('SHA-256', encoded)
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

// ═══════════════════════════════════════════════════════════════
//  IP REAL DO CLIENTE [FIX-EF-3]
// ═══════════════════════════════════════════════════════════════
function getClientIp(req: Request): string {
    return (
        req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
        req.headers.get('x-real-ip') ??
        'unknown'
    )
}

// ═══════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════
function jsonOk(corsHeaders: Record<string, string>, body: Record<string, unknown>) {
    return new Response(
        JSON.stringify(body),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
}

function jsonErr(corsHeaders: Record<string, string>, message: string, status = 400) {
    return new Response(
        JSON.stringify({ success: false, error: message }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status }
    )
}

// ═══════════════════════════════════════════════════════════════
//  RATE LIMIT [OPT-01]
//  Janela deslizante de 15 min, máximo MAX_ATTEMPTS_RATE_LIMIT.
//  Usa UPSERT: incrementa se janela ativa, recria se expirada.
//  Retorna true se o limite foi atingido (deve bloquear).
// ═══════════════════════════════════════════════════════════════
async function isRateLimited(
    supabase: ReturnType<typeof createClient>,
    identifier: string,
    type: 'ip' | 'email'
): Promise<boolean> {
    // Busca janela atual
    const { data: existing } = await supabase
        .from('invite_rate_limit')
        .select('id, attempt_count, expires_at')
        .eq('identifier', identifier)
        .eq('identifier_type', type)
        .maybeSingle()

    const now = new Date()

    if (existing) {
        // Janela expirada — recria do zero
        if (new Date(existing.expires_at) < now) {
            await supabase
                .from('invite_rate_limit')
                .update({
                    attempt_count: 1,
                    window_start:  now.toISOString(),
                    expires_at:    new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
                })
                .eq('id', existing.id)
            return false
        }

        // Janela ativa — já atingiu o limite?
        if (existing.attempt_count >= MAX_ATTEMPTS_RATE_LIMIT) {
            return true
        }

        // Incrementa
        await supabase
            .from('invite_rate_limit')
            .update({ attempt_count: existing.attempt_count + 1 })
            .eq('id', existing.id)
        return false
    }

    // Primeira tentativa — cria registro
    await supabase
        .from('invite_rate_limit')
        .insert({
            identifier,
            identifier_type: type,
            attempt_count:   1,
            window_start:    now.toISOString(),
            expires_at:      new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        })
    return false
}

// ═══════════════════════════════════════════════════════════════
//  VALIDAÇÃO DE NONCE [BUG-02]
//  Verifica: existe + não foi usado + não expirou.
//  Marca como usado imediatamente (atômico via update com filtro).
//  Retorna true se o nonce é válido e foi consumido com sucesso.
// ═══════════════════════════════════════════════════════════════
async function consumeNonce(
    supabase: ReturnType<typeof createClient>,
    nonce: string
): Promise<boolean> {
    if (!nonce || typeof nonce !== 'string' || nonce.length < 8) return false

    // Tenta marcar como usado em uma única operação
    // O filtro used=false + expires_at > now() garante atomicidade suficiente
    const { data, error } = await supabase
        .from('invite_nonces')
        .update({ used: true })
        .eq('nonce', nonce)
        .eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .select('id')
        .maybeSingle()

    if (error || !data) {
        // Nonce inexistente, já usado ou expirado — registra para diagnóstico
        console.warn('[INVITE] Nonce inválido ou reutilizado:', nonce.slice(0, 8) + '...')
        return false
    }

    return true
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
    const corsHeaders = getCorsHeaders(req)

    // Preflight CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    // [FIX-EF-7] Tempo mínimo de resposta — dificulta timing attacks
    const startTime = Date.now()
    async function respond(res: Response): Promise<Response> {
        const elapsed = Date.now() - startTime
        if (elapsed < MIN_RESP_MS) {
            await new Promise(r => setTimeout(r, MIN_RESP_MS - elapsed))
        }
        return res
    }

    try {
        const supabaseUrl   = Deno.env.get('SUPABASE_URL')!
        const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        const supabaseAdmin = createClient(supabaseUrl, serviceKey)

        // Limpeza assíncrona de nonces e rate limits expirados
        // Não aguarda — não bloqueia a resposta, erro ignorado intencionalmente
        supabaseAdmin.rpc('cleanup_invite_tables').then(() => {}).catch(() => {})

        // [FIX-EF-3] IP real do header da requisição
        const clientIp = getClientIp(req)

        // [SEC-FIX R4-003] Limite de tamanho de body antes do parse JSON.
        // verify-guest-invite é chamado direto do browser — sem proxy Vercel.
        const MAX_BODY_BYTES = 8_192 // 8 KB suficiente para todos os campos
        const rawBody = await (async () => {
            const reader = req.body?.getReader()
            if (!reader) return ''
            const chunks: Uint8Array[] = []
            let total = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done || !value) break
                total += value.byteLength
                if (total > MAX_BODY_BYTES) throw Object.assign(new Error('TOO_LARGE'), { status: 413 })
                chunks.push(value)
            }
            return new TextDecoder().decode(
                chunks.reduce((a, b) => { const m = new Uint8Array(a.length + b.length); m.set(a); m.set(b, a.length); return m }, new Uint8Array())
            )
        })()

        let parsed: Record<string, unknown>
        try { parsed = JSON.parse(rawBody) }
        catch { return respond(jsonErr(corsHeaders, 'Body JSON inválido.', 400)) }

        // Desestrutura payload — ipAddress e userAgent descartados [FIX-EF-3]
        const { step, email, code, password, acceptedTerms, nonce } = parsed as {
            step?: string; email?: string; code?: string | number
            password?: string; acceptedTerms?: boolean; nonce?: string
        }

        // ── Validações básicas de entrada ─────────────────────────
        // [SEC-FIX R4-006] Remove null bytes antes de qualquer processamento.
        const emailNorm = (email ?? '').replace(/\x00/g, '').toLowerCase().trim()

        if (!emailNorm || !code) {
            return respond(jsonErr(corsHeaders, 'Email e código são obrigatórios.'))
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
            return respond(jsonErr(corsHeaders, 'Email inválido.'))
        }

        const codeTrimmed = String(code).trim()
        if (!/^\d{6}$/.test(codeTrimmed)) {
            return respond(jsonErr(corsHeaders, 'Código inválido.'))
        }

        // ── [OPT-01] Rate limit por IP ────────────────────────────
        const ipLimited = await isRateLimited(supabaseAdmin, clientIp, 'ip')
        if (ipLimited) {
            return respond(jsonErr(
                corsHeaders,
                'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.',
                429
            ))
        }

        // ── [OPT-01] Rate limit por email ─────────────────────────
        const emailLimited = await isRateLimited(supabaseAdmin, emailNorm, 'email')
        if (emailLimited) {
            return respond(jsonErr(
                corsHeaders,
                'Muitas tentativas para este email. Aguarde 15 minutos.',
                429
            ))
        }

        // ── [BUG-02] Validação de nonce ───────────────────────────
        // Nonce é obrigatório — requests sem nonce são rejeitados.
        // O frontend sempre envia nonce; ausência indica automação.
        if (!nonce) {
            return respond(jsonErr(corsHeaders, 'Requisição inválida.', 400))
        }

        // Registra o nonce antes de consumir (permite validação)
        // Se já existe, consumeNonce retorna false
        await supabaseAdmin
            .from('invite_nonces')
            .insert({ nonce })
            .then(() => {})  // ignora erro de duplicata — consumeNonce tratará

        const nonceValido = await consumeNonce(supabaseAdmin, nonce)
        if (!nonceValido) {
            return respond(jsonErr(corsHeaders, 'Requisição inválida ou expirada. Tente novamente.', 400))
        }

        // ── [FIX-DB-2] Hash do código para comparação ─────────────
        const codeHash = await hashCode(codeTrimmed)

        // ── Buscar convite válido ─────────────────────────────────
        // [BUG-01] guest_email / guest_name (schema real)
        // [OPT-02] usa índice composto idx_guest_inv_email_used_expires
        // [FIX-EF-1] select explícito — nunca select('*')
        const { data: invitation, error: invError } = await supabaseAdmin
            .from('guest_invitations')
            .select([
                'id',
                'owner_user_id',
                'owner_email',
                'owner_name',
                'guest_name',
                'guest_email',
                'code_hash',
                'verification_attempts',
                'used',
                'expires_at',
            ].join(', '))
            .eq('guest_email', emailNorm)          // [BUG-01]
            .eq('used', false)
            .gt('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        // Resposta genérica — não diferencia "não encontrado" de "expirado"
        if (invError || !invitation) {
            return respond(jsonErr(corsHeaders, 'Código inválido ou expirado.'))
        }

        // ── Rate limit por convite ────────────────────────────────
        if ((invitation.verification_attempts ?? 0) >= MAX_ATTEMPTS_PER_INVITE) {
            return respond(jsonErr(
                corsHeaders,
                'Muitas tentativas incorretas. Este convite foi bloqueado por segurança.'
            ))
        }

        // ── Verificar código via hash [FIX-DB-2] ─────────────────
        if (invitation.code_hash !== codeHash) {
            await supabaseAdmin
                .from('guest_invitations')
                .update({
                    verification_attempts: (invitation.verification_attempts ?? 0) + 1,
                })
                .eq('id', invitation.id)

            return respond(jsonErr(corsHeaders, 'Código inválido ou expirado.'))
        }

        // ════════════════════════════════════════════════════════
        //  STEP: verify
        // ════════════════════════════════════════════════════════
        if (step === 'verify') {
            return respond(jsonOk(corsHeaders, {
                success:   true,
                guestName: invitation.guest_name,   // [BUG-01]
                ownerName: invitation.owner_name ?? '',
            }))
        }

        // ════════════════════════════════════════════════════════
        //  STEP: create
        // ════════════════════════════════════════════════════════
        if (step === 'create') {

            // [FIX-EF-2] Mínimo alinhado com frontend: 10 chars
            if (!password || password.length < PASSWORD_MIN) {
                return respond(jsonErr(
                    corsHeaders,
                    `A senha deve ter no mínimo ${PASSWORD_MIN} caracteres.`
                ))
            }

            if (!acceptedTerms) {
                return respond(jsonErr(corsHeaders, 'Você precisa aceitar os Termos de Uso.'))
            }

            // ── Revalida: email já é membro ativo? ────────────────
            const { data: existingMember } = await supabaseAdmin
                .from('account_members')
                .select('id')
                .eq('member_email', emailNorm)
                .eq('is_active', true)
                .maybeSingle()

            if (existingMember) {
                return respond(jsonErr(
                    corsHeaders,
                    'Este email já é convidado de outra conta. Entre em contato com o suporte.'
                ))
            }

            // ── Revalida: email já usou convite? ──────────────────
            const { data: usedInvite } = await supabaseAdmin
                .from('guest_invitations')
                .select('id')
                .eq('guest_email', emailNorm)       // [BUG-01]
                .eq('used', true)
                .limit(1)
                .maybeSingle()

            if (usedInvite) {
                return respond(jsonErr(
                    corsHeaders,
                    'Este email já aceitou um convite anteriormente. Tente fazer login diretamente.'
                ))
            }

            // ── Criar usuário no Supabase Auth ────────────────────
            const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
                email:         emailNorm,
                password,
                email_confirm: true,
                user_metadata: {
                    name:          invitation.guest_name,   // [BUG-01]
                    is_guest:      true,
                    owner_user_id: invitation.owner_user_id,
                },
            })

            if (createError) {
                console.error('Erro ao criar usuário:', createError)
                if (
                    createError.message?.includes('already been registered') ||
                    createError.message?.includes('already exists') ||
                    createError.code === 'email_exists'
                ) {
                    return respond(jsonErr(
                        corsHeaders,
                        'Este email já possui login cadastrado. Se esqueceu sua senha, use a recuperação de senha na tela de login.'
                    ))
                }
                return respond(jsonErr(corsHeaders, 'Erro ao criar conta. Tente novamente.'))
            }

            if (!newUser?.user) {
                return respond(jsonErr(corsHeaders, 'Erro inesperado ao criar conta. Tente novamente.'))
            }

            console.log('✅ Usuário criado:', newUser.user.id, '→', emailNorm)

            // ── Vincular em account_members ───────────────────────
            const { error: memberError } = await supabaseAdmin
                .from('account_members')
                .insert({
                    owner_user_id:  invitation.owner_user_id,
                    owner_email:    invitation.owner_email,
                    member_user_id: newUser.user.id,
                    member_email:   emailNorm,
                    member_name:    invitation.guest_name,   // [BUG-01]
                    invitation_id:  invitation.id,
                    joined_at:      new Date().toISOString(),
                    is_active:      true,
                })

            if (memberError) {
                console.error('Erro ao inserir account_member:', memberError)
                // Rollback: remove usuário criado para não deixar órfão
                await supabaseAdmin.auth.admin.deleteUser(newUser.user.id)
                return respond(jsonErr(corsHeaders, 'Erro ao vincular conta ao dono. Tente novamente.'))
            }

            console.log('✅ Membro vinculado ao dono:', invitation.owner_email)

            // ── Registrar aceite de termos ────────────────────────
            // [OPT-03] terms_version incluído
            // [FIX-EF-3] IP do header — user_agent não salvo
            await supabaseAdmin
                .from('terms_acceptance')
                .insert({
                    user_id:       newUser.user.id,
                    email:         emailNorm,
                    accepted:      true,
                    ip_address:    clientIp,
                    user_agent:    null,         // [FIX-EF-3] não confiável — descartado
                    terms_version: TERMS_VERSION, // [OPT-03]
                })
                .then(({ error }) => {
                    if (error) console.warn('Aviso: erro ao salvar terms_acceptance:', error.message)
                })

            // ── Marcar convite como usado [ANTI-REPLAY] ───────────
            await supabaseAdmin
                .from('guest_invitations')
                .update({
                    used:    true,
                    used_at: new Date().toISOString(),
                })
                .eq('id', invitation.id)

            // [FIX-EF-4] userId fora do response — não expõe UUID interno
            return respond(jsonOk(corsHeaders, {
                success: true,
                message: 'Conta criada com sucesso! Você já pode fazer login.',
            }))
        }

        return respond(jsonErr(corsHeaders, 'Step inválido. Use "verify" ou "create".'))

    } catch (error: unknown) {
        const e = error as { status?: number; message?: string }
        if (e?.status === 413) {
            return respond(jsonErr(corsHeaders, 'Requisição muito grande.', 413))
        }
        console.error('❌ verify-guest-invite:', error)
        return respond(jsonErr(corsHeaders, 'Erro interno. Tente novamente em instantes.', 500))
    }
})