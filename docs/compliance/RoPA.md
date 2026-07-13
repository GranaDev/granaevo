# RoPA — Registro das Operações de Tratamento de Dados Pessoais
**Controlador:** GranaEvo · **Base:** LGPD (Lei 13.709/2018), art. 37 · **Versão:** 1.0 — 2026-07-07
**Encarregado (DPO):** Equipe GranaEvo · privacidade@granaevo.com

> Documento interno (não publicado no site). Mantê-lo atualizado sempre que mudar coleta,
> finalidade, operador, retenção ou base legal. Serve como evidência de conformidade à ANPD.

## 1. Identificação
- **Controlador:** GranaEvo (SaaS de finanças pessoais). Contato: privacidade@granaevo.com.
- **Encarregado/DPO:** Equipe GranaEvo · privacidade@granaevo.com. (Agente de pequeno porte — canal de contato nos termos da Res. CD/ANPD nº 2/2022; dispensada a indicação de pessoa natural.)
- **Natureza:** dados inseridos manualmente pelo titular; sem Open Finance/scraping.

## 2. Registro das operações (por atividade de tratamento)

| # | Atividade | Dados pessoais | Titulares | Finalidade | Base legal (art. 7º) | Operadores | Transf. internacional | Retenção |
|---|---|---|---|---|---|---|---|---|
| 1 | Cadastro e autenticação | E-mail, senha (hash bcrypt), tokens JWT | Usuários | Criar/acessar conta | Execução de contrato (V) | Supabase | EUA (Supabase/AWS) | Vida da conta + 90d |
| 2 | Gestão de perfil | Nome do perfil, foto (sem EXIF), plano | Usuários | Personalização/serviço | Execução de contrato (V) | Supabase | EUA | Vida da conta + 90d |
| 3 | Dados financeiros | Transações, contas, cartões (nome/banco), metas, rendas — **cifrados AES-256-GCM por usuário** | Usuários | Núcleo do serviço | Execução de contrato (V) | Supabase | EUA | Vida da conta + 90d; snapshot 5d |
| 4 | Assinatura e pagamento | ID Stripe, status, histórico (sem cartão) | Usuários pagantes | Cobrança | Execução de contrato (V) | Stripe | EUA | Vida da conta + 90d |
| 5 | **Assistente por IA** | Texto da mensagem + rótulos não sensíveis (**sem** id/e-mail/saldos) | Usuários que usam o assistente | Interpretar comando em linguagem natural | Execução de contrato (V) | **Anthropic** | **EUA** | Retenção padrão até 30d (só segurança, não treino), sob DPA+SCCs; ZDR só p/ enterprise |
| 6 | **Diagnóstico de erros** | Pseudônimo de sessão, plano, detalhes do erro (**sem** dados financeiros) | Usuários (em caso de falha) | Corrigir bugs/estabilidade | Legítimo interesse (IX) | **Sentry** | **EUA** (ou UE, se região migrada) | Conforme retenção do Sentry |
| 7 | Segurança/anti-abuso | IP, User-Agent, chave de sessão | Usuários/visitantes | Rate limit, anti-fraude | Legítimo interesse (IX) | Supabase, Cloudflare, Upstash | EUA | Rate limit: efêmero |
| 8 | Log de auditoria/acesso | IP, User-Agent, ação, timestamp, user_id | Usuários | Segurança + Marco Civil | Obrigação legal (II) / Leg. interesse (IX) | Supabase | EUA | **6 meses** (imutável, purga automática) |
| 9 | Aceite de termos | E-mail, IP, UA, versão, data | Usuários | Prova de consentimento | Execução de contrato (V) | Supabase | EUA | Vida da conta |
| 10 | Notificações push (opcional) | Endpoint/chaves push | Usuários que optam | Enviar notificações | Consentimento (I) | Supabase, serviços de push do navegador | EUA | 180d inativo |
| 11 | E-mails transacionais | E-mail, nome | Usuários | Boas-vindas/reset/avisos | Consentimento (I) / Contrato (V) | Resend (envio) | EUA | Efêmero |
| 12 | Proteção contra bots | Sinais comportamentais (reCAPTCHA) | Visitantes do login | Anti-bot | Legítimo interesse (IX) | Google | EUA | Conforme Google |

## 3. Salvaguardas de transferência internacional (art. 33)
Cláusulas contratuais padrão constantes dos DPAs firmados com cada operador (Supabase, Stripe,
Vercel, Cloudflare, Anthropic, Sentry, Google, Resend, Upstash). Ver `docs/compliance/DPAs.md`
(checklist de assinatura). Padrões de segurança: SOC 2, ISO 27001, GDPR.

## 4. Medidas de segurança (art. 46)
Criptografia em repouso (AES-256) e em trânsito (TLS 1.2+); camada extra AES-256-GCM por usuário
nos dados financeiros; RLS em 100% das tabelas; senhas em bcrypt; refresh token em cookie HttpOnly;
audit log imutável; rate limiting; CSP estrito; upload com validação de assinatura + strip de EXIF/GPS.

## 5. Direitos do titular (art. 18) — como são atendidos
- **Acesso/portabilidade:** exportação JSON no app.
- **Correção:** edição in-app.
- **Eliminação:** exclusão self-service (`delete-account`) e/ou por e-mail; purga automática 90d após cancelamento.
- **Canal:** privacidade@granaevo.com — resposta em até 15 dias (art. 19).

## 6. Ciclo de vida / descarte
Purga automática (pg_cron): contas canceladas 90d, não-pagas, abandonadas; snapshots 5d; backups 90d;
audit log 6m. Todas com FK ON DELETE CASCADE para auth.users, exceto os legados da Cakto (integração
encerrada em 2026-05-21), agora **sem PII**: `subscriptions_cakto_archive` (e-mail/nome/CPF/telefone
anonimizados) e `payment_events` (payloads de webhook redigidos; cron mensal `granaevo-purge-payment-events-pii`).
Não há novos registros nessas tabelas.

## 7. Histórico de revisões
| Data | Versão | Mudança |
|---|---|---|
| 2026-07-07 | 1.0 | Criação. Inclui assistente IA (Anthropic) e diagnóstico (Sentry). |
| 2026-07-12 | 1.1 | DPAs firmados (com SCCs); DPO "Equipe GranaEvo"; canais privacidade@/suporte@/contato@; retenção Anthropic confirmada (30d); redação de PII legada Cakto (`payment_events` + `subscriptions_cakto_archive`); Resend/Upstash na política. Pós-auditoria /god-mode. |
