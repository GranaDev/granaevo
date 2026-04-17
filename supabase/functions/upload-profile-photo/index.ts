// supabase/functions/upload-profile-photo/index.ts
/**
 * GranaEvo — upload-profile-photo
 *
 * CORREÇÕES NESTA VERSÃO:
 * ✅ ES256: supabaseAdmin.auth.getUser(token) — funciona com ES256 e HS256
 * ✅ GUEST: busca owner_user_id via account_members — foto vai para pasta certa
 * ✅ SIGNED URL: gerada server-side com service_role — sem restrição de RLS
 *    Isso elimina o bug em que o convidado não conseguia gerar a URL no client.
 * ✅ SIGNED URL LONGA: 7 dias (604800s) — evita foto quebrada imediatamente
 * ✅ upsert: true — evita erro se o mesmo arquivo tentar ser re-enviado
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ─── Magic bytes de cada formato permitido ────────────────────────────────────
const MAGIC: Record<string, (buf: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,

  "image/png": (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
    b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,

  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,

  "image/gif": (b) =>
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x39 || b[4] === 0x37) && b[5] === 0x61,
};

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
};

// URL assinada válida por 7 dias — tempo suficiente para o usuário usar o app
// sem a foto quebrar. O ideal futuro é tornar o bucket público para fotos.
const SIGNED_URL_EXPIRES = 60 * 60 * 24 * 7; // 7 dias em segundos

// ─── CORS ─────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ─── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── 1. Extrai o token do header Authorization ─────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token || token.length < 20) {
    console.error("[upload-profile-photo] Authorization header ausente ou malformado");
    return json({ error: "Unauthorized: missing Bearer token" }, 401);
  }

  // ── 2. Lê variáveis de ambiente ───────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    console.error("[upload-profile-photo] Variáveis de ambiente ausentes");
    return json({ error: "Configuração interna incompleta" }, 500);
  }

  // ── 3. Admin client ────────────────────────────────────────────────────────
  //
  // CORREÇÃO ES256:
  // supabaseAdmin.auth.getUser(token) delega validação ao servidor Auth via JWKS.
  // Funciona com ES256 e HS256. A abordagem antiga (createClient + anonKey no
  // global header) falhava silenciosamente com tokens ES256 de novos usuários.
  //
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken:   false,
      persistSession:     false,
      detectSessionInUrl: false,
    },
  });

  // ── 4. Verifica o JWT via Admin client ────────────────────────────────────
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user || !user.id) {
    console.error(
      "[upload-profile-photo] Falha na autenticação:",
      authError?.message ?? "user null"
    );
    return json({ error: "Unauthorized: invalid or expired token" }, 401);
  }

  const callerUserId = user.id;

  // ── 5. Resolve effectiveUserId — suporta convidados ──────────────────────
  //
  // Se o usuário for um convidado (member_user_id em account_members),
  // os arquivos vão para a pasta do DONO (owner_user_id).
  // Isso garante:
  //   (a) as fotos ficam associadas à conta correta
  //   (b) o dono consegue ver todas as fotos da sua conta
  //   (c) a URL assinada (gerada aqui com service_role) funciona sem RLS
  //
  let effectiveUserId = callerUserId;

  try {
    const { data: memberRow } = await supabaseAdmin
      .from("account_members")
      .select("owner_user_id")
      .eq("member_user_id", callerUserId)
      .eq("is_active", true)
      .maybeSingle();

    if (memberRow?.owner_user_id) {
      effectiveUserId = memberRow.owner_user_id;
      console.log(
        `[upload-profile-photo] Usuário ${callerUserId.slice(0,8)}... é convidado. ` +
        `Usando pasta do dono: ${effectiveUserId.slice(0,8)}...`
      );
    }
  } catch (err) {
    // Não crítico — se falhar, usa a pasta do próprio usuário
    console.warn("[upload-profile-photo] Falha ao verificar account_members:", err);
  }

  // ── 6. Parse do FormData ──────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[upload-profile-photo] Falha no parse do FormData:", err);
    return json({ error: "Requisição inválida: FormData mal formatado" }, 400);
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return json({ error: "Nenhum arquivo enviado (campo 'file' ausente)" }, 400);
  }

  // ── 7. Validação de tamanho ───────────────────────────────────────────────
  if (file.size === 0) {
    return json({ error: "Arquivo vazio" }, 400);
  }
  if (file.size > MAX_SIZE) {
    return json({ error: "Arquivo muito grande. Máximo: 5MB." }, 413);
  }

  // ── 8. Validação de MIME declarado ────────────────────────────────────────
  const mime = file.type.toLowerCase();
  if (!MAGIC[mime]) {
    return json({
      error: "Tipo de arquivo não permitido. Use JPEG, PNG, WebP ou GIF.",
    }, 415);
  }

  // ── 9. Leitura dos bytes e validação de magic bytes ───────────────────────
  let buffer: Uint8Array;
  try {
    buffer = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    console.error("[upload-profile-photo] Falha ao ler bytes do arquivo:", err);
    return json({ error: "Erro ao processar arquivo" }, 500);
  }

  if (buffer.length < 12) {
    return json({ error: "Arquivo corrompido ou muito pequeno" }, 415);
  }

  if (!MAGIC[mime](buffer)) {
    return json({
      error: "Conteúdo do arquivo não corresponde ao tipo declarado (magic bytes inválidos)",
    }, 415);
  }

  // ── 10. Upload via service_role (bypassa RLS) ─────────────────────────────
  //
  // Arquivo salvo em {effectiveUserId}/{timestamp}.{ext}
  // Para usuários normais: pasta própria.
  // Para convidados: pasta do dono.
  //
  const ext      = EXT_MAP[mime];
  const filePath = `${effectiveUserId}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("profile-photos")
    .upload(filePath, buffer, {
      contentType:  mime,
      cacheControl: "max-age=3600",
      upsert:       true, // evita erro de conflito em re-tentativas
    });

  if (uploadError) {
    console.error("[upload-profile-photo] Erro no storage upload:", uploadError.message);
    return json({ error: "Erro interno ao salvar imagem. Tente novamente." }, 500);
  }

  // ── 11. Gera URL assinada server-side (sem restrição de RLS) ─────────────
  //
  // CORREÇÃO CONVIDADOS: createSignedUrl no cliente falha para convidados
  // porque a policy storage_select exige auth.uid() = foldername.
  // Convidado tem auth.uid() = guest_id mas o arquivo está em owner_id/.
  // Usando o service_role aqui, contornamos essa restrição com segurança.
  //
  const { data: signedData, error: signedError } = await supabaseAdmin.storage
    .from("profile-photos")
    .createSignedUrl(filePath, SIGNED_URL_EXPIRES);

  if (signedError || !signedData?.signedUrl) {
    console.error("[upload-profile-photo] Erro ao gerar URL assinada:", signedError?.message);
    // Retorna o path mesmo sem a URL — o cliente pode tentar gerar depois
    return json({ path: filePath, signedUrl: null }, 200);
  }

  console.log(
    `[upload-profile-photo] Upload OK: ${filePath} ` +
    `(caller: ${callerUserId.slice(0,8)}..., effective: ${effectiveUserId.slice(0,8)}...)`
  );

  return json({ path: filePath, signedUrl: signedData.signedUrl }, 200);
});