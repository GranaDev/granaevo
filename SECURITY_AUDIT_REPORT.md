# GranaEvo — Security Audit Report
**Data:** 2026-05-30  
**Auditor:** Claude Sonnet 4.6 via /god-eyes-v2  
**Stack:** Supabase · Vercel · Cloudflare · Stripe · Vanilla JS  
**Metodologia:** ANÁLISE PROFUNDA → ATAQUES → CORREÇÕES → REANÁLISE → SEGURO ✅

---

## Sumário Executivo

Auditoria completa de segurança cobrindo 7 seções do produto GranaEvo. Foram identificadas **10 vulnerabilidades** (1 HIGH, 3 MEDIUM, 2 LOW, 4 INFO). Todas as vulnerabilidades exploráveis foram corrigidas durante esta auditoria. O sistema apresenta arquitetura de segurança sólida com múltiplas camadas de defesa.

**Status final:** SEGURO ✅ (vulnerabilidades exploráveis corrigidas)

---

## Resultados por Seção

### SEÇÃO 1: Landing Page / Index ✅ SEGURO

**Arquivo:** `src/index.html`, `/`

**Ataques simulados (7):**
1. Reflected XSS via query string → **Bloqueado:** sem `document.write`, sem `innerHTML` com dados externos; CSP `script-src 'self'` bloqueia scripts inline
2. Clickjacking → **Bloqueado:** `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`
3. CSS injection via `style-src` → **Bloqueado:** CSP `style-src 'self'` sem `unsafe-inline` na landing
4. Open redirect em link externo → **Bloqueado:** sem parâmetros de redirect na landing
5. Information disclosure via headers → **Bloqueado:** `X-Content-Type-Options: nosniff`, sem `Server:` header, sem stack trace
6. Mixed content → **Bloqueado:** `upgrade-insecure-requests` + `block-all-mixed-content`
7. Crawler de endpoint via source maps → **Bloqueado:** source maps não gerados em produção (Vite config)

**Vulnerabilidades:** Nenhuma  
**Resultado:** ✅ SEGURO

---

### SEÇÃO 2: Planos / Stripe Checkout ✅ SEGURO

**Arquivos:** `src/planos.html`, `api/stripe.js`, `supabase/functions/create-stripe-checkout/index.ts`, `supabase/functions/webhook-stripe/index.ts`

**Ataques simulados (12):**
1. Manipulação de preço no body → **Bloqueado:** preço determinado pelo servidor via `STRIPE_PRICE_*` env vars; `plan` do cliente apenas seleciona a chave
2. Plan injection (`plan: "../../etc/passwd"`) → **Bloqueado:** whitelist `VALID_PLANS = Set(['individual','casal','familia'])`
3. Webhook replay → **Bloqueado:** `stripe_events` tabela de idempotência; `23505` conflict = ignorado
4. Webhook sem assinatura → **Bloqueado:** `verifyStripeSignature()` com HMAC-SHA256 timing-safe; sem assinatura = 401
5. Webhook forjado com payload válido → **Bloqueado:** `timingSafeEqual()` sem early-return; chave `STRIPE_WEBHOOK_SECRET` nunca exposta
6. Timing oracle na validação de webhook → **Bloqueado:** XOR-based compare (`aB[i] ^ bB[i]`), sem early-return em length
7. Checkout sem autenticação (bypass de plano) → **Aceito by design:** checkout anônimo é feature; subscription fica com `user_id=null`, vinculada por email no `check-user-access`
8. SSRF via `success_url`/`cancel_url` → **Bloqueado:** URLs hardcoded no servidor, não aceitas do cliente
9. Rate limit bypass via checkout repetido → **Bloqueado:** `checkRate('checkout:ip', 5)` por IP
10. Action injection em portal (`action: "delete_account"`) → **Bloqueado:** `VALID_ACTIONS` whitelist no `api/stripe.js`
11. Body overflow (payload > 2048 bytes) → **Bloqueado:** `MAX_BODY_BYTES = 2048`; body drenado com limite
12. **VUL-003 (CORRIGIDO):** Email inválido em checkout anônimo → **CORRIGIDO:** regex `/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/` substituiu `raw.includes('@')`

**Vulnerabilidades corrigidas:**
- **VUL-003 [MEDIUM] → CORRIGIDO:** `create-stripe-checkout/index.ts`: validação de email anônimo era `raw.includes('@') && raw.length <= 254`. Substituída por regex adequada.

**Resultado:** ✅ SEGURO

---

### SEÇÃO 3: Login / Auth ✅ SEGURO

**Arquivos:** `src/scripts/pages/login.js`, `api/check-email.js`, `api/reset-password.js`, `src/scripts/modules/auth-guard.js`

**Ataques simulados (14):**
1. Brute force de senha → **Bloqueado:** lockout progressivo (DB: `login_lockouts`); reCAPTCHA após 3 falhas; rate limit 20/min por IP no proxy
2. User enumeration via mensagem de erro diferente → **Bloqueado:** mensagem genérica `'Tentativa inválida: email ou senha incorreto'` para todos os casos
3. User enumeration via timing → **Bloqueado:** `check-email` não revela existência diretamente; sempre chama as funções na mesma ordem
4. Password reset poisoning (Host header injection) → **Bloqueado:** Supabase gera URL de reset com `SITE_URL` configurado no dashboard, não com Host do request
5. Open redirect em `?next=` → **Bloqueado:** `NEXT_WHITELIST` hardcoded; `SafeRedirect.validate()` verifica same-origin; bloqueia `javascript:`, `data:`, `vbscript:`
6. JWT forjado para bypassar auth → **Bloqueado:** `supabaseAdmin.auth.getUser(token)` valida assinatura ES256/HS256 server-side em toda Edge Function
7. Session fixation → **Bloqueado:** novo JWT emitido pelo Supabase a cada login; sessionStorage limpo em logout
8. CSRF em login form → **Bloqueado:** Supabase auth via AJAX (sem form POST), Origin validation no proxy
9. Bot form submission → **Bloqueado:** honeypot fields (`_ge_confirm_email`, `_ge_phone`); reCAPTCHA
10. Token de reset reutilizado → **Bloqueado:** código armazenado como SHA-256, TTL curto; invalidado após uso ou novo pedido
11. Injeção via campo email em reset → **Bloqueado:** validação de email no proxy antes de encaminhar à EF
12. **VUL-004 (CORRIGIDO):** OPTIONS preflight sem validação de origin → **CORRIGIDO** em `api/check-email.js` e `api/reset-password.js`
13. XSS via parâmetro de URL na página de login → **Bloqueado:** `textContent` em vez de `innerHTML`; sem `document.write`; Trusted Types policy
14. Lockout bypass via IP rotation → **Mitigado:** lockout por email (não por IP); mesmo IP novo, lockout por email persiste

**Vulnerabilidades corrigidas:**
- **VUL-004a [MEDIUM] → CORRIGIDO:** `api/check-email.js`: OPTIONS retornava 204 + CORS para qualquer origem. Agora valida origin antes de responder preflight.
- **VUL-004b [MEDIUM] → CORRIGIDO:** `api/reset-password.js`: mesmo problema. Corrigido com padrão idêntico.

**Resultado:** ✅ SEGURO

---

### SEÇÃO 4: Dashboard ✅ SEGURO

**Arquivos:** `src/scripts/pages/dashboard.js`, `api/user-data.js`, `api/upload-profile-photo.js`, `supabase/functions/upload-profile-photo/index.ts`

**Ataques simulados (15):**
1. IDOR: acessar dados de outro usuário → **Bloqueado:** RLS `user_data_select_own`: `auth.uid() = user_id`; `api/user-data.js` extrai userId do JWT server-side
2. Mass assignment: injetar `user_id` no save → **Bloqueado:** `api/user-data.js` ignora `user_id` do body; usa JWT para determinar owner
3. JSON depth bomb (aninhamento infinito) → **Bloqueado:** `analyzeJson()` valida `maxDepth=8`, `maxKeys=50` antes de salvar
4. Payload oversized (> 5MB) → **Bloqueado:** body limit 5MB no proxy; Supabase column limit no DB
5. Substituição de dados de outro usuário via race condition → **Bloqueado:** RLS WITH CHECK impede update de linhas de outro usuário
6. Upload de arquivo não-imagem como foto → **Bloqueado:** magic bytes validation (JPEG/PNG/WebP header bytes verificados); MIME tipo declarado deve corresponder
7. Upload de GIF com payload JS (gif polyglot attack) → **CORRIGIDO (VUL-002):** GIF removido da lista de tipos aceitos
8. **VUL-001 (CORRIGIDO):** Upload de JPEG com coordenadas GPS em EXIF → **CORRIGIDO:** `stripJpegExif()` remove todos os segmentos APP1 antes do upload
9. Upload de PNG com iTXt/tEXt com XSS → **CORRIGIDO (VUL-001):** `stripPngMetadata()` remove chunks tEXt, iTXt, zTXt, tIME
10. Upload de WebP com EXIF chunk → **CORRIGIDO (VUL-001):** `stripWebpMetadata()` remove chunks EXIF e XMP
11. **VUL-004 (CORRIGIDO):** OPTIONS sem validação de origem em `api/upload-profile-photo.js` → **CORRIGIDO**
12. Rate limit bypass no upload via User-Agent spoofing → **Mitigado:** rate limit por IP + por userId (extraído do JWT); IP spoofing limitado por Vercel infra
13. SVG upload (XSS via inline script em SVG) → **Bloqueado:** SVG não está em MAGIC nem EXT_MAP; rejeitado em step 8 (MIME) e magic bytes
14. Stored XSS via nome de perfil com HTML → **Bloqueado:** `_setHTML()` usa DOMPurify; `textContent` para campos críticos
15. **VUL-006 [LOW — ACEITO]:** `data:` em `img-src` CSP do dashboard → **ACEITO:** necessário para SVG inline fallback de avatar (`graficos.js:71`); risco mitigado pela ausência de `unsafe-inline` em `script-src`

**Vulnerabilidades corrigidas:**
- **VUL-001 [HIGH] → CORRIGIDO:** `upload-profile-photo/index.ts`: sem strip de EXIF/XMP/GPS. Adicionadas funções `stripJpegExif()`, `stripPngMetadata()`, `stripWebpMetadata()`. Strip aplicado server-side antes do upload para storage.
- **VUL-002 [MEDIUM] → CORRIGIDO:** `upload-profile-photo/index.ts`: GIF removido de `MAGIC` e `EXT_MAP`. Aceitos apenas JPEG, PNG, WebP.
- **VUL-004c [MEDIUM] → CORRIGIDO:** `api/upload-profile-photo.js`: OPTIONS sem validação de origem. Corrigido.

**Risco aceito:**
- **VUL-006 [LOW]:** `data:` em `img-src` do dashboard é necessário para SVG avatar fallback. Não explorável sem XSS prévio, e XSS é bloqueado por `script-src 'self'`.

**Resultado:** ✅ SEGURO

---

### SEÇÃO 5: Convidados (Guest System) ✅ SEGURO

**Arquivos:** `src/scripts/pages/convidados.js`, `api/send-guest-invite.js`, `supabase/functions/send-guest-invite/index.ts`, `supabase/migrations/20260519000001_guest_rls_policies.sql`

**Ataques simulados (10):**
1. Convidado acessando dados do dono diretamente → **Bloqueado:** RLS `profiles_select_as_guest` permite apenas leitura do perfil próprio; `effectiveUserId` resolvido server-side na EF, não aceito do cliente
2. Escalar de convidado para dono (privilege escalation) → **Bloqueado:** `effectiveUserId` determinado pela EF via `account_members` com `service_role`; nunca aceito do body
3. Convidar usuário já dono (self-invite) → **Bloqueado:** EF verifica `guestEmail !== ownerEmail` e que o email não pertence a um usuário com subscription própria
4. Enumerar convidados de outros donos → **Bloqueado:** RLS `account_members_select_own`: `owner_user_id = auth.uid()`
5. Spam de convites → **Bloqueado:** rate limit 5/min por IP no proxy; max 4 convites por 24h por dono no DB; limit de convidados por plano (Individual=0, Casal=1, Família=3)
6. Convite com email forjado para XSS no template → **Bloqueado:** `escapeHtml()` em todos os campos do template de email; guestName e guestEmail escapados
7. Re-convite loop (invalidar convites ativos do dono) → **Bloqueado:** re-convite ao mesmo email invalida convite anterior; sem DoS porque rate limit aplica
8. Convidado continua com acesso após remoção → **Bloqueado:** `removerConvidado()` faz soft-delete (`is_active=false`); `check-user-access` verifica `is_active=true` a cada request
9. **VUL-004 (CORRIGIDO):** OPTIONS sem validação de origem em `api/send-guest-invite.js` → **CORRIGIDO**
10. Código de convite armazenado em plaintext → **Bloqueado:** código armazenado como SHA-256 hash; plaintext nunca persiste no DB

**Vulnerabilidades corrigidas:**
- **VUL-004d [MEDIUM] → CORRIGIDO:** `api/send-guest-invite.js`: OPTIONS retornava CORS para qualquer origem. Corrigido.
- **VUL-010 [INFO] → CORRIGIDO:** `send-guest-invite/index.ts`: `@supabase/supabase-js@2.39.3` atualizado para `@2.49.2`.

**Resultado:** ✅ SEGURO

---

### SEÇÃO 6: AtualizarPlano (Upgrade/Downgrade/Cancel) ✅ SEGURO

**Arquivos:** `src/scripts/pages/atualizarplano.js`, `api/stripe.js`

**Ataques simulados (10):**
1. Alterar plano de outro usuário (IDOR via Stripe) → **Bloqueado:** portal do Stripe usa `customer_id` vinculado ao JWT do usuário autenticado; não aceita customer_id do cliente
2. Downgrade instantâneo (bypass de período pago) → **Bloqueado:** Stripe aplica downgrade no próximo período; `pending_plan_change` na `stripe_subscriptions` gerenciado pelo webhook
3. Cancelar assinatura de outro usuário → **Bloqueado:** portal Stripe gerado com customer_id do JWT; outros usuários não têm acesso
4. Replay de preview/changeRemovalList para outro profile_id → **Bloqueado:** `profile_id` validado como UUID; pertencimento ao usuário verificado via RLS
5. Injetar `action: "delete_account"` → **Bloqueado:** `VALID_ACTIONS` whitelist estrito no proxy
6. Rate limit bypass em updatePlan (downgrade/upgrade abusivo) → **Bloqueado:** `checkRate('updatePlan:ip', 3)` — máximo 3/min
7. Body injection em `changeRemovalList` → **Bloqueado:** UUIDs validados com regex; arrays verificados; max itens implícito pelo plano
8. Informação de plano de outro usuário via previewPlan → **Bloqueado:** `previewPlan` retorna apenas informações do subscription do JWT atual; Stripe usa customer_id interno
9. Acesso ao portal sem autenticação → **Bloqueado:** `portal`, `details`, `updatePlan`, `previewPlan`, `changeRemovalList` exigem JWT válido
10. CORS origin spoofing no Stripe proxy → **Bloqueado:** `api/stripe.js` valida origin ANTES de OPTIONS (confirmado correto no audit)

**Vulnerabilidades:** Nenhuma  
**Resultado:** ✅ SEGURO

---

### SEÇÃO 7: Subprocessos, LGPD, Infraestrutura, Rate Limiting ✅ SEGURO*

**Arquivos:** `api/_rate-limit.js`, `api/_alert.js`, `supabase/migrations/20260427000000_final_hardening.sql`, `supabase/migrations/20260519000001_guest_rls_policies.sql`, `vercel.json`

#### 7a. Rate Limiting

**Redis (Upstash) como primário, in-memory como fallback.**

- `checkRate(key, max)`: sliding window via INCR + EXPIRE NX; fallback Map com cap de 10k entradas
- `checkRateWindow(key, max, windowSecs)`: janelas customizadas
- Fire-and-forget `trackSecurityEvent('rate_limit_burst')` em bloqueios

**Limites configurados:**
| Endpoint | Limite |
|---|---|
| `check-user-access` | 20/min por IP |
| `check-email` | 10/min por IP |
| `reset-password (send)` | 3/min por IP |
| `reset-password (verify)` | 10/min por IP |
| `reset-password (reset)` | 5/min por IP |
| `upload-profile-photo` | 20/hora IP + 10/hora userId |
| `send-guest-invite` | 5/min por IP |
| `stripe checkout` | 5/min por IP |
| `stripe updatePlan` | 3/min por IP |
| `stripe portal` | 10/min por IP |

**VUL-009 [INFO]:** `api/upload-profile-photo.js` usa in-memory Map (não Redis). Risco: em deployments multi-instância, cada instância tem contador independente. Impacto limitado porque uploads de foto já são raros por natureza.

#### 7b. Alertas de Segurança

`api/_alert.js`: alertas por email (Resend) com threshold por tipo de evento:

| Evento | Threshold |
|---|---|
| `rate_limit_burst` | 40 em 5min |
| `jwt_forgery` | 10 em 5min |
| `webhook_tamper` | 3 em 1min |
| `login_lockout` | 5 em 10min |
| `upload_abuse` | 15 em 5min |
| `proxy_bypass` | 5 em 2min |

Alerta dispara exatamente uma vez no threshold (não em cada evento subsequente). Degradação silenciosa se Redis/Resend indisponível.

#### 7c. LGPD / Compliance

- Tabela `terms_acceptance`: registra aceite dos termos com timestamp, IP, user_agent
- Policy `terms_owner_insert` WITH CHECK (`auth.uid() = user_id`) impede inserção por outros usuários
- **VUL-008 [CORRIGIDO]:** Aceite agora versionado (`CURRENT_TERMS_VERSION` em `_shared/terms.ts`) e verificado server-side a cada login via `check-user-access`. Flag `needsTermsAcceptance: true` redireciona para `aceitar-termos.html`; aceite registrado via `accept-terms` EF com `userId` sempre extraído do JWT. Flag `_ge_tv` em sessionStorage evita round-trip repetido na mesma sessão. Bump de versão força re-aceite de todos os usuários.

#### 7d. RLS Global

Todas as tabelas auditadas têm RLS habilitado:
- `user_data` ✅ FORCE RLS, policies select/insert/update/delete
- `profiles` ✅ policies com guest-read via subquery
- `stripe_subscriptions` ✅ policies com guest-read do dono
- `subscriptions` ✅ policies com guest-read do dono
- `account_members` ✅ GRANT + policies select/update para authenticated
- `profile_backups` ✅ FORCE RLS + REVOKE anon
- `login_lockouts` ✅ SECURITY DEFINER via RPC
- `edge_rate_limits` ✅ service_role only
- `stripe_events` ✅ service_role via webhook EF

#### 7e. Headers de Segurança

Aplicados globalmente via `vercel.json`:
- ✅ `X-Frame-Options: DENY`
- ✅ `X-Content-Type-Options: nosniff`
- ✅ `X-XSS-Protection: 0` (desabilita implementação bugada do browser)
- ✅ `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- ✅ `Referrer-Policy: strict-origin-when-cross-origin`
- ✅ `Permissions-Policy` (desabilita camera, mic, geolocation, payment, etc.)
- ✅ `Cross-Origin-Opener-Policy: same-origin-allow-popups`
- ✅ `Cross-Origin-Resource-Policy: same-origin`
- ✅ `X-Permitted-Cross-Domain-Policies: none`

**VUL-007 [LOW]:** `unsafe-inline` em `style-src` em múltiplas rotas (`/planos`, `/dashboard`, `/convidados`, `/atualizarplano`). Necessário para Chart.js e componentes dinâmicos. Mitigação adequada: `script-src` não tem `unsafe-inline`, então XSS via CSS injection não resulta em execução de código. Risco aceito enquanto os componentes precisarem de inline styles.

**Resultado:** ✅ SEGURO* (riscos info/low aceitos e documentados)

---

## Inventário Completo de Vulnerabilidades

| ID | Severidade | Status | Arquivo | Descrição |
|---|---|---|---|---|
| VUL-001 | **HIGH** | ✅ CORRIGIDO | `upload-profile-photo/index.ts` | Sem strip de EXIF/GPS. Adicionadas `stripJpegExif`, `stripPngMetadata`, `stripWebpMetadata` |
| VUL-002 | **MEDIUM** | ✅ CORRIGIDO | `upload-profile-photo/index.ts` | GIF aceito (polyglot attack). Removido de MAGIC e EXT_MAP |
| VUL-003 | **MEDIUM** | ✅ CORRIGIDO | `create-stripe-checkout/index.ts` | Email anônimo validado só com `includes('@')`. Substituído por regex |
| VUL-004a | **MEDIUM** | ✅ CORRIGIDO | `api/check-email.js` | OPTIONS preflight sem validação de origin |
| VUL-004b | **MEDIUM** | ✅ CORRIGIDO | `api/reset-password.js` | OPTIONS preflight sem validação de origin |
| VUL-004c | **MEDIUM** | ✅ CORRIGIDO | `api/upload-profile-photo.js` | OPTIONS preflight sem validação de origin |
| VUL-004d | **MEDIUM** | ✅ CORRIGIDO | `api/send-guest-invite.js` | OPTIONS preflight sem validação de origin |
| VUL-005 | **LOW** | ⚠️ ACEITO | `upload-profile-photo/index.ts` | Signed URL com TTL 7 dias. Aceitável dado que bucket privado e URL autenticada |
| VUL-006 | **LOW** | ⚠️ ACEITO | `vercel.json` | `data:` em `img-src` do dashboard. Necessário para SVG avatar fallback |
| VUL-007 | **LOW** | ⚠️ ACEITO | `vercel.json` | `unsafe-inline` em `style-src` em múltiplas rotas. Necessário para Chart.js |
| VUL-008 | **INFO** | ✅ CORRIGIDO | `auth-guard.js`, `accept-terms/index.ts`, `check-user-access/index.ts` | LGPD: aceite versionado, enforçado server-side a cada login |
| VUL-009 | **INFO** | ⚠️ ACEITO | `api/upload-profile-photo.js` | Rate limiter de upload usa in-memory Map, não Redis |
| VUL-010 | **INFO** | ✅ CORRIGIDO | `send-guest-invite/index.ts` | `@supabase/supabase-js@2.39.3` → `@2.49.2` |

---

## Postura de Segurança Positiva (Sem Vulnerabilidade)

Estas proteções foram auditadas e confirmadas como corretas:

| Controle | Onde | Verificação |
|---|---|---|
| JWT validado server-side (ES256/HS256) | Todas as EFs | `supabaseAdmin.auth.getUser(token)` |
| Webhook HMAC-SHA256 timing-safe | `webhook-stripe/index.ts` | `timingSafeEqual()` XOR sem early-return |
| Webhook idempotente | `stripe_events` table | `23505` conflict = duplicate ignorado |
| SQL injection | Todas as queries | Supabase client (parametrizado) |
| XSS stored | `dashboard.js`, `graficos.js` | `textContent`, DOMPurify, Trusted Types |
| IDOR dados | `user_data`, `profiles` | RLS `auth.uid() = user_id` |
| IDOR fotos | `upload-profile-photo` | `effectiveUserId` server-side |
| Direct EF bypass | Todas as EFs | `x-proxy-secret` timing-safe |
| CSRF | Todos os proxies | Origin validation + Sec-Fetch headers |
| Brute force login | `login.js`, `check-user-access` | Lockout progressivo + reCAPTCHA + rate limit |
| User enumeration | `login.js` | Mensagem genérica única |
| Open redirect | `login.js`, `auth-guard.js` | `SafeRedirect.validate()` com whitelist |
| Service role key exposta | Todo JS do browser | Nunca presente; apenas em EFs/serverless |
| Mass assignment role | Todas as EFs | Role nunca aceita do body |
| GIF polyglot | `upload-profile-photo` | GIF removido |
| GPS em imagem | `upload-profile-photo` | EXIF stripped server-side |
| Session fixation | `supabase-client.js` | Novo JWT a cada login; sessionStorage limpo |
| Clickjacking | `vercel.json` | `X-Frame-Options: DENY` + `frame-ancestors 'none'` |

---

## Arquivos Modificados Nesta Auditoria

```
supabase/functions/upload-profile-photo/index.ts  — VUL-001 + VUL-002
supabase/functions/create-stripe-checkout/index.ts — VUL-003
supabase/functions/send-guest-invite/index.ts      — VUL-010
api/check-email.js                                 — VUL-004a
api/reset-password.js                              — VUL-004b
api/upload-profile-photo.js                        — VUL-004c
api/send-guest-invite.js                           — VUL-004d
```

---

## Recomendações Futuras (Fora do Escopo Desta Auditoria)

1. **Redis para upload rate limit (VUL-009):** Migrar `api/upload-profile-photo.js` para usar `checkRateWindow()` do `_rate-limit.js` (Redis) em vez da Map in-memory local.

3. **Bucket público para fotos (VUL-005/VUL-006):** Tornar `profile-photos` bucket público eliminaria signed URLs (TTL 7 dias) e a necessidade de `data:` no CSP para fotos. Implicação: fotos publicamente acessíveis por URL direta — avaliar com produto.

4. **Nonce-based CSP para inline styles:** Substituir `unsafe-inline` em `style-src` por nonces gerados por request elimina VUL-007. Requer mudança na configuração do Vite e nos componentes.

5. **Subresource Integrity (SRI):** Adicionar `integrity` hashes para scripts/estilos de CDN externos (`cdnjs.cloudflare.com`, `fonts.googleapis.com`).

---

*Auditoria realizada em 2026-05-30. Próxima auditoria recomendada: 2026-11-30 ou após mudanças significativas na arquitetura.*
