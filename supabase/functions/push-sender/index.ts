// Follow this setup guide to integrate the Deno runtime into your application:
// https://deno.land/manual/runtime/web_platform_apis

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'https://esm.sh/web-push@3.6.3'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// VAPID KEYS (Generadas dinámicamente)
const publicVapidKey = 'BC49QJYejPNKZWplyifz-acdngsr_X5gYVChortVmr02SUFbUXjqlM1OUzrR8d-w-9bHOcOQBNSEGTOKx5GW5c0';
const privateVapidKey = 'muAhruKDcBbvCAg7PuX_1h2qNbGg9TZLHeI02R4A7s0';

webpush.setVapidDetails(
    'mailto:admin@segumex.com',
    publicVapidKey,
    Deno.env.get('VAPID_PRIVATE_KEY') || privateVapidKey
);

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        const { user_id, notify_all, title, body, data } = await req.json()

        // Resolver qué usuarios notificar
        let targetUserIds: string[] = [];
        if (notify_all) {
            const { data: allSubs } = await supabaseClient
                .from('push_subscriptions')
                .select('user_id');
            targetUserIds = [...new Set((allSubs || []).map((s: any) => s.user_id as string))];
            console.log(`Sending push to ALL users (${targetUserIds.length}): ${title}`);
        } else if (user_id) {
            targetUserIds = [user_id];
            console.log(`Sending push to user ${user_id}: ${title}`);
        }

        if (targetUserIds.length === 0) {
            return new Response(JSON.stringify({ message: 'No subscriptions found' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 1. Obtener suscripciones de los usuarios objetivo
        const { data: subs, error } = await supabaseClient
            .from('push_subscriptions')
            .select('*')
            .in('user_id', targetUserIds);

        if (error || !subs || subs.length === 0) {
            console.log("No subscriptions found");
            return new Response(JSON.stringify({ message: 'No subscriptions' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 2. Guardar en Historial (una entrada por usuario único)
        await Promise.all(targetUserIds.map(uid =>
            supabaseClient.from('notifications_history').insert({ user_id: uid, title, body, data })
        ));

        // 3. Enviar a todos los dispositivos del usuario
        const results = await Promise.all(subs.map(sub => {
            const pushConfig = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: atob(sub.p256dh), // Base64 decode back to string if needed by lib, or pass as is? 
                    // web-push lib expects string keys usually.
                    auth: atob(sub.auth)
                }
            };
            // En realidad web-push espera las keys tal cual vienen del navegador (base64url).
            // Pero nosotros las guardamos en base64 estándar.
            // Vamos a reconstruir el objeto subscription.

            const pushSubscription = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh, // Nuestra DB tiene base64
                    auth: sub.auth
                }
            };

            // Payload must be string
            const payload = JSON.stringify({ title, body, data });

            return webpush.sendNotification(pushSubscription, payload)
                .catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        // Expired, delete from DB
                        console.log("Expired subscription, deleting", sub.id);
                        supabaseClient.from('push_subscriptions').delete().eq('id', sub.id);
                    }
                    return { error: err };
                });
        }));

        return new Response(JSON.stringify({ success: true, results }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
        })
    }
})
