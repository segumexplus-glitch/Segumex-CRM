// Setup: npm i -g supabase
// Deploy: supabase functions deploy webhook-meta --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const META_VERIFY_TOKEN        = Deno.env.get('META_VERIFY_TOKEN') ?? 'segumex_secure_token';

Deno.serve(async (req) => {
    const { method } = req;
    const url = new URL(req.url);

    // ─────────────────────────────────────────────────────────
    // GET — Verificación del webhook por Meta
    // ─────────────────────────────────────────────────────────
    if (method === 'GET') {
        const mode      = url.searchParams.get('hub.mode');
        const token     = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');

        if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
            console.log('✅ Webhook Meta verificado');
            return new Response(challenge ?? '', { status: 200 });
        }
        return new Response('Forbidden', { status: 403 });
    }

    if (method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // ─────────────────────────────────────────────────────────
    // POST — Mensajes entrantes
    // ─────────────────────────────────────────────────────────
    try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const body     = await req.json();
        console.log('📦 META PAYLOAD:', JSON.stringify(body).substring(0, 600));

        const objeto = body.object ?? '';

        // ── Facebook Messenger ──────────────────────────────
        if (objeto === 'page') {
            for (const entry of body.entry ?? []) {
                for (const event of entry.messaging ?? []) {
                    if (event.message?.is_echo) continue;
                    if (!event.message?.text)   continue;

                    const senderId = event.sender?.id   ?? '';
                    const texto    = event.message.text ?? '';
                    if (!senderId || !texto) continue;

                    console.log(`📘 Facebook Messenger de ${senderId}: ${texto}`);
                    const p = procesarMensajeMeta(supabase, senderId, texto, 'Usuario Facebook', 'facebook');
                    // @ts-ignore
                    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
                }
            }
            return new Response('EVENT_RECEIVED', { status: 200 });
        }

        // ── Instagram DM ────────────────────────────────────
        if (objeto === 'instagram') {
            for (const entry of body.entry ?? []) {
                for (const event of entry.messaging ?? []) {
                    if (event.message?.is_echo) continue;
                    if (!event.message?.text)   continue;

                    const senderId = event.sender?.id   ?? '';
                    const texto    = event.message.text ?? '';
                    if (!senderId || !texto) continue;

                    console.log(`📸 Instagram DM de ${senderId}: ${texto}`);
                    const p = procesarMensajeMeta(supabase, senderId, texto, 'Usuario Instagram', 'instagram');
                    // @ts-ignore
                    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
                }
            }
            return new Response('EVENT_RECEIVED', { status: 200 });
        }

        // ── WhatsApp Business API (Meta nativa) ─────────────
        if (objeto === 'whatsapp_business_account' || body.entry?.[0]?.changes) {
            for (const entry of body.entry ?? []) {
                for (const change of entry.changes ?? []) {
                    const value    = change.value ?? {};
                    const messages = value.messages ?? [];
                    const phoneId  = value.metadata?.phone_number_id ?? 'meta_waba';

                    for (const message of messages) {
                        const from = message.from ?? '';
                        const text = message.text?.body ?? '';
                        if (!from || !text) continue;

                        console.log(`💬 WhatsApp Business (Meta) de ${from}: ${text}`);
                        const p = procesarMensajeWABA(supabase, from, text, phoneId, message);
                        // @ts-ignore
                        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
                    }
                }
            }
            return new Response('EVENT_RECEIVED', { status: 200 });
        }

        return new Response('EVENT_RECEIVED', { status: 200 });

    } catch (e) {
        console.error('❌ Error webhook-meta:', e);
        return new Response('Internal Server Error', { status: 500 });
    }
});

// ============================================================
// Procesa mensajes de Facebook Messenger e Instagram DM
// ============================================================
async function procesarMensajeMeta(
    supabase: any,
    senderId: string,
    texto: string,
    senderName: string,
    plataforma: 'facebook' | 'instagram'
) {
    const identifier      = `meta_${plataforma}`;
    const nombreCanal     = plataforma === 'instagram' ? 'Instagram DM' : 'Facebook Messenger';
    const emojiPlataforma = plataforma === 'instagram' ? '📸' : '📘';

    // A. Canal
    let { data: channel } = await supabase
        .from('comm_channels')
        .select('id')
        .eq('identifier', identifier)
        .maybeSingle();

    if (!channel) {
        const { data: newChannel, error } = await supabase
            .from('comm_channels')
            .insert({ platform: plataforma, identifier, name: nombreCanal })
            .select()
            .single();
        if (error) { console.error('Error creando canal Meta:', error); return; }
        channel = newChannel;
    }

    // B. Conversación
    let { data: conversation } = await supabase
        .from('comm_conversations')
        .select('*')
        .eq('channel_id', channel.id)
        .eq('platform_user_id', senderId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!conversation) {
        const { data: newConv, error } = await supabase
            .from('comm_conversations')
            .insert({
                channel_id: channel.id,
                platform_user_id: senderId,
                status: 'ai_handling',
                metadata: { name: senderName, platform: plataforma }
            })
            .select()
            .single();
        if (error) { console.error('Error creando conversación Meta:', error); return; }
        conversation = newConv;
    }

    // C. Guardar mensaje
    await supabase.from('comm_messages').insert({
        conversation_id: conversation.id,
        sender_type: 'user',
        content: texto
    });

    // D. Invocar ai-brain o notificar agente
    if (conversation.status === 'ai_handling') {
        const aiPromise = supabase.functions.invoke('ai-brain', {
            body: { conversation_id: conversation.id, user_message: texto }
        });
        // @ts-ignore
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(aiPromise);
    } else {
        supabase.functions.invoke('push-sender', {
            body: {
                notify_all: true,
                title: `${emojiPlataforma} Mensaje de ${senderName}`,
                body: texto.substring(0, 100),
                data: { url: 'buzon.html' }
            }
        });
    }

    // E. Push en primer mensaje nuevo
    if (conversation.status === 'ai_handling') {
        const { count } = await supabase
            .from('comm_messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversation.id)
            .eq('sender_type', 'user');

        if ((count ?? 0) <= 1) {
            supabase.functions.invoke('push-sender', {
                body: {
                    notify_all: true,
                    title: `${emojiPlataforma} Nuevo contacto ${plataforma}`,
                    body: `${senderName}: ${texto.substring(0, 80)}`,
                    data: { url: 'buzon.html' }
                }
            });
        }
    }
}

// ============================================================
// Procesa mensajes de WhatsApp Business API (Meta nativa)
// ============================================================
async function procesarMensajeWABA(
    supabase: any,
    from: string,
    text: string,
    phoneId: string,
    rawMessage: any
) {
    let { data: channel } = await supabase
        .from('comm_channels')
        .select('id')
        .eq('identifier', phoneId)
        .maybeSingle();

    if (!channel) {
        const { data: newChannel } = await supabase
            .from('comm_channels')
            .insert({ platform: 'whatsapp', identifier: phoneId, name: 'WhatsApp Business (Meta)' })
            .select()
            .single();
        channel = newChannel;
    }

    if (!channel) return;

    let { data: conversation } = await supabase
        .from('comm_conversations')
        .select('*')
        .eq('channel_id', channel.id)
        .eq('platform_user_id', from)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!conversation) {
        const { data: newConv } = await supabase
            .from('comm_conversations')
            .insert({ channel_id: channel.id, platform_user_id: from, status: 'ai_handling' })
            .select()
            .single();
        conversation = newConv;
    }

    if (!conversation) return;

    await supabase.from('comm_messages').insert({
        conversation_id: conversation.id,
        sender_type: 'user',
        content: text,
        metadata: rawMessage
    });

    if (conversation.status === 'ai_handling') {
        const aiPromise = supabase.functions.invoke('ai-brain', {
            body: { conversation_id: conversation.id, user_message: text }
        });
        // @ts-ignore
        if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(aiPromise);
    }
}
