# GranaEvo — Achados de Código (Análise Estática)
Data: 2026-06-04 | God Mode + God Eyes Ultra

---

## ✅ O QUE ESTÁ CORRETO (verificado e OK)

### Autenticação e Autorização
- Todas as Edge Functions verificam JWT via `supabaseAdmin.auth.getUser(token)` (ES256 real) ✅
- Nenhum endpoint usa `jwt.decode()` sem verificar assinatura ✅
- Nenhuma autenticação/autorização feita apenas no frontend ✅
- supabase.auth.admin nunca exposto em arquivo frontend ✅
- user_id sempre extraído do JWT verificado, nunca do body/query ✅
- Todas as EFs verificam PROXY_SECRET com timingSafeEqual antes de processar ✅

### Secrets e Variáveis de Ambiente
- service_role key não presente em nenhum arquivo JS enviado ao browser ✅
- SUPABASE_ANON_KEY é pública por design (protegida por RLS) ✅
- .gitignore bloqueia .env, .env.* corretamente ✅
- Nenhum secret hardcoded em arquivos commitados ✅
- STRIPE_SECRET_KEY configurada via supabase secrets (não Vercel) ✅

### Validação de Input
- Todos os endpoints validam input antes de usar ✅
- Nenhuma SQL string interpolation encontrada — queries parametrizadas ✅
- innerHTML usado apenas com dados de whitelist (planName de whitelist, daysText de número) ✅
- Uploads validados por magic bytes + MIME type server-side ✅
- Tamanho máximo de body enforçado em todos os endpoints ✅
- JSON depth e maxKeys limitados em user-data.js ✅

### Rate Limiting
- Login/signup: 3 criações/hora por IP ✅
- Reset de senha: 3/min para "send", 10/min para verify ✅
- Upload de foto: 20/hora por IP + 10/hora por usuário ✅
- Convites: 5/min por IP ✅
- Todos os endpoints usam Redis quando configurado, in-memory como fallback ✅
- Lockout progressivo no banco (15min → 1h → 24h) ✅

### Stripe Webhook
- Assinatura HMAC-SHA256 verificada com timingSafeEqual ✅
- Body lido como raw bytes antes de verificar (não JSON parsed) ✅
- Janela de tolerância: 300s ✅
- Idempotência via stripe_events (insert + 23505 duplicate check) ✅
- Rate limit in-memory para assinaturas inválidas (brute force protection) ✅
- IDs Stripe validados com regex `[a-zA-Z0-9_]{4,100}` ✅
- user_id validado como UUID antes de inserir no banco ✅

### Headers e Configuração
- CSP configurada por página em vercel.json ✅
- HSTS max-age=63072000 com includeSubDomains e preload ✅
- X-Frame-Options: DENY ✅
- X-Content-Type-Options: nosniff ✅
- Permissions-Policy restritivo ✅
- X-XSS-Protection: 0 (correto — desabilitado pois CSP é mais seguro) ✅
- Cache-Control: no-store em APIs autenticadas ✅
- sourcemap: false em produção ✅
- console.log removido em produção via terser ✅

### Uploads
- GIF explicitamente bloqueado (polyglot attack) ✅
- Magic bytes validados: JPEG (FFD8FF), PNG (89504E47 + resto), WebP (RIFF+WEBP) ✅
- EXIF stripped em JPEG (APP1 segments removidos) ✅
- PNG metadata stripped (tEXt, iTXt, zTXt, tIME) ✅
- WebP EXIF/XMP stripped ✅

### Lógica de Negócio
- Race condition de webhooks coberta por idempotência ✅
- Downgrade agendado aplica apenas na renovação do ciclo ✅
- Convidado nunca regride user_id do dono para NULL ✅
- Rollback de usuário em falha de vínculo de convite ✅
- Anti-replay de convites: código armazenado como SHA-256, flag used, 5 tentativas máx ✅
- Delay mínimo de 400ms em verify-guest-invite (anti-timing) ✅

---

## 🟡 MÉDIO

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 MÉDIO

ID:           MED-01
Categoria:    CSP — Third-party Script Loader
Arquivo:      vercel.json:86
Tipo:         CSP Weakness

CÓDIGO ATUAL:
```
"script-src 'self' https://www.googletagmanager.com https://connect.facebook.net https://static.cloudflareinsights.com"
```

PROBLEMA:
https://connect.facebook.net é um script loader de terceiros que:
1. Carrega scripts adicionais dinamicamente do domínio Facebook
2. Qualquer comprometimento do CDN do Facebook afeta o GranaEvo
3. Scripts do Facebook têm amplo acesso ao DOM após carregamento

IMPACTO:
- Confidencialidade: MÉDIO — exfiltração de dados visíveis no DOM
- Integridade: MÉDIO — injeção de código se CDN comprometido
- Disponibilidade: BAIXO

A presença de Google Tag Manager (also a dynamic loader) amplifica o risco.

CORREÇÃO:
Remover https://connect.facebook.net do script-src de /planos.
Se pixel do Facebook for necessário, usar server-side events (Conversions API).
Se for indispensável, isolar em iframe sandboxed.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 MÉDIO

ID:           MED-02
Categoria:    Supply Chain — Dependência não pinada
Arquivo:      supabase/functions/save-push-subscription/index.ts:1
Tipo:         Supply Chain Risk

CÓDIGO ATUAL:
```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
```

PROBLEMA:
Todas as outras Edge Functions usam `@2.49.2` (versão pinada).
Esta usa `@2` (mutable — carrega qualquer 2.x).
Se uma versão 2.x futura tiver vulnerabilidade de segurança, esta função
será atualizada automaticamente na próxima cold start, enquanto as demais não.

IMPACTO:
- Inconsistência: uma EF atualiza, as outras não
- Supply chain: versão com bug poderia ser importada automaticamente

CORREÇÃO:
```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 MÉDIO

ID:           MED-03
Categoria:    Timing Oracle — Implementação inconsistente
Arquivo:      supabase/functions/save-push-subscription/index.ts:88-103
Tipo:         Timing Vulnerability (Leve)

CÓDIGO ATUAL:
```typescript
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = b.padEnd(a.length, '\0')
    let diff = 0
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ dummy.charCodeAt(i)
    }
    return false  // ← early-return baseado em length
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
```

PROBLEMA:
Esta implementação vaza o comprimento do PROXY_SECRET via timing.
Quando `a.length !== b.length`, retorna `false` após percorrer `a.length` iterações.
Um atacante pode fazer timing measurements para determinar se o tamanho do segredo
é maior/menor que o input enviado.

A implementação correta usada em todas as outras EFs:
```typescript
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0
}
```

IMPACTO:
- Oracle de comprimento: leve (exige muitas medições com jitter de rede)
- Probabilidade de exploração: baixa em produção (latência mascarada)
- Risco real: MED por inconsistência arquitetural mais que impacto prático

CORREÇÃO:
Substituir a implementação pela padrão usada em todas as outras EFs.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

---

## 🔵 BAIXO

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔵 BAIXO

ID:           LOW-01
Categoria:    CORS Misconfiguration (cosmético)
Arquivo:      api/check-user-access.js:31
Tipo:         CORS

CÓDIGO ATUAL:
```javascript
if (req.method === 'OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? ALLOWED_ORIGINS[0])
```

PROBLEMA:
Para requestes OPTIONS de origens não autorizadas, o header retorna
`https://granaevo.com` em vez de recusar. O browser interpreta isso como
"granaevo.com pode fazer requests" mas o request real (POST) será rejeitado
com 403 pelo check de origem subsequente.

IMPACTO:
Cosmético — nenhum bypass possível pois o POST é protegido.
Pode confundir ferramentas de análise CORS.

CORREÇÃO:
```javascript
if (req.method === 'OPTIONS') {
  if (!allowedOrigin) return res.status(403).end()
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  ...
}
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔵 BAIXO

ID:           LOW-02
Categoria:    Secrets — Token expirado em .env.local
Arquivo:      .env.local:5
Tipo:         Secret Management

SITUAÇÃO:
VERCEL_OIDC_TOKEN contém um JWT com exp=1774177855 (expirado em 2026-04-20).
O arquivo está no .gitignore e não foi commitado.

IMPACTO:
- Token já expirado → sem risco de uso
- .env.local não commitado → sem exposição em repositório
- Mas: arquivos .env.local com tokens expirados podem ser confundidos com tokens válidos

AÇÃO RECOMENDADA:
Remover a linha VERCEL_OIDC_TOKEN do .env.local ou anotar claramente que está expirado.
O token é gerado automaticamente pela Vercel CLI e não precisa ser mantido manualmente.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔵 BAIXO

ID:           LOW-03
Categoria:    DB — SECURITY DEFINER sem GRANT
Arquivo:      supabase/migrations/20260601000000_push_subscriptions.sql:53-67
Tipo:         Função não chamável

CÓDIGO ATUAL:
```sql
CREATE OR REPLACE FUNCTION cleanup_push_subscriptions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM push_subscriptions WHERE ...;
END;
$$;
-- Sem GRANT EXECUTE para nenhum role
```

PROBLEMA:
A função tem SECURITY DEFINER mas nenhum `GRANT EXECUTE` para qualquer role.
Sem GRANT, apenas o owner da função (postgres) pode chamá-la.
Os cron jobs das outras migrations usam SQL inline, não esta função.
Isso significa que subscriptions inativas não estão sendo limpas automaticamente.

IMPACTO:
- Acumulação de dados expirados na push_subscriptions
- Sem impacto de segurança direto

CORREÇÃO:
```sql
-- Opção 1: adicionar cron job via SQL inline (consistente com outras migrations)
SELECT cron.schedule(
  'granaevo-limpar-push-subscriptions',
  '0 4 * * *',
  $$
    DELETE FROM push_subscriptions
    WHERE is_active = false AND last_used_at < now() - INTERVAL '90 days';
    DELETE FROM push_subscriptions
    WHERE last_used_at < now() - INTERVAL '180 days';
  $$
);

-- OU Opção 2: adicionar GRANT para service_role
GRANT EXECUTE ON FUNCTION cleanup_push_subscriptions() TO service_role;
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔵 BAIXO [FECHADO — R12 — migration 20260604000001]

ID:           LOW-04
Categoria:    RLS — auth.jwt() vs auth.uid() para email
Arquivo:      supabase/migrations/20260505000000_stripe_rls_policies.sql:10
Tipo:         Info / Arquitetural

CÓDIGO ORIGINAL (obsoleto — policy recriada):
```sql
CREATE POLICY "stripe_sub_select_by_email"
  ON stripe_subscriptions FOR SELECT TO authenticated
  USING (lower(user_email) = lower(auth.jwt()->>'email'));
```

CORREÇÃO APLICADA (migration 20260604000001_stripe_subscriptions_hardening.sql):
- Policy recriada com auth.email() + verificação de email_confirmed_at
- FORCE ROW LEVEL SECURITY adicionado a stripe_subscriptions (HARD-01)

IMPACTO ORIGINAL: muito baixo — apenas observação arquitetural.
STATUS: ✅ FECHADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 MÉDIO [FECHADO — R12 — corrigido nesta sessão]

ID:           MED-R12-01
Categoria:    Supply Chain — dependência não pinada
Arquivo:      supabase/functions/delete-push-subscription/index.ts:1
Linha(s):     1
Tipo:         Supply Chain Risk

CÓDIGO VULNERÁVEL:
```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
```

PROBLEMA:
Versão `@2` é mutável — qualquer patch pode introduzir código malicioso.
Inconsistente com todas as outras 17 EFs que usam `@2.49.2`.

VETOR DE ATAQUE:
1. esm.sh ou supabase-js@2.x.x recebe patch comprometido
2. Próximo cold start da EF carrega a versão comprometida
3. service_role key vaza para servidor externo

IMPACTO:
- Confidencialidade: Alto se explorado
- Disponibilidade: Alto

CORREÇÃO APLICADA:
```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2'
```
STATUS: ✅ FECHADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟡 MÉDIO [FECHADO — R12 — corrigido nesta sessão]

ID:           MED-R12-02
Categoria:    Cryptography — timing oracle
Arquivo:      supabase/functions/delete-push-subscription/index.ts:45-55
Linha(s):     45-55
Tipo:         Timing Oracle no PROXY_SECRET

CÓDIGO VULNERÁVEL:
```typescript
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = b.padEnd(a.length, '\0')
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ dummy.charCodeAt(i)
    return false  // ← diff ignorado, early-return — loop proporcional a len(a)
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
```

PROBLEMA:
1. Quando `a.length !== b.length`, o loop roda `a.length` vezes (controlado pelo atacante)
2. `diff` é calculado mas ignorado — `return false` é sempre executado
3. Resultado: tempo de resposta proporcional ao comprimento enviado pelo atacante,
   permitindo enumerar o comprimento do PROXY_SECRET via timing de múltiplas requests

VETOR DE ATAQUE (timing oracle):
1. Atacante envia requests com tamanhos 1, 2, 3...N como PROXY_SECRET
2. Mede o tempo de resposta de cada request
3. Quando o tempo aumenta proporcionalmente → infere comprimento do segredo
4. Com o comprimento conhecido, ataque de brute force é reduzido em ordens de magnitude

IMPACTO:
- Confidencialidade: Médio (facilita brute force do PROXY_SECRET)
- Integridade: Alto (PROXY_SECRET compromete isolamento de todas as EFs)

CORREÇÃO APLICADA (idêntica às outras 17 EFs):
```typescript
// [GOD-TSE] Sem early-return em length — codifica divergência via XOR no diff
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aB  = enc.encode(a)
  const bB  = enc.encode(b)
  const len = Math.max(aB.length, bB.length)
  let diff  = aB.length ^ bB.length   // divergência de comprimento no diff
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
  return diff === 0  // único return — tempo constante
}
```
STATUS: ✅ FECHADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
