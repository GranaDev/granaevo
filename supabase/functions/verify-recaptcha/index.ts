const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { token } = await req.json();

    if (!token) {
      return Response.json(
        { success: false, error: 'Token não fornecido' },
        { headers: corsHeaders, status: 400 }
      );
    }

    const secretKey = Deno.env.get('RECAPTCHA_SECRET_KEY');
    if (!secretKey) {
      console.error('❌ RECAPTCHA_SECRET_KEY não configurada');
      return Response.json(
        { success: false, error: 'Configuração interna inválida' },
        { headers: corsHeaders, status: 500 }
      );
    }

    // Valida o token com a API do Google
    const verifyResponse = await fetch(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: secretKey,
          response: token,
        }),
      }
    );

    const verifyData = await verifyResponse.json();

    console.log('reCAPTCHA response:', verifyData);

    if (verifyData.success) {
      return Response.json(
        { success: true },
        { headers: corsHeaders }
      );
    } else {
      return Response.json(
        { success: false, errors: verifyData['error-codes'] },
        { headers: corsHeaders }
      );
    }

  } catch (error) {
    console.error('❌ Erro na verificação do reCAPTCHA:', error);
    return Response.json(
      { success: false, error: 'Erro interno' },
      { headers: corsHeaders, status: 500 }
    );
  }
});