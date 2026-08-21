# Plano de Resposta a Incidentes de Segurança / Vazamento de Dados
**Controlador:** GranaEvo · **Base:** LGPD art. 48 · **Versão:** 1.0 — 2026-07-07
**Responsável:** privacidade@granaevo.com

> Documento interno. Objetivo: reagir rápido e corretamente a incidentes com dados pessoais,
> e cumprir o dever de comunicar a ANPD e os titulares em prazo razoável (art. 48).

## O que conta como incidente
Qualquer evento que possa comprometer confidencialidade, integridade ou disponibilidade de dados
pessoais: vazamento, acesso indevido, perda/corrupção de dados, ransomware, vazamento de secret
(service_role, STRIPE_SECRET, ANTHROPIC_API_KEY, PROXY_SECRET, DATA_ENCRYPTION_KEY), exploração de
vulnerabilidade, ou falha que exponha dados de um usuário a outro.

## Fluxo em 5 passos

### 1. DETECTAR e registrar (imediato)
- Fontes: alertas do Sentry, `cron-health-alert`, logs do Supabase/Vercel, relato de usuário, aviso de terceiro.
- Abrir um registro no **Registro de Incidentes** (seção abaixo) com data/hora, quem detectou, o que se sabe.

### 2. CONTER (primeiras horas)
- Vazou secret? **Revogar/rotacionar imediatamente** (ver `SECURITY.md` e o passo a passo de rotação). Ex.:
  regenerar service_role no Supabase, `STRIPE_SECRET_KEY` no Stripe, `ANTHROPIC_API_KEY`, `PROXY_SECRET`.
- Acesso indevido a conta? Revogar sessões do(s) usuário(s) afetado(s).
- Falha explorável? Desabilitar o endpoint/feature afetada (feature_flag) até corrigir.
- Preservar evidências (logs) antes de qualquer limpeza.

### 3. AVALIAR o risco
- Quais dados? Quantos titulares? Dado financeiro/sensível envolvido? Estava cifrado?
- Classificar gravidade: **Baixa** (sem exposição real / dado cifrado inacessível) · **Média** (exposição limitada) · **Alta** (dado pessoal exposto a terceiro, risco a titulares).

### 4. NOTIFICAR (se risco relevante — art. 48)
- **ANPD:** comunicar em prazo razoável (referência da ANPD: até ~3 dias úteis da ciência) via canal oficial gov.br/anpd. Incluir: natureza dos dados, titulares afetados, medidas técnicas, riscos, medidas adotadas/propostas.
- **Titulares afetados:** e-mail claro (o que aconteceu, quais dados, o que fazer — ex.: trocar senha, revisar Stripe), sem juridiquês.
- **Guardar prova** das comunicações.

### 5. CORRIGIR e aprender
- Aplicar correção definitiva (migration/patch); rodar `/god-mode`/`/god-eyes` na área afetada.
- Post-mortem curto: causa-raiz, como evitar recorrência, o que melhorar na detecção.
- Fechar o registro do incidente.

## Contatos e recursos
- **ANPD:** gov.br/anpd · **Encarregado:** privacidade@granaevo.com
- **Rotação de secrets:** `SECURITY.md` · **Auditoria:** `/god-mode`, `/god-eyes`
- **Backups/recuperação:** snapshots diários cifrados (`user_data_snapshots`, 5d) + backups de perfil (90d).

## Registro de Incidentes (append-only)
> ⚠️ **Este registro é versionado no git, num repositório público.** Não escreva aqui
> e-mail, `user_id`, CPF ou qualquer identificador direto de titular — registrar um
> incidente de privacidade criando uma exposição nova é o pior desfecho possível.
> Use uma referência interna e mantenha a identificação fora do repositório.

| Data/hora | Detectado por | Descrição | Dados/titulares | Gravidade | ANPD notificada? | Titulares notificados? | Correção | Status |
|---|---|---|---|---|---|---|---|---|
| 2026-06-23 | Titular afetado (relato direto ao desenvolvedor) | **Perda de dados (wipe), não vazamento.** `loadUserData()` devolvia estrutura vazia em qualquer falha transitória (token/HTTP/timeout/rede); o auto-save de 30s e o POST de `beforeunload` então gravavam o perfil VAZIO por cima do banco. O guard antigo só barrava "zero perfis", não perfil esvaziado. Restaurar backup não resolvia: restaurava → recarregava → load falhava → reapagava. | **1 titular.** Dados financeiros próprios (transações, contas fixas, cartões, metas). **Sem acesso por terceiro em nenhum momento** — nenhum dado saiu do ambiente. | **Relevante** — perda total de disponibilidade e integridade para o titular | ⏳ **avaliação pendente** — ver nota abaixo | ✅ Sim — o titular foi quem reportou e acompanhou toda a recuperação | **1)** Guard anti-wipe no cliente (`e3daa82`). **2)** Como o navegador do titular rodava bundle/Service Worker antigo e reapagou, foi necessário guard **autoritativo no servidor** em `save-user-data`, que decifra o registro atual e rejeita com `409 WIPE_BLOCKED` qualquer save que esvaziaria perfil com dados (`abc2c33`) — imune à versão do cliente. **3)** Restauração pelo snapshot cifrado de 2026-06-20 (22.091 bytes; o vivo estava em 1.231). | ✅ **Fechado** — dados recuperados e confirmados pelo titular |

> **Nota sobre a notificação à ANPD (art. 48) — pendente de decisão do controlador.**
> O incidente foi de **disponibilidade/integridade**, não de confidencialidade: não houve
> acesso não autorizado e nenhum dado saiu do ambiente. O art. 48 exige comunicação
> quando o incidente "possa acarretar risco ou dano relevante aos titulares" — e a perda
> total dos dados de um titular é dano relevante, ainda que ele tenha sido recuperado
> integralmente no mesmo dia e acompanhado o processo.
>
> O registro fica com a avaliação **explicitamente em aberto** em vez de marcada como
> "não aplicável": a decisão é do controlador, e um registro que afirma uma conclusão
> jurídica que ninguém tomou vale menos do que um que admite a lacuna.
> Registrado retroativamente em 2026-08-21, na auditoria LGPD (achado A-10).

## Histórico de revisões
| Data | Versão | Mudança |
|---|---|---|
| 2026-07-07 | 1.0 | Criação (God Eyes / remediação LGPD). |
| 2026-08-21 | 1.1 | Registro retroativo do incidente de perda de dados de 2026-06-23 (achado A-10: o registro estava vazio apesar de um incidente conhecido e já corrigido). Aviso de PII no topo do registro — o arquivo é versionado em repositório público. |
