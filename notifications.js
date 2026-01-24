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
    const btn = document.getElementById('btnNotificaciones');

    if (subscription) {
        console.log("✅ Ya suscrito:", subscription);
        updateBtnState(true);
        // Opcional: Actualizar en DB por si cambió
        syncSubscription(subscription);
    } else {
        console.log("🔕 No suscrito");
        updateBtnState(false);
    }
}

function updateBtnState(isSubscribed) {
    const btn = document.getElementById('btnNotificaciones');
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
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
        // Desuscribir (Opcional, por ahora solo visual)
        // await subscription.unsubscribe();
        alert("Ya estás suscrito. Para desactivar, hazlo desde la configuración del navegador.");
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
        alert("¡Notificaciones Activadas! Te avisaremos de pólizas por vencer.");

    } catch (e) {
        console.error("Error suscribiendo:", e);
        alert("Error activando notificaciones: " + e.message);
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
