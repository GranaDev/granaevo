import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { userId, userEmail, profiles } = await req.json()

    if (!userId || !profiles) {
      throw new Error('userId e profiles são obrigatórios.')
    }

    const dataToSave = {
      version: '1.0',
      user: { userId, email: userEmail },
      profiles,
      metadata: {
        lastSync: new Date().toISOString(),
        totalProfiles: profiles.length
      }
    }

    // Verificar se já existe
    const { data: existing } = await supabaseAdmin
      .from('user_data')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    let error

    if (existing) {
      const { error: updateError } = await supabaseAdmin
        .from('user_data')
        .update({
          data_json: dataToSave,
          email: userEmail,
          last_modified: new Date().toISOString()
        })
        .eq('user_id', userId)
      error = updateError
    } else {
      const { error: insertError } = await supabaseAdmin
        .from('user_data')
        .insert({
          user_id: userId,
          email: userEmail,
          data_json: dataToSave
        })
      error = insertError
    }

    if (error) throw error

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error: any) {
    console.error('❌ save-user-data:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})