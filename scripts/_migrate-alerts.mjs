// Migração pontual: alert() → mostrarNotificacao() (toasts).
// Substituição por string EXATA (split/join), trata duplicatas idênticas.
// NÃO toca: alerts de auth/sessão/upload de foto (seguidos de redirect),
// template-literals e mensagem multi-linha (tratados à parte por Edit).
import { readFileSync, writeFileSync } from 'node:fs';

const PAGES = new URL('../src/scripts/pages/', import.meta.url);

// entry: [argComAspas, tipo, argNovoOpcional(sem emoji)]
const JOBS = {
  'db-transacoes.js': { prefix: '_ctx.mostrarNotificacao', items: [
    [`'Você ainda não criou nenhuma meta ou reserva, crie no menu "Reservas"'`, 'error'],
    [`"Selecione o cartão!"`, 'error'],
    [`"Selecione a quantidade de parcelas!"`, 'error'],
    [`"Cartão não encontrado!"`, 'error'],
    [`"Selecione o dia de cobrança!"`, 'error'],
    [`"Dia de cobrança inválido!"`, 'error'],
    [`'Digite a descrição.'`, 'error'],
    [`'Digite um valor válido.'`, 'error'],
    [`'Selecione a categoria.'`, 'error'],
    [`'Categoria inválida.'`, 'error'],
    [`'Digite um limite válido.'`, 'error'],
    [`'Limite muito alto.'`, 'error'],
  ]},
  'db-metas.js': { prefix: '_ctx.mostrarNotificacao', items: [
    [`'Informe o nome da reserva.'`, 'error'],
    [`'Nome muito longo (máx. 200 caracteres).'`, 'error'],
    [`'Tipo de reserva inválido.'`, 'error'],
    [`'Informe um saldo válido (entre R$ 0,00 e R$ 9.999.999,00).'`, 'error'],
    [`'Objetivo inválido (entre R$ 0,00 e R$ 999.999.999,00).'`, 'error'],
    [`'Tipo de rendimento inválido.'`, 'error'],
    [`'Informe a % do CDI entre 1% e 200%.'`, 'error'],
    [`'Informe uma taxa entre 0,01% e 999%.'`, 'error'],
    [`'Digite o nome da reserva.'`, 'error'],
    [`'Nome muito longo (máx. 200 caracteres).'`, 'error'],
    [`'Digite um objetivo válido.'`, 'error'],
    [`'Digite uma porcentagem válida do CDI (1–200).'`, 'error'],
    [`'Digite uma taxa válida (0–999).'`, 'error'],
    [`'Digite um valor de aporte válido.'`, 'error'],
    [`'Selecione uma meta primeiro.'`, 'error'],
    [`'Meta não encontrada.'`, 'error'],
    [`'Não há saldo disponível nesta reserva para retirar.'`, 'error'],
    [`'Digite um valor válido.'`, 'error'],
    [`'⚠️ Por favor, selecione o motivo da retirada.'`, 'warning', `'Por favor, selecione o motivo da retirada.'`],
    [`'⚠️ Por favor, descreva o motivo da retirada.'`, 'warning', `'Por favor, descreva o motivo da retirada.'`],
    [`'Valor inválido após processamento.'`, 'error'],
    [`'Valor maior que o saldo disponível!'`, 'error'],
  ]},
  'db-cartoes.js': { prefix: '_ctx.mostrarNotificacao', items: [
    [`'Informe um valor válido e positivo.'`, 'error'],
    [`'Dia de cobrança inválido.'`, 'error'],
    [`'Digite o nome do cartão!'`, 'error'],
    [`'Nome do cartão muito longo (máx. 50 caracteres).'`, 'error'],
    [`'Preencha todos os campos!'`, 'error'],
    [`'Informe um limite válido e positivo.'`, 'error'],
    [`'Limite máximo permitido: R$ 9.999.999,00.'`, 'error'],
    [`'O dia de fechamento e o dia de vencimento não podem ser iguais.'`, 'error'],
    [`'✅ Última parcela paga! Fatura quitada.'`, 'success', `'Última parcela paga! Fatura quitada.'`],
  ]},
  'db-relatorios.js': { prefix: '_ctx.mostrarNotificacao', items: [
    [`'Você precisa ter pelo menos 2 perfis cadastrados para gerar relatório de casal!'`, 'warning'],
    [`'Você precisa ter pelo menos 2 perfis para gerar relatório da família!'`, 'warning'],
    [`'Por favor, selecione o mês e o ano.'`, 'error'],
    [`'Mês inválido.'`, 'error'],
    [`'Ano inválido.'`, 'error'],
    [`'Por favor, selecione um perfil.'`, 'error'],
    [`'Perfil inválido.'`, 'error'],
    [`'Erro: É necessário selecionar exatamente 2 perfis.'`, 'error', `'É necessário selecionar exatamente 2 perfis.'`],
  ]},
  'dashboard.js': { prefix: 'mostrarNotificacao', items: [
    // Bloco conta-fixa / pagamento (seguros — terminam em return, sem redirect)
    [`'Preencha todos os campos.'`, 'error'],
    [`'Descrição muito longa (máx. 100 caracteres).'`, 'error'],
    [`'Informe um valor válido e positivo.'`, 'error'],
    [`'Data de vencimento inválida.'`, 'error'],
    [`'Digite um valor válido!'`, 'error'],
    [`'Valor de pagamento inválido.'`, 'error'],
    [`'Valor de pagamento inválido. Informe um valor entre R$ 0,01 e R$ 9.999.999,00.'`, 'error'],
    [`'Aguarde, pagamento em andamento...'`, 'info'],
    [`'✅ Antecipação concluída! Todas as parcelas foram quitadas.'`, 'success', `'Antecipação concluída! Todas as parcelas foram quitadas.'`],
    [`'✅ Todas as parcelas pagas! Fatura quitada.'`, 'success', `'Todas as parcelas pagas! Fatura quitada.'`],
    [`'✅ Parcela paga! O lembrete foi atualizado.'`, 'success', `'Parcela paga! O lembrete foi atualizado.'`],
    [`'✅ Pagamento realizado! A conta volta para "Pendente" no próximo vencimento.'`, 'success', `'Pagamento realizado! A conta volta para "Pendente" no próximo vencimento.'`],
    [`'❌ Erro ao processar antecipação. Nenhuma alteração foi salva.'`, 'error', `'Erro ao processar antecipação. Nenhuma alteração foi salva.'`],
    [`'❌ Erro ao processar pagamento. Nenhuma alteração foi salva.'`, 'error', `'Erro ao processar pagamento. Nenhuma alteração foi salva.'`],
  ]},
};

let totalGlobal = 0;
for (const [file, { prefix, items }] of Object.entries(JOBS)) {
  const url = new URL(file, PAGES);
  let src = readFileSync(url, 'utf8');
  let count = 0;
  for (const [arg, tipo, narg] of items) {
    const find = `alert(${arg})`;
    const repl = `${prefix}(${narg ?? arg}, '${tipo}')`;
    const before = src.split(find).length - 1;
    if (before === 0) { console.warn(`  [!] não encontrado em ${file}: ${find}`); continue; }
    src = src.split(find).join(repl);
    count += before;
  }
  writeFileSync(url, src, 'utf8');
  console.log(`${file}: ${count} alert() migrados`);
  totalGlobal += count;
}
console.log(`\nTOTAL: ${totalGlobal} alert() → mostrarNotificacao()`);
