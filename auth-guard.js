import { supabase } from './supabase-client.js';

const AuthGuard = {
    async checkAuth() {
        console.log('🔒 AuthGuard: Verificando autenticação...');
        
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session) {
            console.log('❌ AuthGuard: Sem sessão ativa, redirecionando...');
            alert('Você precisa fazer login para acessar esta página.');
            window.location.href = 'login.html';
            return null;
        }
        
        console.log('✅ AuthGuard: Usuário autenticado:', session.user.email);
        return session.user;
    },

    async getUserData() {
        console.log('📊 AuthGuard: Buscando dados do usuário...');
        
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return null;

        // Buscar assinatura do usuário
        const { data: subscription, error } = await supabase
            .from('subscriptions')
            .select('*, plans(*)')
            .eq('user_id', session.user.id)
            .eq('payment_status', 'approved')
            .single();

        if (error || !subscription) {
            console.error('❌ AuthGuard: Assinatura não encontrada ou não aprovada');
            alert('⚠️ Você ainda não possui um plano ativo!\n\nPor favor, adquira um plano para continuar.');
            window.location.href = 'planos.html';
            return null;
        }

        console.log('✅ AuthGuard: Assinatura ativa encontrada:', subscription.plans.name);

        return {
            email: session.user.email,
            name: session.user.user_metadata.name || 'Usuário',
            plan: subscription.plans.name,
            planLevel: subscription.plans.max_profiles
        };
    },

    async performLogout() {
        console.log('🚪 AuthGuard: Realizando logout...');
        await supabase.auth.signOut();
        window.location.href = 'login.html';
    }
};

// PROTEÇÃO AUTOMÁTICA DA DASHBOARD
(async function protectPage() {
    // Verificar se a página tem conteúdo protegido
    const protectedContent = document.querySelector('[data-protected-content]');
    
    if (!protectedContent) {
        console.log('ℹ️ AuthGuard: Página não protegida, pulando verificação.');
        return;
    }

    console.log('🛡️ AuthGuard: Página protegida detectada, iniciando verificação...');

    // Mostrar loading
    const authLoading = document.getElementById('authLoading');
    if (authLoading) {
        authLoading.style.display = 'flex';
    }

    // Esconder conteúdo protegido
    protectedContent.style.display = 'none';

    try {
        // 1. Verificar se está autenticado
        const user = await AuthGuard.checkAuth();
        if (!user) return; // Já redireciona automaticamente

        // 2. Verificar se tem assinatura ativa
        const userData = await AuthGuard.getUserData();
        if (!userData) return; // Já redireciona automaticamente

        // 3. Tudo OK, liberar acesso
        console.log('✅ AuthGuard: Acesso liberado!');
        
        if (authLoading) {
            authLoading.style.display = 'none';
        }
        protectedContent.style.display = 'block';

        // Atualizar dados do usuário na interface
        const userNameElement = document.getElementById('userName');
        const userPlanElement = document.querySelector('[data-user-plan]');
        
        if (userNameElement) {
            userNameElement.textContent = userData.name;
        }
        if (userPlanElement) {
            userPlanElement.textContent = `Plano ${userData.plan}`;
        }

    } catch (error) {
        console.error('❌ AuthGuard: Erro na verificação:', error);
        alert('Erro ao verificar autenticação. Por favor, faça login novamente.');
        window.location.href = 'login.html';
    }
})();

// Expor globalmente
window.AuthGuard = AuthGuard;