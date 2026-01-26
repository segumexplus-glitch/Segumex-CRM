// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-greenapi --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

Deno.serve(async (req) => {
    const { method } = req;

    // Green API envía POST para notificaciones
    if (method !== 'POST') {
        return new Response('Only POST allowed', { status: 405 });
    }

    try {
        const body = await req.json();
        console.log("📦 GREEN API PAYLOAD:", JSON.stringify(body));

        // Solo nos interesan los mensajes entrantes (texto)
        if (body.typeWebhook === 'incomingMessageReceived' && body.messageData?.typeMessage === 'textMessage') {

            const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

            const senderData = body.senderData;
            const messageData = body.messageData.textMessageData;

            const chatId = senderData.chatId; // Ej: 5211234567890@c.us
            const phoneNumber = chatId.replace('@c.us', '');
            const text = messageData.textMessage;
            const senderName = senderData.senderName || 'Usuario WhatsApp';

            // Usamos el ID de instancia como identificador del canal
            const instanceId = body.instanceData.idInstance.toString();

            console.log(`Mensaje recibido de ${phoneNumber}: ${text}`);

            // A. Buscar o Crear Canal (Green API Instance)
            let { data: channel } = await supabase
                .from('comm_channels')
                .select('id')
                .eq('identifier', instanceId)
                .single();

            if (!channel) {
                // Si no existe, lo creamos.
                const { data: newChannel, error: channelError } = await supabase.from('comm_channels').insert({
                    platform: 'whatsapp',
                    identifier: instanceId,
                    name: 'Green API WA'
                }).select().single();

                if (channelError) {
                    console.error("Error creando canal:", channelError);
                    // Fallback: intentar buscar un canal genérico o reusar uno existente si falla la creación única
                } else {
                    channel = newChannel;
                }
            }


            if (channel) {

                // B. Buscar o Crear Conversación
                let { data: conversation } = await supabase
                    .from('comm_conversations')
                    .select('*')
                    .eq('channel_id', channel.id)
                    .eq('platform_user_id', chatId) // Guardamos el chatId completo (con @c.us) para responder fácil
                    .single();

                if (!conversation) {
                    const { data: newConv, error: convError } = await supabase.from('comm_conversations').insert({
                        channel_id: channel.id,
                        platform_user_id: chatId,
                        status: 'ai_handling',
                        metadata: { name: senderName }
                    }).select().single();
                    if (convError) console.error("Error creando conversación:", convError);
                    conversation = newConv;
                }

                // C. Guardar Mensaje del Usuario
                if (conversation) {
                    await supabase.from('comm_messages').insert({
                        conversation_id: conversation.id,
                        sender_type: 'user',
                        content: text,
                        metadata: body
                    });

                    // D. Invocar al Cerebro (AI Brain)
                    if (conversation.status === 'ai_handling') {
                        console.log("Invocando AI Brain...");
                        const aiPromise = supabase.functions.invoke('ai-brain', {
                            body: { conversation_id: conversation.id, user_message: text }
                        });

                        // @ts-ignore
                        if (typeof EdgeRuntime !== 'undefined') {
                            EdgeRuntime.waitUntil(aiPromise);
                        }
                    }
                }
            }
        }

        return new Response('OK', { status: 200 });

    } catch (e) {
        console.error(e);
        return new Response('Internal Server Error', { status: 500 });
    }
});
