import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204,
      headers: corsHeaders 
    })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { userId, email, name } = await req.json()

    console.log('📧 Enviando email para:', email)

    // Buscar usuário para pegar a senha temporária
    const { data: user } = await supabase.auth.admin.getUserById(userId)

    if (!user) {
      throw new Error('Usuário não encontrado')
    }

    // Gerar nova senha temporária
    const tempPassword = Math.random().toString(36).slice(-10) + 'Aa1!'

    // Atualizar senha do usuário
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      password: tempPassword
    })

    if (updateError) throw updateError

    // Enviar email via Resend
    const resendKey = Deno.env.get('RESEND_API_KEY')

    const emailHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; padding: 40px; }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 32px; font-weight: bold; color: #10b981; }
        .content { color: #333; line-height: 1.6; }
        .credentials { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .credential-item { margin: 10px 0; }
        .credential-label { font-weight: bold; color: #666; }
        .credential-value { font-size: 18px; color: #10b981; font-weight: bold; }
        .button { display: inline-block; background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; margin-top: 20px; }
        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🚀 GranaEvo</div>
        </div>
        
        <div class="content">
            <h2>Bem-vindo(a) ao GranaEvo, ${name}!</h2>
            
            <p>🎉 Seu pagamento foi aprovado com sucesso!</p>
            
            <p>Estamos muito felizes em ter você conosco. Sua jornada de evolução financeira começa agora!</p>
            
            <div class="credentials">
                <h3>🔐 Suas Credenciais de Acesso</h3>
                
                <div class="credential-item">
                    <div class="credential-label">Email:</div>
                    <div class="credential-value">${email}</div>
                </div>
                
                <div class="credential-item">
                    <div class="credential-label">Senha Temporária:</div>
                    <div class="credential-value">${tempPassword}</div>
                </div>
            </div>
            
            <p><strong>⚠️ Importante:</strong> Por segurança, recomendamos que você altere sua senha no primeiro acesso através das configurações da sua conta.</p>
            
            <a href="https://seusite.com/login.html" class="button">Acessar Minha Conta</a>
            
            <p style="margin-top: 30px;">Se tiver qualquer dúvida, estamos aqui para ajudar!</p>
        </div>
        
        <div class="footer">
            <p>© 2025 GranaEvo - Sua Evolução Financeira</p>
        </div>
    </div>
</body>
</html>
    `

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'GranaEvo <onboarding@resend.dev>',
        to: [email],
        subject: '🎉 Bem-vindo ao GranaEvo - Suas Credenciais de Acesso',
        html: emailHTML
      })
    })

    const emailData = await emailResponse.json()

    console.log('📧 Resposta Resend:', emailData)

    if (!emailResponse.ok) {
      throw new Error(emailData.message || 'Erro ao enviar email')
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Email enviado' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})