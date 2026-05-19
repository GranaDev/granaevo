# GranaEvo — Mapa de Arquivos da Auditoria
Data: 2026-05-19

## Arquivos de API (Vercel Serverless)
| Arquivo | Funcao |
|---------|--------|
| api/check-user-access.js | Proxy para check-user-access EF |
| api/check-email.js | Proxy para check-email-status EF |
| api/create-account.js | Proxy para create-user-account EF |
| api/queue-email.js | Fila de emails via QStash |
| api/reset-password.js | Proxy unificado reset de senha |
| api/send-guest-invite.js | Proxy para send-guest-invite EF |
| api/stripe.js | Proxy unificado Stripe |
| api/upload-profile-photo.js | Proxy para upload de foto |
| api/verify-invite.js | Proxy para verify-guest-invite EF |
| api/verify-recaptcha.js | Proxy para verify-recaptcha EF |
| api/csp-report.js | Endpoint de relatorio CSP |
| api/_rate-limit.js | Modulo de rate limiting (Redis + in-memory) |
| api/_alert.js | Modulo de rastreamento de eventos de seguranca |

## Edge Functions (Supabase Deno)
27 funcoes mapeadas — principais auditadas: check-user-access, get-user-data, save-user-data,
send-guest-invite, verify-guest-invite, upload-profile-photo.

## Migrations SQL (33 arquivos, ordem cronologica)
Periodo: 20260417 a 20260519.
Migration mais recente: 20260519000001_guest_rls_policies.sql

## Frontend (src/scripts — 20 arquivos)
Principal: auth-guard.js, supabase-client.js, data-manager.js, dashboard.js, convidados.js.

## Configuracoes
- vercel.json: headers de seguranca completos (CSP por rota, HSTS, X-Frame-Options, etc.)
- vite.config.js: sourcemap=false, drop_console=true em producao
- .env.local: nao commitado (confirmado por .gitignore implicito)