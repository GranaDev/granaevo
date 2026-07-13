# Checklist de DPAs (Acordos de Tratamento de Dados)
Rastreamento das cláusulas contratuais de proteção de dados firmadas com cada operador.
Guardar uma cópia (PDF/print) de cada DPA numa pasta segura — é prova de conformidade (art. 33/39 LGPD).

| Operador | Papel | DPA firmado? | ZDR / região | Onde | Data | Cópia guardada? |
|---|---|---|---|---|---|---|
| **Anthropic** | Assistente por IA | ✅ auto via Commercial Terms + **SCCs** | ❌ ZDR só enterprise → **retenção padrão 30d** (só segurança, NÃO treino) | anthropic.com/legal/data-processing-addendum | 2026-07-12 | ✅ PDF salvo |
| **Sentry** | Diagnóstico de erros | ✅ v5.1.0 firmado | US (UE opcional) | Org Settings → Legal | 2026-07-12 | ✅ PDF salvo |
| Supabase | Banco + Auth | ✅ via Termos + **SCCs** | AWS us-east-1 (SCCs cobrem) | supabase.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Stripe | Pagamentos | ✅ via SSA | — | stripe.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Vercel | Hospedagem | ✅ via Termos (Pro/Ent) | — | vercel.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Cloudflare | CDN/segurança | ✅ aplicado por padrão | — | cloudflare.com/cloudflare-customer-dpa | 2026-07-12 | ✅ PDF salvo |
| Google (reCAPTCHA) | Anti-bot | ✅ coberto via Termos Google | — | políticas Google | 2026-07-12 | n/a (sem DPA avulso) |
| Resend | Envio de e-mail | ✅ via ToS + SCCs/DPF | — | resend.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Upstash | Rate limit (Redis) | ✅ via ToS + SCCs/DPF | — | upstash.com/trust/dpa.pdf | 2026-07-12 | ✅ PDF salvo |

**Prioridade real:** Anthropic (+ ZDR) e Sentry exigem ação. Os demais normalmente já têm DPA
aplicado via Termos de Serviço — só confirmar e guardar cópia.
