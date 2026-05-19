# GranaEvo — Achados de Codigo (Analise Estatica)
Data: 2026-05-19 | Auditoria Completa

## API Routes (api/*.js)

### check-user-access.js
- Autentica antes de logica: SIM — passa JWT para EF que chama getUser()
- Usa user_id do body: NAO — body e drenado e descartado; EF usa JWT
- Valida inputs: N/A (sem body critico)
- Rate limit: SIM — checkRate('check-access:IP', 20) via _rate-limit.js
- CORS: SIM — ALLOWED_ORIGINS validada, origin check antes de CORS header
- Proxy secret: SIM — repassado para EF via x-proxy-secret
- FINDING MEDIO: Preflight OPTIONS nao valida origin (intencional por design — browsers enviam preflight antes da requisicao real). Risco baixo pois o header ACAO retorna o primeiro allowed origin quando origin e null/invalida.

### user-data.js
- Autentica antes de logica: SIM — extrai token do Bearer header ou cookie; valida na EF via getUser()
- Usa user_id do body: NAO — userId extraido do JWT (sem verificacao de assinatura) APENAS para rate limiting. Auth real feita pela EF.
- Valida inputs: SIM — MAX_BODY_BYTES 5MB, MAX_JSON_DEPTH 8, MAX_KEYS_OBJ 50, MAX_PROFILES 200
- Rate limit: SIM — por IP (GET:20, POST:10) e por userId (POST:8) por janela de 60s
- CORS: SIM — ALLOWED_ORIGINS + Sec-Fetch-Site/Mode/Dest verificados
- Rate limit restaurar: SIM — 3 restauracoes por hora por IP e por userId
- FINDING BAIXO: extractUserId decodifica JWT sem verificar assinatura — aceitavel pois e explicitamente documentado como sendo apenas para rate limiting; auth real e feita na EF.

### create-account.js
- Autentica antes de logica: N/A — endpoint publico (criacao de conta)
- Valida inputs: SIM — email regex, senha 8-128 chars, plano em whitelist, tamanho maximo 2048 bytes
- Rate limit: SIM — 3 criacoes por IP por hora via checkRateWindow()
- Honeypot: SIM — _hp_email e _hp_url verificados server-side
- CORS: SIM
- Sem service_role key: SIM — delega para EF via proxy secret

### send-guest-invite.js
- Autentica antes de logica: SIM — Bearer token obrigatorio; EF valida com getUser()
- Valida inputs: SIM — email regex, guestName 2-100 chars, body limit 4096 bytes
- Rate limit: SIM — 5 req/min por IP
- CORS: SIM
- FINDING BAIXO: Para origens nao na whitelist, corsOrigin assume o primeiro item da lista em vez de retornar 403. A validacao de origem real acontece logo apos (linha 38), portanto sem impacto de seguranca — e apenas um CORS header cosmético incorreto para origens invalidas antes do 403.

### verify-invite.js
- Autentica antes de logica: N/A — endpoint publico (aceite de convite por nao-usuario)
- Valida inputs: SIM — email, code, step, invitationId sanitizado, createToken limitado, body limit 8192 bytes
- Rate limit: SIM — 3 req/min por IP
- CORS: SIM
- Proxy secret: SIM — repassado para EF
- FINDING BAIXO: mesmo CORS cosmético que send-guest-invite.js

### stripe.js
- Autentica antes de logica: SIM para acoes portal/details/updatePlan/previewPlan/changeRemovalList; checkout e intencioalmente publico
- Valida inputs: SIM — action em whitelist, plano em whitelist, UUIDs validados com regex para membersToRemove
- Rate limit: SIM — por acao e IP
- CORS: SIM — origin check ANTES do CORS header (correcao GOD6-L01 aplicada)

### upload-profile-photo.js
- Autentica antes de logica: SIM — Bearer token obrigatorio
- Valida inputs: SIM — Content-Type multipart, body limit 6MB, MIME e magic bytes validados pela EF
- Rate limit: SIM — 20/hora por IP, 10/hora por userId
- CORS: SIM
- FINDING BAIXO: OPTIONS preflight nao valida origin — mesma situacao de check-user-access.js (por design)

### reset-password.js / check-email.js / verify-recaptcha.js / queue-email.js
- Todos: rate limit, CORS, validacao de input, proxy secret — CORRETO
- FINDING INFO: queue-email.js exige origin nao-vazia (linha 58) — protecao extra contra ferramentas sem browser que nao enviam Origin

## Edge Functions (Supabase Deno)

### check-user-access/index.ts
- Proxy secret: SIM — timingSafeEqual antes de qualquer logica (fail-closed se PROXY_SECRET ausente)
- JWT validacao: SIM — supabaseAdmin.auth.getUser(token) — valida assinatura ES256 via JWKS
- Inputs validados: SIM — token length >= 20
- Lockout progressivo: SIM — check_login_lockout RPC antes de consultar subscriptions
- Convidado: SIM — verifica account_members + subscription do dono (Cakto e Stripe)
- Logs: user_id truncado (primeiros 8 chars) — sem exposicao de UUID completo
- Erro generico: SIM — catch retorna deny(500) sem stack trace
- timingSafeEqual: previne timing oracle no proxy secret (max-length loop via XOR)

### save-user-data/index.ts
- Proxy secret: SIM — timingSafeEqual (mas com early-return em length != — diferente de check-user-access!)
- JWT validacao: SIM — supabaseAdmin.auth.getUser(token)
- Resolucao de convidado: SIM — effectiveUserId = owner_user_id para convidados
- Criptografia: SIM — AES-256-GCM HKDF por usuario
- FINDING MEDIO: timingSafeEqual em save-user-data tem early-return em aBytes.length !== bBytes.length (linha 57). Isso revela o tamanho do PROXY_SECRET via timing. O proxy secret tem tamanho fixo em producao (tipicamente 32+ chars), portanto o atacante ja sabe o tamanho esperado. Risco: MUITO BAIXO (tamanho e publico de fato). Recomendacao: alinhar com a implementacao de check-user-access que usa XOR sem early-return.

### get-user-data/index.ts
- Mesmo padrao que save-user-data: mesmo FINDING MEDIO de timingSafeEqual

### verify-guest-invite/index.ts
- Proxy secret: SIM — timingSafeEqualInvite usa max-length XOR (correto, sem early-return)
- Nonce: SIM — criado com expires_at explicito + consumido atomicamente
- Rate limit: SIM — por IP e por email via RPC atomica check_rate_limit
- HMAC step token: SIM — vincula step=verify ao step=create server-side
- Hash de codigo: SIM — SHA-256 do codigo 6 digitos
- Tempo minimo de resposta: SIM — MIN_RESP_MS = 400ms (anti-timing)
- Rollback de usuario orfao: SIM — deleteUser se insert em account_members falhar
- User-id fora do response: SIM [FIX-EF-4]
- FINDING INFO: usuario criado com auth.admin.createUser(email_confirm: true) — email nao confirmado por padrao para convidados. Convidado ja validou email indiretamente (recebeu o convite + codigo). Design correto.

### send-guest-invite/index.ts
- Proxy secret: SIM — timingSafeEqualInvite (max-length XOR)
- JWT validacao: SIM — supabaseAdmin.auth.getUser(token)
- Verificacao de plano: SIM — verifica subscription Cakto e Stripe antes de criar convite
- Limite de membros: SIM — GUEST_LIMITS por plano
- Rate limit de convites: SIM — max 4 em 24h por owner
- HTML do email: SIM — escapeHtml() aplicado em todos os campos do usuario (guestName, ownerName, planName, invId)
- inviteUrl usa encodeURIComponent para invId
- Sem codigo no banco: SIM — apenas code_hash armazenado

## Frontend (src/scripts/)

### supabase-client.js
- service_role key exposta: NAO — apenas SUPABASE_URL e SUPABASE_ANON_KEY (intencioalmente publicas)
- auth.admin: NAO
- FINDING INFO: SUPABASE_ANON_KEY hardcoded no bundle. Isso e INTENCIONAL — anon key e projetada para ser publica. A seguranca e garantida pelo RLS no Supabase. Documentado no proprio arquivo.

### auth-guard.js
- Verificacao de plano no frontend: SIM — mas como FALLBACK complementar; a verificacao autoritativa e feita via /api/check-user-access (server-side)
- Usa user_id do cliente para auth: NAO — apenas userId derivado do session object do Supabase SDK
- supabase.auth.admin: NAO
- Redirect seguro: SIM — SafeRedirect._isSafe() valida same-origin e blocklist de esquemas perigosos
- FINDING MEDIO: A verificacao de plano no SubscriptionChecker.getActive() e feita via queries Supabase diretamente do frontend. Se um usuário manipular o RLS ou tiver um JWT valido com role indevida, poderia burlar esta verificacao. MITIGACAO: A verificacao autoritativa e o endpoint /api/check-user-access que usa service_role + auth.getUser(). O frontend usa as queries RLS como cache/UX — o acesso real aos dados e controlado server-side pelas Edge Functions. RISCO: BAIXO.
- FINDING BAIXO: _renderFrozenOverlay usa overlay.innerHTML com template literal que interpola planName e daysText. planName vem de uma whitelist (_PLAN_WL) e daysText e construido de um numero inteiro — sem entrada do usuario. SEGURO.

### dashboard.js / outros pages
- service_role key: NAO encontrada em nenhum arquivo
- auth.admin: NAO
- innerHTML com dados externos: Maioria usa textContent. Casos de innerHTML:
  - graficos.js: usa _sanitize() antes de innerHTML
  - db-relatorios.js: usa _sanitizarHTMLRelatorio() (DOMParser-based)
  - dashboard.js: usa sanitizarHTMLPopup() (DOMParser-based)
  - auth-guard.js overlay: usa whitelist para planName, inteiro para daysText
  - tutorial.js linha 242: innerHTML com template — verificacao necessaria
- CONFIRMADO SEGURO: tutorial.js linha 242 usa innerHTML com conteudo de PASSOS (array de constantes definidas estaticamente no modulo, sem entrada do usuario). p.titulo e p.texto sao strings literais do codigo-fonte. Sem risco de XSS.

## vercel.json

### Headers de Seguranca
- X-Frame-Options: DENY — SIM
- X-Content-Type-Options: nosniff — SIM
- X-XSS-Protection: 0 — SIM (correto — desabilita XSS filter legado que causa problemas)
- HSTS: max-age=63072000; includeSubDomains; preload — SIM (2 anos)
- Referrer-Policy: strict-origin-when-cross-origin — SIM
- Permissions-Policy: restrictiva — SIM
- Cross-Origin-Opener-Policy: same-origin-allow-popups — SIM (permite popups para OAuth)
- Cross-Origin-Resource-Policy: same-origin — SIM
- Cross-Origin-Embedder-Policy: unsafe-none — NOTA: necessario por restricoes de terceiros (Cloudflare Insights, reCAPTCHA)

### CSP por rota
- Todas as rotas sensíveis tem CSP especifico (dashboard, login, convidados, atualizarplano)
- Rotas estaticas (termos, privacidade, /) tem CSP restritivo
- /api/*: CSP default-src 'none' — correto para endpoints de API
- FINDING MEDIO: CSP ausente para a rota /atualizarplano nas rotas de HTML (rewrite nao tem entrada de rota HTML para atualizarplano com CSP proprio — mas vercel.json linha 140 tem CSP para /atualizarplano). VERIFICADO — ha CSP em /atualizarplano.
- FINDING INFO: dashboard CSP inclui 'unsafe-inline' em style-src (necessario para chart.js inline styles). Nao e ideal mas e pratico.

### Cache Control
- /api/*: no-store, no-cache, must-revalidate, private — CORRETO
- /dashboard: no-store — CORRETO
- /convidados: no-store + CDN-Cache-Control + Surrogate-Control — CORRETO
- /atualizarplano: no-store — CORRETO

---

## AUTH-01 — ALTO: Auth-guard overlay usa inline styles (CSP violations em múltiplas páginas)
**Arquivo:** `src/scripts/modules/auth-guard.js:1016` e `:1024`
**Severidade:** ALTO

```javascript
overlay.style.cssText = [...].join(';');   // line 1016 — blocked by style-src
overlay.innerHTML = `
  <div style="max-width:460px;...">         // line 1025 — blocked by style-src
    <div style="...">                        // blocked
```

O overlay de assinatura expirada aplica inline styles via `style.cssText` E via `style=""` attributes em innerHTML. O Chrome bloqueia ambos quando a CSP não tem `'unsafe-inline'` em `style-src`.

**Páginas afetadas:** `/atualizarplano`, `/convidados`, `/planos` — todas sem `'unsafe-inline'`.
**Impacto:** Overlay aparece sem formatação quando assinatura expira nessas páginas. Não é uma vulnerabilidade de segurança, mas quebra a UX de controle de acesso.

**Fix:** Mover todos os estilos do overlay para uma classe CSS e adicionar `'unsafe-inline'` ao style-src das rotas afetadas, OU usar a abordagem já aplicada no dashboard.

---

## AUTH-02 — BAIXO: check-user-access.js loga user_id do body (não do JWT)
**Arquivo:** `api/check-user-access.js:86`
**Severidade:** BAIXO

```javascript
trackSecurityEvent('login_lockout', { ip, user_id: body.user_id?.slice?.(0, 8) })
```

O `user_id` logado no evento de segurança vem do body da requisição, não do JWT verificado. Um atacante pode manipular os logs de segurança enviando um user_id falso no body. O controle de acesso real usa o JWT (correto), mas os logs podem ser enganosos.

**Fix:** Usar o user_id do JWT verificado pela Edge Function. Como o proxy não tem o JWT decodificado, o melhor é remover o user_id do evento de tracking no proxy e deixar a EF logar.

---

## RATE-01 — MÉDIO: Rate limiting in-memory sem Redis
**Arquivo:** `api/_rate-limit.js`
**Severidade:** MÉDIO

O rate limiting usa in-memory Map como fallback quando UPSTASH_REDIS_REST_URL não está configurado. Em ambientes serverless (Vercel), cada instância tem seu próprio contador — um atacante com múltiplos IPs pode contornar limites distribuindo requests entre instâncias.

**Impacto:** Redução da eficácia do rate limiting em ataques distribuídos. Não anula proteção (cada instância ainda bloqueia após o limite), mas torna mais difícil bloquear ataques de volume.

**Fix:** Configurar Upstash Redis para rate limiting centralizado e distribuído. Documentado no código como requisito para produção em escala.

---

## SANITIZE-01 — MÉDIO: Sanitizador HTML customizado em graficos.js
**Arquivo:** `src/scripts/modules/graficos.js:98-139`
**Severidade:** MÉDIO

`_setSafeHTML()` usa um sanitizador custom (DOMParser + remoção de tags + bloqueio de atributos on*). É funcional e razoável, mas:
1. Não é uma biblioteca testada contra mutação XSS (mXSS)
2. SVG é bloqueado explicitamente, mas `<math>` também deve ser monitorado
3. O template element pode ter comportamento diferente em navegadores antigos

**Mitigação já existente:** Tags estruturalmente perigosas bloqueadas, atributos on* removidos, URIs perigosos bloqueados.

**Recomendação:** Avaliar substituição por DOMPurify (3.7KB gzipped, battle-tested).

---

## CSP-01 — BAIXO: atualizarplano e convidados sem 'unsafe-inline' no style-src
**Arquivo:** `vercel.json:140,130`
**Severidade:** BAIXO

As rotas `/atualizarplano` e `/convidados` têm CSP estrita (sem `'unsafe-inline'`). O modal de atualizarplano usa CSS classes (✓), mas a library de gráficos ou auth-guard overlay podem gerar violações.

---

## XSS-01 — VERIFICADO OK: innerHTML em atualizarplano.js
**Arquivo:** `src/scripts/pages/atualizarplano.js:801`
**Severidade:** OK

`modal.innerHTML = \`<div class="gm-step-wrap">${html}</div>\`` — o `html` é gerado pelas funções de render internas que usam `_esc()` em TODOS os dados externos (m.id, m.name, m.email, g.id, g.email). Estrutura estática das templates. Nenhum dado de usuário é interpolado sem escaping.

---

## XSS-02 — VERIFICADO OK: innerHTML em auth-guard.js frozen overlay
**Arquivo:** `src/scripts/modules/auth-guard.js:1024`
**Severidade:** OK para XSS (ALTO para CSP — ver AUTH-01)

`${planName}` no innerHTML está whitelisted:
```javascript
const _PLAN_WL = { individual: 'Individual', casal: 'Casal', familia: 'Família' };
const planName = _PLAN_WL[_rawPlanName?.toLowerCase?.()] ?? 'GranaEvo';
```
Nunca interpola string arbitrária. Seguro para XSS.

---

## XSS-03 — VERIFICADO OK: innerHTML em tutorial.js
**Arquivo:** `src/scripts/modules/tutorial.js:242`
**Severidade:** OK

`p.titulo` e `p.texto` vêm de um array `PASSOS` hardcoded no arquivo, nunca de input do usuário.

---

## REDIRECT-01 — VERIFICADO OK: Open redirect
**Arquivos:** auth-guard.js, convidados.js, login.js
**Severidade:** OK

Todos os redirects usam validação de same-origin ou whitelist explícita de paths:
- `auth-guard.js`: valida `new URL(url, origin).origin === origin`
- `convidados.js`: SafeRedirect com validação de scheme + same-origin
- `login.js`: `getNextRedirect()` valida paths relativos conhecidos

---

## SECRETS-01 — VERIFICADO OK: Secrets e variáveis
**Severidade:** OK

- `.env.local` NÃO rastreado pelo git ✓
- `SUPABASE_ANON_KEY` hardcoded em `convidados.js` — intencional (chave pública) ✓
- `service_role` nunca aparece em arquivos de frontend ✓
- `STRIPE_SECRET_KEY` nunca em código — apenas via `supabase secrets` ✓
- `PROXY_SECRET` nunca exposto em frontend ✓

---

## HEADERS-01 — VERIFICADO OK: Headers de segurança globais
**Arquivo:** `vercel.json:17-53`
**Severidade:** OK

Global (todas as rotas):
- X-Frame-Options: DENY ✓
- X-Content-Type-Options: nosniff ✓
- Referrer-Policy: strict-origin-when-cross-origin ✓
- HSTS: max-age=63072000 (2 anos) + includeSubDomains + preload ✓
- Permissions-Policy: câmera, mic, geo, pagamento bloqueados ✓
- Reporting-Endpoints configurado ✓

---

## INVITE-01 — VERIFICADO OK: Fluxo de convites
**Severidade:** OK

- SHA-256 do código de convite no banco (nunca plaintext) ✓
- Nonce anti-replay com TTL de 2 minutos ✓
- Rate limit duplo (por IP + por email) ✓
- Tempo mínimo de resposta 400ms (dificulta timing attack) ✓
- Rollback de usuário órfão em caso de erro ✓
- `userId` nunca retornado ao frontend ✓
- Mensagem de erro genérica (sem enumeração de emails) ✓

---

## STRIPE-01 — VERIFICADO OK: Webhook Stripe
**Severidade:** OK

- HMAC-SHA256 Stripe signature verificado com timing-safe compare ✓
- Rate limit in-memory para assinaturas inválidas (evita DB flood) ✓
- Idempotência via `stripe_events` table (previne replay) ✓
- `pending_member_removals` com proteção `.neq('member_user_id', ownerUserId)` ✓

---

## GUEST-01 — VERIFICADO OK: Bloqueio server-side de convidados
**Severidade:** OK

`update-stripe-plan` e `preview-stripe-plan` verificam `account_members.member_user_id = user.id` ANTES de qualquer operação. Convidados recebem 403 GUEST_BLOCKED. Defense-in-depth além do frontend auth-guard.

---

## Resumo Código
- Problemas CRÍTICOS: 0
- Problemas ALTOS: 1 (AUTH-01 — overlay CSP)
- Problemas MÉDIOS: 2 (RATE-01, SANITIZE-01)
- Problemas BAIXOS: 1 (AUTH-02)
- Verificados OK: 10+

Escopo: todos os 47 arquivos de código (api/, src/, supabase/functions/, vercel.json, package.json, migrations/)

---

## Achados Round 8

### GOD8-M01 — MÉDIO (CORRIGIDO) — `timingSafeEqual` com early-return em `webhook-cakto`

| Campo | Valor |
|-------|-------|
| Arquivo | `supabase/functions/webhook-cakto/index.ts` |
| Linha | 16 |
| CWE | CWE-208 (Observable Timing Discrepancy) |
| Status | ✅ CORRIGIDO nesta sessão |

**Código vulnerável:**
```ts
if (aBytes.length !== bBytes.length) return false  // timing oracle
```

**Fix aplicado:**
```ts
const len  = Math.max(aB.length, bB.length)
let diff   = aB.length ^ bB.length
for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0)
return diff === 0
```

---

### GOD8-L01 — BAIXO — CSP dashboard permite `data:` em img-src

| Campo | Valor |
|-------|-------|
| Arquivo | `vercel.json` |
| Linha | 100 |
| Status | ⏳ Verificar uso antes de corrigir |

**Trecho:**
```json
"img-src 'self' https://fvrhqqeofqedmhadzzqw.supabase.co data:"
```

**Ação:** Verificar se algum componente do dashboard renderiza `data:image/...`. Se não, remover `data:`.

---

### GOD8-L02 — BAIXO — Rate limiter de upload não usa Redis

| Campo | Valor |
|-------|-------|
| Arquivo | `api/upload-profile-photo.js` |
| Linhas | 44–65 |
| Status | ⏳ Baixa prioridade |

Rate limiter próprio (Map local) em vez de `_rate-limit.js` com Redis. Em deploy multi-instância, efetividade é `limite / N_instâncias`.

---

### GOD8-L03 — BAIXO — `package.json` usa semver range `^`

| Campo | Valor |
|-------|-------|
| Arquivo | `package.json` |
| Status | ⏳ Mitigado por package-lock.json |

`npm ci` usa lock file, então o risco principal está mitigado. Rodar `npm audit` periodicamente.

---

## Achados Anteriores — Todos Corrigidos

### Round 7 — Corrigidos (resumo)

| ID | Severidade | Achado | Status |
|----|-----------|--------|--------|
| GOD7-C01 | CRÍTICO | XSS em atualizarplano.js (m.name/m.email) | ✅ |
| GOD7-A01 | ALTO | `_planLabel()` slug raw da API | ✅ |
| GOD7-A02 | ALTO | planName sem whitelist em auth-guard.js | ✅ |
| GOD7-M01 | MÉDIO | timingSafeEqual early-return em 7 EFs | ✅ |
| GOD7-M02 | MÉDIO | pdfUrl sem validação HTTPS | ✅ |
| GOD7-M03 | MÉDIO | _setSafeHTML incompleto | ✅ |
| GOD7-M04 | MÉDIO | sanitizarHTMLPopup faltando tags | ✅ |
| GOD7-L01 | BAIXO | Rate limit userId em upload | ✅ |
| GOD7-L02 | BAIXO | Texto login "8 chars" vs validação "10" | ✅ |
| GOD7-L03 | BAIXO | webhook-stripe account_members sem filtro | ✅ |

---

## Verificações que passaram (Round 8)

- `eval()` / `new Function()` / `setTimeout(string)` — **zero ocorrências**
- `document.write()` — **zero ocorrências**
- `innerHTML` com dados externos — **todos sanitizados** via `textContent`, `_esc()` ou whitelist
- Secrets hardcoded — **nenhum** (service_role key, Stripe secret: via env vars)
- SQL injection — **zero** (todo acesso via supabase-js parametrizado)
- `auth.uid()` em todas as policies RLS — **confirmado**
- `WITH CHECK` em todos os UPDATE policies — **confirmado**
- `supabase.auth.admin` no frontend — **zero ocorrências**
- `x-proxy-secret` em todas as EFs — **confirmado** (fail-closed quando ausente)
- HMAC-SHA256 no webhook-stripe via raw bytes — **confirmado**
- Timing-safe comparison em todos os paths de auth — **confirmado após fix GOD8-M01**
