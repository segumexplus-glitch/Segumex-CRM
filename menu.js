document.addEventListener("DOMContentLoaded", async function () {
    const sidebar = document.querySelector('aside');
    if (!sidebar) return;

    // --- PWA: Registrar Service Worker & Manifest ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registrado for:', reg.scope))
            .catch(err => console.log('SW fallo:', err));
    }

    if (!document.querySelector('link[rel="manifest"]')) {
        const link = document.createElement('link');
        link.rel = 'manifest';
        link.href = 'manifest.json';
        document.head.appendChild(link);
    }

    // Inyectar Script de Notificaciones
    if (!document.querySelector('script[src="notifications.js"]')) {
        const script = document.createElement('script');
        script.src = 'notifications.js';
        script.onload = () => window.initNotifications && window.initNotifications();
        document.body.appendChild(script);
    }

    // --- SEGURIDAD: Verificar sesión real en Supabase ---
    const { data: { session } } = await window.supabaseClient.auth.getSession();

    if (!session) {
        window.location.href = 'login.html';
        return;
    }

    const sesion = JSON.parse(localStorage.getItem('segumex_sesion')) || { nombre: 'Usuario', rol: 'agente' };
    const path = window.location.pathname;
    const page = path.split("/").pop() || "index.html";

    // --- RESPONSIVE: Setup Mobile Menu ---
    window.toggleMenu = function () {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');

        if (sidebar.classList.contains('-translate-x-full')) {
            // Abrir
            sidebar.classList.remove('-translate-x-full');
            overlay?.classList.remove('hidden');
        } else {
            // Cerrar
            sidebar.classList.add('-translate-x-full');
            overlay?.classList.add('hidden');
        }
    };

    // Close menu when clicking a link on mobile
    const isMobile = window.innerWidth < 768;

    // --- OPTIMIZACIÓN: Consultar comisiones pendientes ---
    let pendientesCount = 0;
    let query = window.supabaseClient.from('polizas').select('pagos_status, comisiones_cobradas_status');

    if (sesion.rol !== 'admin') {
        query = query.eq('agente', sesion.nombre);
    }

    const { data: polizasMenu } = await query;

    if (polizasMenu) {
        polizasMenu.forEach(p => {
            if (p.pagos_status) {
                p.pagos_status.forEach((pagado, idx) => {
                    const cobrada = p.comisiones_cobradas_status && p.comisiones_cobradas_status[idx] === true;
                    if (pagado === true && !cobrada) {
                        pendientesCount++;
                    }
                });
            }
        });
    }

    const menuItems = [
        { name: 'Dashboard', icon: 'dashboard', link: 'index.html' },
        { name: 'Leads (Ventas)', icon: 'filter_alt', link: 'leads.html' },
        { name: 'Buzón AI', icon: 'chat_bubble', link: 'buzon.html' },
        { name: 'Clientes', icon: 'group', link: 'clientes.html' },
        { name: 'Pólizas', icon: 'description', link: 'polizas.html' },
        { name: 'Pay Tracker', icon: 'account_balance_wallet', link: 'cobranza.html' },
        { name: 'Comisiones', icon: 'payments', link: 'comisiones.html', badge: pendientesCount },
        { name: 'Siniestros', icon: 'medical_services', link: 'siniestros.html' },
        { name: 'Reportes', icon: 'analytics', link: 'reportes.html' },
        { name: 'Marketing', icon: 'campaign', link: 'marketing.html' },
        { name: 'Task Planner', icon: 'task_alt', link: 'tareas.html' },
        // Botón especial de Notificaciones insertado como item del menú
        {
            name: 'Alertas',
            icon: 'notifications_off',
            id: 'btnNotificaciones',
            action: 'toggleNotification()',
            specialClass: 'text-[#9da6b9]'
        }
    ];

    if (sesion.rol === 'admin') {
        menuItems.push({ name: 'Comisiones (R)', icon: 'lock_person', link: 'comisiones_restringidas.html' });
        menuItems.push({ name: 'Pay Tracker (R)', icon: 'lock_person', link: 'cobranza_restringida.html' });
        menuItems.push({ name: 'Usuarios', icon: 'manage_accounts', link: 'usuarios.html' });
    }

    let menuHTML = `
        <div class="flex h-full flex-col justify-between p-4 overflow-y-auto scrollbar-hide">
            <div class="flex flex-col gap-6">
                <div class="flex items-center gap-3 px-2">
                    <div class="bg-primary h-10 w-10 rounded-full flex items-center justify-center font-bold text-white shadow-lg shadow-blue-900/20">SX</div>
                    <div class="flex flex-col">
                        <h1 class="text-white text-base font-semibold leading-tight">Segumex</h1>
                        <p class="text-[#94a3b8] text-xs font-normal">${sesion.rol === 'admin' ? 'Administrador' : 'Agente Segumex'}</p>
                    </div>
                </div>
                <div class="flex flex-col gap-2">
    `;

    menuItems.forEach(item => {
        const isActive = page === item.link;

        let activeClass = isActive
            ? "bg-primary/10 text-primary border border-primary/20 font-bold"
            : "text-[#94a3b8] hover:bg-[#1f242e] hover:text-white transition-colors group";

        // Overrides para botones especiales
        if (item.specialClass && !isActive) {
            activeClass = item.specialClass + " hover:bg-[#1f242e] hover:text-white transition-colors group";
        }

        const iconClass = isActive ? "text-primary" : "text-[#94a3b8] group-hover:text-white";

        const badgeHTML = (item.badge && item.badge > 0)
            ? `<span class="ml-auto bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full shadow-lg shadow-red-900/20">${item.badge}</span>`
            : "";

        if (item.action) {
            // Es un botón con acción (Notificaciones)
            menuHTML += `
            <button id="${item.id}" onclick="${item.action}" class="w-full flex items-center gap-3 px-3 py-3 rounded-lg ${activeClass} text-left">
                <span class="material-symbols-outlined ${iconClass}">${item.icon}</span>
                <p class="text-sm">${item.name}</p>
                ${badgeHTML}
            </button>
            `;
        } else {
            menuHTML += `
            <a class="flex items-center gap-3 px-3 py-3 rounded-lg ${activeClass}" href="${item.link}">
                <span class="material-symbols-outlined ${iconClass}">${item.icon}</span>
                <p class="text-sm">${item.name}</p>
                ${badgeHTML}
            </a>
        `;
        }
    });

    menuHTML += `
                </div>
            </div>
            <div class="px-2 py-4 border-t border-[#2d3442]">
                <div class="flex items-center gap-3 mb-3">
                    <div class="size-8 rounded bg-primary/20 flex items-center justify-center text-primary">
                        <span class="material-symbols-outlined text-sm">person</span>
                    </div>
                    <div class="overflow-hidden">
                        <p class="text-white text-[11px] font-bold truncate">${sesion.nombre}</p>
                    </div>
                </div>
                <button onclick="logout()" class="w-full flex items-center gap-2 text-[#94a3b8] hover:text-red-400 text-[10px] font-black uppercase tracking-widest transition-colors">
                    <span class="material-symbols-outlined text-sm">logout</span> Cerrar Sesión
                </button>
                <p class="text-[8px] text-[#475569] uppercase font-bold tracking-widest text-center mt-4">Segumex CRM v2.6</p>
            </div>
        </div>
    `;

    sidebar.innerHTML = menuHTML;

    // --- RESPONSIVE: Auto-close on link click ---
    if (window.innerWidth < 768) {
        const links = sidebar.querySelectorAll('a, button');
        links.forEach(link => {
            link.addEventListener('click', () => {
                // Don't close for notification toggle if desired, but for navigation yes.
                // Assuming we want to close menu after clicking anything
                const sidebar = document.getElementById('sidebar');
                const overlay = document.getElementById('sidebarOverlay');
                sidebar.classList.add('-translate-x-full');
                overlay?.classList.add('hidden');
            });
        });
    }
});

async function logout() {
    await window.supabaseClient.auth.signOut();
    localStorage.removeItem('segumex_sesion');
    window.location.href = 'login.html';
}