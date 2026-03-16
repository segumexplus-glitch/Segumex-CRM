// Setup: npm i -g supabase
// Deploy: supabase functions deploy ai-brain --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ============================================================
// Extrae 10 dígitos locales del platform_user_id de Green API
// ============================================================
function extraerTelefono10(platformUserId: string): string {
    let tel = platformUserId.replace('@c.us', '').replace(/\D/g, '');
    if (tel.length === 13 && tel.startsWith('521')) tel = tel.slice(3);
    else if (tel.length === 12 && tel.startsWith('52')) tel = tel.slice(2);
    return tel;
}

// ============================================================
// Busca cliente en tabla clientes por teléfono
// ============================================================
async function buscarClientePorTelefono(tel10: string) {
    const { data, error } = await supabase
        .from('clientes')
        .select('id, nombre, apellido, rfc, email, telefono')
        .or(`telefono.eq.${tel10},telefono.ilike.%${tel10}%`)
        .maybeSingle();
    if (error) console.error('buscarClientePorTelefono error:', error.message);
    return data || null;
}

// ============================================================
// Obtiene pólizas vigentes de un cliente (incluye documentos)
// ============================================================
async function obtenerPolizasCliente(clienteId: number) {
    const { data } = await supabase
        .from('polizas')
        .select('id, no_poliza, ramo, aseguradora, vence, prima, estado, documentos')
        .eq('cliente_id', clienteId)
        .in('estado', ['activa', 'vigente'])
        .order('vence', { ascending: true })
        .limit(12);
    return data || [];
}

// ============================================================
// Genera URL firmada para un path de Supabase Storage
// ============================================================
async function generarUrlFirmada(path: string): Promise<string | null> {
    const { data, error } = await supabase.storage
        .from('documentos-polizas')
        .createSignedUrl(path, 300);
    if (error) {
        console.error('Error generando URL firmada:', error.message);
        return null;
    }
    return data.signedUrl;
}

// ============================================================
// Construye la base URL de Green API según el instance ID
// ============================================================
function buildGreenBaseUrl(instanceId: string): string {
    if (instanceId.startsWith('7107')) {
        return `https://7107.api.greenapi.com/waInstance${instanceId}`;
    }
    return `https://api.green-api.com/waInstance${instanceId}`;
}

// ============================================================
// Envía un PDF por WhatsApp vía Green API
// ============================================================
async function enviarPdfPoliza(
    greenBaseUrl: string,
    token: string,
    chatId: string,
    poliza: any
): Promise<boolean> {
    const docs: any[] = poliza.documentos || [];
    const doc = docs.find((d: any) => d.tipo === 'poliza' && d.path);

    if (!doc) {
        await fetch(`${greenBaseUrl}/sendMessage/${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId,
                message: `⚠️ La póliza *${poliza.no_poliza || 'S/N'}* no tiene documento digital disponible aún. Tu asesor te la hará llegar pronto.`
            })
        });
        return false;
    }

    const signedUrl = await generarUrlFirmada(doc.path);
    if (!signedUrl) return false;

    const res = await fetch(`${greenBaseUrl}/sendFileByUrl/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chatId,
            urlFile: signedUrl,
            fileName: `${doc.nombre || poliza.no_poliza || 'Poliza'}.pdf`,
            caption: `📄 Póliza *${poliza.no_poliza || 'S/N'}* · ${poliza.aseguradora || ''}`
        })
    });

    const data = await res.json();
    if (!res.ok) { console.error('Error enviando PDF:', data); return false; }
    console.log(`✅ PDF enviado: ${poliza.no_poliza}`);
    return true;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID') ?? '';
    const GREEN_API_TOKEN   = Deno.env.get('GREEN_API_TOKEN') ?? '';
    const GEMINI_API_KEY    = Deno.env.get('GEMINI_API_KEY')?.trim() ?? '';

    const greenBaseUrl = buildGreenBaseUrl(GREEN_INSTANCE_ID);

    let aiData;

    try {
        const body = await req.json();
        const { conversation_id, user_message, action, agent_message, selected_options, poll_chat_id } = body;

        // 1. Obtener conversación
        const { data: conversation } = await supabase
            .from('comm_conversations')
            .select('*, leads(*)')
            .eq('id', conversation_id)
            .single();

        if (!conversation) throw new Error("Conversación no encontrada");

        // --------------------------------------------------------
        // MODO 3: SELECCIÓN DE PÓLIZA POR NÚMERO (menú de texto)
        // --------------------------------------------------------
        const chatId = conversation.platform_user_id;

        if (!action && user_message) {
            const { data: pendingMenu } = await supabase
                .from('ai_poll_pending')
                .select('*')
                .eq('chat_id', chatId)
                .maybeSingle();

            if (pendingMenu) {
                const opciones: any[] = pendingMenu.opciones || [];
                const numInput = parseInt(user_message.trim(), 10);

                if (!isNaN(numInput) && numInput >= 1 && numInput <= opciones.length) {
                    // El usuario eligió una póliza válida
                    await supabase.from('ai_poll_pending').delete().eq('id', pendingMenu.id);

                    // Guardar mensaje del usuario en historial
                    await supabase.from('comm_messages').insert({
                        conversation_id,
                        sender_type: 'user',
                        content: user_message
                    });

                    const polizaElegida = opciones[numInput - 1];
                    const ok = await enviarPdfPoliza(greenBaseUrl, GREEN_API_TOKEN, chatId, polizaElegida);

                    const confirmMsg = ok
                        ? '✅ Listo, ya te envié tu póliza. Si necesitas algo más, con gusto te ayudo. 🛡️'
                        : '⚠️ No se encontró el documento digital de esa póliza. Tu asesor te la hará llegar pronto.';

                    await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chatId, message: confirmMsg })
                    });

                    await supabase.from('comm_messages').insert({
                        conversation_id,
                        sender_type: 'ai',
                        content: confirmMsg
                    });

                    return new Response(JSON.stringify({ success: true, pdf_sent: ok }), {
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });

                } else if (/^\d+$/.test(user_message.trim())) {
                    // Número fuera de rango
                    const rangoMsg = `Por favor responde con un número del 1 al ${opciones.length}.`;
                    await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chatId, message: rangoMsg })
                    });
                    return new Response(JSON.stringify({ success: true, note: 'out of range' }), {
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
                // Si no es número, el usuario cambió de tema → borrar menú pendiente y continuar con IA
                await supabase.from('ai_poll_pending').delete().eq('id', pendingMenu.id);
            }
        }

        let textToSend = "";
        let aiResponseAction: any = { reply: "", create_lead: false, send_pdf: false };
        let clienteIdentificado: any = null;
        let polizasCliente: any[] = [];

        // --------------------------------------------------------
        // MODO 1: RESPUESTA MANUAL DEL AGENTE
        // --------------------------------------------------------
        if (action === 'manual_reply') {
            textToSend = agent_message;

            await supabase.from('comm_messages').insert({
                conversation_id,
                sender_type: 'agent',
                content: textToSend
            });

            await supabase.from('comm_conversations')
                .update({ status: 'agent_handling' })
                .eq('id', conversation_id);

        } else {
            // --------------------------------------------------------
            // MODO 2: RESPUESTA AUTOMÁTICA IA (GEMINI)
            // --------------------------------------------------------

            // 2. Identificar cliente por teléfono
            const tel10 = extraerTelefono10(conversation.platform_user_id || '');

            if (tel10.length === 10) {
                clienteIdentificado = await buscarClientePorTelefono(tel10);

                if (clienteIdentificado) {
                    polizasCliente = await obtenerPolizasCliente(clienteIdentificado.id);
                    console.log(`✅ Cliente: ${clienteIdentificado.nombre} (ID: ${clienteIdentificado.id}), Pólizas: ${polizasCliente.length}`);

                    if (!conversation.lead_id) {
                        const { data: leadExistente } = await supabase
                            .from('leads')
                            .select('id')
                            .eq('telefono', tel10)
                            .maybeSingle();
                        if (leadExistente) {
                            await supabase.from('comm_conversations')
                                .update({ lead_id: leadExistente.id })
                                .eq('id', conversation_id);
                        }
                    }
                }
            }

            // 3. Construir system instruction
            let systemInstruction = `Eres "Segumex IA", el asistente virtual de Segumex (Seguros de Autos, Gastos Médicos, Vida y Daños).

TUS REGLAS DE ORO:
1. **Personalidad**: Amable, profesional, empático. Usa emojis moderadamente (🚗, 🏥, ✅, 🛡️).
2. **Objetivo**: Resolver dudas, informar sobre pólizas existentes y cotizar seguros nuevos.
3. **Lead Scoring (CRÍTICO)**: Si el usuario muestra interés en comprar o cotizar, marca "create_lead": true.
4. **Envío de póliza PDF**: Si el cliente pide su póliza en cualquier forma — "mándame mis documentos", "quiero el pdf", "necesito mi póliza", "me lo puedes enviar", "dónde está mi póliza", o cualquier variación — marca "send_pdf": true. No importa cómo lo escriba, interpreta la intención.

FORMATO DE SALIDA (JSON obligatorio):
{
    "reply": "Tu mensaje para el usuario aquí.",
    "create_lead": true/false,
    "send_pdf": true/false,
    "lead_data": {
        "nombre": "Extraer si lo menciona",
        "interes": "Auto/GMM/Vida/General"
    }
}
`;

            // 4. Personalizar según si el cliente está identificado
            if (clienteIdentificado) {
                const nombre = clienteIdentificado.nombre;
                const nombreCompleto = `${nombre} ${clienteIdentificado.apellido || ''}`.trim();

                systemInstruction += `\n\n--- CLIENTE IDENTIFICADO ---`;
                systemInstruction += `\nEstás hablando con ${nombreCompleto}, cliente registrado de Segumex.`;
                systemInstruction += `\nSALÚDALE POR SU NOMBRE (${nombre}) en la primera respuesta de forma natural.`;
                systemInstruction += `\nNO le pidas datos que ya tenemos (nombre, teléfono).`;

                if (polizasCliente.length > 0) {
                    systemInstruction += `\n\nSUS PÓLIZAS ACTIVAS (${polizasCliente.length}):\n`;
                    polizasCliente.forEach(p => {
                        const fechaVence = p.vence
                            ? new Date(p.vence).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })
                            : 'Sin fecha';
                        const prima = p.prima ? `$${Number(p.prima).toLocaleString('es-MX')}` : 'N/D';
                        systemInstruction += `- Póliza ${p.no_poliza || 'S/N'}: ${(p.ramo || '').toUpperCase()} con ${p.aseguradora || 'N/D'} · Vence: ${fechaVence} · Prima: ${prima}\n`;
                    });
                    systemInstruction += `\nResponde dudas sobre sus pólizas con esta info. Para detalles profundos, dile que su asesor se lo confirma.`;

                    if (polizasCliente.length > 1) {
                        systemInstruction += `\n\n⚠️ MÚLTIPLES PÓLIZAS — REGLA ESPECIAL: Si el cliente pide su póliza o documentos (send_pdf: true), en tu "reply" dile únicamente: "Tienes ${polizasCliente.length} pólizas activas con nosotros. ¿Cuál necesitas? Te mando el menú para que elijas 👇". No listes las pólizas en el reply. El sistema enviará el menú automáticamente.`;
                    }
                } else {
                    systemInstruction += `\nEl cliente NO tiene pólizas activas. Si le interesa contratar una, ayúdale a cotizar.`;
                }

            } else if (conversation.leads) {
                systemInstruction += `\nEstás hablando con ${conversation.leads.nombre} ${conversation.leads.apellido || ''}.`;
            } else {
                systemInstruction += `\nEl usuario que escribe NO es un cliente registrado. Sé amable, intenta obtener su nombre y si muestra interés en cotizar, marca create_lead: true.`;
            }

            // 5. Base de conocimiento: productos
            const { data: products } = await supabase
                .from('products')
                .select('name, description, price, requirements')
                .limit(10);

            if (products && products.length > 0) {
                systemInstruction += `\n\nNUESTROS PRODUCTOS:\n`;
                products.forEach((p: any) => {
                    systemInstruction += `- **${p.name}**: ${p.description}. Precio: ${p.price}. Requisitos: ${p.requirements}\n`;
                });
            }

            // 6. Base de conocimiento: documentos PDF
            const { data: docs } = await supabase
                .from('knowledge_docs')
                .select('title, extracted_text')
                .limit(5);

            if (docs && docs.length > 0) {
                systemInstruction += `\n\nBIBLIOTECA DE DOCUMENTOS:\n`;
                docs.forEach((doc: any) => {
                    const content = doc.extracted_text ? doc.extracted_text.substring(0, 5000) : "";
                    systemInstruction += `- **${doc.title}**:\n${content}\n---\n`;
                });
            }

            // 7. Historial de conversación (últimos 10)
            const { data: history } = await supabase
                .from('comm_messages')
                .select('sender_type, content')
                .eq('conversation_id', conversation_id)
                .order('created_at', { ascending: false })
                .limit(10);

            const chatHistory = (history || [])
                .reverse()
                .filter((msg: any) => msg.content && msg.content.trim() !== '')
                .map((msg: any) => ({
                    role: msg.sender_type === 'user' ? 'user' : 'model',
                    parts: [{ text: msg.content }]
                }));

            if (chatHistory.length === 0 || (chatHistory[chatHistory.length - 1].role === 'model' && user_message)) {
                chatHistory.push({ role: 'user', parts: [{ text: user_message }] });
            } else if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
                const lastText = chatHistory[chatHistory.length - 1].parts[0].text;
                if (lastText !== user_message) {
                    chatHistory.push({ role: 'user', parts: [{ text: user_message }] });
                }
            }

            // 8. Llamar Gemini 2.0 Flash
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

            const legacyHistory = [
                { role: 'user', parts: [{ text: systemInstruction }] },
                { role: 'model', parts: [{ text: 'Entendido. Responderé en formato JSON.' }] },
                ...chatHistory
            ];

            console.log(`🤖 Gemini → Cliente: ${clienteIdentificado ? clienteIdentificado.nombre : 'Desconocido'}`);

            const response = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: legacyHistory })
            });

            aiData = await response.json();
            aiResponseAction = { reply: "Disculpa, no entendí eso.", create_lead: false, send_pdf: false };

            if (aiData.candidates?.[0]?.content?.parts) {
                const rawText = aiData.candidates[0].content.parts[0].text;
                try {
                    let cleanText = rawText
                        .replace(/```json/gi, '')
                        .replace(/```/g, '')
                        .replace(/^\s*json\s*/i, '')
                        .trim();
                    aiResponseAction = JSON.parse(cleanText);
                    textToSend = aiResponseAction.reply;
                } catch {
                    console.error("Error parsing AI JSON:", rawText);
                    const replyMatch = rawText.match(/"reply":\s*"([^"]+)"/);
                    textToSend = replyMatch?.[1] || rawText;
                }
            } else if (aiData.error?.code === 429) {
                textToSend = "El sistema de IA está saturado. Por favor intenta en unos minutos.";
            } else {
                console.error("❌ Gemini Error:", JSON.stringify(aiData));
                textToSend = "Disculpa, no entendí eso. Un asesor te contactará.";
            }

            // 9. Crear lead
            if (aiResponseAction.create_lead && !conversation.lead_id && !clienteIdentificado) {
                console.log("🎯 Creando lead por intención de compra...");
                const phoneNumber = tel10 || conversation.platform_user_id.replace(/\D/g, '');

                const { data: existingLead } = await supabase
                    .from('leads')
                    .select('id')
                    .eq('telefono', phoneNumber)
                    .maybeSingle();

                let leadId = existingLead?.id;

                if (!leadId) {
                    const { data: newLead } = await supabase
                        .from('leads')
                        .insert({
                            nombre: aiResponseAction.lead_data?.nombre || 'Prospecto WhatsApp',
                            telefono: phoneNumber,
                            origen: 'whatsapp_ai',
                            estado: 'nuevo',
                            interes: aiResponseAction.lead_data?.interes || 'General'
                        })
                        .select('id')
                        .single();
                    leadId = newLead?.id;
                }

                if (leadId) {
                    await supabase.from('comm_conversations')
                        .update({ lead_id: leadId })
                        .eq('id', conversation_id);
                }
            }

            // Guardar respuesta de IA en historial
            await supabase.from('comm_messages').insert({
                conversation_id,
                sender_type: 'ai',
                content: textToSend
            });

        } // fin else IA

        // --------------------------------------------------------
        // 10. ENVIAR TEXTO POR WHATSAPP (Green API)
        // --------------------------------------------------------
        let waData, waRes;

        if (textToSend && conversation.platform_user_id && GREEN_INSTANCE_ID && GREEN_API_TOKEN) {
            waRes = await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: conversation.platform_user_id, message: textToSend })
            });
            waData = await waRes.json();
            if (!waRes.ok) console.error("Error Green API:", waData);
        }

        // --------------------------------------------------------
        // 11. ENVIAR PÓLIZA(S)
        // --------------------------------------------------------
        if (aiResponseAction?.send_pdf && clienteIdentificado && polizasCliente.length > 0 && GREEN_INSTANCE_ID && GREEN_API_TOKEN) {
            // chatId ya definido arriba (const chatId = conversation.platform_user_id)
            if (polizasCliente.length === 1) {
                // ── Póliza única → enviar directamente ──────────────
                await enviarPdfPoliza(greenBaseUrl, GREEN_API_TOKEN, chatId, polizasCliente[0]);

            } else {
                // ── Múltiples pólizas → menú numerado por texto ─────
                const numeros = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                const lineas = polizasCliente.map((p, i) => {
                    const emoji = numeros[i] || `${i + 1}.`;
                    const ramo = (p.ramo || 'S/R').toUpperCase();
                    const aseg = p.aseguradora || 'S/A';
                    const num = p.no_poliza || 'S/N';
                    return `${emoji} ${aseg} · ${ramo} (${num})`;
                });

                const menuMsg = `¿Cuál de tus pólizas necesitas?\n\n${lineas.join('\n')}\n\nResponde con el número de tu elección.`;

                // Guardar selección pendiente (delete+insert para evitar problemas de constraint)
                await supabase.from('ai_poll_pending').delete().eq('chat_id', chatId);
                const { error: insertPollErr } = await supabase.from('ai_poll_pending')
                    .insert({ chat_id: chatId, conversation_id, opciones: polizasCliente });
                if (insertPollErr) console.error('❌ Error guardando menú pendiente:', insertPollErr.message);

                await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId, message: menuMsg })
                });

                console.log(`📋 Menú de ${polizasCliente.length} pólizas enviado a ${chatId}`);
            }
        }

        return new Response(JSON.stringify({
            success: true,
            green_api: waData ?? null,
            green_api_status: waRes?.status ?? null,
            debug: {
                has_text: !!textToSend,
                has_user_id: !!conversation?.platform_user_id,
                has_instance: !!GREEN_INSTANCE_ID,
                has_token: !!GREEN_API_TOKEN,
                gemini_key_prefix: GEMINI_API_KEY ? GEMINI_API_KEY.substring(0, 5) + "..." : "NONE",
                ai_raw_response: aiData ?? "No AI Data"
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
