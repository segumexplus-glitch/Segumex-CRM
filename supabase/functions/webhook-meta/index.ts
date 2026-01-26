
// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-meta --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

// LEER VARIABLES DE ENTORNO
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VERIFY_TOKEN = Deno.env.get('META_VERIFY_TOKEN') || 'segumex_secure_token';

Deno.serve(async (req) => {
    const { method } = req;
    const url = new URL(req.url);
    console.log(` INCOMING WEBHOOK: ${method} ${url.pathname}`);


    // 1. Verificación del Webhook (Meta GET Request)
    if (method === 'GET') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            return new Response(challenge, { status: 200 });
        }
        return new Response('Forbidden', { status: 403 });
    }

    // 2. Recepción de Mensajes (Meta POST Request)
    if (method === 'POST') {
        try {
            // Lazy Load: Iniciamos Supabase
            if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
                console.error("Faltan credenciales de Supabase");
                return new Response('Config Error', { status: 200 });
            }

            const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
            const body = await req.json();
            console.log("📦 PAYLOAD:", JSON.stringify(body));

            // Verificar si es evento de WhatsApp
            if (body.object) {
                if (
                    body.entry &&
                    body.entry[0].changes &&
                    body.entry[0].changes[0] &&
                    body.entry[0].changes[0].value.messages &&
                    body.entry[0].changes[0].value.messages[0]
                ) {
                    const change = body.entry[0].changes[0].value;
                    const message = change.messages[0];
                    const phoneNumber = message.from; // Número del usuario
                    const text = message.text ? message.text.body : '[Multimedia]';
                    const businessPhoneId = change.metadata.phone_number_id;

                    console.log(`Mensaje recibido de ${phoneNumber}: ${text}`);

                    // A. Buscar o Crear Canal
                    let { data: channel } = await supabase
                        .from('comm_channels')
                        .select('id')
                        .eq('identifier', businessPhoneId)
                        .single();

                    if (!channel) {
                        const { data: newChannel, error: channelError } = await supabase.from('comm_channels').insert({
                            platform: 'whatsapp',
                            identifier: businessPhoneId,
                            name: 'WhatsApp Business'
                        }).select().single();
                        if (channelError) console.error("Error creando canal:", channelError);
                        channel = newChannel;
                    }

                    // B. Buscar o Crear Conversación
                    let { data: conversation } = await supabase
                        .from('comm_conversations')
                        .select('*')
                        .eq('channel_id', channel?.id)
                        .eq('platform_user_id', phoneNumber)
                        .single();

                    if (!conversation) {
                        const { data: newConv, error: convError } = await supabase.from('comm_conversations').insert({
                            channel_id: channel?.id,
                            platform_user_id: phoneNumber,
                            status: 'ai_handling'
                        }).select().single();
                        if (convError) console.error("Error creando conversación:", convError);
                        conversation = newConv;
                    }

                    // C. Guardar Mensaje del Usuario
                    const { error: msgError } = await supabase.from('comm_messages').insert({
                        conversation_id: conversation.id,
                        sender_type: 'user',
                        content: text,
                        metadata: message
                    });
                    if (msgError) console.error("Error guardando mensaje:", msgError);

                    // D. Invocar al Cerebro (AI Brain)
                    if (conversation.status === 'ai_handling' && text !== '[Multimedia]') {
                        console.log("Invocando AI Brain (Background Mode)...");

                        const aiPromise = supabase.functions.invoke('ai-brain', {
                            body: { conversation_id: conversation.id, user_message: text }
                        }).then(({ error }) => {
                            if (error) console.error("Error async invoking AI Brain:", error);
                            else console.log("AI Brain invocado exitosamente.");
                        });

                        // @ts-ignore
                        if (typeof EdgeRuntime !== 'undefined') {
                            console.log("EdgeRuntime detected, using waitUntil");
                            // @ts-ignore
                            EdgeRuntime.waitUntil(aiPromise);
                        } else {
                            console.log("EdgeRuntime NOT detected, executing promise without waitUntil (may timeout locally)");
                            // In local dev, we just let it float, but in prod this branch shouldn't be hit usually.
                        }
                    }
                }
                return new Response('EVENT_RECEIVED', { status: 200 });
            } else {
                return new Response('Not Found', { status: 404 });
            }
        } catch (e) {
            console.error(e);
            return new Response('Internal Server Error', { status: 500 });
        }
    }

    return new Response('Method Not Allowed', { status: 405 });
});

