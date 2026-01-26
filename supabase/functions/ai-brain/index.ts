// Setup: npm i -g supabase
// Deploy: supabase functions deploy ai-brain --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const META_TOKEN = Deno.env.get('META_ACCESS_TOKEN') ?? '';
const META_PHONE_ID = Deno.env.get('META_PHONE_ID') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
    // Handle CORS preflight request
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    // Credentials (Global Scope for Debug)
    const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID');
    const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN');

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

            let systemInstruction = `Eres "Segumex IA", el asistente virtual estrella de Segumex (Seguros de Autos, Gastos Médicos, Vida y Daños).
            
            TUS REGLAS DE ORO:
            1. **Personalidad**: Eres amable, profesional, empático y usas emojis moderadamente (🚗, 🏥, ✅).
            2. **Objetivo**: Tu meta es obtener información para cotizar o resolver dudas rápidas.
            3. **Lead Scoring (CRÍTICO)**: Debes DETECTAR si el usuario tiene INTENCIÓN DE COMPRA o quiere cotizar. Si es así, marca "create_lead": true.
            
            FORMATO DE SALIDA (JSON):
            Tu respuesta DEBE ser SIEMPRE un JSON válido con esta estructura:
            {
                "reply": "Tu mensaje textual para el usuario aquí (usa emojis).",
                "create_lead": true/false, // Pon true SOLO si el usuario muestra interés claro o pide cotización
                "lead_data": { // Opcional, solo si capturas datos
                    "nombre": "Extraer si lo dice",
                    "interes": "Auto/GMM/Vida"
                }
            }
            `;

            if (conversation.leads) {
                systemInstruction += `\nEstás hablando con ${conversation.leads.nombre} ${conversation.leads.apellido}.`;
            }

            // 3.1 Fetch Products (Knowledge Base)
            const { data: products } = await supabase.from('products').select('name, description, price, requirements').limit(10);
            if (products && products.length > 0) {
                systemInstruction += `\n\nNUESTROS PRODUCTOS Y SERVICIOS DISPONIBLES:\n`;
                products.forEach(p => {
                    systemInstruction += `- **${p.name}**: ${p.description}. Precio: ${p.price}. Requisitos: ${p.requirements}\n`;
                });
                systemInstruction += `\nUsa esta información para responder dudas sobre seguros. Si te preguntan algo que no está aquí, di que consultarás con un humano.`;
            }

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

            // Ensure we have the user's latest message if history missed it (race condition)
            if (chatHistory.length === 0 || (chatHistory[chatHistory.length - 1].role === 'model' && user_message)) {
                console.log("⚠️ Appending user message manually to history.");
                chatHistory.push({
                    role: 'user',
                    parts: [{ text: user_message }]
                });
            } else if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
                const lastText = chatHistory[chatHistory.length - 1].parts[0].text;
                if (lastText !== user_message) {
                    console.log("⚠️ Last history message differs from current user_message. Appending.");
                    chatHistory.push({
                        role: 'user',
                        parts: [{ text: user_message }]
                    });
                }
            }

            const payload = {
                contents: chatHistory,
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: { responseMimeType: "application/json" }
            };

            console.log("🤖 Sending to Gemini 1.5 Flash (JSON Mode).");

            const response = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const aiData = await response.json();
            let aiResponseAction = { reply: "Disculpa, no entendí eso.", create_lead: false };

            if (aiData.candidates && aiData.candidates[0].content && aiData.candidates[0].content.parts) {
                const rawText = aiData.candidates[0].content.parts[0].text;
                try {
                    aiResponseAction = JSON.parse(rawText);
                    textToSend = aiResponseAction.reply;
                } catch (e) {
                    console.error("Error parsing JSON from AI:", rawText);
                    textToSend = rawText; // Fallback
                }
            } else if (aiData.error && aiData.error.code === 429) {
                console.error("⛔ Quota Exceeded:", JSON.stringify(aiData));
                textToSend = "El sistema de IA está saturado en este momento. Por favor intenta en unos minutos.";
            } else {
                console.error("❌ Gemini API Error:", JSON.stringify(aiData));
                textToSend = "Disculpa, no entendí eso. Un asesor te contactará.";
            }

            // 3.5 Handle Intelligent Lead Creation (Restored)
            if (aiResponseAction.create_lead && !conversation.lead_id) {
                console.log("🎯 AI detected INTERES! Creating Lead...");
                const phoneNumber = conversation.platform_user_id.replace('@c.us', '');
                const { data: existingLead } = await supabase.from('leads').select('id').eq('telefono', phoneNumber).single();

                let leadId = existingLead?.id;

                if (!leadId) {
                    const { data: newLead } = await supabase.from('leads').insert({
                        nombre: aiResponseAction.lead_data?.nombre || 'Prospecto Interesado',
                        telefono: phoneNumber,
                        origen: 'whatsapp_ai',
                        estado: 'nuevo',
                        interes: aiResponseAction.lead_data?.interes || 'General'
                    }).select('id').single();
                    leadId = newLead?.id;
                }

                if (leadId) {
                    await supabase.from('comm_conversations').update({ lead_id: leadId }).eq('id', conversation_id);
                }
            }

            // Guardar Respuesta de IA (ONLY for AI path)
            await supabase.from('comm_messages').insert({
                conversation_id: conversation_id,
                sender_type: 'ai',
                content: textToSend
            });
        } // Close ELSE block here

        // 4. Enviar Respuesta a WhatsApp (Vía Green API) - AHORA FUERA DEL ELSE
        // Credentials already declared at top
        let waData, waRes;

        if (textToSend && conversation.platform_user_id && GREEN_INSTANCE_ID && GREEN_API_TOKEN) {
            const url = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}/sendMessage/${GREEN_API_TOKEN}`;
            const payload = {
                chatId: conversation.platform_user_id, // Ya incluye @c.us
                message: textToSend
            };

            console.log("Enviando respuesta a Green API:", url);

            waRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            waData = await waRes.json();
            console.log("Respuesta Green API:", waData);

            if (!waRes.ok) {
                console.error("Error enviando a Green API:", waData);
            }
        } else if (!GREEN_INSTANCE_ID || !GREEN_API_TOKEN) {
            console.error("Faltan credenciales de Green API para respuesta de IA");
        }

        // Return result
        return new Response(JSON.stringify({
            success: true,
            green_api: typeof waData !== 'undefined' ? waData : null,
            green_api_status: typeof waRes !== 'undefined' ? waRes.status : null,
            debug: {
                has_text: !!textToSend,
                has_user_id: !!conversation?.platform_user_id,
                has_instance: !!GREEN_INSTANCE_ID,
                has_token: !!GREEN_API_TOKEN
            }
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
