// Importa as funções essenciais de outros módulos
import { verificarLogin, exportFunctions } from './dashboard.js';

// Torna as funções do dashboard.js acessíveis globalmente para o HTML (onclick, etc)
// Isso é crucial para que os botões continuem funcionando.
Object.assign(window, exportFunctions());

// Inicia o processo de verificação de login assim que o DOM estiver pronto.
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Aplicação iniciada. Chamando verificarLogin...');
    verificarLogin();
});
