// ----------------------------------------------------------------------------
// exportar-dados.js — exportação JSON/CSV (extraído de dashboard.js, Passo 10)
//
// POR QUE ISTO SAIU DO dashboard.js:
// O dashboard.js carrega EAGER no boot e vive em 40,9 KB de um orçamento de
// 42 KB gzip — 97%. Cada feature nova exigia conferir se cabia, e a próxima
// podia simplesmente não caber. Estas duas funções são o caso mais claro de
// código FRIO no caminho crítico: ~7 KB de fonte que só rodam quando o usuário
// clica em "Exportar", coisa que a maioria nunca faz — mas que todo mundo baixa
// em todo boot.
//
// A lógica é a MESMA, movida sem alteração de comportamento. O que mudou:
// tudo que era global do dashboard agora entra por `ctx` (o mesmo objeto com
// getters vivos que as telas lazy já usam), então troca de perfil continua
// funcionando sem re-init.
//
// Carregado sob demanda no clique (`import()`), não no boot.
// ----------------------------------------------------------------------------

// Escape de CSV Injection: uma célula começando com = + - @ vira fórmula no
// Excel/Sheets e pode executar. O TAB à frente neutraliza sem sujar o dado.
// (Regra de segurança já existente — mantida ao mover; não relaxar.)
function escaparCSV(str) {
    const s = String(str || '').replace(/"/g, '""').replace(/[\r\n]/g, ' ');
    if (/^[=+\-@\t\r]/.test(s)) return `"\t${s}"`;
    return `"${s}"`;
}

// Mais recente primeiro — o que importa quando o volume estoura o teto e é
// preciso truncar.
function _maisRecentesPrimeiro(a, b) {
    const dataA = `${a.data} ${a.hora || ''}`;
    const dataB = `${b.data} ${b.hora || ''}`;
    return dataB.localeCompare(dataA);
}

const _LIMITE_BLOB_BYTES = 10 * 1024 * 1024; // ~10MB: teto seguro da maioria dos navegadores

function _baixar(conteudo, mime, nomeArquivo) {
    const blob = new Blob([conteudo], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Exporta o perfil ativo em JSON.
 * @param {Object} ctx  precisa de: perfilAtivo, transacoes, metas, contasFixas,
 *                      cartoesCredito, _validators, _EXPORT_MAX_REGISTROS,
 *                      _sanitizeText, confirmarAcao, mostrarNotificacao, isoDate
 */
export function exportarDadosJSON(ctx) {
    if (!ctx?.perfilAtivo) {
        ctx?.mostrarNotificacao?.('Nenhum perfil ativo!', 'error');
        return;
    }
    const V   = ctx._validators;
    const MAX = ctx._EXPORT_MAX_REGISTROS;

    const totalTransacoes = ctx.transacoes.filter(V.transacao).length;
    const seraTruncado    = totalTransacoes > MAX;
    const avisoTruncamento = seraTruncado
        ? `\n\n⚠️ Atenção: você possui ${totalTransacoes} transações. Serão exportadas apenas as ${MAX} mais recentes para proteger o desempenho do navegador.`
        : '';

    ctx.confirmarAcao(
        `⚠️ Você está prestes a exportar TODOS os dados financeiros do perfil "${ctx._sanitizeText(ctx.perfilAtivo.nome)}" — transações, metas, contas e cartões — para um arquivo local. Confirma?${avisoTruncamento}`,
        () => {
            // `_processando` é lock de UI em memória — não é dado do usuário e
            // não faz sentido no arquivo exportado.
            const contasSemLock = ctx.contasFixas.map(({ _processando, ...rest }) => rest);

            const transacoesOrdenadas = ctx.transacoes
                .filter(V.transacao).slice().sort(_maisRecentesPrimeiro).slice(0, MAX);

            const dados = {
                perfil:         ctx._sanitizeText(ctx.perfilAtivo.nome),
                dataExportacao: new Date().toISOString(),
                totalRegistros: {
                    transacoes: totalTransacoes,
                    exportadas: transacoesOrdenadas.length,
                    truncado:   seraTruncado,
                },
                transacoes:     transacoesOrdenadas,
                metas:          ctx.metas.filter(V.meta).slice(0, MAX),
                contasFixas:    contasSemLock.filter(V.contaFixa).slice(0, MAX),
                cartoesCredito: ctx.cartoesCredito.filter(V.cartao).slice(0, MAX),
            };

            const dataStr = JSON.stringify(dados, null, 2);

            if (new TextEncoder().encode(dataStr).length > _LIMITE_BLOB_BYTES) {
                ctx.mostrarNotificacao('O arquivo gerado é muito grande. Tente exportar um período menor via Relatórios.', 'error');
                return;
            }

            _baixar(
                dataStr,
                'application/json',
                `granaevo_${ctx._sanitizeText(ctx.perfilAtivo.nome).replace(/\s+/g, '_')}_${ctx.isoDate()}.json`,
            );

            ctx.mostrarNotificacao(
                seraTruncado
                    ? `Exportação concluída (${MAX} de ${totalTransacoes} transações)`
                    : 'Dados exportados com sucesso!',
                'success',
            );
        },
    );
}

/** Exporta as transações do perfil ativo em CSV. Mesmas dependências do JSON. */
export function exportarDadosCSV(ctx) {
    if (!ctx?.perfilAtivo) {
        ctx?.mostrarNotificacao?.('Nenhum perfil ativo!', 'error');
        return;
    }
    const V   = ctx._validators;
    const MAX = ctx._EXPORT_MAX_REGISTROS;

    const transacoesValidas = ctx.transacoes.filter(V.transacao);
    const seraTruncado      = transacoesValidas.length > MAX;
    const avisoTruncamento  = seraTruncado
        ? `\n\n⚠️ Você possui ${transacoesValidas.length} transações. Serão exportadas apenas as ${MAX} mais recentes.`
        : '';

    ctx.confirmarAcao(
        `⚠️ Exportar as transações do perfil "${ctx._sanitizeText(ctx.perfilAtivo.nome)}" para CSV? O arquivo ficará salvo no seu dispositivo.${avisoTruncamento}`,
        () => {
            const paraExportar = transacoesValidas.slice().sort(_maisRecentesPrimeiro).slice(0, MAX);

            let csv = 'Data,Hora,Categoria,Tipo,Descrição,Valor\n';
            for (const t of paraExportar) {
                csv += [
                    escaparCSV(t.data),
                    escaparCSV(t.hora),
                    escaparCSV(t.categoria),
                    escaparCSV(t.tipo),
                    escaparCSV(t.descricao),
                    String(Number(t.valor).toFixed(2)),
                ].join(',') + '\n';
            }

            if (new TextEncoder().encode(csv).length > _LIMITE_BLOB_BYTES) {
                ctx.mostrarNotificacao('O arquivo CSV é muito grande. Tente exportar um período menor.', 'error');
                return;
            }

            // ﻿ (BOM): sem ele o Excel abre UTF-8 como Latin-1 e "Alimentação"
            // vira "AlimentaÃ§Ã£o". Não remover.
            _baixar(
                '﻿' + csv,
                'text/csv;charset=utf-8;',
                `granaevo_transacoes_${ctx._sanitizeText(ctx.perfilAtivo.nome).replace(/\s+/g, '_')}_${ctx.isoDate()}.csv`,
            );

            ctx.mostrarNotificacao(
                seraTruncado
                    ? `CSV exportado (${MAX} de ${transacoesValidas.length} transações)`
                    : 'Transações exportadas com sucesso!',
                'success',
            );
        },
    );
}
