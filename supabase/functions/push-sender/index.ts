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

        const { user_id, title, body, data } = await req.json()

        console.log(`Sending push to user ${user_id}: ${title}`);

        // 1. Obtener suscripciones del usuario
        const { data: subs, error } = await supabaseClient
            .from('push_subscriptions')
            .select('*')
            .eq('user_id', user_id)

        if (error || !subs || subs.length === 0) {
            console.log("No subscriptions found for user");
            return new Response(JSON.stringify({ message: 'No subscriptions' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // 2. Guardar en Historial
        await supabaseClient.from('notifications_history').insert({
            user_id,
            title,
            body,
            data
        });

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
