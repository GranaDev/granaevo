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
| 8 | Log de auditoria interno | Ação, timestamp, user_id, tamanho e hash dos dados (**sem IP e sem User-Agent** — colunas existem no schema mas estão **nulas em 100%** das 19.796 linhas, verificado em 2026-07-16) | Usuários | Segurança e diagnóstico | **Legítimo interesse (IX)** | Supabase | EUA | **6 meses** (imutável, purga automática — cron `purge-audit-log-retention`) |
| 9 | Aceite de termos | E-mail, IP, UA, versão, data | Usuários | Prova de consentimento | Execução de contrato (V) | Supabase | EUA | Vida da conta |
| 10 | Notificações push (opcional) | Endpoint/chaves push | Usuários que optam | Enviar notificações | Consentimento (I) | Supabase, serviços de push do navegador | EUA | 180d inativo |
| 11 | E-mails transacionais | E-mail, nome | Usuários | Boas-vindas/reset/avisos | Consentimento (I) / Contrato (V) | Resend (envio) | EUA | Efêmero |
| 12 | Proteção contra bots | Sinais técnicos do navegador durante a verificação (**sem cookie de rastreamento, sem rastreio entre sites**) | Visitantes de login, cadastro e redefinição de senha | Anti-bot | Legítimo interesse (IX) | **Cloudflare Turnstile** (substituiu o Google reCAPTCHA em 2026-07-27) | EUA | Conforme Cloudflare |
| 13 | **Aparelhos reconhecidos** | Identificador técnico derivado do aparelho (`device_hash`) + rótulo curto de navegador/SO (ex.: "Chrome no Windows"). **Sem** modelo, IMEI, localização ou ID de publicidade | Usuários | Avisar o titular quando a conta é acessada de um aparelho novo | Legítimo interesse (IX) — segurança da conta do próprio titular | Supabase (armazenamento), Resend (envio do aviso) | EUA | Vida da conta (apagado junto com ela); exportável em Configurações → Privacidade |
| 14 | **Recebimento de e-mails** | Endereço do remetente e o conteúdo que a própria pessoa escrever | Quem nos escreve em @granaevo.com | Receber contato de privacidade/suporte | Legítimo interesse (IX) / Contrato (V) | **ImprovMX** | **França (UE)** | Conforme ImprovMX; encaminhado e não armazenado por nós |

## 3. Salvaguardas de transferência internacional (art. 33)
Cláusulas contratuais padrão constantes dos DPAs firmados com cada operador (Supabase, Stripe,
Vercel, Cloudflare, Anthropic, Sentry, Resend, Upstash, ImprovMX). Ver `docs/compliance/DPAs.md`
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
audit log 6m. **As tabelas** têm FK ON DELETE CASCADE para auth.users, exceto os legados da Cakto (integração
encerrada em 2026-05-21), agora **sem PII**: `subscriptions_cakto_archive` (e-mail/nome/CPF/telefone
anonimizados) e `payment_events` (payloads de webhook redigidos; cron mensal `granaevo-purge-payment-events-pii`).
Não há novos registros nessas tabelas.

> ⚠️ **O que a cascata NÃO alcança — corrigido em 2026-08-21, registrado para não repetir.**
>
> Até esta data esta seção dizia "**Todas** com FK ON DELETE CASCADE para auth.users". A
> frase era verdadeira para tabelas e **falsa para o produto**: as **fotos de perfil** ficam
> em `storage.objects`, que **não tem FK** para `auth.users` — o vínculo com o dono é o
> *nome do arquivo* (`<user_id>/<timestamp>.ext`). Cascata não segue nome de arquivo.
>
> O efeito medido em 2026-08-21: **35 de 44 objetos**, em **14 de 16 pastas**, pertenciam a
> titulares já excluídos — o mais antigo havia **7 meses**, enquanto `termos.html` prometia
> que a exclusão removia "inclusive fotografias".
>
> Eram **quatro** os caminhos que apagavam usuário e nenhum tocava o bucket: a edge
> `delete-account` (corrigida e publicada, v12) e os três crons de purga — que são **SQL
> puro e não conseguem chamar a Storage API**. Para os crons, a varredura por
> `public.listar_fotos_orfas()` não é rede de segurança: é o único caminho possível.
>
> **A regra que fica:** ao afirmar cobertura de descarte, diga de qual *tipo de repositório*
> a garantia vale. `ON DELETE CASCADE` é propriedade do **tipo tabela**; todo dado que não
> é linha — objeto de Storage, chave em cache, arquivo em bucket, registro num SaaS externo
> — fica de fora por construção, e a checagem "as FKs estão certas?" passa em verde para
> sempre sem nunca olhar para ele.

## 7. Histórico de revisões
| Data | Versão | Mudança |
|---|---|---|
| 2026-08-21 | 1.3 | **Auditoria God Mode + God Eyes.** §6: corrigida a afirmação de que "todas" as tabelas têm CASCADE — verdadeira para tabelas, mas as **fotos de perfil** vivem em `storage.objects`, sem FK, e nenhum dos 4 caminhos de exclusão as alcançava (35 objetos órfãos de 14 titulares, o mais antigo de 09/01). Documentada a regra de método para não repetir. Publicados também nos documentos ao titular os operadores que já constavam aqui mas faltavam em `termos.html` (6 dos 10) e os **serviços de push**, que constavam na atividade nº 10 e em nenhum documento público. |
| 2026-07-07 | 1.0 | Criação. Inclui assistente IA (Anthropic) e diagnóstico (Sentry). |
| 2026-07-31 | 1.2 | **Turnstile substitui o Google reCAPTCHA** (nº 12 — o Google deixa de ser operador). Duas atividades que existiam no código e faltavam aqui: **nº 13 aparelhos reconhecidos** (`user_devices`, base do alerta de login novo) e **nº 14 recebimento de e-mails** (ImprovMX, França/UE — 1º operador fora dos EUA). Corrigido também que **não usamos o Cloudflare Insights**: a análise de tráfego é bloqueada pela CSP do próprio site, e estava declarada como se acontecesse. |
| 2026-07-12 | 1.1 | DPAs firmados (com SCCs); DPO "Equipe GranaEvo"; canais privacidade@/suporte@/contato@; retenção Anthropic confirmada (30d); redação de PII legada Cakto (`payment_events` + `subscriptions_cakto_archive`); Resend/Upstash na política. Pós-auditoria /god-mode. |
