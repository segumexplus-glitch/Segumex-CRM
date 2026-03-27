// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-greenapi --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim() ?? '';

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
            const selectedOptions: string[] = votes
                .filter((v: any) => v.optionVoters && v.optionVoters.length > 0)
                .map((v: any) => v.optionName as string);

            if (selectedOptions.length === 0) return new Response('OK', { status: 200 });

            console.log(`🗳️ Poll vote de ${chatId}: [${selectedOptions.join(', ')}]`);

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

            const aiPromise = supabase.functions.invoke('ai-brain', {
                body: { action: 'poll_response', conversation_id: conversation.id, selected_options: selectedOptions, poll_chat_id: chatId }
            });
            // @ts-ignore
            if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(aiPromise);
            return new Response('OK', { status: 200 });
        }

        // --------------------------------------------------------
        // CASO B: Mensaje de texto normal (textMessage)
        // --------------------------------------------------------
        if (body.typeWebhook === 'incomingMessageReceived' && typeMessage === 'textMessage') {

            const senderData  = body.senderData;
            const chatId      = senderData.chatId;
            const text        = body.messageData.textMessageData.textMessage;
            const senderName  = senderData.senderName || 'Usuario WhatsApp';
            const instanceId  = body.instanceData.idInstance.toString();

            console.log(`💬 Texto de ${chatId}: ${text}`);
            await procesarMensajeEntrante(supabase, chatId, text, senderName, instanceId, body);
            return new Response('OK', { status: 200 });
        }

        // --------------------------------------------------------
        // CASO C: Mensaje de audio / nota de voz
        // --------------------------------------------------------
        if (body.typeWebhook === 'incomingMessageReceived' &&
            (typeMessage === 'audioMessage' || typeMessage === 'voiceMessage')) {

            const senderData  = body.senderData;
            const chatId      = senderData.chatId;
            const senderName  = senderData.senderName || 'Usuario WhatsApp';
            const instanceId  = body.instanceData.idInstance.toString();

            const downloadUrl = body.messageData?.fileMessageData?.downloadUrl
                             ?? body.messageData?.audioMessageData?.downloadUrl;

            if (!downloadUrl) {
                console.warn('⚠️ Audio sin downloadUrl, ignorando.');
                return new Response('OK', { status: 200 });
            }

            console.log(`🎤 Audio recibido de ${chatId}. Transcribiendo...`);
            const transcripcion = await transcribirAudio(downloadUrl);

            if (!transcripcion) {
                // No se pudo transcribir → notificar al agente manualmente
                await supabase.functions.invoke('push-sender', {
                    body: {
                        notify_all: true,
                        title: `🎤 Audio de ${senderName}`,
                        body: 'El cliente envió un audio. No se pudo transcribir automáticamente.',
                        data: { url: 'buzon.html' }
                    }
                });
                return new Response('OK', { status: 200 });
            }

            console.log(`✅ Transcripción: "${transcripcion}"`);

            // Procesar como si fuera un mensaje de texto (con prefijo visual para el buzon)
            const textoConPrefijo = `🎤 ${transcripcion}`;
            await procesarMensajeEntrante(supabase, chatId, textoConPrefijo, senderName, instanceId, body, transcripcion);
            return new Response('OK', { status: 200 });
        }

        return new Response('OK', { status: 200 });

    } catch (e) {
        console.error(e);
        return new Response('Internal Server Error', { status: 500 });
    }
});

// ============================================================
// Transcribe un audio usando Gemini 2.0 Flash
// ============================================================
async function transcribirAudio(downloadUrl: string): Promise<string | null> {
    try {
        // 1. Descargar el archivo de audio
        const audioRes = await fetch(downloadUrl);
        if (!audioRes.ok) {
            console.error('Error descargando audio:', audioRes.status);
            return null;
        }

        const mimeType = audioRes.headers.get('content-type') || 'audio/ogg; codecs=opus';
        const buffer = await audioRes.arrayBuffer();

        // 2. Convertir a base64 en bloques (evita stack overflow con archivos grandes)
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
        }
        const audioBase64 = btoa(binary);

        // 3. Enviar a Gemini para transcripción
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const geminiRes = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType: mimeType.split(';')[0].trim(), // limpia "audio/ogg; codecs=opus" → "audio/ogg"
                                data: audioBase64
                            }
                        },
                        {
                            text: 'Transcribe exactamente lo que se dice en este audio en español. Responde ÚNICAMENTE con la transcripción, sin comillas, sin explicaciones, sin notas adicionales.'
                        }
                    ]
                }]
            })
        });

        const data = await geminiRes.json();
        const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        return texto || null;

    } catch (err) {
        console.error('Error en transcribirAudio:', err);
        return null;
    }
}

// ============================================================
// Lógica compartida: procesar mensaje entrante (texto o audio)
// Crea/busca canal → conversación → guarda mensaje → invoca ai-brain
// ============================================================
async function procesarMensajeEntrante(
    supabase: any,
    chatId: string,
    textoBuzon: string,    // texto que se guarda en comm_messages (puede llevar prefijo 🎤)
    senderName: string,
    instanceId: string,
    rawBody: any,
    textoParaIA?: string   // texto limpio para ai-brain (sin prefijo); si no se pasa, usa textoBuzon
) {
    const mensajeParaIA = textoParaIA ?? textoBuzon;

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

    if (!channel) return;

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

    if (!conversation) return;

    // C. Guardar mensaje del usuario en el buzón
    await supabase.from('comm_messages').insert({
        conversation_id: conversation.id,
        sender_type: 'user',
        content: textoBuzon,
        metadata: rawBody
    });

    // D. Invocar ai-brain o notificar al agente
    if (conversation.status === 'ai_handling') {
        console.log("🤖 Invocando AI Brain...");
        const aiPromise = supabase.functions.invoke('ai-brain', {
            body: { conversation_id: conversation.id, user_message: mensajeParaIA }
        });
        // @ts-ignore
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(aiPromise);
    } else {
        const pushPromise = supabase.functions.invoke('push-sender', {
            body: {
                notify_all: true,
                title: `💬 Mensaje de ${senderName}`,
                body: textoBuzon.substring(0, 100),
                data: { url: 'buzon.html' }
            }
        });
        // @ts-ignore
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(pushPromise);
    }

    // E. Notificar en primer mensaje de conversación nueva
    if (conversation.status === 'ai_handling') {
        const { count } = await supabase
            .from('comm_messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversation.id)
            .eq('sender_type', 'user');

        if ((count ?? 0) <= 1) {
            const newMsgPush = supabase.functions.invoke('push-sender', {
                body: {
                    notify_all: true,
                    title: `📲 Nuevo contacto WA`,
                    body: `${senderName}: ${textoBuzon.substring(0, 80)}`,
                    data: { url: 'buzon.html' }
                }
            });
            // @ts-ignore
            if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(newMsgPush);
        }
    }
}
