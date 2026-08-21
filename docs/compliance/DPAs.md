# Checklist de DPAs (Acordos de Tratamento de Dados)
Rastreamento das cláusulas contratuais de proteção de dados firmadas com cada operador.
Guardar uma cópia (PDF/print) de cada DPA numa pasta segura — é prova de conformidade (art. 33/39 LGPD).

> **Revisão 2026-08-21** (auditoria God Mode + God Eyes). O documento estava parado em
> 2026-07-12 e havia divergido da realidade em três pontos: listava Google/reCAPTCHA, que
> foi **substituído pelo Turnstile em 2026-07-27**; não tinha **ImprovMX**, que é o
> **único operador na União Europeia**; e não tinha os **serviços de push**.
>
> ⚠️ Isso importa porque `privacidade.html:275` e `:297` afirmam ao titular que o
> tratamento é regido por cláusulas contratuais padrão "firmadas com **cada** operador".
> Uma afirmação dessas precisa de lastro documental linha a linha — senão o documento
> promete mais do que o registro comprova, que é achado de conformidade por si só.

| Operador | Papel | DPA firmado? | ZDR / região | Onde | Data | Cópia guardada? |
|---|---|---|---|---|---|---|
| **Anthropic** | Assistente por IA | ✅ auto via Commercial Terms + **SCCs** | ❌ ZDR só enterprise → **retenção padrão 30d** (só segurança, NÃO treino) | anthropic.com/legal/data-processing-addendum | 2026-07-12 | ✅ PDF salvo |
| **Sentry** | Diagnóstico de erros | ✅ v5.1.0 firmado | US (UE opcional) | Org Settings → Legal | 2026-07-12 | ✅ PDF salvo |
| Supabase | Banco + Auth | ✅ via Termos + **SCCs** | AWS us-east-1 (SCCs cobrem) | supabase.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Stripe | Pagamentos | ✅ via SSA | — | stripe.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Vercel | Hospedagem | ✅ via Termos (Pro/Ent) | — | vercel.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Cloudflare | CDN/segurança | ✅ aplicado por padrão | — | cloudflare.com/cloudflare-customer-dpa | 2026-07-12 | ✅ PDF salvo |
| **Cloudflare Turnstile** | Anti-bot (login/cadastro/reset) | ✅ **coberto pelo DPA da Cloudflare** — mesmo fornecedor, mesmo contrato | — | cloudflare.com/cloudflare-customer-dpa | 2026-08-21 | ✅ (mesma cópia da Cloudflare) |
| Resend | Envio de e-mail | ✅ via ToS + SCCs/DPF | — | resend.com/legal/dpa | 2026-07-12 | ✅ PDF salvo |
| Upstash | Rate limit (Redis) | ✅ via ToS + SCCs/DPF | — | upstash.com/trust/dpa.pdf | 2026-07-12 | ✅ PDF salvo |
| **ImprovMX** | Recebimento de e-mail `@granaevo.com` | ⚠️ **PENDENTE — ação necessária** | 🇫🇷 **França (UE)** — único operador fora dos EUA | improvmx.com/privacy · solicitar DPA ao suporte | — | ❌ **não** |

## Serviços de notificação push — natureza distinta, registrar como infraestrutura

Entram em cena **apenas se o titular ativar as notificações**, e **qual deles** é usado
depende do navegador/sistema do aparelho — não é escolha do GranaEvo. Recebem o endereço
técnico de entrega e o momento do envio; **não conseguem ler o conteúdo**, que trafega
com criptografia de ponta a ponta (Web Push, chaves `p256dh`/`auth` que só o aparelho tem).

Não existe DPA avulso a assinar com nenhum deles — a relação é de infraestrutura de
transporte, coberta pelos termos da plataforma do usuário final. Registrados aqui para o
inventário ficar completo e bater com `privacidade.html`.

| Serviço | Quando é usado | DPA |
|---|---|---|
| Google (Firebase Cloud Messaging) | Chrome / Android | n/a — sem DPA avulso |
| Mozilla Push Service | Firefox | n/a — sem DPA avulso |
| Apple Push Notification service | Safari / iOS | n/a — sem DPA avulso |
| Microsoft (WNS) | Edge / Windows | n/a — sem DPA avulso |

Endpoints aceitos estão travados por CHECK constraint no banco
(`20260817010000_sec002_push_endpoint_allowlist.sql`) — nenhum outro destino é possível.

## ❌ Removido

| Operador | Motivo |
|---|---|
| ~~Google (reCAPTCHA)~~ | **Substituído pelo Cloudflare Turnstile em 2026-07-27**, justamente para tirar um rastreador de terceiro do caminho de quem faz login. Não há mais nenhuma chamada ao reCAPTCHA no código. Constava neste checklist por 25 dias depois de já não existir no produto. |

---

## ⚠️ Ação necessária — só o titular do contrato pode fazer

**ImprovMX (art. 33 da LGPD).** É o único operador na União Europeia e o único sem
lastro de DPA. Enquanto isso não for resolvido, `privacidade.html:297` afirma uma
salvaguarda que o registro não comprova.

1. Acessar improvmx.com → conta → suporte, e **solicitar o DPA** (ou verificar se os
   Terms of Service já incluem cláusulas de tratamento com SCCs).
2. Guardar o PDF junto com as outras cópias.
3. Preencher a linha da tabela acima com a data.

Se o ImprovMX **não** oferecer DPA, há duas saídas honestas — e a segunda é preferível a
manter no ar uma afirmação sem lastro:
- trocar o encaminhamento de e-mail por um operador que ofereça DPA; **ou**
- ajustar `privacidade.html:275` e `:297` para descrever a salvaguarda real de cada
  operador em vez de afirmar DPA para todos indistintamente.
