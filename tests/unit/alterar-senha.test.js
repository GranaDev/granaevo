// alterar-senha.test.js — invariantes da troca de senha na conta autenticada.
//
// Auditoria 2026-08-19. A tela chamava `supabase.auth.updateUser({password})`
// direto no GoTrue, do browser, e isso carregava TRÊS defeitos:
//
//   1. BUG REAL — `security_update_password_require_reauthentication = true` no
//      projeto. Sem reautenticação, a troca só funciona com sessão criada nas
//      últimas 24h; passando disso o GoTrue exige um `nonce` que nenhum ponto do
//      código produzia. Num PWA a sessão dura dias: era o caso COMUM.
//   2. Sem HIBP — era o único dos três caminhos de definir senha sem checagem
//      de vazamento (o nativo do Supabase exige plano Pro: medido HTTP 402).
//   3. Sem prova de posse — sessão sequestrada trocava a senha e expulsava o dono.
//
// ⚠️ A DISTINÇÃO QUE ESTES TESTES PROTEGEM (decisão do dono, 2026-08-19):
//    Alterar senha (autenticado) → EXIGE a senha atual.
//    Esqueci a senha (reset)     → NÃO exige — a prova é o código no e-mail.
//    Confundir os dois quebra um fluxo ou o outro.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ler = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');

const EDGE   = ler('supabase', 'functions', 'change-password', 'index.ts');
const PROXY  = ler('api', 'user-data.js');
const TELA   = ler('src', 'scripts', 'pages', 'db-configuracoes.js');
const RESET  = ler('supabase', 'functions', 'verify-and-reset-password', 'index.ts');

/** Fonte SEM comentários.
 *
 *  Necessário para toda asserção de ORDEM. Estes arquivos documentam o próprio
 *  raciocínio em blocos longos, e o cabeçalho de `change-password/index.ts` cita
 *  `admin.updateUserById` para explicar POR QUE ela é usada. Um `indexOf` no
 *  fonte cru acha essa menção — dezenas de linhas ANTES da chamada real — e
 *  conclui que a troca acontece antes das checagens. Foi o que aconteceu na
 *  primeira versão deste teste: dois vermelhos, ambos falsos.
 *
 *  A regra geral: asserção de POSIÇÃO só vale sobre código; asserção de
 *  EXISTÊNCIA pode olhar o arquivo inteiro. */
function semComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* … */
    .replace(/^[ \t]*\/\/.*$/gm, ' ');   // linhas iniciadas por //
}

const EDGE_CODE = semComentarios(EDGE);

/** Recorta o corpo de `abrirAlterarSenha` — sem isto, uma asserção sobre o
 *  arquivo inteiro passaria por causa de OUTRA função (foi assim que um teste
 *  do projeto já ficou verde com o código removido). */
function blocoAlterarSenha() {
  const i = TELA.indexOf('function abrirAlterarSenha');
  assert.ok(i > 0, 'não achei abrirAlterarSenha em db-configuracoes.js');
  const j = TELA.indexOf('\nwindow.abrirAlterarSenha', i);
  assert.ok(j > i, 'não consegui delimitar o fim de abrirAlterarSenha');
  return TELA.slice(i, j);
}

describe('alterar senha — o navegador deixou de ser a fronteira', () => {
  test('a tela NÃO fala mais direto com o GoTrue', () => {
    const bloco = blocoAlterarSenha();
    assert.doesNotMatch(bloco, /supabase\.auth\.updateUser/,
      'Chamar updateUser do browser reintroduz os três defeitos de uma vez: a parede '
      + 'das 24h (reauthentication), a ausência de HIBP e a ausência de prova de posse.');
  });

  test('a tela manda a senha ATUAL para o servidor', () => {
    const bloco = blocoAlterarSenha();
    assert.match(bloco, /action:\s*'change-password'/);
    assert.match(bloco, /currentPassword:\s*senhaAtual/,
      'Sem a senha atual, quem sequestra uma sessão troca a senha e expulsa o dono.');
  });

  test('existe o campo de senha atual na tela', () => {
    const bloco = blocoAlterarSenha();
    assert.match(bloco, /id="senhaAtual"/,
      'O campo precisa existir, senão o usuário não tem como fornecer a senha atual.');
    assert.match(bloco, /autocomplete="current-password"/,
      'Sem autocomplete correto, gerenciadores de senha preenchem o campo errado.');
  });
});

describe('alterar senha — a Edge é quem decide', () => {
  test('confere a senha atual contra o GoTrue antes de trocar', () => {
    assert.match(EDGE, /token\?grant_type=password/,
      'A senha atual tem de ser validada pela mesma engine do login — nunca comparando '
      + 'hash na mão.');
    // A recusa precisa vir ANTES da troca, senão a checagem é decorativa.
    const iCheck  = EDGE_CODE.indexOf('current_invalid');
    const iUpdate = EDGE_CODE.indexOf('admin.updateUserById');
    assert.ok(iCheck > 0, 'não achei a recusa `current_invalid` no código');
    assert.ok(iUpdate > iCheck,
      'A recusa por senha atual incorreta precisa vir ANTES de admin.updateUserById.');
  });

  test('roda o HIBP — é o que o plano Pro faria', () => {
    assert.match(EDGE, /import\s*\{\s*isPasswordPwned\s*\}/);
    const iHibp   = EDGE_CODE.indexOf('isPasswordPwned(senhaNova)');
    const iUpdate = EDGE_CODE.indexOf('admin.updateUserById');
    assert.ok(iHibp > 0, 'não achei a chamada de isPasswordPwned no código');
    assert.ok(iUpdate > iHibp,
      'O HIBP precisa rodar ANTES da troca. Depois seria só telemetria.');
  });

  test('troca por ADMIN — é isso que fura a parede das 24h', () => {
    assert.match(EDGE, /admin\.updateUserById\(user\.id,\s*\{[\s\S]{0,80}password:\s*senhaNova/,
      'Tem de ser admin.updateUserById. `updateUser` comum esbarra em '
      + 'security_update_password_require_reauthentication quando a sessão passa de 24h — '
      + 'que é exatamente o bug que esta função existe para consertar.');
  });

  test('a política de senha é revalidada no SERVIDOR', () => {
    // As mesmas três regras que a tela exibe. Se sumirem daqui, a política volta
    // a ser só JavaScript — e `updateUser({password:'aaaaaa'})` volta a passar.
    assert.match(EDGE, /s\.length\s*<\s*8/);
    assert.match(EDGE, /\/\[A-Z\]\/\.test\(s\)/);
    assert.match(EDGE, /\/\[0-9\]\/\.test\(s\)/);
  });

  test('encerra as OUTRAS sessões, não todas', () => {
    assert.match(EDGE, /signOut\(token,\s*'others'\)/,
      "'global' derrubaria quem acabou de trocar a senha, que reapareceria no login "
      + 'sem entender por quê. O padrão do GoTrue é global — por isso o escopo é explícito.');
    assert.doesNotMatch(EDGE, /signOut\(token,\s*'global'\)/);
  });

  test('o teto de tentativas falha FECHADO', () => {
    // Cada tentativa carrega um palpite da senha atual: solto, o endpoint vira
    // oráculo de senha.
    const i = EDGE.indexOf("rpc('check_rate_limit'");
    assert.ok(i > 0, 'não achei o backstop de rate limit na edge');
    const bloco = EDGE.slice(EDGE.lastIndexOf('try {', i), EDGE.indexOf('\n  }', EDGE.indexOf('catch', i)));
    assert.match(bloco, /if\s*\(\s*rlErr\s*\)[\s\S]{0,300}?429/,
      'Erro da RPC precisa RECUSAR. Fail-open aqui libera adivinhação de senha.');
    assert.doesNotMatch(bloco, /!\s*rlErr\s*&&/,
      'O padrão `!erro &&` é o fail-open que a auditoria de 2026-08-18 fechou em chat-parse.');
  });
});

describe('alterar senha — o proxy não decide, mas protege', () => {
  test('a action existe e tem rate limit por IP e por usuário', () => {
    const i = PROXY.indexOf("parsed?.action === 'change-password'");
    assert.ok(i > 0, 'não achei a action change-password no proxy');
    const bloco = PROXY.slice(i, i + 3000);
    assert.match(bloco, /checkRL\(`chpwd:ip:\$\{ip\}`/);
    assert.match(bloco, /checkRL\(`chpwd:uid:\$\{userId\}`/,
      'Só por IP não basta: IP rotativo contorna. O teto por usuário cobre isso.');
  });

  test('o corpo é reconstruído — nada extra do cliente atravessa', () => {
    const i = PROXY.indexOf("parsed?.action === 'change-password'");
    const bloco = PROXY.slice(i, i + 3000);
    assert.match(bloco, /body:\s*JSON\.stringify\(\{[\s\S]{0,200}currentPassword:[\s\S]{0,200}newPassword:/,
      'Repassar `parsed` inteiro deixaria o cliente injetar campos que a edge não espera.');
    assert.doesNotMatch(bloco, /body:\s*JSON\.stringify\(parsed\)/);
  });

  test('não virou a 13ª função da Vercel', () => {
    // A 13ª função congela o deploy em silêncio (2026-07-25). Este recurso tinha
    // de nascer como `action` numa rota existente.
    assert.match(PROXY, /parsed\?\.action === 'change-password'/,
      'change-password precisa morar dentro de api/user-data.js, não em arquivo próprio.');
  });
});

describe('alterar senha — o RESET continua sendo outro fluxo', () => {
  test('"esqueci a senha" NÃO passa a exigir a senha atual', () => {
    // A prova de posse do reset é o código no e-mail. Exigir a senha atual lá
    // seria absurdo — o usuário esqueceu justamente essa senha.
    assert.doesNotMatch(RESET, /currentPassword/,
      'O fluxo de reset não pode exigir a senha atual: quem o usa não a sabe.');
  });

  test('e continua com HIBP próprio', () => {
    assert.match(RESET, /isPasswordPwned/,
      'Os três caminhos de definir senha (cadastro, reset, alterar) usam o mesmo HIBP.');
  });
});
