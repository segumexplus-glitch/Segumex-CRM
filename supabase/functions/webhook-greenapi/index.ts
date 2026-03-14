// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-greenapi --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

Deno.serve(async (req) => {
    const { method } = req;

    if (method !== 'POST') {
        return new Response('Only POST allowed', { status: 405 });
    }

    try {
        const body = await req.json();
        console.log("📦 GREEN API PAYLOAD:", JSON.stringify(body));

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const typeMessage = body.messageData?.typeMessage;

        // --------------------------------------------------------
        // CASO A: Voto de encuesta (pollUpdateMessage)
        // --------------------------------------------------------
        if (body.typeWebhook === 'incomingMessageReceived' && typeMessage === 'pollUpdateMessage') {

            const chatId = body.senderData?.chatId;
            if (!chatId) return new Response('OK', { status: 200 });

            const votes: any[] = body.messageData?.pollUpdateMessage?.votes || [];

            // Solo procesar opciones que tienen al menos un votante (el propio usuario)
            const selectedOptions: string[] = votes
                .filter((v: any) => v.optionVoters && v.optionVoters.length > 0)
                .map((v: any) => v.optionName as string);

            if (selectedOptions.length === 0) {
                // El usuario deseleccionó todo — ignorar
                return new Response('OK', { status: 200 });
            }

            console.log(`🗳️ Poll vote de ${chatId}: [${selectedOptions.join(', ')}]`);

            // Buscar la conversación más reciente de este chatId
            const { data: conversation } = await supabase
                .from('comm_conversations')
                .select('id, status')
                .eq('platform_user_id', chatId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!conversation) {
                console.warn('No se encontró conversación para', chatId);
                return new Response('OK', { status: 200 });
            }

            // Llamar ai-brain con la respuesta de la encuesta
            const aiPromise = supabase.functions.invoke('ai-brain', {
                body: {
                    action: 'poll_response',
                    conversation_id: conversation.id,
                    selected_options: selectedOptions,
                    poll_chat_id: chatId
                }
            });

            // @ts-ignore
            if (typeof EdgeRuntime !== 'undefined') {
                EdgeRuntime.waitUntil(aiPromise);
            }

            return new Response('OK', { status: 200 });
        }

        // --------------------------------------------------------
        // CASO B: Mensaje de texto normal (textMessage)
        // --------------------------------------------------------
        if (body.typeWebhook === 'incomingMessageReceived' && typeMessage === 'textMessage') {

            const senderData = body.senderData;
            const messageData = body.messageData.textMessageData;

            const chatId      = senderData.chatId;
            const text        = messageData.textMessage;
            const senderName  = senderData.senderName || 'Usuario WhatsApp';
            const instanceId  = body.instanceData.idInstance.toString();

            console.log(`Mensaje recibido de ${chatId}: ${text}`);

            // A. Buscar o crear canal
            let { data: channel } = await supabase
                .from('comm_channels')
                .select('id')
                .eq('identifier', instanceId)
                .single();

            if (!channel) {
                const { data: newChannel, error: channelError } = await supabase
                    .from('comm_channels')
                    .insert({ platform: 'whatsapp', identifier: instanceId, name: 'Green API WA' })
                    .select()
                    .single();
                if (channelError) console.error("Error creando canal:", channelError);
                else channel = newChannel;
            }

            if (channel) {
                // B. Buscar o crear conversación
                let { data: conversation } = await supabase
                    .from('comm_conversations')
                    .select('*')
                    .eq('channel_id', channel.id)
                    .eq('platform_user_id', chatId)
                    .single();

                if (!conversation) {
                    const { data: newConv, error: convError } = await supabase
                        .from('comm_conversations')
                        .insert({
                            channel_id: channel.id,
                            platform_user_id: chatId,
                            status: 'ai_handling',
                            metadata: { name: senderName }
                        })
                        .select()
                        .single();
                    if (convError) console.error("Error creando conversación:", convError);
                    conversation = newConv;
                }

                // C. Guardar mensaje del usuario
                if (conversation) {
                    await supabase.from('comm_messages').insert({
                        conversation_id: conversation.id,
                        sender_type: 'user',
                        content: text,
                        metadata: body
                    });

                    // D. Invocar ai-brain
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
