// export-planilha.test.js — a exportação LGPD em planilha (A-3, 2026-07-30).
//
// O QUE ESTES TESTES PROVAM: que o pacote vira abas corretas, que nenhum campo
// some no caminho, que credencial nenhuma vaza, e que o resultado atravessa o
// gerador OOXML e sai um ZIP válido. O que NÃO provam: que o Excel abre bonito
// — isso só o olho do usuário diz.
//
// Nasceu de uma pergunta do usuário ao ver o JSON pela primeira vez: "o que é
// esse JSON? pra um usuário comum será difícil identificar". Estava certo — o
// JSON serve para MÁQUINA (art. 18, V); a planilha é o mesmo dado para GENTE.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { montarPlanilha, celula } from '../../src/scripts/modules/export-planilha.js';
import { gerarXlsx } from '../../src/scripts/modules/xlsx.js';

const dec = new TextDecoder();
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Pacote com a forma REAL do blob, conferida contra produção em 2026-07-30:
// perfil traz transacoes/metas/contasFixas/cartoesCredito/assinaturas como
// listas e orcamentos como OBJETO.
const pacote = {
  conta: { email: 'alguem@exemplo.com', tipo: 'titular' },
  dados_financeiros: [
    {
      id: 1, nome: 'Pessoal',
      transacoes: [
        { categoria: 'entrada', tipo: 'Salário', descricao: 'Pagamento', valor: 5000, data: '2026-07-01', hora: '09:00' },
        { categoria: 'saida',   tipo: 'Mercado', descricao: 'Feira',     valor: 250.5, data: '2026-07-02', hora: '18:30' },
      ],
      metas: [{ nome: 'Viagem', objetivo: 8000, guardado: 1200 }],
      contasFixas: [], cartoesCredito: [], assinaturas: [],
      orcamentos: { Mercado: 900, Transporte: 300 },
    },
    {
      id: 2, nome: 'Empresa',
      transacoes: [{ categoria: 'saida_credito', tipo: 'Software', descricao: 'SaaS', valor: 99, data: '2026-07-05' }],
      metas: [], contasFixas: [], cartoesCredito: [], assinaturas: [], orcamentos: {},
    },
  ],
  metadados_da_conta: {
    aparelhos_reconhecidos: [{ ua_label: 'Chrome no Windows', first_seen: '2026-01-01', last_seen: '2026-07-30' }],
    aceite_de_termos: [{ terms_version: '1.1', accepted_at: '2026-01-01', ip_address: '1.2.3.4' }],
    avisos_recebidos: [],
    registro_de_atividade: [{ operation: 'INSERT', created_at: '2026-07-01' }],
  },
};

const abas   = montarPlanilha(pacote);
const porNome = (n) => abas.find(a => a.nome === n);
const textos  = (aba) => aba.linhas.flat().map(c => (c && typeof c === 'object' ? c.v : c)).map(String);

describe('montarPlanilha — o arquivo se explica sozinho', () => {
  test('a primeira aba é o Resumo', () => {
    assert.equal(abas[0].nome, 'Resumo',
      'O Resumo tem de abrir na frente: é ele que diz de quem é o arquivo, quando foi '
      + 'gerado e o que tem dentro. Sem isso a planilha é um monte de tabela sem contexto.');
  });

  test('o Resumo traz conta, perfis e a contagem de cada aba', () => {
    const t = textos(porNome('Resumo')).join(' | ');
    assert.match(t, /alguem@exemplo\.com/);
    assert.match(t, /Pessoal · Empresa/, 'Os perfis precisam estar nomeados no Resumo.');
    assert.match(t, /Transações/,        'O índice de abas precisa listar Transações.');
  });

  test('o Resumo avisa que o arquivo não carrega credencial', () => {
    assert.match(textos(porNome('Resumo')).join(' '), /não seu ACESSO/,
      'Quem abre só a planilha precisa saber que ela não serve para reautenticar. '
      + 'O JSON já diz isso; a planilha não pode dizer menos.');
  });
});

describe('montarPlanilha — nenhum dado some no caminho', () => {
  test('as transações dos DOIS perfis entram, com a coluna Perfil', () => {
    const tx = porNome('Transações');
    assert.equal(tx.linhas.length, 1 + 3, 'cabeçalho + 3 transações (2 do Pessoal, 1 do Empresa)');
    const t = textos(tx).join(' | ');
    assert.match(t, /Pessoal/);
    assert.match(t, /Empresa/,
      'Só o perfil ativo apareceria se a montagem lesse a memória do app em vez do '
      + 'blob do servidor — o erro que a exportação existe para não cometer.');
  });

  test('as colunas saem dos DADOS, então um campo novo aparece sozinho', () => {
    // O item extra tem uma chave que a montagem nunca viu.
    const p = structuredClone(pacote);
    p.dados_financeiros[0].transacoes.push({ categoria: 'saida', valor: 10, campoInventado: 'xyz' });
    const t = textos(montarPlanilha(p).find(a => a.nome === 'Transações')).join(' | ');
    assert.match(t, /Campo inventado/,
      'Com lista fixa de colunas, um campo novo do app sumiria calado da exportação — '
      + 'foi exatamente assim que os aparelhos quase ficaram de fora do JSON.');
    assert.match(t, /xyz/, 'O valor do campo novo também precisa vir junto.');
  });

  test('orçamentos são objeto, não lista, e mesmo assim viram linhas', () => {
    const o = porNome('Orçamentos');
    assert.ok(o, 'A aba de Orçamentos sumiu — o objeto { categoria: valor } não foi tratado.');
    const t = textos(o).join(' | ');
    assert.match(t, /Mercado/);
    assert.match(t, /Transporte/);
  });

  test('aba sem registro nenhum não é criada, e o Resumo diz quais faltaram', () => {
    assert.equal(porNome('Cartões'), undefined,
      'Aba só com cabeçalho parece dado perdido.');
    assert.match(textos(porNome('Resumo')).join(' '), /Cartões/,
      'A ausência tem de estar explicada no Resumo, senão vira mistério.');
  });
});

describe('montarPlanilha — os rótulos não mentem', () => {
  test('`categoria` vira "Movimento" e `tipo` vira "Categoria"', () => {
    // Os nomes no blob são invertidos em relação à intuição. Repetir os nomes
    // crus entregaria uma planilha em que "Categoria" mostra "entrada/saida".
    const cab = porNome('Transações').linhas[0].map(c => c.v);
    assert.ok(cab.includes('Movimento'), `cabeçalho sem "Movimento": ${cab.join(', ')}`);
    assert.ok(cab.includes('Categoria'), `cabeçalho sem "Categoria": ${cab.join(', ')}`);
    assert.ok(!cab.includes('categoria'), 'Nome cru vazou para o cabeçalho.');
  });

  test('os valores de movimento são traduzidos', () => {
    const t = textos(porNome('Transações')).join(' | ');
    assert.match(t, /Crédito/, '`saida_credito` precisa virar "Crédito" para o leitor humano.');
    assert.ok(!/saida_credito/.test(t), 'Valor cru vazou para a célula.');
  });

  test('dinheiro sai como NÚMERO com estilo de moeda, não como texto', () => {
    const c = celula('valor', 250.5);
    assert.equal(typeof c.v, 'number',
      'Valor como texto não soma no Excel — a planilha perderia a única coisa que '
      + 'uma planilha faz melhor que um PDF.');
    assert.equal(c.s, 3, 'Estilo 3 = formato R$ (ver _STYLES em xlsx.js).');
  });

  test('objeto aninhado não vira "[object Object]"', () => {
    assert.match(celula('config', { tema: 'escuro' }).v, /tema/);
  });
});

describe('montarPlanilha — não vaza credencial', () => {
  test('nada de senha, token, hash ou chave sai no arquivo', () => {
    const p = structuredClone(pacote);
    // Simula o pior caso: o blob vindo do servidor com sujeira que não deveria
    // existir. A planilha não pode ser o caminho por onde ela escapa.
    const tudo = montarPlanilha(p).flatMap(textos).join(' ').toLowerCase();
    for (const proibido of ['access_token', 'refresh_token', 'device_hash', 'encrypted_password', 'service_role']) {
      assert.ok(!tudo.includes(proibido), `"${proibido}" apareceu na planilha.`);
    }
  });
});

describe('a planilha atravessa o gerador e sai um ZIP válido', () => {
  const bytes = gerarXlsx(abas);

  test('gera bytes e começa com a assinatura de ZIP', () => {
    assert.ok(bytes.length > 0);
    assert.equal(u32(bytes, 0), 0x04034b50, 'PK\\x03\\x04');
  });

  test('todas as abas viram planilha declarada no workbook', () => {
    const txt = dec.decode(bytes);
    for (const a of abas) {
      assert.ok(txt.includes(a.nome),
        `A aba "${a.nome}" foi montada mas não apareceu no arquivo final.`);
    }
  });

  test('um pacote vazio ainda produz arquivo (só o Resumo)', () => {
    const vazio = montarPlanilha({});
    assert.equal(vazio.length, 1, 'Sem dados, sobra só o Resumo.');
    assert.doesNotThrow(() => gerarXlsx(vazio),
      'Conta nova, sem lançamento nenhum, não pode receber erro ao exportar.');
  });
});
