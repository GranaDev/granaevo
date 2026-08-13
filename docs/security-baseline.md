# GranaEvo — Security Baseline

> Substitui o placar de "nota X/10". Nota agregada cria uma sensação matemática
> falsa: some a diferença entre "nenhum achado" e "não procurei". Aqui cada
> controle carrega o seu próprio estado e a **data da última validação**.

**Última atualização:** 2026-08-13 (re-validação pós-freeze)

---

## Contadores

```
CRITICAL   0
HIGH       0
MEDIUM     0     (2 corrigidos em 2026-08-13)
LOW        0     (1 corrigido em 2026-08-13)
INFO       documentados abaixo
```

---

## Controles críticos

| Controle | Estado | Última validação | Como foi provado |
|---|---|---|---|
| RLS | VERIFIED | 2026-08-13 | 30/30 tabelas com RLS **e** `FORCE`; consulta a `pg_class.relrowsecurity` em prod |
| Grants | VERIFIED | 2026-08-13 | Matriz `anon`/`authenticated` por tabela; escrita do cliente só em 4 tabelas, todas com policy `auth.uid()` |
| SECURITY DEFINER | VERIFIED | 2026-08-13 | 36 funções; só `can_create_profile` e `mfa_pendente` alcançáveis por `authenticated`; `anon` = zero |
| `search_path` | VERIFIED | 2026-08-13 | 49/49 funções com `search_path` fixado |
| Views | VERIFIED | 2026-08-13 | Única view (`active_profile_backups`) com `security_invoker=true` |
| Realtime | VERIFIED | 2026-08-13 | `supabase_realtime` sem tabelas publicadas — só broadcast |
| Auth/MFA | VERIFIED | 2026-08-13 | Policies restritivas `exige_aal2` nas 4 tabelas graváveis; `mfaBloqueia` nas edges |
| Sessões | VERIFIED | 2026-08-11 | `revogar_sessoes_usuario` + cascade em `auth.sessions` (SEC-008) |
| Secret isolation | VERIFIED | 2026-08-13 | 26 env vars listadas por nome/alvo na Vercel; Preview sem `PROXY_SECRET`, `CRON_SECRET`, `DATA_ENCRYPTION_KEY`, `UPSTASH_*`, `RESEND_API_KEY`. Zero segredo no `dist/`, zero source map próprio, gitleaks no CI com histórico completo |
| Anti-bot | VERIFIED | 2026-08-13 | `TURNSTILE_SECRET_KEY` presente em Production (Vercel API, sem `decrypt`); token ausente/malformado → rejeitado |
| Rate limit (config) | VERIFIED | 2026-08-13 | Upstash presente em Production; `RATE_LIMIT_STRICT` derruba o boot se sumir |
| Rate limit (comportamento) | **NOT VERIFIED** | — | Exige ambiente dedicado; ver FASE B |
| Backup | VERIFIED | 2026-08-12 | Dump cifrado AES-256 + `privilegios.sql` + verificação de decifragem + R2 |
| Restore | VERIFIED | 2026-08-12 | Ensaio E2E com login. **Não reexecutado** em 2026-08-13 (rodada read-only) — não é regressão |
| Vercel Preview | VERIFIED | 2026-08-12 | Deployment Protection; previews antigos removidos; bypass de origem → 403 |
| Headers | VERIFIED | 2026-08-13 | CSP `script-src 'self'` sem `unsafe-inline`/`unsafe-eval`; HSTS preload 2a; `frame-ancestors 'none'`; COOP/CORP |
| XSS | VERIFIED | 2026-08-13 | Sinks passam por `sanitizeHTML` (entidades) ou `sanitizarHTMLPopup` (DOMParser + whitelist CSS + `on*` removido); CSP como segunda camada |
| IA / prompt injection | VERIFIED | 2026-08-13 | Tool-use forçado com enum travado; nenhum texto do modelo chega ao usuário; injeção indireta por rótulo neutralizada |
| Upload | VERIFIED | 2026-08-13 | MIME allowlist + magic bytes + EXIF stripping + limite nos dois níveis; GIF excluído (polyglot) |
| Dependências | VERIFIED | 2026-08-13 | `npm audit --omit=dev` → 0 vulnerabilidades |
| Testes | VERIFIED | 2026-08-13 | **1571/1571 testes executados passaram**; 3 skipped documentados (sinal — só POSIX). Nunca escrever "1574/1574 PASS": skip não é pass |

---

## Lockout de login — tabela de estados (decisão arquitetural explícita)

Uma camada **não pode mascarar silenciosamente a falha da outra**. Os três
estados são decididos, não emergentes:

```
                  tentativa de login
                          │
                ┌─────────┴─────────┐
                ↓                   ↓
             Redis                Banco
           principal            backstop
                │                   │
                └─────────┬─────────┘
                          ↓
                  decisão de auth
```

| Estado | Condição | Comportamento |
|---|---|---|
| 1 | Redis ok | Proteção do Redis (5/10/20, janela 24 h). Banco **não** é consultado — caminho feliz sem salto extra |
| 2 | Redis degradado, banco responde | Banco decide. `redisDegradado()` detecta sem round-trip extra |
| 3 | **Redis degradado E banco mudo** | **Captcha exigido incondicionalmente** + `logger.error('lockout_sem_camada')` |

**Escrita é sempre nas duas.** O backstop precisa *chegar* na queda com o
histórico pronto — começar a contar do zero no pior momento não é backstop.

**Por que o estado 3 não bloqueia o login de vez:** uma queda simultânea de
Upstash e da edge trancaria todos os clientes pagantes para fora da própria
conta. Degradar para um provedor **independente** (Cloudflare/Turnstile) mantém
uma defesa real sem transformar indisponibilidade em outage. Se um dia o captcha
for a única camada restante, esta decisão precisa ser revista junto.

**Por que o alarme não usa `trackSecurityEvent`:** aquele caminho começa com
`if (!REDIS_URL || !REDIS_TOKEN) return` e conta no próprio Redis. Usá-lo para
avisar que o Redis caiu criaria mais um controle incapaz de disparar justamente
quando importa. O alarme é `logger.error` → stdout → Vercel Logs.

---

## Resíduos aceitos (exceções, não pendências)

Cada um destes é uma **decisão**, não um item de backlog. Não devem reabrir
discussão sem fato novo.

| Resíduo | Por que é aceito |
|---|---|
| JWT stateless válido ≤ 1 h após revogação | Natureza do JWT. Encurtar o TTL troca segurança por carga no refresh. |
| RPO ~24 h | Backup diário. PITR custaria plano superior sem receita que o justifique. |
| RTO completo do SaaS não medido | Só o RTO do banco foi medido (~1,3 min). O do produto inteiro depende de Vercel/Supabase. |
| Turnstile fail-open em queda da Cloudflare | Deliberado: token ausente/malformado é rejeitado; só indisponibilidade de terceiro passa. Lockout e rate limit por IP seguem valendo. |
| Windows: "Finalizar tarefa" pode deixar dump em claro | `TerminateProcess` não é interceptável. Mitigação é o destino ficar fora do repo e de pasta sincronizada. |
| Lockout por conta permite DoS de terceiro | Progressivo, começa em 15 min, e a recuperação de senha continua funcionando. A alternativa (sem lockout) é pior. |
| `radar_update_own_dismiss` com `polroles={}` (TO PUBLIC) | Inalcançável: `anon` não tem o grant de coluna, e `auth.uid()` NULL reprova o predicado. Inconsistência cosmética. |

---

## Contrato de auditoria

**Nenhuma auditoria completa nova é executada por rotina.**

Uma auditoria completa só abre com um destes gatilhos:

1. mudança arquitetural
2. novo requisito regulatório ou de produto
3. incidente
4. nova dependência crítica
5. achado concreto

### O ciclo de toda alteração

```
código
  ↓
suíte completa (1568+)
  ↓
security regression
  ↓
testes específicos do componente alterado
  ↓
deploy
  ↓
smoke test
```

### Quando algo quebra

```
NOVO ACHADO → abre exceção ao freeze → corrige → teste de regressão → fecha
```

A exceção é **do escopo do achado**, não do freeze inteiro.

---

## Por que não "10/10"

Uma nota agregada responde "quanto tirei?". A pergunta útil é
**"este controle específico consegue disparar, e quando foi a última vez que
alguém provou isso?"**

As três correções de 2026-08-13 vieram exatamente daí. Nas três o controle
existia e estava escrito certo — o que faltava era a ligação:

- o lockout tinha tabela, RPC e cron, e **nenhum escritor**;
- o rate limit tinha a chave certa, derivada de uma identidade **que ninguém
  verificou**;
- a limpeza do dump cobria `exit` e **não cobria sinal**.

Nenhum apareceria numa varredura que pergunta *"existe proteção?"*. Os três
aparecem quando se pergunta *"essa proteção consegue disparar?"*.
