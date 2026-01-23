
// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-meta --no-verify-jwt

Deno.serve(async (req) => {
    const { method } = req;
    const url = new URL(req.url);

    // 1. Verificación (GET)
    if (method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');
        if (mode === 'subscribe' && token === 'segumex_secure_token') {
            return new Response(challenge, { status: 200 });
        }
        return new Response('Forbidden', { status: 403 });
    }

    // 2. Recepción (POST) - Respuesta Dummy
    if (method === 'POST') {
        console.log("Webhook recibido (Simulado)");
        return new Response('EVENT_RECEIVED', { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
});

