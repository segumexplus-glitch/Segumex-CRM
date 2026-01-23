// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-meta --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VERIFY_TOKEN = Deno.env.get('META_VERIFY_TOKEN') || 'segumex_secure_token';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
    const { method } = req;
    const url = new URL(req.url);

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
            const body = await req.json();

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
                    const platform = 'whatsapp';
                    const businessPhoneId = change.metadata.phone_number_id;

                    // A. Buscar o Crear Canal
                    let { data: channel } = await supabase
                        .from('comm_channels')
                        .select('id')
                        .eq('identifier', businessPhoneId)
                        .single();

                    if (!channel) {
                        // Crear canal temporal si no existe
                        const { data: newChannel } = await supabase.from('comm_channels').insert({
                            platform: 'whatsapp',
                            identifier: businessPhoneId,
                            name: 'WhatsApp Business'
                        }).select().single();
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
                        const { data: newConv } = await supabase.from('comm_conversations').insert({
                            channel_id: channel?.id,
                            platform_user_id: phoneNumber,
                            status: 'ai_handling'
                        }).select().single();
                        conversation = newConv;
                    }

                    // C. Guardar Mensaje del Usuario
                    await supabase.from('comm_messages').insert({
                        conversation_id: conversation.id,
                        sender_type: 'user',
                        content: text,
                        metadata: message
                    });

                    // D. Invocar al Cerebro (AI Brain) asíncronamente
                    // No esperamos la respuesta para que Meta no nos de timeout
                    if (conversation.status === 'ai_handling' && text !== '[Multimedia]') {
                        supabase.functions.invoke('ai-brain', {
                            body: { conversation_id: conversation.id, user_message: text }
                        });
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
