// xlsx.test.js — estrutura do .xlsx gerado (RF-13).
//
// O QUE ESTES TESTES PROVAM: que o ZIP é estruturalmente válido (assinaturas,
// contagem de entradas, CRC correto) e que as peças obrigatórias do OOXML estão
// lá. O que NÃO provam: que o Excel abre — isso só o teste do usuário diz.
// Formato binário não perdoa: por isso a estrutura é verificada byte a byte.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gerarXlsx, zipar, crc32, colunaLetra } from '../../src/scripts/modules/xlsx.js';

const dec = new TextDecoder();
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16 = (b, o) => (b[o] | (b[o + 1] << 8));

describe('crc32 — valores canônicos', () => {
  test('"123456789" → 0xCBF43926 (vetor padrão)', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  });
  test('vazio → 0', () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
  });
});

describe('colunaLetra', () => {
  test('1→A, 26→Z, 27→AA, 28→AB', () => {
    assert.equal(colunaLetra(1), 'A');
    assert.equal(colunaLetra(26), 'Z');
    assert.equal(colunaLetra(27), 'AA');
    assert.equal(colunaLetra(28), 'AB');
  });
});

describe('zipar — estrutura do container', () => {
  const bytes = zipar([{ nome: 'a.txt', dados: new TextEncoder().encode('ola') }]);

  test('começa com a assinatura de arquivo local (PK\\x03\\x04)', () => {
    assert.equal(u32(bytes, 0), 0x04034b50);
  });

  test('termina com o End of Central Directory e conta 1 entrada', () => {
    const eocdOff = bytes.length - 22;
    assert.equal(u32(bytes, eocdOff), 0x06054b50, 'assinatura EOCD');
    assert.equal(u16(bytes, eocdOff + 8),  1, 'entradas neste disco');
    assert.equal(u16(bytes, eocdOff + 10), 1, 'entradas no total');
  });

  test('o offset do diretório central aponta para uma assinatura central válida', () => {
    const eocdOff = bytes.length - 22;
    const centralOff = u32(bytes, eocdOff + 16);
    assert.equal(u32(bytes, centralOff), 0x02014b50);
  });

  test('o CRC gravado bate com o conteúdo', () => {
    assert.equal(u32(bytes, 14), crc32(new TextEncoder().encode('ola')));
  });
});

describe('gerarXlsx — peças obrigatórias do OOXML', () => {
  const bytes = gerarXlsx([
    { nome: 'Resumo', linhas: [['Indicador', 'Valor'], ['Entradas', { v: 1234.5, s: 3 }]] },
    { nome: 'Transações', linhas: [['Data', 'Descrição'], ['01/07/2026', 'Mercado']] },
  ]);
  const txt = dec.decode(bytes);

  test('contém todas as partes exigidas', () => {
    for (const parte of [
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
    ]) {
      assert.ok(txt.includes(parte), `falta a parte ${parte}`);
    }
  });

  test('EOCD declara 7 entradas (5 fixas + 2 planilhas)', () => {
    const eocdOff = bytes.length - 22;
    assert.equal(u16(bytes, eocdOff + 10), 7);
  });

  test('nome da aba e valores aparecem no XML', () => {
    assert.ok(txt.includes('name="Resumo"'));
    assert.ok(txt.includes('name="Transações"'));
    assert.ok(txt.includes('<v>1234.5</v>'), 'número vai como número, não texto');
    assert.ok(txt.includes('Mercado'));
  });

  test('escapa XML (não corrompe com & e <)', () => {
    const b = gerarXlsx([{ nome: 'X', linhas: [['a & b <c>']] }]);
    const s = dec.decode(b);
    assert.ok(s.includes('a &amp; b &lt;c&gt;'));
  });

  test('recusa entrada vazia em vez de gerar arquivo inválido', () => {
    assert.throws(() => gerarXlsx([]), /nenhuma planilha/);
  });
});

describe('gráficos nativos — todas as peças e referências fechadas', () => {
  const bytes = gerarXlsx([
    {
      nome: 'Resumo',
      linhas: [['Cat', 'Valor'], ['Mercado', 100], ['Luz', 50]],
      graficos: [
        { tipo: 'pizza', titulo: 'Fatia', catRef: "'Resumo'!$A$2:$A$3", valRef: "'Resumo'!$B$2:$B$3", pontos: 2 },
        { tipo: 'barra', titulo: 'Barras', catRef: "'Resumo'!$A$2:$A$3", valRef: "'Resumo'!$B$2:$B$3" },
      ],
      barras: [{ ref: 'C2:C3' }],
      filtro: 'A1:B3',
    },
    { nome: 'Sem grafico', linhas: [['x']] },
  ]);
  const txt = dec.decode(bytes);

  test('gera chart1/chart2, o drawing e os DOIS .rels que os amarram', () => {
    for (const parte of [
      'xl/charts/chart1.xml', 'xl/charts/chart2.xml',
      'xl/drawings/drawing1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
      'xl/drawings/_rels/drawing1.xml.rels',
    ]) assert.ok(txt.includes(parte), `falta ${parte}`);
  });

  test('a aba SEM gráfico não ganha drawing (rel quebrada = arquivo recusado)', () => {
    assert.ok(!txt.includes('xl/worksheets/_rels/sheet2.xml.rels'));
    assert.ok(!txt.includes('drawing2.xml'));
  });

  test('[Content_Types] declara chart e drawing (sem isso o Excel recusa)', () => {
    assert.ok(txt.includes('drawingml.chart+xml'));
    assert.ok(txt.includes('officedocument.drawing+xml'));
  });

  test('a folha referencia o desenho e declara o namespace r:', () => {
    assert.ok(txt.includes('<drawing r:id="rIdDraw"/>'));
    assert.ok(txt.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'));
  });

  test('pizza e barra usam elementos distintos e as refs vao para o XML', () => {
    assert.ok(txt.includes('<c:pieChart>'));
    assert.ok(txt.includes('<c:barChart>'));
    // O apóstrofo do nome da aba sai escapado (&apos;) — XML válido; o Excel
    // converte de volta ao ler. Conferimos a forma que REALMENTE vai no arquivo.
    assert.ok(txt.includes('<c:f>&apos;Resumo&apos;!$B$2:$B$3</c:f>'));
  });

  test('barra de dados e autofiltro entram na folha', () => {
    assert.ok(txt.includes('type="dataBar"'));
    assert.ok(txt.includes('<autoFilter ref="A1:B3"/>'));
  });

  test('ordem do schema: sheetData vem ANTES de autoFilter e de drawing', () => {
    const i1 = txt.indexOf('</sheetData>');
    const i2 = txt.indexOf('<autoFilter');
    const i3 = txt.indexOf('<drawing r:id');
    assert.ok(i1 < i2 && i2 < i3, 'ordem invalida faz o Excel recusar o arquivo');
  });
});
