// Setup: npm i -g supabase
// Deploy: supabase functions deploy ai-brain --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const META_TOKEN = Deno.env.get('META_ACCESS_TOKEN') ?? '';
const META_PHONE_ID = Deno.env.get('META_PHONE_ID') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
    try {
        const { conversation_id, user_message, action, agent_message } = await req.json();

        // 1. Obtener Info del Contacto y Conversacion
        const { data: conversation } = await supabase.from('comm_conversations').select('*, leads(*)').eq('id', conversation_id).single();

        if (!conversation) {
            throw new Error("Conversación no encontrada");
        }

        let textToSend = "";

        // --- MODO 1: RESPUESTA MANUAL DEL AGENTE ---
        if (action === 'manual_reply') {
            textToSend = agent_message;

            // Guardar mensaje del agente
            await supabase.from('comm_messages').insert({
                conversation_id: conversation_id,
                sender_type: 'agent',
                content: textToSend
            });

            // Actualizar estado a 'agent_handling' para pausar a la IA
            await supabase.from('comm_conversations').update({ status: 'agent_handling' }).eq('id', conversation_id);

        } else {
            // --- MODO 2: RESPUESTA AUTOMÁTICA IA (GEMINI) ---

            // Obtenemos historial (Últimos 10)
            const { data: history } = await supabase
                .from('comm_messages')
                .select('sender_type, content')
                .eq('conversation_id', conversation_id)
                .order('created_at', { ascending: false })
                .limit(10);

            const chatHistory = (history || []).reverse().map(msg => ({
                role: msg.sender_type === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            }));

            let systemInstruction = `Eres "Segumex IA", un asistente virtual experto en seguros. Tu tono es profesional pero cercano.
        Objetivo: Ayudar a clientes con dudas, calificar leads y agendar citas.
        Si no sabes una respuesta, ofrece contactar a un humano.
        NO inventes coberturas de seguros.
        
        IMPORTANTE: Responde de manera concisa, ideal para WhatsApp.
        `;

            if (conversation.leads) {
                systemInstruction += `\nEstás hablando con ${conversation.leads.nombre} ${conversation.leads.apellido}.`;
            }

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

            const payload = {
                contents: chatHistory,
                systemInstruction: { parts: [{ text: systemInstruction }] }
            };

            const response = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const aiData = await response.json();

            if (aiData.candidates && aiData.candidates[0].content && aiData.candidates[0].content.parts) {
                textToSend = aiData.candidates[0].content.parts[0].text;
            } else {
                console.error("Gemini Error:", JSON.stringify(aiData));
                // No enviamos nada si la IA falla silenciosamente o podríamos enviar un mensaje de error genérico
                textToSend = "Disculpa, no entendí eso. Un asesor te contactará.";
            }

            // Guardar Respuesta de IA
            await supabase.from('comm_messages').insert({
                conversation_id: conversation_id,
                sender_type: 'ai',
                content: textToSend
            });
        }

        // --- ENVIAR A WHATSAPP (Meta API) ---
        if (textToSend && conversation.platform_user_id) {
            // Simple validación de número (Meta requiere formato sin +)
            const toPhone = conversation.platform_user_id.replace('+', '');

            const metaRes = await fetch(`https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${META_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: toPhone,
                    text: { body: textToSend }
                })
            });

            if (!metaRes.ok) {
                const errBody = await metaRes.text();
                console.error("Meta API Error:", errBody);
            }
        }

        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });

    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
});
