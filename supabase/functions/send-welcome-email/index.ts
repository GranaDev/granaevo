import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

// Headers CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req) => {
  // Tratar requisições OPTIONS (preflight CORS)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, name, password, plan } = await req.json()

    console.log('📧 Enviando email para:', email)

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'GranaEvo <onboarding@resend.dev>',
        to: email,
        subject: '🎉 Bem-vindo ao GranaEvo! Suas credenciais de acesso',
        html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: Arial, sans-serif;
      background-color: #0a0f1a;
      color: #ffffff;
      margin: 0;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background: linear-gradient(135deg, #1a2332 0%, #0f1621 100%);
      border-radius: 16px;
      padding: 40px;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 32px;
      font-weight: bold;
      color: #10b981;
    }
    h1 {
      color: #10b981;
      margin-top: 20px;
    }
    .credentials {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 12px;
      padding: 25px;
      margin: 25px 0;
    }
    .credential-item {
      margin: 15px 0;
    }
    .credential-label {
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      margin-bottom: 5px;
    }
    .credential-value {
      color: #10b981;
      font-size: 18px;
      font-weight: bold;
      word-break: break-all;
    }
    .button {
      display: inline-block;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      text-decoration: none;
      padding: 16px 32px;
      border-radius: 12px;
      font-weight: bold;
      margin: 20px 0;
    }
    .warning {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      padding: 15px;
      margin: 20px 0;
      color: #fca5a5;
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      color: rgba(255, 255, 255, 0.5);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">💰 GranaEvo</div>
      <h1>Bem-vindo ao GranaEvo, ${name}!</h1>
      <p style="color: rgba(255,255,255,0.7);">Seu pagamento foi aprovado e sua conta está ativa! 🎉</p>
    </div>

    <div class="credentials">
      <h3 style="color: #10b981; margin-top: 0;">🔐 Suas Credenciais de Acesso</h3>
      
      <div class="credential-item">
        <div class="credential-label">Email:</div>
        <div class="credential-value">${email}</div>
      </div>

      <div class="credential-item">
        <div class="credential-label">Senha Temporária:</div>
        <div class="credential-value">${password}</div>
      </div>

      <div class="credential-item">
        <div class="credential-label">Plano:</div>
        <div class="credential-value">${plan}</div>
      </div>
    </div>

    <div class="warning">
      ⚠️ <strong>Importante:</strong> Por segurança, recomendamos que você altere sua senha após o primeiro login.
    </div>

    <div style="text-align: center;">
      <a href="https://granaevo.vercel.app/login.html" class="button">
        Acessar minha conta agora →
      </a>
    </div>

    <div style="margin-top: 30px; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 8px;">
      <h4 style="color: #10b981; margin-top: 0;">✨ O que você pode fazer agora:</h4>
      <ul style="color: rgba(255,255,255,0.8); line-height: 1.8;">
        <li>Criar seus perfis financeiros</li>
        <li>Adicionar seus cartões de crédito</li>
        <li>Registrar suas transações</li>
        <li>Definir metas financeiras</li>
        <li>Visualizar relatórios em tempo real</li>
      </ul>
    </div>

    <div class="footer">
      <p>Precisa de ajuda? Responda este email ou visite nossa central de ajuda.</p>
      <p>© 2025 GranaEvo. Todos os direitos reservados.</p>
    </div>
  </div>
</body>
</html>
        `
      })
    })

    const emailData = await emailResponse.json()

    if (!emailResponse.ok) {
      throw new Error(emailData.message || 'Erro ao enviar email')
    }

    console.log('✅ Email enviado com sucesso')

    return new Response(
      JSON.stringify({ success: true, data: emailData }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Erro ao enviar email:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})