/**
 * EXCLUSÃO DE PERFIL COM JANELA DE 7 DIAS.
 *
 * Desenho e decisões: docs/exclusao-de-perfil-desenho.md
 *
 * As duas invariantes que este arquivo existe para proteger:
 *
 *   1. A REGRA ASSIMÉTRICA DO LIMITE. Criar conta só perfis ativos (para que
 *      excluir libere vaga na hora); restaurar confere `ativos + 1 <= limite`
 *      (para que ninguém burle o teto do plano excluindo e recriando). Uma
 *      metade sem a outra é um furo: contar só ativos, sozinho, permitiria
 *      excluir 3, criar 3 e ficar com 6 perfis num plano de 4 — com os 3
 *      antigos ainda restauráveis.
 *
 *   2. A ORDEM CONTRA PERDA. Backup primeiro, blob depois, desativar por
 *      último. Falha em qualquer ponto deixa o perfil VIVO, nunca o contrário.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const soCodigo = (t) => t.split('\n')
  .filter((l) => {
    const s = l.trim()
    return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || s.startsWith('--'))
  })
  .join('\n')

const bloco = (src, ini, fim) => {
  const i = src.indexOf(ini); assert.ok(i !== -1, `não achei o início: ${ini}`)
  const j = src.indexOf(fim, i); assert.ok(j > i, `não achei o fim: ${fim}`)
  return src.slice(i, j)
}

const MIGR  = readFileSync(join(RAIZ, 'supabase/migrations/20260815210000_exclusao_de_perfil.sql'), 'utf8')
const EDGE  = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/user-data-backup/index.ts'), 'utf8'))
const PROXY = soCodigo(readFileSync(join(RAIZ, 'api/user-data.js'), 'utf8'))

let core
before(async () => {
  core = await import('../../supabase/functions/user-data-backup/_restore-core.js')
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a regra ASSIMÉTRICA do limite de perfis', () => {
  test('CRIAR conta só perfis ativos — senão excluir não libera vaga', () => {
    const fn = bloco(MIGR, 'FUNCTION public.enforce_profile_limit_stripe', 'FUNCTION public.limite_de_perfis')
    assert.match(
      fn,
      /WHERE user_id = NEW\.user_id AND is_active = true/,
      'o trigger voltou a contar perfis excluídos: excluir deixaria de liberar vaga',
    )
  })

  test('⭐ RESTAURAR confere a vaga — é o que impede burlar o plano', () => {
    const fn = bloco(MIGR, 'FUNCTION public.restaurar_perfil', 'idx_profile_backups_restauraveis')
    assert.match(fn, /v_ativos \+ 1 > v_limite/,
      'sumiu a checagem de vaga: excluir 3 e criar 3 daria 6 perfis num plano de 4')
    assert.match(fn, /PROFILE_LIMIT_REACHED/)
    // Sob lock: sem ele, duas restaurações simultâneas passariam as duas.
    assert.match(fn, /pg_advisory_xact_lock/,
      'sem o lock, duas restaurações ao mesmo tempo furam o limite juntas')
  })

  test('o limite vem de UMA fonte só', () => {
    // Duas cópias da regra de plano divergiriam, e é ela que decide se alguém
    // passa do teto pago.
    assert.match(MIGR, /FUNCTION public\.limite_de_perfis/)
    const restore = bloco(MIGR, 'FUNCTION public.restaurar_perfil', 'idx_profile_backups')
    assert.match(restore, /public\.limite_de_perfis\(p_user_id\)/,
      'a restauração passou a calcular o limite por conta própria')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ a ordem contra perda de dados', () => {
  const fluxo = () => bloco(EDGE, "if (body.action === 'delete-profile')", "if (body.action === 'restore-profile')")

  test('backup ANTES de mexer no blob e no perfil', () => {
    const t = fluxo()
    const iBackup = t.indexOf("rpc('excluir_perfil'")
    const iBlob   = t.indexOf('.update({ data_json')
    const iDesat  = t.indexOf("rpc('desativar_perfil'")
    assert.ok(iBackup > 0 && iBlob > iBackup,
      'o blob passou a ser regravado antes do backup: uma falha ali perde o perfil')
    assert.ok(iDesat > iBlob,
      'desativar passou a vir antes de gravar o blob')
  })

  test('desativar FALHA FECHADA: sem backup válido, o perfil não sai do ar', () => {
    const fn = bloco(MIGR, 'FUNCTION public.desativar_perfil', 'FUNCTION public.listar_perfis_excluidos')
    assert.match(fn, /IF NOT EXISTS \([\s\S]*?profile_backups[\s\S]*?RETURN false;/,
      'passou a desativar sem conferir se existe backup — é o defeito do reset de novo')
  })

  test('restaurar NÃO consome o backup — dá para tentar de novo', () => {
    const fn = bloco(MIGR, 'FUNCTION public.restaurar_perfil', 'idx_profile_backups')
    assert.doesNotMatch(fn, /UPDATE public\.profile_backups/,
      'passou a consumir o backup: se a escrita do blob falhar, o perfil volta vazio e sem rede')
  })

  test('excluir é IDEMPOTENTE — duplo clique não cria segundo backup', () => {
    const fn = bloco(MIGR, 'FUNCTION public.excluir_perfil', 'FUNCTION public.desativar_perfil')
    assert.match(fn, /IF v_perfil\.is_active = false THEN/,
      'sem esta saída, o 2º clique sobrescreveria o backup bom com dados já removidos')
    assert.match(fn, /'ja_excluido', true/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ autorização e superfície de ataque', () => {
  test('SÓ O DONO — convidado leva 403', () => {
    const t = bloco(EDGE, 'const ACOES_DE_PERFIL', "if (body.action === 'list-deleted-profiles')")
    assert.match(t, /if \(memberEntry\?\.owner_user_id\) \{/,
      'sumiu a porta do dono: um membro de conta família apagaria o perfil de outro')
    assert.match(t, /\}, 403, cors\)/)
  })

  test('profile_id validado por forma antes de qualquer uso', () => {
    // Numérico e curto. Nunca entra em SQL por concatenação — vai como
    // parâmetro tipado para a RPC, então SQLi e blind SQLi não têm superfície.
    assert.match(EDGE, /\/\^\\d\{1,12\}\$\/\.test\(profileId\)/,
      'a validação de forma do profile_id sumiu da edge')
    assert.match(PROXY, /\/\^\\d\{1,12\}\$\/\.test\(parsed\.profile_id\.trim\(\)\)/,
      'a validação de forma do profile_id sumiu do proxy')
  })

  test('as RPCs são inalcançáveis pelo cliente', () => {
    for (const f of ['excluir_perfil', 'desativar_perfil', 'restaurar_perfil',
                     'listar_perfis_excluidos', 'limite_de_perfis']) {
      assert.match(MIGR, new RegExp(`'public\\.${f}\\(`),
        `${f} saiu da lista de REVOKE/GRANT`)
    }
    assert.match(MIGR, /REVOKE ALL ON FUNCTION %s FROM anon/)
    assert.match(MIGR, /REVOKE ALL ON FUNCTION %s FROM authenticated/)
    assert.match(MIGR, /GRANT EXECUTE ON FUNCTION %s TO service_role/)
  })

  test('toda DEFINER com search_path fixado', () => {
    // Conta sobre o CODIGO: a migration explica a regra em comentario, e
    // contar a prosa junto acusaria um DEFINER a mais que nao existe.
    const cod = soCodigo(MIGR)
    const defs = cod.match(/SECURITY DEFINER/g) ?? []
    const paths = cod.match(/SET search_path TO 'public', 'pg_temp'/g) ?? []
    assert.ok(defs.length > 0 && paths.length >= defs.length,
      `${defs.length} SECURITY DEFINER para ${paths.length} search_path fixados`)
  })

  test('anti-IDOR: perfil de outra conta não confirma existência', () => {
    const fn = bloco(MIGR, 'FUNCTION public.excluir_perfil', 'FUNCTION public.desativar_perfil')
    assert.match(fn, /WHERE id::text = p_profile_id AND user_id = p_user_id/,
      'a busca deixou de amarrar o perfil à conta de quem pediu')
    assert.match(fn, /PERFIL_NAO_ENCONTRADO/)
  })

  test('o proxy não repassa nada além da ação e do id', () => {
    const t = bloco(PROXY, "parsed?.action === 'delete-profile'", "parsed?.action === 'snapshot'")
    assert.match(t, /corpo = \{ action: parsed\.action, profile_id: parsed\.profile_id\.trim\(\) \}/,
      'o proxy passou a repassar campos arbitrários do cliente')
  })

  test('rate limit nas três ações, mais folgado só na leitura', () => {
    const t = bloco(PROXY, "parsed?.action === 'delete-profile'", "parsed?.action === 'snapshot'")
    // 20, nao 5: o contador sobe ANTES da resposta, entao tentativa que falha
    // consome cota igual — dois bugs meus queimaram a franquia do dono e o
    // clique que ia funcionar levou 429. O abuso ja e limitado pela feature:
    // no maximo 4 perfis por conta.
    assert.match(t, /const maxHora\s*=\s*soLeitura \? 60 : 20/,
      'o teto de mexer em perfil voltou a ser apertado demais para tolerar erro')
    assert.match(t, /checkRL\(`ip:\$\{ip\}:\$\{bucket\}`/)
    assert.match(t, /checkRL\(`uid:\$\{userId\}:\$\{bucket\}`/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('o blob: sair das reservas e guardar o slot', () => {
  const perfis = () => ([
    { id: '1', nome: 'A', transacoes: [{ id: 't1' }],
      metas: [{ id: 'm1', nome: 'Casa', membros: [{ id: '1' }, { id: '2' }] }] },
    { id: '2', nome: 'B', transacoes: [{ id: 't2' }, { id: 't3' }], metas: [] },
    { id: '3', nome: 'C', metas: [{ id: 'm2', nome: 'Carro', membros: [{ id: '3' }] }] },
  ])

  test('⭐ o perfil sai das reservas dos OUTROS, e o valor fica', () => {
    const { restantes, afetadas } = core.extrairProfileSlot(perfis(), '2')
    assert.deepEqual(restantes[0].metas[0].membros, [{ id: '1' }],
      'o perfil excluído continuou membro da reserva de outro')
    assert.equal(afetadas.length, 1, 'a lista de quem notificar não bate')
    assert.equal(afetadas[0].meta, 'm1')
    // A meta continua existindo, com o valor: quem sai não leva o aporte.
    assert.equal(restantes[0].metas.length, 1)
  })

  test('o slot guardado é o perfil INTEIRO', () => {
    const { slot } = core.extrairProfileSlot(perfis(), '2')
    assert.equal(slot.nome, 'B')
    assert.equal(slot.transacoes.length, 2, 'o backup perderia as transações')
  })

  test('reserva de terceiro não é tocada', () => {
    const { restantes } = core.extrairProfileSlot(perfis(), '2')
    const c = restantes.find((p) => p.id === '3')
    assert.deepEqual(c.metas[0].membros, [{ id: '3' }])
  })

  test('⭐ perfil ausente LANÇA — o chamador aborta antes de gravar', () => {
    assert.throws(() => core.extrairProfileSlot(perfis(), '99'), /perfil_ausente_no_blob/)
  })

  test('restaurar é idempotente: não duplica o perfil no blob', async () => {
    const slot = { id: '2', nome: 'B', transacoes: [] }
    const atual = { profiles: [{ id: '1' }, { id: '2', nome: 'antigo' }] }
    const r = await core.buildBlobComPerfil({
      keyBase64: '', currentDataJson: atual, slot, userId: 'u', now: 'agora',
    })
    assert.equal(r.total, 2, 'o perfil foi duplicado no blob — origem do órfão que oscila')
    assert.equal(r.dataToStore.profiles.find((p) => p.id === '2').nome, 'B')
  })

  test('não reinscreve nas reservas ao restaurar', () => {
    // Quem saiu, saiu. Voltar a inscrever alguém numa meta compartilhada sem os
    // demais saberem seria pior que a perda — e o aporte já ficou lá.
    const fn = readFileSync(join(RAIZ, 'supabase/functions/user-data-backup/_restore-core.js'), 'utf8')
    const t = bloco(fn, 'export async function buildBlobComPerfil', '\n}')
    assert.doesNotMatch(t, /sairDasReservas|membros/,
      'a restauração passou a mexer em reservas de outros perfis')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('o cliente: duas confirmações e nenhum HTML do usuário', () => {
  const CFG  = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/db-configuracoes.js'), 'utf8'))
  const REST = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/restaurar-perfil.js'), 'utf8'))
  const DASH = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))
  const HTML = readFileSync(join(RAIZ, 'dashboard.html'), 'utf8')

  test('o botão existe e chama a função certa', () => {
    assert.match(HTML, /id="btnExcluirPerfil"/, 'o botão sumiu do HTML')
    assert.match(CFG, /getElementById\('btnExcluirPerfil'\)/, 'o botão ficou sem binding')
  })

  test('⭐ o aviso diz que NÃO tem reversão, e mostra o prazo', () => {
    const fn = bloco(CFG, 'async function excluirPerfil()', 'window.excluirPerfil')
    assert.match(fn, /ESTA AÇÃO NÃO POSSUI REVERSÃO APÓS 7 DIAS/,
      'o aviso de irreversibilidade sumiu do popup')
    assert.match(fn, /restaurá-lo por 7 dias/)
  })

  test('⭐ o botão de confirmar diz exatamente o que faz', () => {
    const fn = bloco(CFG, 'async function excluirPerfil()', 'window.excluirPerfil')
    assert.match(fn, /Sim, eu desejo excluir este perfil/,
      'voltou a ser um "Confirmar" genérico — é o que faz alguém apagar por reflexo')
  })

  test('lista o que será perdido com as contagens REAIS', () => {
    assert.match(CFG, /function _inventarioDoPerfil/)
    const inv = bloco(CFG, 'function _inventarioDoPerfil', 'async function excluirPerfil')
    for (const campo of ['transacoes', 'metas', 'contasFixas', 'cartoesCredito', 'orcamentos']) {
      assert.ok(inv.includes(campo), `${campo} saiu do inventário mostrado ao usuário`)
    }
    assert.match(inv, /filter\(\(\[, q\]\) => q > 0\)/, 'passou a listar categorias vazias')
  })

  test('⭐ XSS: nome do perfil nunca entra como HTML', () => {
    const fn = bloco(CFG, 'async function excluirPerfil()', 'window.excluirPerfil')
    // O nome é escrito pelo usuário. Todo lugar que o exibe usa textContent.
    assert.match(fn, /alertaTexto\.textContent =/)
    assert.doesNotMatch(fn, /innerHTML\s*=\s*[^;]*nomePerfil/,
      'o nome do perfil voltou a entrar por innerHTML')
    assert.doesNotMatch(REST, /innerHTML/,
      'o chunk de restauração passou a montar HTML — o nome vem do usuário')
  })

  test('salva o blob ANTES de pedir a exclusão', () => {
    // A edge tira o slot do blob guardado. Um blob velho guardaria menos do que
    // o usuário tinha na tela.
    const fn = bloco(CFG, 'async function excluirPerfil()', 'window.excluirPerfil')
    const iSalva = fn.indexOf('await _ctx.salvarDados()')
    const iFetch = fn.indexOf("action: 'delete-profile'")
    assert.ok(iSalva > 0 && iSalva < iFetch,
      'a exclusão passou a ser pedida antes de salvar: o backup perderia as últimas edições')
  })

  test('erro não deixa o usuário sem saber se perdeu tudo', () => {
    const fn = bloco(CFG, 'async function excluirPerfil()', 'window.excluirPerfil')
    assert.match(fn, /nada foi removido/i,
      'a mensagem de erro voltou a ser genérica')
  })

  test('⭐ PROFILE_LIMIT_REACHED vira instrução, não erro cru', () => {
    assert.match(REST, /PROFILE_LIMIT_REACHED/)
    assert.match(REST, /Exclua um perfil antes de restaurar este/,
      'o limite atingido voltou a ser um erro sem saída para o usuário')
  })

  test('a contagem regressiva aparece', () => {
    assert.match(REST, /function _prazoRestante/)
    assert.match(REST, /Removido definitivamente em/)
  })

  test('convidado não vê o bloco de restauração', () => {
    assert.match(REST, /_ui\.usuarioLogado\?\.isGuest/, 'sumiu a guarda de convidado no chunk')
    assert.match(DASH, /if \(!usuarioLogado\?\.isGuest\) \{/, 'o dashboard passou a carregar o chunk para convidado')
  })

  test('o chunk lazy não derruba a tela se não carregar', () => {
    const t = bloco(DASH, "import('../modules/restaurar-perfil.js", 'const nomeExibir')
    assert.match(t, /\.catch\(\(\) => \{/,
      'sem o catch, o chunk faltando (offline, janela pós-deploy) quebraria a seleção de perfis')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ quem LÊ perfis precisa filtrar is_active', () => {
  // ACHADO EM PRODUÇÃO, no primeiro teste real: o perfil era excluído no banco
  // (is_active = false, backup gravado) e continuava aparecendo na seleção — e a
  // vaga parecia nunca abrir.
  //
  // A migration mudou o SIGNIFICADO de `is_active`: antes só o cron de downgrade
  // a escrevia, agora ela marca "excluído pelo usuário". Mudar o sentido de uma
  // coluna obriga a auditar TODO caminho que a lê — e eu não fiz isso.
  const DASH = soCodigo(readFileSync(join(RAIZ, 'src/scripts/pages/dashboard.js'), 'utf8'))
  const ENG  = soCodigo(readFileSync(join(RAIZ, 'src/scripts/modules/assistant/engine.js'), 'utf8'))

  test('⭐ a lista da tela de seleção não traz perfil excluído', () => {
    // Os dois SELECT de perfis do dashboard: a lista principal e o recarregamento
    // de fotos em background. Um sem o outro deixa o perfil voltando pela janela.
    const selects = DASH.split(".from('profiles')").length - 1
    const filtros = DASH.split(".eq('is_active', true)").length - 1
    assert.ok(selects > 0, 'o dashboard deixou de ler profiles — o teste perdeu o alvo')
    assert.equal(filtros, selects,
      `${selects} leitura(s) de profiles para ${filtros} filtro(s) de is_active: ` +
      'perfil excluído volta a aparecer na seleção')
  })

  test('o assistente não sugere perfil excluído', () => {
    assert.match(ENG, /\.from\('profiles'\)[\s\S]{0,120}?\.eq\('is_active', true\)/,
      'o assistente passou a enxergar perfis excluídos ao interpretar comandos')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ o plano gravado no backup respeita o CHECK da tabela', () => {
  // ACHADO no primeiro teste real: a exclusão devolvia 500 e nada acontecia.
  //
  //   profile_backups_plan_check  CHECK (original_plan IN ('individual','casal','familia'))
  //
  // e `excluir_perfil` gravava COALESCE(plano, 'desconhecido'). A tabela nasceu
  // para o downgrade, onde os dois campos sempre têm plano real; ao reaproveitá-la
  // eu inventei um valor de preenchimento sem conferir o domínio da coluna.
  //
  // A FALHA FECHADA FUNCIONOU: o INSERT estourou ANTES de qualquer remoção, então
  // o perfil ficou intacto. Backup primeiro não é slogan.
  const FIX = soCodigo(readFileSync(join(RAIZ, 'supabase/migrations/20260815220000_fix_plano_no_backup_de_perfil.sql'), 'utf8'))

  test('⭐ nunca grava um plano fora dos três aceitos', () => {
    assert.match(FIX, /v_plano NOT IN \('individual', 'casal', 'familia'\)/,
      'voltou a aceitar qualquer valor de plan_name — o CHECK derruba o INSERT e a exclusão vira 500')
    assert.doesNotMatch(FIX, /'desconhecido'/,
      "'desconhecido' não é um plano válido no CHECK da tabela")
  })

  test('o fallback é o mesmo de limite_de_perfis (fail-closed em 1 perfil)', () => {
    // Os dois precisam contar a mesma história: sem assinatura legível, o
    // usuário é tratado como individual.
    assert.match(FIX, /v_plano := 'individual';/)
    assert.match(MIGR, /ELSE 1\s+-- fail-closed/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ excluir → restaurar → excluir de novo', () => {
  // ACHADO no SEGUNDO teste real. O erro exato do Postgres:
  //
  //   duplicate key value violates unique constraint
  //   "idx_profile_backups_active_per_member"
  //
  // O índice permite UM backup ativo por membro, e está certo. O que faltava era
  // cobrir o ciclo: minha guarda de idempotência olhava só `is_active = false`.
  // Um perfil ATIVO que já teve backup — porque foi restaurado — caía direto no
  // INSERT e batia no índice.
  //
  // E como a restauração NÃO consome o backup (de propósito, para permitir nova
  // tentativa se o blob falhar), TODO perfil restaurado carrega um backup ativo.
  // O caso não era raro: era o segundo uso da feature.
  const UP = soCodigo(readFileSync(join(RAIZ, 'supabase/migrations/20260815230000_backup_de_perfil_upsert.sql'), 'utf8'))

  test('⭐ o INSERT do backup é UPSERT no índice parcial', () => {
    assert.match(UP, /ON CONFLICT \(owner_user_id, original_member_id, source_table\)/,
      'voltou a ser INSERT puro: excluir um perfil já restaurado dá 500')
    assert.match(UP, /WHERE status IN \('pending', 'active'\)/,
      'o alvo do ON CONFLICT precisa ser o mesmo predicado do índice parcial')
    assert.match(UP, /DO UPDATE SET/)
  })

  test('substituir renova o prazo e o conteúdo', () => {
    // Quem exclui hoje quer poder desfazer a exclusão de HOJE — não uma de
    // dias atrás, com dados que já não existem.
    assert.match(UP, /member_data\s*= EXCLUDED\.member_data/)
    assert.match(UP, /backup_expires_at = EXCLUDED\.backup_expires_at/)
    assert.match(UP, /status\s*= 'active'/)
  })

  test('mas perfil JÁ excluído continua saindo cedo, sem sobrescrever', () => {
    // A idempotência do duplo clique não pode virar upsert: o 2º clique
    // gravaria o estado já esvaziado por cima do backup bom.
    const i = UP.indexOf('IF v_perfil.is_active = false THEN')
    const j = UP.indexOf('INSERT INTO public.profile_backups')
    assert.ok(i > 0 && i < j, 'a saída antecipada do perfil já excluído sumiu ou foi parar depois do INSERT')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ TODOS os lugares que contam perfis filtram is_active', () => {
  // ACHADO no teste 4: criar perfil depois de excluir dava 403 do PostgREST.
  // Era RLS — a policy `profiles_insert_own` chama `can_create_profile()`, que
  // contava TODAS as linhas.
  //
  // Era o TERCEIRO lugar que conta perfis. Eu conhecia dois. É a mesma falha
  // que cometi três vezes hoje: mudei o SIGNIFICADO de `is_active` e auditei
  // quem escreve, não quem CONTA.
  const CCP = soCodigo(readFileSync(join(RAIZ, 'supabase/migrations/20260815240000_can_create_profile_conta_ativos.sql'), 'utf8'))

  test('⭐ can_create_profile (a policy de INSERT) conta só ativos', () => {
    assert.match(CCP, /WHERE user_id = v_user_id AND is_active = true/,
      'a policy voltou a contar perfis excluídos: criar depois de excluir dá 403')
  })

  test('e usa a MESMA fonte de limite das outras duas', () => {
    // Três cópias da tabela de planos divergiriam, e é ela que decide se alguém
    // passa do teto pago.
    assert.match(CCP, /public\.limite_de_perfis\(v_user_id\)/,
      'a policy voltou a ter a própria cópia da tabela de planos')
    assert.doesNotMatch(CCP, /WHEN 'familia'\s+THEN 4/,
      'a tabela de planos foi duplicada de volta para dentro da função')
  })

  test('as três contagens continuam existindo, e cada uma no seu lugar', () => {
    // criar (trigger) · criar (policy) · restaurar. As duas primeiras contam só
    // ativos; a terceira soma o que está voltando. A assimetria é o desenho.
    assert.match(MIGR, /WHERE user_id = NEW\.user_id AND is_active = true/)   // trigger
    assert.match(CCP,  /AND is_active = true/)                                 // policy
    assert.match(MIGR, /v_ativos \+ 1 > v_limite/)                             // restaurar
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('etapa 4: avisar quem ficou nas reservas', () => {
  const NOT = soCodigo(readFileSync(join(RAIZ, 'supabase/migrations/20260815250000_notificar_saida_de_reserva.sql'), 'utf8'))
  const E   = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/user-data-backup/index.ts'), 'utf8'))

  test('⭐ o tipo novo entrou no CHECK antes de ser usado', () => {
    // `radar_notifications_tipo_check` tem lista fechada. Inserir tipo fora dela
    // seria o mesmo erro que o CHECK de plano me custou nesta feature.
    assert.match(NOT, /ADD CONSTRAINT radar_notifications_tipo_check[\s\S]*?'saida_reserva'/,
      "o tipo 'saida_reserva' precisa estar no CHECK, senão o INSERT é rejeitado")
  })

  test('respeita os limites de tamanho da tabela', () => {
    assert.match(NOT, /left\(.*, 80\)/, 'title pode passar de 80 chars e violar o CHECK')
    // `,\s*200` e não `, 200`: o argumento fica em linha própria no SQL.
    assert.match(NOT, /left\([\s\S]*?,\s*200\)/, 'body pode passar de 200 chars e violar o CHECK')
    assert.match(NOT, /left\('saida_reserva:[\s\S]*?, 120\)/, 'dedupe_key pode passar de 120')
  })

  test('a url casa com o regex exigido pela tabela', () => {
    const url = NOT.match(/'(\/[a-zA-Z0-9/_#?=&-]*)'\s*,\s*now\(\)/)?.[1]
    assert.ok(url, 'não achei a url da notificação')
    assert.match(url, /^\/[a-zA-Z0-9/_#?=&-]{0,199}$/, `url "${url}" viola radar_notifications_url_check`)
  })

  test('idempotente: excluir duas vezes não enche a caixa', () => {
    assert.match(NOT, /ON CONFLICT \(user_id, dedupe_key\) DO NOTHING/)
  })

  test('⭐ o aviso NUNCA derruba a exclusão', () => {
    // A exclusão já aconteceu quando isto roda. Falhar aqui custa um aviso que
    // não sai — não um perfil num estado ruim.
    const t = bloco(E, "if (blobNovo.afetadas.length > 0)", 'console.log(\'[user-data-backup] perfil excluído')
    assert.match(t, /try \{[\s\S]*?\} catch \(e\) \{/,
      'o aviso passou a poder derrubar a exclusão')
  })

  test('só notifica quando há reserva afetada', () => {
    assert.match(E, /if \(blobNovo\.afetadas\.length > 0\) \{/,
      'passou a criar notificação mesmo sem reserva envolvida')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('⭐ conta de login único também recebe aviso de reserva', () => {
  // ACHADO em 2026-08-15: a caixa do sino do dono tinha ZERO linhas desde
  // sempre, de qualquer tipo.
  //
  // `radar_notifications` é por USER_ID; reserva compartilhada é por PERFIL.
  // Numa conta família com 4 perfis e UM login — o caso mais comum — os "outros
  // membros" não existem como user_id: são perfis do mesmo login. A edge fazia
  // `alvos.delete(callerId)`, a lista zerava, e ela saía sem gravar nada.
  const INV = soCodigo(readFileSync(join(RAIZ, 'supabase/functions/notify-reserve-invite/index.ts'), 'utf8'))

  test('⭐ lista vazia não sai mais sem gravar', () => {
    assert.match(INV, /const soEuNaConta = alvos\.size === 0/)
    assert.match(INV, /if \(soEuNaConta\) alvos\.add\(callerId\)/,
      'voltou a sair sem notificar ninguém em conta de login único')
    assert.doesNotMatch(INV, /if \(alvos\.size === 0\) \{[\s\S]{0,200}?return json/,
      'o early-return que engolia a notificação voltou')
  })

  test('o texto não mente para quem convidou', () => {
    // "Você foi convidado" seria falso para o autor do convite.
    assert.match(INV, /soEuNaConta[\s\S]{0,120}?Um perfil desta conta foi convidado/,
      'o texto genérico voltaria a dizer "você foi convidado" para quem convidou')
  })

  test('a notificação de saída de reserva notifica o dono', () => {
    // Mesmo problema, mesma solução: a RPC inclui o owner sem removê-lo.
    const NOT = soCodigo(readFileSync(join(RAIZ, 'supabase/migrations/20260815250000_notificar_saida_de_reserva.sql'), 'utf8'))
    assert.match(NOT, /SELECT p_owner_user_id AS u/,
      'o dono saiu da lista de destinatários — em conta de login único ninguém receberia')
  })
})
