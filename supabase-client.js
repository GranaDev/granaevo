// supabase-client.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'COLE_SUA_URL_AQUI'; // Do passo 1.3
const SUPABASE_KEY = 'COLE_SUA_CHAVE_AQUI'; // Do passo 1.3

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);