// auth-guard.js
import { supabase } from './supabase-client.js';

const AuthGuard = {
    async checkAuth() {
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session) {
            window.location.href = 'login.html';
            return null;
        }
        
        return session.user;
    },

    async getUserData() {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return null;

        // Buscar assinatura do usuário
        const { data: subscription } = await supabase
            .from('subscriptions')
            .select('*, plans(*)')
            .eq('user_id', session.user.id)
            .eq('payment_status', 'approved')
            .single();

        if (!subscription) {
            alert('Você precisa adquirir um plano primeiro!');
            window.location.href = 'planos.html';
            return null;
        }

        return {
            email: session.user.email,
            name: session.user.user_metadata.name || 'Usuário',
            plan: subscription.plans.name,
            planLevel: subscription.plans.max_profiles
        };
    },

    async performLogout() {
        await supabase.auth.signOut();
        window.location.href = 'login.html';
    }
};

// Proteção automática
if (document.querySelector('[data-protected-content]')) {
    AuthGuard.checkAuth();
}

window.AuthGuard = AuthGuard;