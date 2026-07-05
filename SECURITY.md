# Segurança — GranaEvo

Modelo de segurança, postura de testes e runbooks de hardening.
Reportar vulnerabilidades: ver [`public/.well-known/security.txt`](public/.well-known/security.txt).

---

## Modelo de sessão

- **Refresh token:** cookie `HttpOnly; Secure; SameSite=Strict; Path=/api/auth-session` — nunca toca em JavaScript.
- **Access token:** somente em memória (`Map`), nunca em `localStorage`/`sessionStorage`.
- **Efeito:** XSS não consegue exfiltrar sessão (o vetor #1 de SaaS Supabase está neutralizado).

## Defesa em profundidade

- Criptografia em repouso por-usuário (AES-256-GCM, chave derivada via HKDF do `userId`).
- JWT verificado de verdade (`auth.getUser(token)` → assinatura ES256 via JWKS) em toda EF sensível.
- Proxy Vercel → EF autenticado com `x-proxy-secret` (`timingSafeEqual`, fail-closed).
- Guarda anti-wipe autoritativa server-side em `save-user-data`.
- Upload: magic bytes + strip de EXIF/XMP/GPS + rejeição de polyglot (GIF/SVG).
- Webhooks: HMAC-SHA256 + tolerância de timestamp + idempotência.
- Rate limit distribuído (Upstash Redis) com blocklist persistente de IP.
- Assistente/chat: **IA como função** — o Haiku só faz *parsing* (tool-use `strict`), nunca vê R$/saldos nem gera texto exibível; render 100% via `textContent`/`createElement` (XSS-proof). Ver seção "Assistente GranaEvo" abaixo.

---

## Rodando os testes de segurança

A suíte tem ~90 testes de regressão em [`tests/security/security.test.js`](tests/security/security.test.js).

```bash
# Contra um ambiente DEDICADO (preview/staging) — NUNCA produção:
BASE_URL=https://granaevo-staging.vercel.app npm run test:security
```

> ⚠️ **A suíte é stateful e parcialmente destrutiva:** dispara `reset-password step:send`
> (e-mails reais), martela endpoints até 429 (gera eventos `rate_limit_burst`) e testa
> blocklist de IP (pode bloquear o IP de quem roda). Por isso **não roda por push** —
> ver [CI](#ci) abaixo.

## CI

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — **por push/PR**, apenas idempotente:
  build, `npm audit` (falha em high/critical) e secret scan (gitleaks).
- [`.github/workflows/security-suite.yml`](.github/workflows/security-suite.yml) — **manual + semanal**,
  roda a suíte completa contra o secret `SECURITY_TEST_BASE_URL` (aponte para staging).

Secrets a configurar no GitHub: `SECURITY_TEST_BASE_URL`, `SECURITY_TEST_SUPABASE_URL`.

---

## Disaster Recovery

O schema/RLS das tabelas centrais precisa estar versionado — ver
[`supabase/schema/README.md`](supabase/schema/README.md) (achado **M1**). Rode o
`supabase db dump --schema-only` e commite após qualquer migration nas tabelas centrais.

## Rate limit estrito (M2)

`api/_rate-limit.js` faz **fail-closed no boot** em produção se o Upstash não estiver
configurado (`RATE_LIMIT_STRICT`, default `true`). Em produção o Upstash já está setado;
o guard existe para que um deploy futuro que perca as envs falhe ALTO em vez de degradar
silenciosamente para in-memory. Para desligar: `RATE_LIMIT_STRICT=false`.

---

## Assistente GranaEvo (chat)

Auditado em 2026-07-02 (god-mode + god-eyes) — relatório em
[`security-audit/god-mode-god-eyes-chat-REPORT.md`](security-audit/god-mode-god-eyes-chat-REPORT.md).
Score 96/100; 0 crítico/alto. Não adiciona superfície nova de banco (reusa o save/get).

**Modelo — "IA como função" (o Haiku é parser, nunca interlocutor):**
- A IA recebe só o texto do turno + rótulos não-sensíveis (nomes de metas/cartões); **nunca** valores, saldos ou dados de outro usuário.
- Saída travada por `tool_choice` forçado + schema `strict` → impossível vazar prompt ou emitir texto livre. O cliente exibe só o objeto `parse`, sanitizado em `normalize.js` (clamp de valor, whitelist de categoria/tipo/período).
- Toda a "voz" do assistente sai de `phrases.js` (templates locais), nunca da IA.
- Render XSS-proof: `ui.js` usa só `textContent`/`createElement` (zero `innerHTML` dinâmico). CSP de `/assistente`: `script-src 'self'` + `style-src 'self'` (sem `unsafe-inline`).

**Auth & anti-abuso (defesa em camadas):**
- Proxy Vercel (`/api/user-data`, action `chat-parse`) → Edge `chat-parse`, ambos com `x-proxy-secret` (`timingSafeEqual`, fail-closed) + `auth.getUser(token)` (ES256). `verify_jwt=false` na EF é intencional (ela verifica ES256 internamente).
- Rate limit primário no proxy: 15/min IP · 20/min uid · **teto diário 120/uid**.
- **Backstop no banco** (achado M1 da auditoria): RPC atômica `chat_parse_bump(uuid,int)` (SECURITY DEFINER, `search_path` travado, EXECUTE só p/ `service_role`) sobre a tabela `chat_parse_usage` (RLS on, sem policies, FK `ON DELETE CASCADE`, sem PII). A Edge consulta o teto (200/dia) **antes** da IA, **fail-open**. Sobrevive a um vazamento do `PROXY_SECRET`. Migration `20260702000000_chat_parse_rate_backstop.sql`.

---

## Runbooks de hardening pendentes

### B1 — Migrar anon key para API keys novas (sb_publishable_)

A anon key atual em `supabase-client.js` é o JWT legado (`exp` 2082). É público por design
(sem risco direto), mas **não é rotacionável sem trocar o JWT secret** — o que invalidaria
todas as sessões. As novas API keys (`sb_publishable_…`) são rotacionáveis isoladamente.

Passos:
1. Supabase Dashboard → Settings → API Keys → criar/ativar publishable key.
2. Trocar o valor em `supabase-client.js` pela `sb_publishable_…`.
3. Verificar que os clients (`createClient`) aceitam o novo formato (supabase-js ≥ 2.x).
4. Manter a anon key legada ativa durante a transição; revogar depois de confirmar.

Severidade: 🟡 baixo. É uma melhoria de *rotacionabilidade*, não corrige uma falha.

### B2 — CSP do dashboard: 'unsafe-inline' → hash do critical-css

[`vercel.json`](vercel.json) linha do `/dashboard` usa `style-src 'self' 'unsafe-inline'`
(as demais páginas já são `'self'` puro). O `'unsafe-inline'` existe por causa do bloco de
CSS crítico inline em `dashboard.html`.

**Decisão de engenharia (aceitar como risco baixo, por ora):** migrar para
`style-src 'self' 'sha256-…'` é frágil porque:
- O hash do `<style>` muda toda vez que o critical-css muda → precisa de build step que
  computa o sha256 e injeta no `vercel.json` (o padrão já existe em `build-light-theme.mjs`
  e nos `integrity=` dos scripts, então é factível).
- Atributos `style="…"` estáticos no HTML exigiriam `'unsafe-hashes'` + hash por atributo.
- `script-src` já está travado em `'self'` — **injeção de *estilo* é muito menos perigosa que
  injeção de *script***, e o vetor de exfiltração via CSS está mitigado por `connect-src`/`img-src`
  fechados em `'self'`.

Se for fechar mesmo assim:
1. Extrair o critical-css inline para o hash: `openssl dgst -sha256 -binary style.css | openssl base64`.
2. Adicionar build step que recomputa e injeta o hash no CSP do `/dashboard` no `vercel.json`.
3. Trocar `'unsafe-inline'` por `'sha256-<hash>'` e validar via `report-uri /api/csp-report`.

Severidade: 🟡 baixo.
