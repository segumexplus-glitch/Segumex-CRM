// VAPID Public Key - IDENTIFICADOR PÚBLICO REAL
const PUBLIC_VAPID_KEY = 'BC49QJYejPNKZWplyifz-acdngsr_X5gYVChortVmr02SUFbUXjqlM1OUzrR8d-w-9bHOcOQBNSEGTOKx5GW5c0';

async function initNotifications() {
    console.log("🔔 Iniciando sistema de notificaciones...");

    // 1. Checar soporte
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn("Push messaging is not supported");
        return;
    }

    // 2. Registrar SW si no está (aunque sw.js ya lo hace, aseguramos)
    const registration = await navigator.serviceWorker.ready;

    // 3. Checar estado actual
    const subscription = await registration.pushManager.getSubscription();
    // btnNotificaciones element might not exist yet if script runs too early, but usually initNotifications is called onload
    const btn = document.getElementById('btnNotificaciones');

    if (subscription) {
        console.log("✅ Ya suscrito:", subscription);
        if (btn) updateBtnState(true);
        // Opcional: Actualizar en DB por si cambió
        syncSubscription(subscription);
    } else {
        console.log("🔕 No suscrito");
        if (btn) updateBtnState(false);
    }
}

function updateBtnState(isSubscribed) {
    const btn = document.getElementById('btnNotificaciones');
    if (!btn) return;
    const icon = btn.querySelector('span');
    if (isSubscribed) {
        icon.innerText = 'notifications_active';
        btn.classList.add('text-primary');
        btn.classList.remove('text-[#9da6b9]');
        btn.title = "Notificaciones Activas";
    } else {
        icon.innerText = 'notifications_off';
        btn.classList.remove('text-primary');
        btn.classList.add('text-[#9da6b9]');
        btn.title = "Activar Notificaciones";
    }
}

async function toggleNotification() {
    // 1. Diagnostico de Permisos
    console.log("Estado actual del permiso:", Notification.permission);

    // Si ya está denegado, avisar y salir
    if (Notification.permission === 'denied') {
        alert("⚠️ EL NAVEGADOR BLOQUEA LAS NOTIFICACIONES.\n\nEstado Interno: " + Notification.permission + "\n\nSOLUCIÓN:\n1. Ve a Preferencias de Safari > Sitios Web > Notificaciones.\n2. SELECCIONA 'localhost' y dale al botón 'Eliminar' (Remove).\n3. Recarga la página y vuelve a intentar.");
        return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
        // Ya suscrito -> Mostrar Historial (Inbox)
        console.log("Abriendo historial de notificaciones...");
        showNotificationHistory();
        return;
    }

    // Suscribir
    try {
        const newSubscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
        });

        console.log("🎉 Suscripción exitosa:", newSubscription);

        // GUARDAR EN SUPABASE
        await syncSubscription(newSubscription);

        updateBtnState(true);
        alert("¡Notificaciones Activadas Correctamente! 🔔");

    } catch (e) {
        console.error("Error suscribiendo:", e);
        // Si el error es de permisos, lo decimos claro
        if (e.message.includes("permission")) {
            alert("Error durante la suscripción: " + e.message + "\n\nEsto suele pasar si cerraste la ventana de permiso muy rápido. Intenta recargar.");
        } else {
            alert("Error Técnico: " + e.message);
        }
    }
}

async function syncSubscription(sub) {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) return;

    const p256dh = btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('p256dh'))));
    const auth = btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('auth'))));

    const payload = {
        user_id: session.user.id,
        endpoint: sub.endpoint,
        p256dh: p256dh,
        auth: auth,
        user_agent: navigator.userAgent
    };

    const { error } = await window.supabaseClient
        .from('push_subscriptions')
        .upsert(payload, { onConflict: 'endpoint' });

    if (error) console.error("Error guardando sub en DB:", error);
}

// Utilidad para convertir VAPID Key
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// Expose globally
window.toggleNotification = toggleNotification;
window.initNotifications = initNotifications;

// --- HISTORIAL DE NOTIFICACIONES (INBOX) ---
async function showNotificationHistory() {
    // 1. Crear/Limpiar Modal
    let modal = document.getElementById('notifModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'notifModal';
        modal.className = 'fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm opacity-0 transition-opacity duration-300';
        modal.onclick = (e) => { if (e.target === modal) closeNotifModal(); };
        document.body.appendChild(modal);
    }
    modal.classList.remove('pointer-events-none');

    // UI Loading
    modal.innerHTML = `
        <div class="bg-[#1e293b] w-full max-w-md rounded-2xl shadow-2xl border border-gray-700 overflow-hidden transform scale-95 transition-transform duration-300" id="notifContent">
            <div class="p-4 border-b border-gray-700 flex justify-between items-center bg-[#0f172a]">
                <h3 class="text-white font-bold text-lg flex items-center gap-2">
                    <span class="material-symbols-outlined text-primary">notifications</span>
                    Tus Notificaciones
                </h3>
                <button onclick="closeNotifModal()" class="text-gray-400 hover:text-white transition-colors">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="max-h-[60vh] overflow-y-auto p-2 space-y-2" id="notifList">
                <div class="p-8 text-center text-gray-400 animate-pulse">Cargando historial...</div>
            </div>
            <div class="p-3 bg-[#0f172a] border-t border-gray-700 text-center">
                <button onclick="closeNotifModal()" class="text-xs text-primary font-bold hover:underline">CERRAR</button>
            </div>
        </div>
    `;

    // Animate In
    requestAnimationFrame(() => {
        modal.classList.remove('opacity-0');
        modal.querySelector('#notifContent').classList.remove('scale-95');
        modal.querySelector('#notifContent').classList.add('scale-100');
    });

    // 2. Fetch de Datos
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) return;

    const { data: notifs, error } = await window.supabaseClient
        .from('notifications_history')
        .select('*')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(20);

    const listContainer = document.getElementById('notifList');

    if (error) {
        listContainer.innerHTML = `<div class="p-4 text-red-400 text-center text-sm">Error cargando: ${error.message}</div>`;
        return;
    }

    if (!notifs || notifs.length === 0) {
        listContainer.innerHTML = `
            <div class="flex flex-col items-center justify-center py-10 text-gray-500 gap-2">
                <span class="material-symbols-outlined text-4xl">notifications_off</span>
                <p class="text-sm">No tienes notificaciones aún.</p>
            </div>
        `;
        return;
    }

    // Render List
    let html = '';
    notifs.forEach(n => {
        const date = new Date(n.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        html += `
            <div class="bg-[#0f172a]/50 p-3 rounded-xl border border-gray-700 hover:border-primary/50 transition-colors group">
                <div class="flex justify-between items-start mb-1">
                    <h4 class="text-white font-semibold text-sm group-hover:text-primary transition-colors">${n.title}</h4>
                    <span class="text-[10px] text-gray-500 bg-black/20 px-1.5 py-0.5 rounded">${date}</span>
                </div>
                <p class="text-gray-400 text-xs leading-relaxed">${n.body}</p>
            </div>
        `;
    });
    listContainer.innerHTML = html;
}

window.closeNotifModal = function () {
    const modal = document.getElementById('notifModal');
    if (modal) {
        modal.classList.add('opacity-0');
        modal.querySelector('#notifContent').classList.add('scale-95');
        setTimeout(() => modal.remove(), 300);
    }
}
