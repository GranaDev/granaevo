# Bateria de testes — RF-09 + Reserva v2 (Fases 1, 2 e 3)

_2026-07-24. Rode tudo de uma vez; anote o que falhar (referencie o nº do item). A gente
conserta aos poucos. Pré-condição geral: aguarde o deploy da Vercel do commit `ce826a1`
ficar **verde**. O edge `user-data-backup` já foi deployado._

**Conta ideal:** plano **Família**, 2 membros logando separados (M1 dono, M2 convidado),
4 perfis (A, B, C, D) com dados distintos e reconhecíveis (ex.: transações "MARCA-A 111",
"MARCA-B 222"…). Onde não tiver conta família, o que der para testar em conta individual
está marcado com _(individual OK)_.

---

## FASE 1 — Restauração POR PERFIL (a dor nº 1)

> Objetivo: restaurar um perfil **não** pode reverter os outros.

- [ ] **1.1** Anote os dados atuais de A, B, C, D.
- [ ] **1.2** No perfil **A**, adicione "MARCA-A NOVA 999". No perfil **B**, "MARCA-B NOVA 888".
- [ ] **1.3** No perfil **A**: Configurações → Dados e Backup → **Histórico de Backups** →
      escolha um backup **anterior** às marcas novas → **Restaurar**.
      - Esperado na tela de confirmação: _"O perfil **A** será restaurado… Os outros perfis
        da conta **não são afetados**."_ (copy nova).
- [ ] **1.4** Após recarregar, **no perfil A**: "MARCA-A NOVA 999" **sumiu** (voltou ao backup). ✅
- [ ] **1.5** **CRÍTICO** — entre em **B**: "MARCA-B NOVA 888" **continua lá** (NÃO reverteu). ✅
- [ ] **1.6** Entre em **C** e **D**: continuam exatamente como estavam. ✅
- [ ] **1.7** _(família)_ **M2 (convidado)** loga, entra num perfil dele, restaura um backup.
      Só aquele perfil volta; os perfis de M1 não mudam.
- [ ] **1.8** **Perfil ausente no backup**: crie um perfil **E** novo (depois do último backup),
      entre nele e tente restaurar um backup que não o contém. Esperado: erro claro
      _"Este perfil não existe nesse backup"_, sem quebrar nada.
- [ ] **1.9** _(individual OK)_ Restauração comum de um perfil funciona e recarrega a tela.

**Se 1.5/1.6 falharem (outros perfis reverteram):** é o bug central — me avise na hora, NÃO
faça mais restaurações; o backup dos outros perfis ainda está guardado.

---

## FASE 2 — viagem / horas-vida por perfil (blindagem)

> Objetivo: cada perfil tem sua viagem/horas-vida; a troca de perfil não vaza nem apaga.
> _(A lógica já tem 12 testes automáticos; aqui é o smoke manual.)_

- [ ] **2.1** No perfil **A**, ative **Modo Viagem** (uma janela de datas). No perfil **B**, ative
      **Horas de Vida** (um valor/hora), mas **não** ative viagem em B.
- [ ] **2.2** Troque A → B → A algumas vezes. Esperado:
      - A **sempre** mostra a viagem de A (banner correto), **sem** horas-vida de B.
      - B **sempre** mostra horas-vida, **sem** a viagem de A. _(era o bug 2026-07-19)_
- [ ] **2.3** Recarregue a página (F5) estando em A: a viagem de A **persiste** (não sumiu no save).
- [ ] **2.4** _(individual OK)_ Ative viagem, dê F5: persiste. Desative: some. Reative com hora de
      início: o custo respeita a HORA (não conta o dia inteiro).

---

## FASE 3 — Reserva compartilhada v2: convite → aceite _(família/casal)_

> Objetivo: ao criar uma reserva compartilhada, os outros perfis **recebem um convite** e
> decidem **aceitar/recusar**. Enquanto não aceitam, não veem a reserva como sua nem
> contribuem. _(Não há push: o convite aparece ao entrar no perfil convidado.)_

- [ ] **3.1** No perfil **A**, crie uma **Reserva** e marque **👥 Compartilhada**; no roster,
      selecione **B** (e C, se quiser). Salve.
- [ ] **3.2** Ainda em **A**: a reserva aparece normalmente (A é o criador, já aceito). A pode
      guardar/retirar nela.
- [ ] **3.3** Entre no perfil **B** → aba **Reservas**. Esperado: um **banner no topo**
      _"👥 Convite de reserva compartilhada — «A» quer criar a reserva «…» com você"_ com
      **Aceitar** / **Recusar**.
- [ ] **3.4** Em **B**, **antes de aceitar**: a reserva **não** aparece como card normal e B
      **não** consegue guardar/retirar nela (não participa ainda).
- [ ] **3.5** Clique **Aceitar** em B. Esperado: banner some, a reserva passa a aparecer como
      card normal, e B consegue guardar/retirar. Dê F5 — continua aceita.
- [ ] **3.6** _(perfil C, se convidou)_ Entre em **C** e clique **Recusar**. Esperado: banner
      some, a reserva **não** aparece para C. Dê F5 — não volta o convite.
- [ ] **3.7** **Atribuição** (quem colocou/tirou): A guarda R$X, B guarda R$Y. Nos detalhes da
      reserva, a trilha mostra os dois corretamente (fluxo já existente).
- [ ] **3.8** **Edição não apaga convite em voo**: convide **D**; sem D aceitar, edite a reserva
      em A (mude o objetivo) e salve. Entre em **D**: o convite **ainda está lá**.
- [ ] **3.9** **Reserva compartilhada antiga** (criada antes desta versão, se houver): continua
      visível para quem já participava, sem exigir aceite (compatibilidade).

---

## Regressão rápida (não pode ter quebrado)

- [ ] **R.1** Criar/editar/excluir uma reserva **normal** (não compartilhada) funciona.
- [ ] **R.2** Guardar/retirar numa reserva normal atualiza o saldo do dashboard.
- [ ] **R.3** Reset de perfil (Configurações) continua só o perfil ativo; cria o safety-backup.
- [ ] **R.4** Trocar de perfil não trava salvamento (edite algo, troque, volte, F5: persistiu).

---

## O que ficou de fora (proposital, para depois)

- **Push do convite**: por ora o convite aparece ao **entrar no perfil convidado** (sem
  notificação push). Push exigiria um edge (a policy de `radar_notifications` só deixa o
  usuário inserir notificação para si mesmo) — fica para uma próxima fase, se você quiser.
- **Badge de convites** na aba Reservas: o helper de contagem já existe (`contarConvitesPendentes`),
  só falta pendurar o número no menu — posso fazer quando quiser.
- **Divergência cosmética** "7 dias" vs "5 dias" de retenção de backup na UI (o real são 5).
