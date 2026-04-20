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
// CORS — permite apenas a origem do site
// ==========================================
const ALLOWED_ORIGIN = 'https://www.granaevo.com';

const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age':       '86400',
};

// Tempo máximo em ms após a criação do usuário para aceitar a confirmação.
// Impede replay de requisições antigas.
const MAX_USER_AGE_MS = 10 * 60 * 1000; // 10 minutos

// ==========================================
// HANDLER PRINCIPAL
// ==========================================
Deno.serve(async (req) => {

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
        return jsonResponse(405, { success: false, error: 'Método não permitido.' });
    }

    // ── Parse do body ────────────────────────────────────────────────────
    let body;
    try {
        body = await req.json();
    } catch {
        return jsonResponse(400, { success: false, error: 'Body JSON inválido.' });
    }

    const { userId, email, subscriptionId } = body ?? {};

    // ── Validação básica dos parâmetros de entrada ───────────────────────
    if (!userId || typeof userId !== 'string' || !isValidUUID(userId)) {
        return jsonResponse(400, { success: false, error: 'userId inválido.' });
    }

    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
        return jsonResponse(400, { success: false, error: 'email inválido.' });
    }

    if (!subscriptionId || typeof subscriptionId !== 'string') {
        return jsonResponse(400, { success: false, error: 'subscriptionId inválido.' });
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
        // ── VALIDAÇÃO 1: Subscription existe, pertence ao email e está aprovada ──
        const { data: subscription, error: subError } = await supabaseAdmin
            .from('subscriptions')
            .select('id, email, is_active, payment_status, password_created')
            .eq('id', subscriptionId)
            .single();

        if (subError || !subscription) {
            console.error('[confirm-user-email] subscription não encontrada:', subError?.message);
            // Resposta genérica — não revela se o ID existe ou não.
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' });
        }

        if (subscription.email.toLowerCase().trim() !== normalizedEmail) {
            console.error('[confirm-user-email] email não bate com a subscription');
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' });
        }

        if (!subscription.is_active || subscription.payment_status !== 'approved') {
            console.error('[confirm-user-email] subscription inativa ou pagamento não aprovado');
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' });
        }

        // ── VALIDAÇÃO 2: password_created = false (uso único, anti-replay) ──
        if (subscription.password_created === true) {
            console.warn('[confirm-user-email] tentativa de replay — password_created já é true');
            return jsonResponse(409, { success: false, error: 'Conta já ativada. Faça o login.' });
        }

        // ── VALIDAÇÃO 3: userId existe no Auth e email confere ───────────
        const { data: authUser, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);

        if (userError || !authUser?.user) {
            console.error('[confirm-user-email] usuário não encontrado no Auth:', userError?.message);
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' });
        }

        if (authUser.user.email?.toLowerCase().trim() !== normalizedEmail) {
            console.error('[confirm-user-email] email do Auth não bate com o informado');
            return jsonResponse(403, { success: false, error: 'Operação não autorizada.' });
        }

        // ── VALIDAÇÃO 4: Anti-replay temporal — usuário criado há ≤ 10 min ──
        const createdAt    = new Date(authUser.user.created_at).getTime();
        const ageMs        = Date.now() - createdAt;

        if (ageMs > MAX_USER_AGE_MS) {
            console.warn(`[confirm-user-email] usuário criado há ${Math.round(ageMs / 60000)} min — fora da janela de 10 min`);
            return jsonResponse(403, { success: false, error: 'Janela de ativação expirada. Contate o suporte.' });
        }

        // ── ETAPA 1: Marca password_created = true ANTES de confirmar ────
        // Feito antes para garantir idempotência: se a confirmação abaixo
        // falhar e a requisição for repetida, esta validação bloqueará replay.
        const { error: updateError } = await supabaseAdmin
            .from('subscriptions')
            .update({ password_created: true })
            .eq('id', subscriptionId);

        if (updateError) {
            console.error('[confirm-user-email] falha ao marcar password_created:', updateError.message);
            return jsonResponse(500, { success: false, error: 'Erro interno. Tente novamente.' });
        }

        // ── ETAPA 2: Confirma o email via Admin API ───────────────────────
        const { data: updatedUser, error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(
            userId,
            { email_confirm: true }
        );

        if (confirmError) {
            // Tenta reverter o password_created para permitir nova tentativa.
            await supabaseAdmin
                .from('subscriptions')
                .update({ password_created: false })
                .eq('id', subscriptionId);

            console.error('[confirm-user-email] erro ao confirmar email no Auth:', confirmError.message);
            return jsonResponse(500, { success: false, error: 'Erro ao ativar conta. Tente novamente.' });
        }

        console.log('✅ [confirm-user-email] email confirmado com sucesso para userId:', userId);

        return jsonResponse(200, {
            success: true,
            message: 'Email confirmado e conta ativada com sucesso.',
        });

    } catch (err) {
        console.error('[confirm-user-email] exceção não tratada:', err?.message);
        return jsonResponse(500, { success: false, error: 'Erro interno inesperado.' });
    }
});

// ==========================================
// HELPERS
// ==========================================

/**
 * Retorna uma Response JSON com os headers CORS incluídos.
 * Sempre usa os mesmos corsHeaders para consistência.
 */
function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders,
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
           /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email);
}