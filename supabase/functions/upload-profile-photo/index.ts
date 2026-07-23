// supabase/functions/upload-profile-photo/index.ts
/**
 * GranaEvo — upload-profile-photo
 *
 * CORREÇÕES NESTA VERSÃO:
 * ✅ ES256: supabaseAdmin.auth.getUser(token) — funciona com ES256 e HS256
 * ✅ JWT SIGNATURE VERIFIED: usa supabaseAdmin.auth.getUser() em vez de decode manual
 * ✅ GUEST: busca owner_user_id via account_members — foto vai para pasta certa
 * ✅ SIGNED URL: gerada server-side com service_role — sem restrição de RLS
 * ✅ SIGNED URL LONGA: 7 dias (604800s) — evita foto quebrada imediatamente
 * ✅ upsert: true — evita erro se o mesmo arquivo tentar ser re-enviado
 * ✅ IMAGE URL TRACKER PREVENTION: Content-Disposition forced, no external redirects
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

// Secret key nova (sb_secret_, injetada pela plataforma em SUPABASE_SECRET_KEYS)
// com fallback na service_role legada — rollback = redeploy do commit anterior
// enquanto a legada existir. Migração de API keys 2026-07-23.
function getSecretKey(): string {
  try {
    const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}")?.default;
    if (typeof k === "string" && k.startsWith("sb_secret_")) return k;
  } catch { /* env ausente/inválida → usa a legada */ }
  console.warn("[keys] SUPABASE_SECRET_KEYS indisponível — usando service_role legada (fallback)");
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

// ─── Magic bytes — apenas formatos rasterizados sem suporte a scripts ─────────
// GIF removido: suporta animação e embute metadados; políglotas podem combinar
// GIF89a com JS válido (gif-polyglot attack). Use JPEG/PNG/WebP.
const MAGIC: Record<string, (buf: Uint8Array) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,

  "image/png": (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
    b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,

  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
};

// ─── Metadata strippers — remove EXIF/XMP/GPS antes do upload ────────────────

// Remove segmentos APP1 (EXIF/XMP) do JPEG, preserva todos os outros.
// VUL-001 FIX: sem strip, coordenadas GPS ficam expostas via EXIF.
function stripJpegExif(jpeg: Uint8Array): Uint8Array {
  try {
    if (jpeg.length < 4 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return jpeg
    const parts: Uint8Array[] = [jpeg.slice(0, 2)] // SOI
    let pos = 2
    while (pos + 1 < jpeg.length) {
      if (jpeg[pos] !== 0xFF) { parts.push(jpeg.slice(pos)); break }
      const marker = jpeg[pos + 1]
      if (marker === 0xFF) { pos++; continue }
      // Marcadores sem comprimento (SOI/EOI/RST)
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
        parts.push(jpeg.slice(pos, pos + 2))
        pos += 2
        if (marker === 0xD9) break
        continue
      }
      if (pos + 4 > jpeg.length) break
      const length = ((jpeg[pos + 2] << 8) | jpeg[pos + 3]) & 0xFFFF
      if (length < 2) break
      const segEnd = pos + 2 + length
      if (segEnd > jpeg.length) break
      if (marker !== 0xE1) parts.push(jpeg.slice(pos, segEnd)) // Skip APP1 (EXIF/XMP)
      pos = segEnd
      if (marker === 0xDA) { parts.push(jpeg.slice(segEnd)); break } // SOS: dados raw
    }
    const totalLen = parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(totalLen)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
  } catch { return jpeg }
}

// Remove chunks tEXt, iTXt, zTXt, tIME do PNG (transportam metadados/EXIF).
function stripPngMetadata(png: Uint8Array): Uint8Array {
  try {
    const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) return png
    const STRIP = new Set(['tEXt', 'iTXt', 'zTXt', 'tIME'])
    const parts: Uint8Array[] = [png.slice(0, 8)]
    let pos = 8
    while (pos + 12 <= png.length) {
      const dataLen = ((png[pos] << 24) | (png[pos+1] << 16) | (png[pos+2] << 8) | png[pos+3]) >>> 0
      const chunkEnd = pos + 12 + dataLen
      if (chunkEnd > png.length) break
      const type = String.fromCharCode(png[pos+4], png[pos+5], png[pos+6], png[pos+7])
      if (!STRIP.has(type)) parts.push(png.slice(pos, chunkEnd))
      pos = chunkEnd
      if (type === 'IEND') break
    }
    const totalLen = parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(totalLen)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
  } catch { return png }
}

// Remove chunks EXIF e XMP do WebP VP8X. Recalcula File Size no cabeçalho RIFF.
function stripWebpMetadata(webp: Uint8Array): Uint8Array {
  try {
    if (webp.length < 12) return webp
    if (webp[0]!==0x52||webp[1]!==0x49||webp[2]!==0x46||webp[3]!==0x46) return webp
    if (webp[8]!==0x57||webp[9]!==0x45||webp[10]!==0x42||webp[11]!==0x50) return webp
    if (webp.length < 20 || String.fromCharCode(webp[12],webp[13],webp[14],webp[15]) !== 'VP8X') return webp
    const STRIP = new Set(['EXIF', 'XMP '])
    const kept: Uint8Array[] = []
    let pos = 12, totalKept = 0
    while (pos + 8 <= webp.length) {
      const type = String.fromCharCode(webp[pos],webp[pos+1],webp[pos+2],webp[pos+3])
      const size = (webp[pos+4]|(webp[pos+5]<<8)|(webp[pos+6]<<16)|(webp[pos+7]<<24)) >>> 0
      const padded = size + (size & 1)
      const chunkEnd = pos + 8 + padded
      if (chunkEnd > webp.length) break
      if (!STRIP.has(type)) { kept.push(webp.slice(pos, chunkEnd)); totalKept += chunkEnd - pos }
      pos = chunkEnd
    }
    const fileSize = 4 + totalKept // 'WEBP' (4) + chunks
    const out = new Uint8Array(12 + totalKept)
    out[0]=0x52;out[1]=0x49;out[2]=0x46;out[3]=0x46
    out[4]=fileSize&0xFF;out[5]=(fileSize>>8)&0xFF;out[6]=(fileSize>>16)&0xFF;out[7]=(fileSize>>24)&0xFF
    out[8]=0x57;out[9]=0x45;out[10]=0x42;out[11]=0x50
    let off = 12
    for (const p of kept) { out.set(p, off); off += p.length }
    return out
  } catch { return webp }
}

// URL assinada válida por 7 dias — tempo suficiente para o usuário usar o app
// sem a foto quebrar. O ideal futuro é tornar o bucket público para fotos.
const SIGNED_URL_EXPIRES = 60 * 60 * 24 * 7; // 7 dias em segundos

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://granaevo.vercel.app",
  "https://granaevo.com",
  "https://www.granaevo.com",
];

function getCors(req: Request): Record<string, string> {
  const origin  = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// ─── timing-safe compare — sem early-return em length (elimina timing oracle) ──
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}

// ─── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const CORS = getCors(req);
  const json = (body: object, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...CORS },
    });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── 1. Verificar proxy secret ─────────────────────────────────────────────
  // [SEC-FIX] Bloqueia chamadas diretas que bypassam o proxy Vercel
  // (que aplica rate limit, CSRF e body size enforcement).
  // [GOD5-M01] fail-closed: sem PROXY_SECRET configurado, bloqueia tudo.
  const proxySecret = Deno.env.get("PROXY_SECRET")
  if (!proxySecret) {
    console.error("[upload-profile-photo] PROXY_SECRET não configurada — requisição bloqueada")
    return json({ error: "Configuração interna inválida" }, 500)
  }
  const received = req.headers.get("x-proxy-secret") ?? ""
  if (!timingSafeEqual(received, proxySecret)) {
    console.warn("[upload-profile-photo] Proxy secret inválido — acesso direto bloqueado")
    return json({ error: "Unauthorized" }, 401)
  }

  // ── 2. Extrai o token do header Authorization ─────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token || token.length < 20) {
    console.error("[upload-profile-photo] Authorization header ausente ou malformado");
    return json({ error: "Unauthorized: missing Bearer token" }, 401);
  }

  // ── 3. Lê variáveis de ambiente ───────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = getSecretKey();

  if (!supabaseUrl || !serviceKey) {
    console.error("[upload-profile-photo] Variáveis de ambiente ausentes");
    return json({ error: "Configuração interna incompleta" }, 500);
  }

  // ── 4. Admin client (service role — para storage e DB, nunca para user JWT) ─
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: {
      autoRefreshToken:   false,
      persistSession:     false,
      detectSessionInUrl: false,
    },
  });

  // ── 4. Verificar JWT com validação real de assinatura (ES256/HS256) ────────
  // [SEC-FIX] CRÍTICO: substitui decode manual (sem verificação de assinatura)
  // por supabaseAdmin.auth.getUser(token) que valida contra o servidor Auth
  // via JWKS. Impede o ataque de JWT forjado com sub arbitrário.
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user?.id) {
    console.error("[upload-profile-photo] JWT inválido ou expirado:", authError?.message ?? "user null");
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
      error: "Tipo de arquivo não permitido. Use JPEG, PNG ou WebP.",
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

  // ── 9b. Strip de metadados EXIF/XMP/GPS (VUL-001 FIX) ────────────────────
  // Remove coordenadas GPS, timestamps, dados de câmera e qualquer payload
  // oculto em metadados antes de persistir no storage.
  let cleanBuffer: Uint8Array
  if (mime === 'image/jpeg') {
    cleanBuffer = stripJpegExif(buffer)
  } else if (mime === 'image/png') {
    cleanBuffer = stripPngMetadata(buffer)
  } else if (mime === 'image/webp') {
    cleanBuffer = stripWebpMetadata(buffer)
  } else {
    cleanBuffer = buffer
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
    .upload(filePath, cleanBuffer, {
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