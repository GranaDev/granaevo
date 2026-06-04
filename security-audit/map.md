# Security Audit — Mapa do Codebase
Data: 2026-06-04 (God Mode + God Eyes Ultra)

## Rotas de API (Vercel Serverless Functions)
| Arquivo | Auth | Rate Limit | Status |
|---------|------|-----------|--------|
| api/stripe.js | JWT (autenticado) / público (checkout) | ✅ Redis+memory | Auditado |
| api/user-data.js | JWT obrigatório | ✅ Redis+memory | Auditado |
| api/upload-profile-photo.js | JWT obrigatório | ✅ Redis distribuído | Auditado |
| api/send-guest-invite.js | JWT obrigatório | ✅ 5/min IP | Auditado |
| api/check-user-access.js | JWT obrigatório | ✅ 20/min IP | Auditado |
| api/create-account.js | Público | ✅ 3/hora IP | Auditado |
| api/reset-password.js | Público | ✅ 3-10/min IP | Auditado |
| api/check-email.js | Público | n/a | Auditado (parcial) |
| api/accept-terms.js | n/a | n/a | Não auditado — proxy simples |
| api/verify-recaptcha.js | Público | n/a | Não auditado — proxy simples |
| api/verify-invite.js | Público | n/a | Não auditado — proxy simples |
| api/queue-email.js | n/a | n/a | Não auditado |
| api/_rate-limit.js | (módulo) | — | Auditado |
| api/_logger.js | (módulo) | — | Auditado — sanitização anti-CRLF |
| api/_alert.js | (módulo) | — | Auditado parcial |

## Edge Functions (Supabase)
| Função | Auth | PROXY_SECRET | Status |
|--------|------|-------------|--------|
| check-user-access | auth.getUser(JWT) | ✅ timingSafeEqual | Auditado |
| save-user-data | auth.getUser(JWT) | ✅ timingSafeEqual | Auditado |
| get-user-data | auth.getUser(JWT) | ✅ timingSafeEqual | Auditado |
| create-user-account | PROXY_SECRET only | ✅ timingSafeEqual | Auditado |
| webhook-stripe | HMAC-SHA256 Stripe | — | Auditado |
| upload-profile-photo | auth.getUser(JWT) | ✅ timingSafeEqual | Auditado |
| save-push-subscription | auth.getUser(JWT) | ⚠️ impl. diferente | Auditado — ver MED-02, MED-03 |
| delete-push-subscription | auth.getUser(JWT) | n/a | Parcial |
| verify-guest-invite | PROXY_SECRET | ✅ timingSafeEqual | Auditado |
| create-stripe-checkout | PROXY_SECRET+JWT op. | n/a | Não auditado |
| stripe-portal | auth.getUser(JWT) | n/a | Não auditado |
| update-stripe-plan | auth.getUser(JWT) | n/a | Não auditado |
| verify-and-reset-password | PROXY_SECRET | n/a | Não auditado |

## Arquivos .env*
| Arquivo | Commitado? | Risco |
|---------|-----------|-------|
| .env.local | ❌ gitignore (.env.*) | VERCEL_OIDC_TOKEN expirado presente — ver LOW-02 |

## Migrations Supabase (52 arquivos)
- RLS habilitada em todas as tabelas de dados
- Políticas SELECT/INSERT/UPDATE/DELETE com WITH CHECK
- Funções SECURITY DEFINER com SET search_path
- Cron jobs para limpeza de lockouts, rate limits, nonces
- stripe_events para idempotência de webhooks
- feature_flags com SECURITY INVOKER

## Frontend
- supabase-client.js: armazenamento dinâmico (localStorage/sessionStorage conforme "lembrar")
- auth-guard.js: fingerprint HMAC-SHA256, rate limit, subscription check, safe redirect
- Todos os redirects passam por SafeRedirect._isSafe() com blocklist de esquemas
