// ═══════════════════════════════════════════════════════════════
//  CORS
//  [SEC-FIX-CORS] Restrito ao domínio real (era '*').
// ═══════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://granaevo.vercel.app',
  'https://granaevo.com',
  'https://www.granaevo.com',
]

function getCorsHeaders(req: Request): Record<string, string> {
  const origin  = req.headers.get('origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

// Comprimento mínimo de um token reCAPTCHA v2 legítimo
const CAPTCHA_TOKEN_MIN_LENGTH = 50

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req)

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── Parse seguro do body ──────────────────────────────────
    // [SEC-FIX-PARSE] Adicionado try/catch separado.
    // Body malformado causava crash não tratado na versão anterior.
    let body: { token?: unknown }
    try {
      body = await req.json()
    } catch {
      return Response.json(
        { success: false },
        { headers: corsHeaders, status: 400 }
      )
    }

    const { token } = body

    // ── Validação mínima do token ─────────────────────────────
    // [SEC-FIX-VALIDATE] Adicionado.
    // Evita chamada desnecessária à API do Google com tokens
    // obviamente inválidos (null, string vazia, muito curtos).
    if (
      typeof token !== 'string' ||
      token.trim().length < CAPTCHA_TOKEN_MIN_LENGTH
    ) {
      return Response.json(
        { success: false },
        { headers: corsHeaders, status: 400 }
      )
    }

    const secretKey = Deno.env.get('RECAPTCHA_SECRET_KEY')
    if (!secretKey) {
      console.error('[verify-recaptcha] RECAPTCHA_SECRET_KEY não configurada')
      return Response.json(
        { success: false },
        { headers: corsHeaders, status: 500 }
      )
    }

    // ── Validação junto à API do Google ──────────────────────
    const verifyResponse = await fetch(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret:   secretKey,
          response: token.trim(),
        }),
      }
    )

    const verifyData = await verifyResponse.json()

    // Log interno completo — útil para debug
    console.log('[verify-recaptcha] Resposta Google:', JSON.stringify({
      success:     verifyData.success,
      hostname:    verifyData.hostname,
      // error-codes logados internamente mas NÃO retornados ao caller
      error_codes: verifyData['error-codes'] ?? [],
    }))

    if (verifyData.success) {
      return Response.json(
        { success: true },
        { headers: corsHeaders }
      )
    }

    // [SEC-FIX-LEAK] error-codes NÃO retornados ao caller.
    // A versão anterior retornava verifyData['error-codes'] no response,
    // revelando ao chamador os motivos exatos da rejeição (ex: 'timeout-or-duplicate',
    // 'invalid-input-response'). Isso ajuda atacantes a calibrar tokens falsos.
    // O frontend só precisa saber success: true/false.
    return Response.json(
      { success: false },
      { headers: corsHeaders }
    )

  } catch (error) {
    console.error('[verify-recaptcha] Erro inesperado:', error)
    return Response.json(
      { success: false },
      { headers: corsHeaders, status: 500 }
    )
  }
})