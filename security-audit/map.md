# GranaEvo — Security Surface Map
Gerado em: 2026-05-18 | GOD MODE + GOD EYES Round 8

---

## API Routes (Vercel Serverless — Superfície Pública)

| Endpoint | Auth obrigatória | Rate Limit | Notas |
|----------|-----------------|-----------|-------|
| `POST /api/check-email` | Nenhuma | IP 10/min | Resposta genérica (não enumera emails) |
| `POST /api/check-user-access` | JWT Bearer | IP 20/min | Lockout progressivo |
| `POST /api/create-account` | Nenhuma | IP 3/hora | Honeypot + validação senha |
| `POST /api/csp-report` | Nenhuma | — | Coleta violações CSP |
| `POST /api/reset-password` | Nenhuma | IP 3–10/min | 3 steps, proxy secret para EFs |
| `POST /api/send-guest-invite` | JWT Bearer | IP 5/min | Proxy secret para EF |
| `POST /api/stripe` (checkout) | Nenhuma | IP 5/min | Plan whitelist, sem amount do cliente |
| `POST /api/stripe` (portal/details/etc) | JWT Bearer | IP variável | |
| `POST /api/upload-profile-photo` | JWT Bearer | IP 20/h + User 10/h | Magic bytes na EF |
| `GET /api/user-data` | JWT Bearer | IP 20/min | Dados financeiros |
| `POST /api/user-data` | JWT Bearer | IP 10/min + User 8/min | JSON depth/key limit |
| `POST /api/verify-invite` | Nenhuma | IP 5/min | Nonce + hash SHA-256 na EF |
| `POST /api/verify-recaptcha` | Nenhuma | — | |

## Edge Functions (Supabase / Deno — protegidas por x-proxy-secret)

| Função | Autenticação | Notas de Segurança |
|--------|-------------|-------------------|
| `check-email-status` | ProxySecret | Resposta genérica |
| `check-user-access` | ProxySecret + auth.getUser | Lockout, dual-source (Cakto+Stripe) |
| `confirm-user-email` | ProxySecret | Anti-replay 10min, password_created |
| `create-stripe-checkout` | ProxySecret | Sem user JWT (pré-login) |
| `get-user-data` | ProxySecret + auth.getUser | |
| `link-user-subscription` | ProxySecret | Auto-link Cakto |
| `preview-stripe-plan` | ProxySecret + auth.getUser | |
| `process-cakto-payment` | ProxySecret | |
| `save-user-data` | ProxySecret + auth.getUser | |
| `send-cancellation-email` | ProxySecret | |
| `send-guest-invite` | ProxySecret + auth.getUser | Hash SHA-256, rate limit 4/24h |
| `send-password-reset-code` | ProxySecret | |
| `send-welcome-email` | ProxySecret | |
| `stripe-portal` | ProxySecret + auth.getUser | |
| `stripe-subscription-details` | ProxySecret + auth.getUser | |
| `update-stripe-plan` | ProxySecret + auth.getUser | Downgrade agendado |
| `upload-profile-photo` | ProxySecret + auth.getUser | Magic bytes validados |
| `verify-and-reset-password` | ProxySecret | OTP SHA-256 |
| `verify-cakto-payment` | ProxySecret | |
| `verify-guest-invite` | ProxySecret | Nonce + hash + rate limit |
| `verify-recaptcha` | ProxySecret | Google reCAPTCHA v3 |
| `webhook-cakto` | CAKTO_WEBHOOK_SECRET (JSON) | timingSafeEqual sem early-return ✅ |
| `webhook-stripe` | STRIPE_WEBHOOK_SECRET (HMAC) | Raw bytes, timestamp tolerance |

## Trust Boundaries

```
[Browser — TOTALMENTE NÃO CONFIÁVEL]
  │ CORS origin whitelist
  │ CSP por página (sem unsafe-eval, unsafe-inline)
  ▼
[Vercel API Routes — Semi-confiável: proxy + rate limit + body limit]
  │ x-proxy-secret (servidor→servidor, timing-safe)
  │ JWT extraído do Authorization header
  ▼
[Supabase Edge Functions — Confiável: auth.getUser() real]
  │ SERVICE_ROLE_KEY (bypassa RLS — apenas para operações admin)
  │ anon key + JWT do usuário (sujeito a RLS)
  ▼
[PostgreSQL com RLS FORCE — Última linha de defesa]
  │ user_id = auth.uid() em todas as policies
  │ WITH CHECK em todos os UPDATE
  │ REVOKE ALL em tabelas internas
```

## Banco de Dados

| Tabela | RLS | Políticas | Notas |
|--------|-----|-----------|-------|
| `user_data` | FORCE | SELECT (owner) | INSERT/UPDATE: service_role only |
| `subscriptions` | FORCE | SELECT (owner), guest | INSERT/UPDATE: service_role only |
| `stripe_subscriptions` | FORCE | SELECT (uid+email), UPDATE (auto-link) | |
| `profiles` | FORCE | SELECT/UPDATE (owner), guest | |
| `account_members` | FORCE | SELECT (owner+member) | |
| `guest_invitations` | FORCE | SELECT (owner) | |
| `terms_acceptance` | FORCE | SELECT/INSERT (owner) | |
| `payment_events` | FORCE | REVOKE ALL + service_role | |
| `password_reset_codes` | FORCE | REVOKE ALL + service_role | |
| `fraud_logs` | FORCE | REVOKE ALL + service_role | |
| `invite_nonces` | FORCE | REVOKE ALL + service_role | |
| `invite_rate_limit` | FORCE | REVOKE ALL + service_role | |
| `plans` | FORCE | SELECT (authenticated, anon) | Readonly |
| `profile_backups` | FORCE | SELECT/INSERT/UPDATE (owner) | 90 dias retenção |
| `stripe_events` | FORCE | REVOKE ALL + service_role | Idempotência |
| `login_lockouts` | FORCE | REVOKE ALL + service_role | |

## Dependências npm

| Pacote | Versão | Tipo | Status |
|--------|--------|------|--------|
| `@supabase/supabase-js` | ^2.49.2 | runtime | ✅ Ativo |
| `vite` | ^8.0.10 | dev | ✅ Build tool |
| `terser` | ^5.31.0 | dev | ✅ Minificador |
| `esbuild` | ^0.28.0 | dev | ✅ Bundler |

**Recomendação:** `npm audit --audit-level=moderate` mensalmente.

## Variáveis de Ambiente

| Variável | Onde | Exposição | Notas |
|----------|------|-----------|-------|
| `SUPABASE_URL` | Vercel + frontend | Pública | By design (anon key) |
| `SUPABASE_ANON_KEY` | Vercel + frontend | Pública | By design (RLS protege) |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel + Supabase secrets | PRIVADA | Nunca no frontend ✅ |
| `STRIPE_SECRET_KEY` | Supabase secrets APENAS | PRIVADA | Nunca na Vercel ✅ |
| `STRIPE_WEBHOOK_SECRET` | Supabase secrets | PRIVADA | |
| `CAKTO_WEBHOOK_SECRET` | Supabase secrets | PRIVADA | |
| `PROXY_SECRET` | Vercel + Supabase secrets | PRIVADA | Compartilhado servidor→servidor |
| `RESEND_API_KEY` | Supabase secrets | PRIVADA | |
| `UPSTASH_REDIS_REST_URL` | Vercel | PRIVADA | Opcional (rate limit distribuído) |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel | PRIVADA | Opcional |
| `SECURITY_ALERT_EMAIL` | Vercel | PRIVADA | Opcional (alertas) |
| `GOOGLE_RECAPTCHA_SECRET_KEY` | Supabase secrets | PRIVADA | |
