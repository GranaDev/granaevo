import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Usar Service Role Key para ter permissões de admin
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    const { userId } = await req.json()

    if (!userId) {
      throw new Error('userId é obrigatório')
    }

    console.log('✉️ Confirmando email para usuário:', userId)

    // Atualizar usuário para confirmar email
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { 
        email_confirm: true,
        // Também podemos atualizar o metadata se necessário
      }
    )

    if (error) {
      console.error('❌ Erro ao confirmar email:', error)
      throw error
    }

    console.log('✅ Email confirmado com sucesso:', data)

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Email confirmado com sucesso',
        user: data 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      },
    )

  } catch (error) {
    console.error('❌ Erro:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      },
    )
  }
})