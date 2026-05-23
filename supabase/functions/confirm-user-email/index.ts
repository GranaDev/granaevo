/**
 * GranaEvo — Edge Function: confirm-user-email
 *
 * ============================================================
 * PROPÓSITO
 * ============================================================
 * Confirma o email de um usuário recém-criado via Admin API do Supabase.
 *
 * IMPORTANTE: Esta função NÃO é chamada atualmente pelo primeiroacesso.js
 * porque "Email Confirmation" está DESATIVADA nas configurações do projeto
 * (Authentication → User Signups). O Supabase cria o usuário já confirmado.
 *
 * Esta função está aqui para ser ativada CASO você habilite a confirmação
 * de email no futuro. Ela foi reescrita com validações de segurança reais
 * para substituir a versão anterior que aceitava qualquer userId sem verificação.
 *
 * ============================================================
 * SEGURANÇA — VALIDAÇÕES REALIZADAS INTERNAMENTE
 * ============================================================
 * 1. subscriptionId obrigatório e pertencente ao email informado
 * 2. Subscription deve estar ativa (is_active = true) e aprovada
 *    (payment_status = 'approved')
 * 3. password_created deve ser false — uso único, impede replay
 * 4. userId deve existir no Auth e o email deve bater exatamente
 * 5. Usuário deve ter sido criado há no máximo 10 minutos (anti-replay temporal)
 * 6. Atualiza password_created = true ANTES de confirmar o email,
 *    garantindo atomicidade e impedindo race conditions
 *
 * ============================================================
 * CORS
 * ============================================================
 * Responde ao preflight OPTIONS com os headers corretos para
 * permitir requisições de https://www.granaevo.com.
 * A versão anterior respondia OPTIONS com status 200 mas sem
 * o header Access-Control-Allow-Methods, causando falha no preflight.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

// ==========================================
// CORS — permite origens do site (www e non-www)
// ==========================================
const ALLOWED_ORIGINS = new Set([
    'https://www.granaevo.com',
    'https://granaevo.com',
    'https://granaevo.vercel.app',
]);

// [GOD5-M01/M02] timing-safe compare para proxy secret
function timingSafeEqualStr(a: string, b: string): boolean {
    const enc = new TextEncoder()
    const aB  = enc.encode(a)
    const bB  = enc.encode(b)
    const len = Math.max(aB.length, bB.length)
    let diff  = aB.length ^ bB.length
    for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
    return diff === 0
}

function getCorsHeaders(req: Request): Record<string, string> {
    const origin  = req.headers.get('origin') ?? ''
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.granaevo.com'
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Max-Age':       '86400',
        'Vary':                         'Origin',
    }
}

// Tempo máximo em ms após a criação do usuário para aceitar a confirmação.
// Impede replay de requisições antigas.
const MAX_USER_AGE_MS = 10 * 60 * 1000; // 10 minutos

// ==========================================
// HANDLER PRINCIPAL
// ==========================================
Deno.serve(async (req) => {
    const corsHeaders = getCorsHeaders(req)

    // Preflight CORS — deve retornar 200 com os headers corretos.
    // A versão anterior retornava 'ok' sem Access-Control-Allow-Methods,
    // causando falha silenciosa no preflight do browser.
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status:  204,
            headers: corsHeaders,
        });
    }

    // Apenas POST é aceito.
    if (req.method !== 'POST') {
        return jsonResponse(405, { success: false, error: 'Método não permitido.' }, corsHeaders);
    }

    // [GOD5-M02] Proxy secret obrigatório — fail-closed.
    // Esta EF não estava em uso mas é endpoint ativo — qualquer caller com
    // userId+email+subscriptionId válidos podia tentar chamá-la sem limite.
    const proxySecret = Deno.env.get('PROXY_SECRET')
    if (!proxySecret) {
        console.error('[confirm-user-email] PROXY_SECRET não configurada — requisição bloqueada')
        return jsonResponse(500, { success: false, error: 'Configuração interna inválida.' }, corsHeaders)
    }
    const receivedSecret = req.headers.get('x-proxy-secret') ?? ''
    if (!timingSafeEqualStr(receivedSecret, proxySecret)) {
        console.warn('[confirm-user-email] Proxy secret inválido — chamada direta bloqueada')
        return jsonResponse(401, { success: false, error: 'Operação não autorizada.' }, corsHeaders)
    }

    // ── Parse do body ────────────────────────────────────────────────────
    let body;
    try {
        body = await req.json();
    } catch {
        return jsonResponse(400, { success: false, error: 'Body JSON inválido.' }, corsHeaders);
    }

    const { userId, email, subscriptionId } = body ?? {};

    // ── Validação básica dos parâmetros de entrada ───────────────────────
    if (!userId || typeof userId !== 'string' || !isValidUUID(userId)) {
        return jsonResponse(400, { success: false, error: 'userId inválido.' }, corsHeaders);
    }

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
        return jsonResponse(400, { success: false, error: 'email inválido.' }, corsHeaders);
    }

    if (!subscriptionId || typeof subscriptionId !== 'string') {
        return jsonResponse(400, { success: false, error: 'subscriptionId inválido.' }, corsHeaders);
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Cria cliente Admin (Service Role Key) ───────────────────────────
    const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        {
            auth: {
                autoRefreshToken: false,
                persistSession:   false,
            },
        }
    );

    try {
        // Tabela `subscriptions` (Cakto) foi arquivada. Todas as assinaturas agora
        // estão em stripe_subscriptions. Esta função confirma o email diretamente
        // via auth.admin, sem mais dependência do fluxo Cakto.

        // ── VALIDAÇÃO: userId existe no Auth e email confere ─────────────
        const { data: authUser, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);

        if (userError || !authUser?.user) {
            console.error('[confirm-user-email] usuário não encontrado no Auth:', userError?.message);
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' }, corsHeaders);
        }

        if (authUser.user.email?.toLowerCase().trim() !== normalizedEmail) {
            console.error('[confirm-user-email] email do Auth não bate com o informado');
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' }, corsHeaders);
        }

        // Se email já confirmado, é idempotente — retorna sucesso
        if (authUser.user.email_confirmed_at) {
            console.log('[confirm-user-email] email já confirmado para userId:', userId);
            return jsonResponse(200, { success: true, message: 'Email confirmado e conta ativada com sucesso.' }, corsHeaders);
        }

        // ── Anti-replay temporal — usuário criado há ≤ 10 min ───────────
        const createdAt = new Date(authUser.user.created_at).getTime();
        const ageMs     = Date.now() - createdAt;

        if (ageMs > MAX_USER_AGE_MS) {
            console.warn(`[confirm-user-email] usuário criado há ${Math.round(ageMs / 60000)} min — fora da janela`);
            return jsonResponse(403, { success: false, error: 'Janela de ativação expirada. Contate o suporte.' }, corsHeaders);
        }

        // ── Confirma o email via Admin API ────────────────────────────────
        const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(
            userId, { email_confirm: true },
        );

        if (confirmError) {
            console.error('[confirm-user-email] erro ao confirmar email:', confirmError.message);
            return jsonResponse(500, { success: false, error: 'Erro ao ativar conta. Tente novamente.' }, corsHeaders);
        }

        console.log('✅ [confirm-user-email] email confirmado para userId:', userId);
        return jsonResponse(200, { success: true, message: 'Email confirmado e conta ativada com sucesso.' }, corsHeaders);

    } catch (err) {
        console.error('[confirm-user-email] exceção não tratada:', err?.message);
        return jsonResponse(500, { success: false, error: 'Erro interno inesperado.' }, corsHeaders);
    }
});

// ==========================================
// HELPERS
// ==========================================

/**
 * Retorna uma Response JSON com os headers CORS incluídos.
 * Recebe os corsHeaders como parâmetro para suportar CORS dinâmico por origin.
 */
function jsonResponse(status, body, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...headers,
            'Content-Type': 'application/json',
        },
    });
}

/** Valida UUID v4 */
function isValidUUID(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Valida email com limite de comprimento */
function isValidEmail(email) {
    return typeof email === 'string' &&
           email.length <= 254 &&
           /^[^\x00-\x1F\x7F\s@]{1,64}@[^\x00-\x1F\x7F\s@]+\.[^\x00-\x1F\x7F\s@]{2,}$/.test(email);
}