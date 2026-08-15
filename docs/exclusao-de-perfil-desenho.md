# Exclusão de perfil — desenho

Decisões tomadas com o dono em 2026-08-15. Este documento é o contrato: o que
for implementado diferente daqui precisa de decisão nova, não de improviso.

---

## 1. Decisões fechadas

| Ponto | Decisão | Por quê |
|---|---|---|
| Quem exclui | **Só o dono da conta** | Convidado apagando perfil de outro é dano sem dono. Autorização no servidor, contra `stripe_subscriptions.user_id` |
| Onde fica | **Configurações do perfil**, ao lado de "Resetar Perfil" | Exclui-se o perfil em que se está |
| Destino após excluir | **Tela de seleção de perfis** | É onde vai ficar o botão de restaurar — o usuário vê que dá para desfazer |
| Último perfil | **Pode ser excluído** | "Quero limpar e recomeçar sem perder a conta" é caso legítimo, e bloquear empurraria para a exclusão total, que é mais destrutiva |
| Reservas compartilhadas | **Sai da reserva, valor fica** + notifica os demais com ação de ajustar saldo | Reusa "sair da reserva" e o ajuste de saldo, ambos já existentes |
| Retenção | **7 dias**, com contagem visível | |

### LGPD — por que 7 dias de backup é conforme

Art. 18, VI garante a eliminação. Backup por prazo curto e determinado antes da
eliminação definitiva é legítimo desde que: (a) o titular seja informado — é o
aviso prévio; (b) o prazo seja limitado e razoável — 7 dias, exibidos na tela;
(c) a eliminação seja efetiva ao fim — o cron zera o conteúdo.

O projeto **já faz isso** para downgrade de plano: `profile_backups` guarda o
perfil e `granaevo-expire-profile-backups` zera a PII depois
(`member_data = '{}'`, `member_name = '[Excluído]'`).

---

## 2. A regra do limite de perfis — o ponto mais delicado

Hoje `enforce_profile_limit_stripe` (AFTER INSERT em `profiles`) conta:

```sql
SELECT COUNT(*) FROM public.profiles WHERE user_id = NEW.user_id;
```

**Todas as linhas, sem filtrar `is_active`.** Isso quebra "excluir libera vaga".

Mas simplesmente passar a contar só ativos abre o furo que o dono quer evitar:
excluir 3 e criar 3 daria 6 perfis num plano de 4, com os 3 antigos ainda
restauráveis.

**A regra é assimétrica, e é o coração do desenho:**

| Operação | Conta o quê | Efeito |
|---|---|---|
| **Criar** perfil | só `is_active = true` | excluir libera vaga na hora |
| **Restaurar** perfil | `is_active = true` **+ o que está voltando** | se estourar, recusa: "exclua outro perfil antes" |

O limite nunca é burlado, porque a soma final é sempre verificada **no momento
em que o perfil volta a existir**. Um perfil inativo não ocupa vaga, mas também
não pode voltar se não houver vaga.

---

## 3. Estado de um perfil

```
ativo ──[excluir]──> inativo + backup (7 dias) ──[expira]──> conteúdo apagado
                          │
                          └──[restaurar, se houver vaga]──> ativo
```

Sem tabela nova. `profiles.is_active = false` marca o excluído;
`profile_backups` guarda o conteúdo com `backup_expires_at = now() + 7 dias`.

Campos de `profile_backups` no fluxo de exclusão voluntária:

| Campo | Valor |
|---|---|
| `source_table` | `'profiles'` |
| `original_member_id` | `profiles.id::text` |
| `member_data` | snapshot do perfil **vindo do blob**, não da tabela |
| `backup_expires_at` | `now() + interval '7 days'` |
| `status` | `'active'` |
| `original_plan` / `target_plan` | plano atual nos dois — não é downgrade |
| `scheduled_removal_at` | `now()` — a remoção é imediata, não agendada |

> ⚠️ O conteúdo do perfil vive no **blob cifrado** (`user_data.data_json`), não
> em `profiles`. O backup precisa do slot do blob, e só a edge consegue
> decifrar. Ver `_restore-core.js` (RF-09).

---

## 4. Fluxo de exclusão

1. Configurações → "Excluir perfil"
2. **Popup 1 — aviso:** "ESTA AÇÃO NÃO POSSUI REVERSÃO APÓS 7 DIAS. Todos os
   dados deste perfil serão removidos." Lista o que será perdido, com as
   contagens reais: transações, metas e reservas, contas fixas, cartões,
   orçamentos, tipos personalizados, conquistas.
3. **Popup 2 — confirmação:** botão "Sim, eu desejo excluir este perfil"
4. Cliente chama `POST /api/user-data { action: 'delete-profile', profile_id }`
5. **Servidor** (é aqui que tudo é decidido — nada do cliente é confiado):
   - autentica o JWT (`getUser`, assinatura ES256 real)
   - **autoriza**: o requisitante é o DONO da conta?
   - valida `profile_id` (forma + pertence a esta conta)
   - salva o blob atual e **fotografa** (`snapshot_sob_demanda`)
   - copia o slot do perfil para `profile_backups` (7 dias)
   - remove o perfil do blob e das reservas compartilhadas
   - `UPDATE profiles SET is_active = false`
   - enfileira notificação aos demais membros das reservas afetadas
6. Cliente vai para a seleção de perfis

**Transacional:** o `UPDATE` de `profiles` e a escrita do backup ficam na mesma
RPC. O blob é outra história (é um `UPDATE` em `user_data`), então a ordem é:
**backup primeiro, blob depois, `is_active` por último** — falha em qualquer
ponto deixa o perfil vivo, nunca o contrário.

---

## 5. Fluxo de restauração

Botão "Restaurar um perfil excluído" na tela de seleção, visível só quando
existe backup válido. Mostra nome e **contagem regressiva** até a exclusão
permanente.

Ao confirmar, o servidor:
1. autentica e autoriza (dono)
2. confere o backup: existe, `status='active'`, `backup_expires_at > now()`,
   pertence a esta conta
3. **confere a vaga**: `ativos + 1 <= limite do plano` → se estourar, devolve
   `PROFILE_LIMIT_REACHED` e o cliente exibe: "Você já atingiu o limite de
   perfis. Exclua um perfil antes de restaurar este."
4. devolve o slot ao blob, reativa (`is_active = true`), marca o backup como
   consumido

---

## 6. Segurança — o que blindar e como

| Vetor | Defesa |
|---|---|
| **Autorização** | Dono verificado no servidor contra `stripe_subscriptions`/`account_members`. Nada de confiar em `isOwner` vindo do cliente |
| **IDOR** | `profile_id` sempre validado como pertencente à conta do JWT. Um id de outra conta devolve 404, não 403 (não confirma existência) |
| **SQL Injection** | Só RPC com parâmetros tipados (`p_profile_id text`). Zero concatenação. `SET search_path` fixado em toda DEFINER |
| **Blind SQL Injection** | Mesma defesa; e as respostas de erro são genéricas e de tempo constante — não vazam por diferença de mensagem nem de latência |
| **XSS** | Nome do perfil entra por `textContent`, nunca `innerHTML`. O popup lista contagens (números), não conteúdo do usuário |
| **JWT** | `supabaseAdmin.auth.getUser(token)` — verifica assinatura contra o JWKS a cada requisição. Gate de MFA aplicado, como em `save-user-data` |
| **Prompt injection** | Não se aplica: nenhum caminho desta feature passa por LLM. Nome de perfil nunca entra em prompt |
| **CSRF** | O proxy já exige `Origin` + `Sec-Fetch-*`; a edge exige `x-proxy-secret` |
| **Rate limit** | Por IP e por usuário. Exclusão é ação rara: 5/hora basta e não atrapalha ninguém |
| **Replay / duplo clique** | A RPC é idempotente: perfil já inativo devolve sucesso sem criar segundo backup |
| **Escalada por restore** | O limite é conferido **no servidor** no momento da restauração, com a soma final |
| **Perda de dados** | Falha fechada: sem backup gravado, o perfil não é desativado |

---

## 7. Onde cada peça vive

| Camada | Arquivo | O quê |
|---|---|---|
| Banco | `migrations/2026081521xxxx_exclusao_de_perfil.sql` | RPCs `excluir_perfil` / `restaurar_perfil` / `listar_perfis_excluidos`; ajuste do trigger de limite; índice em `profile_backups` |
| Edge | `supabase/functions/user-data-backup/index.ts` | ações `delete-profile`, `restore-profile`, `list-deleted-profiles` (reusa a função que já decifra o blob) |
| Proxy | `api/user-data.js` | roteia as 3 ações com rate limit próprio — **sem criar arquivo novo** (teto de 12 funções da Vercel) |
| Cliente | `db-configuracoes.js` | botão + 2 popups + chamada |
| Cliente | `dashboard.js` | botão "Restaurar perfil excluído" na seleção, com contagem |
| Cliente | `reserva-familia.js` | remoção do perfil das reservas + notificação |

> ⚠️ `api/` está em 10/12 rotas. **Nenhum arquivo novo lá** — a 13ª função
> congela produção em silêncio (ver `vercel_12_funcoes_congela_prod`).

---

## 8. Ordem de implementação

1. **Migration** — RPCs + ajuste do trigger + índice. Aplicar e verificar
2. **Edge** — as 3 ações, falha fechada
3. **Proxy** — roteamento + rate limit
4. **Cliente** — popups, botão de restaurar, remoção das reservas
5. **Testes** — unitários + prova por mutação, suíte inteira verde
6. **Deploy** na ordem banco → edge → cliente
7. **Bateria** de testes manuais

Cada etapa é commitável sozinha e não quebra o que está no ar: enquanto o
cliente não chamar, as RPCs e ações novas ficam inertes.
