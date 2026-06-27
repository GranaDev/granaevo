# /god-eyes — Auditoria Completa de Segurança

Execute este protocolo inteiro, em ordem, sem pular etapas.
Escopo: todo o codebase local + Supabase (via MCP) + variáveis de ambiente.

---

## FASE 0 — PRÉ-VOO: ACESSO AO SUPABASE

Antes de tudo, confirme que o servidor MCP do Supabase está conectado (read-only).
Setup completo em `.claude/SUPABASE_MCP_SETUP.md`.

1. Verifique se as ferramentas `mcp__supabase__*` estão disponíveis nesta sessão.
2. Se NÃO estiverem:
   - Avise o desenvolvedor que o acesso ao banco não está ativo e mostre os passos
     de `.claude/SUPABASE_MCP_SETUP.md` (gerar token → `setx` → reiniciar editor → `/mcp`).
   - **Nunca** peça nem aceite o token colado no chat. Ele mora só em variável de
     ambiente do Windows; o repositório jamais o contém.
   - Rode então apenas as fases que não dependem do banco (1, 3) e marque as demais
     como BLOQUEADAS por falta de acesso ao banco.
3. Se estiverem: prossiga com todas as fases.

---

## FASE 1 — MAPEAMENTO

Antes de qualquer análise:

1. Liste todos os arquivos do projeto:
   find . -type f \
     -not -path "*/node_modules/*" \
     -not -path "*/.git/*" \
     -not -path "*/.next/*"

2. Identifique e liste:
   - Todas as rotas de API (api/)
   - Todas as Edge Functions / Supabase Functions
   - Todos os arquivos com acesso ao banco (supabase.from, createClient)
   - Todos os arquivos .env* presentes no projeto
   - Todos os schemas e migrations do Supabase

3. Salve o mapa em: security-audit/map.md

---

## FASE 2 — AUDITORIA RLS (execute via Supabase MCP)

> **Passo profundo (recomendado):** delegue esta fase ao subagente
> `supabase-rls-auditor`, que roda uma bateria estendida (USING(true) frouxo,
> grants a anon/authenticated, search_path em SECURITY DEFINER, drift vs migrations,
> advisors nativos) e escreve `security-audit/rls-deep-findings.md`. As queries
> abaixo são o piso mínimo caso rode inline.

Rode cada query abaixo e documente o resultado.

### 2.1 — Tabelas sem RLS habilitado (CRÍTICO se retornar linhas)
```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity ASC;
```

### 2.2 — Tabelas com RLS ativo mas sem nenhuma política
```sql
SELECT t.tablename
FROM pg_tables t
LEFT JOIN pg_policies p
  ON t.tablename = p.tablename AND t.schemaname = p.schemaname
WHERE t.schemaname = 'public'
  AND t.rowsecurity = true
  AND p.policyname IS NULL;
```

### 2.3 — Todas as políticas existentes (revisar cada uma)
```sql
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;
```

### 2.4 — UPDATE sem WITH CHECK (permite alterar user_id — CRÍTICO)
```sql
SELECT tablename, policyname, cmd, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd = 'UPDATE'
  AND (with_check IS NULL OR with_check = '');
```

### 2.5 — Views sem security_invoker (bypassam RLS silenciosamente)
```sql
SELECT viewname, definition
FROM pg_views
WHERE schemaname = 'public';
```
Para cada view retornada, verificar se contém: WITH (security_invoker = true)

### 2.6 — Funções SECURITY DEFINER (potencial escalada de privilégios)
```sql
SELECT routine_name, security_type, routine_definition
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND security_type = 'DEFINER';
```

### 2.7 — Tabelas expostas no Realtime sem RLS validado
```sql
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';
```
Cruzar com resultado da query 2.1 — toda tabela no Realtime deve ter RLS.

### 2.8 — Buckets de Storage e suas políticas
```sql
SELECT id, name, public FROM storage.buckets;
SELECT bucket_id, name, definition FROM storage.policies;
```
Buckets public = true devem ser auditados com atenção.

### 2.9 — Permissões concedidas ao role anon
```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon'
ORDER BY table_name;
```

Para cada resultado da Fase 2:
- Classificar: CRÍTICO / ALTO / MÉDIO / BAIXO
- Gerar a migration SQL corretora
- Salvar em: security-audit/rls-findings.md

---

## FASE 2B — CRON JOBS E TRIGGERS (execute via Supabase MCP)

Delegue ao subagente `supabase-cron-trigger-auditor` (ou rode inline as queries dele).
Objetivo: nenhum job morto/falhando, nenhum trigger de validação desconectado,
nenhuma rotina de retenção/limpeza ausente.

Mínimo inline:
```sql
-- jobs agendados
SELECT jobid, schedule, command, active, jobname FROM cron.job ORDER BY jobid;
-- execuções recentes que falharam
SELECT j.jobname, r.status, r.return_message, r.start_time
FROM cron.job_run_details r JOIN cron.job j ON j.jobid=r.jobid
WHERE r.start_time > now() - interval '14 days' AND r.status='failed'
ORDER BY r.start_time DESC;
-- triggers
SELECT event_object_table AS tabela, trigger_name, action_timing,
       event_manipulation AS evento, action_statement
FROM information_schema.triggers
WHERE event_object_schema IN ('public','auth','storage')
ORDER BY event_object_table;
```
Verifique especificamente: trigger de limite de perfis está atrelado à tabela certa?
Job de expiração de backups roda? Existe rotina de retenção do `financial_audit_log`?

Classifique cada achado e salve em: security-audit/cron-trigger-findings.md

---

## FASE 2C — CONFORMIDADE LGPD (execute via Supabase MCP + docs + código)

Delegue ao subagente `lgpd-compliance-auditor`. É a fase mais minuciosa: ele monta o
inventário de dados pessoais, checa base legal/consentimento, minimização, direitos do
titular (acesso/correção/eliminação/portabilidade), retenção e descarte, segurança,
transferência internacional, registro de operações (RoPA) e documentos legais.

Saída obrigatória: security-audit/lgpd-findings.md com inventário + matriz de
conformidade por eixo + riscos jurídicos priorizados. Marque toda correção como PENDENTE.

---

## FASE 3 — ANÁLISE ESTÁTICA DO CODEBASE

Leia cada arquivo identificado no mapeamento e verifique:

### Autenticação e autorização
- Existe endpoint de API que não verifica auth antes de executar lógica?
- Existe endpoint que confia em user_id vindo do body/query em vez de extrair do token?
- Existe uso de supabase.auth.admin em arquivo carregado no browser?
- Existe verificação de role/permissão feita apenas no frontend?

### Secrets e variáveis de ambiente
- Existe variável de ambiente exposta ao browser que deveria ser privada?
- Existe API key, token ou secret hardcoded em qualquer arquivo?
- Existe arquivo .env* que não está no .gitignore?
- O .gitignore está bloqueando .env, .env.local, .env.production?

### Validação de input
- Existe endpoint que usa dados do body/query sem validação?
- Existe query SQL construída com string interpolation ou template literal?
- Existe uso de innerHTML com dados não sanitizados?
- Existe redirect que aceita URL vinda do usuário sem validar domínio?

### Rate limiting
- Endpoints de auth (login, signup, reset de senha) têm rate limit?
- Endpoints de criação de recurso têm rate limit?
- Endpoints públicos têm rate limit?

### Headers e configuração
- vercel.json define headers de segurança (CSP, HSTS, X-Frame-Options)?
- Cookies de sessão têm HttpOnly + Secure + SameSite?

Para cada problema encontrado:
- Descrever o arquivo, linha e o problema exato
- Gerar a correção
- Salvar em: security-audit/code-findings.md

---

## FASE 4 — CORREÇÕES

Para cada item classificado como CRÍTICO ou ALTO nas Fases 2 e 3:

1. Gerar o código/migration corretora completo
2. Explicar o que estava errado e por que a correção resolve
3. Indicar como testar que a correção funciona
4. Marcar como PENDENTE DE APLICAÇÃO pelo desenvolvedor (não aplicar automaticamente em produção)

Salvar todas as correções em: security-audit/fixes.md

---

## FASE 5 — RELATÓRIO FINAL

Salvar em: security-audit/god-eyes-REPORT.md

```
# God Eyes — Relatório de Segurança
Data: [data atual]

## Score estimado de segurança
(descontar 20pts por CRÍTICO, 10 por ALTO, 3 por MÉDIO)
Score: XX/100 — [CRÍTICO / ALTO / MÉDIO / BOM / EXCELENTE]

## Resumo
- Tabelas auditadas: N
- Problemas RLS encontrados: N (X críticos, Y altos, Z médios)
- Cron jobs auditados: N (mortos: X, falhando: Y, retenção ausente: Z)
- Triggers auditados: N (desconectados/inseguros: X)
- LGPD: nota de conformidade XX — eixos NÃO-CONFORME: N
- Problemas no código encontrados: N
- Secrets/variáveis expostos: N
- Endpoints sem rate limit: N

## Conformidade LGPD (resumo da Fase 2C)
- Inventário de dados pessoais: ver security-audit/lgpd-findings.md
- Riscos jurídicos críticos: [lista]
- Disclaimer: auditoria técnica, não substitui parecer jurídico.

## Itens Críticos (corrigir imediatamente)
[lista — inclui achados de RLS, Cron/Trigger e LGPD]

## Itens Altos (corrigir antes do próximo deploy)
[lista]

## Itens Médios (corrigir no próximo sprint)
[lista]

## Recomendações adicionais
[lista priorizada]
```

---

## REGRAS DE EXECUÇÃO
- Executar todas as fases em ordem
- Não pular nenhuma query SQL da Fase 2
- Não pular nenhuma verificação da Fase 3
- Documentar TODOS os achados, mesmo os que já estão corretos
- O relatório final é obrigatório mesmo se nenhum problema for encontrado
- Nunca aplicar correção em produção sem sinalizar claramente ao desenvolvedor
