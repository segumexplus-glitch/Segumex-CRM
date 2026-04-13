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
        .select('id, nombre, apellido, rfc, email, telefono, nacimiento')
        .or(`telefono.eq.${tel10},telefono.ilike.%${tel10}%`)
        .maybeSingle();
    if (error) console.error('buscarClientePorTelefono error:', error.message);
    return data || null;
}

// ============================================================
// Busca clientes por nombre (búsqueda flexible palabra por palabra)
// Hace una query separada por cada parte del nombre para evitar
// problemas de sintaxis con OR compuestos en Supabase.
// ============================================================
// Elimina acentos: "Álvaro" → "Alvaro", "José" → "Jose"
function quitarAcentos(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function buscarClientesPorNombre(nombreCompleto: string): Promise<any[]> {
    // Normalizar: quitar acentos para que "Soto" encuentre "SOTO" y "Héctor" encuentre "HECTOR"
    const nombreNormalizado = quitarAcentos(nombreCompleto);
    const partes = nombreNormalizado.trim().split(/\s+/).filter(p => p.length > 2);
    if (partes.length === 0) return [];

    const mapa = new Map<number, any>();

    for (const parte of partes) {
        const { data, error } = await supabase
            .from('clientes')
            .select('id, nombre, apellido, rfc, nacimiento, telefono')
            .or(`nombre.ilike.%${parte}%,apellido.ilike.%${parte}%`)
            .limit(10);

        if (error) {
            console.error('buscarClientesPorNombre error:', error.message);
            continue;
        }

        for (const c of (data || [])) {
            if (!mapa.has(c.id)) {
                mapa.set(c.id, { ...c, _score: 0 });
            }
            // Sumar puntuación: cada palabra que coincide suma 1
            mapa.get(c.id)._score += 1;
        }
    }

    // Ordenar por score (más coincidencias primero) y devolver top 5
    return Array.from(mapa.values())
        .sort((a, b) => b._score - a._score)
        .slice(0, 5);
}

// ============================================================
// Normaliza texto de fecha a formato YYYY-MM-DD para comparar
// Soporta: "15/01/1990", "15-01-1990", "1990-01-15",
//          "15 de enero de 1990", "enero 15 de 1990"
// ============================================================
function normalizarFecha(texto: string): string | null {
    const meses: Record<string, string> = {
        'enero':'01','febrero':'02','marzo':'03','abril':'04',
        'mayo':'05','junio':'06','julio':'07','agosto':'08',
        'septiembre':'09','octubre':'10','noviembre':'11','diciembre':'12'
    };

    const t = texto.trim();

    // ISO: 1990-01-15
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;

    // DD/MM/YYYY o DD-MM-YYYY
    m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;

    // "15 de enero de 1990" o "15 enero 1990"
    const lower = t.toLowerCase();
    for (const [mes, num] of Object.entries(meses)) {
        if (lower.includes(mes)) {
            const dayM  = lower.match(/(\d{1,2})\s+de\s+/);
            const dayM2 = lower.match(/^(\d{1,2})\s+/);
            const yearM = lower.match(/\d{4}/);
            const dia   = (dayM || dayM2)?.[1];
            if (dia && yearM) {
                return `${yearM[0]}-${num}-${dia.padStart(2,'0')}`;
            }
        }
    }

    return null;
}

// ============================================================
// Obtiene mensajes outbound recientes enviados a este teléfono
// (cobranza, bienvenida) para dar contexto a la IA
// ============================================================
async function obtenerMensajesRecientes(tel10: string): Promise<any[]> {
    const hace30dias = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data } = await supabase
        .from('mensajes_cobranza_log')
        .select('tipo_mensaje, numero_poliza, created_at, cliente_nombre, fecha_vencimiento, prima')
        .or(`telefono.eq.${tel10},telefono.ilike.%${tel10}%`)
        .gte('created_at', hace30dias)
        .eq('status', 'enviado')
        .order('created_at', { ascending: false })
        .limit(5);
    return data || [];
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
// Envía un WhatsApp de alerta al número del agente (4494296226)
// ============================================================
async function alertarAgentePorWhatsApp(
    greenBaseUrl: string,
    token: string,
    nombreCliente: string | null,
    telefonoCliente: string,
    motivo: 'escalation' | 'verificacion_fallida'
): Promise<void> {
    const AGENTE_CHAT_ID = '524494296226@c.us';
    const identificador  = nombreCliente
        ? `*${nombreCliente}* (${telefonoCliente})`
        : `cliente con número *${telefonoCliente}*`;

    const mensaje = motivo === 'escalation'
        ? `🙋 El ${identificador} está solicitando hablar con un asesor.`
        : `⚠️ El ${identificador} no pudo verificar su identidad tras 3 intentos.`;

    try {
        await fetch(`${greenBaseUrl}/sendMessage/${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: AGENTE_CHAT_ID, message: mensaje })
        });
        console.log(`📲 Agente notificado por WhatsApp: ${motivo}`);
    } catch (e) {
        console.error('Error notificando agente por WhatsApp:', e);
    }
}

// ============================================================
// Envía mensaje por Meta Graph API (Facebook Messenger / Instagram DM)
// Limpia formato WhatsApp (*bold*, _italic_) ya que Meta no lo soporta
// ============================================================
async function enviarMensajeMeta(recipientId: string, message: string, token: string): Promise<void> {
    const textoLimpio = message
        .replace(/\*(.*?)\*/g, '$1')   // *negrita* → texto
        .replace(/_(.*?)_/g, '$1')     // _cursiva_ → texto
        .replace(/~(.*?)~/g, '$1');    // ~tachado~ → texto

    const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: textoLimpio }
        })
    });
    const data = await res.json();
    if (!res.ok) console.error('❌ Error enviando mensaje Meta:', JSON.stringify(data));
    else console.log(`✅ Mensaje Meta enviado a ${recipientId}`);
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

    const GREEN_INSTANCE_ID        = Deno.env.get('GREEN_INSTANCE_ID') ?? '';
    const GREEN_API_TOKEN          = Deno.env.get('GREEN_API_TOKEN') ?? '';
    const GEMINI_API_KEY           = Deno.env.get('GEMINI_API_KEY')?.trim() ?? '';
    const META_PAGE_ACCESS_TOKEN   = Deno.env.get('META_PAGE_ACCESS_TOKEN') ?? '';
    const META_INSTAGRAM_TOKEN     = Deno.env.get('META_INSTAGRAM_TOKEN') ?? '';

    const greenBaseUrl = buildGreenBaseUrl(GREEN_INSTANCE_ID);

    let aiData;

    try {
        const body = await req.json();
        const { conversation_id, user_message, action, agent_message, selected_options, poll_chat_id } = body;

        // 1. Obtener conversación (incluye canal para saber la plataforma)
        const { data: conversation } = await supabase
            .from('comm_conversations')
            .select('*, leads(*), comm_channels(platform, identifier)')
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
                const opcionesRaw = pendingMenu.opciones;

                // ────────────────────────────────────────────────────
                // CASO: Verificación de identidad por fecha de nacimiento
                // ────────────────────────────────────────────────────
                if (opcionesRaw && !Array.isArray(opcionesRaw) && opcionesRaw.tipo === 'verificacion_identidad') {
                    const verificacion = opcionesRaw;

                    await supabase.from('comm_messages').insert({
                        conversation_id, sender_type: 'user', content: user_message
                    });

                    // Verificar por fecha de nacimiento O por RFC (cualquiera de los dos)
                    const fechaIngresada = normalizarFecha(user_message);
                    const fechaEsperada  = verificacion.nacimiento
                        ? normalizarFecha(verificacion.nacimiento)
                        : null;

                    const rfcIngresado = user_message.trim().toUpperCase().replace(/\s/g, '');
                    const rfcEsperado  = (verificacion.rfc || '').toUpperCase().trim();
                    // RFC mexicano: 12-13 caracteres alfanuméricos (puede tener dígitos en cualquier posición)
                    const esRFC        = /^[A-Z0-9Ñ&]{12,13}$/i.test(rfcIngresado);

                    const verificadoPorFecha = !!(fechaIngresada && fechaEsperada && fechaIngresada === fechaEsperada);
                    const verificadoPorRFC   = !!(esRFC && rfcEsperado && rfcIngresado === rfcEsperado);
                    const identidadConfirmada = verificadoPorFecha || verificadoPorRFC;

                    if (identidadConfirmada) {
                        // ✅ Identidad confirmada
                        await supabase.from('ai_poll_pending').delete().eq('id', pendingMenu.id);

                        const polizasVerificadas: any[] = verificacion.polizas || [];
                        let respuestaFinal = '';

                        if (polizasVerificadas.length === 0) {
                            respuestaFinal = `✅ Identidad confirmada. Sin embargo, no encontré pólizas activas asociadas a tu nombre. Tu asesor te contactará pronto. 🛡️`;
                            await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chatId, message: respuestaFinal })
                            });
                        } else if (polizasVerificadas.length === 1) {
                            respuestaFinal = `✅ ¡Identidad confirmada! Enseguida te envío tu póliza. 😊`;
                            await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chatId, message: respuestaFinal })
                            });
                            await enviarPdfPoliza(greenBaseUrl, GREEN_API_TOKEN, chatId, polizasVerificadas[0]);
                        } else {
                            // Múltiples pólizas → mostrar menú
                            const numeros = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                            const lineas = polizasVerificadas.map((p: any, i: number) => {
                                const emoji = numeros[i] || `${i + 1}.`;
                                const ramo  = (p.ramo || 'S/R').toUpperCase();
                                const aseg  = p.aseguradora || 'S/A';
                                const num   = p.no_poliza   || 'S/N';
                                return `${emoji} ${aseg} · ${ramo} (${num})`;
                            });
                            respuestaFinal = `✅ ¡Identidad confirmada! Tienes *${polizasVerificadas.length} pólizas* activas con nosotros.\n\n¿Cuál necesitas?\n\n${lineas.join('\n')}\n\nResponde con el número de tu elección.`;

                            // Guardar menú de pólizas como pendingMenu normal
                            await supabase.from('ai_poll_pending').delete().eq('chat_id', chatId);
                            await supabase.from('ai_poll_pending').insert({
                                chat_id: chatId, conversation_id, opciones: polizasVerificadas
                            });

                            await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chatId, message: respuestaFinal })
                            });
                        }

                        await supabase.from('comm_messages').insert({
                            conversation_id, sender_type: 'ai', content: respuestaFinal
                        });
                        return new Response(JSON.stringify({ success: true, identity_verified: true }), {
                            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                        });

                    } else {
                        // ❌ Fecha incorrecta o no reconocida
                        const intentos = (verificacion.intentos || 0) + 1;

                        if (intentos >= 3) {
                            // Demasiados intentos → bloquear y notificar agente
                            await supabase.from('ai_poll_pending').delete().eq('id', pendingMenu.id);
                            const msgBloqueo = `Lo sentimos, no pudimos verificar tu identidad. Un asesor se pondrá en contacto contigo a la brevedad. 🙏`;
                            await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chatId, message: msgBloqueo })
                            });
                            await supabase.from('comm_messages').insert({
                                conversation_id, sender_type: 'ai', content: msgBloqueo
                            });
                            await supabase.functions.invoke('push-sender', {
                                body: {
                                    notify_all: true,
                                    title: '⚠️ Verificación fallida',
                                    body: `${verificacion.nombre_buscado || 'Desconocido'} no pudo verificar su identidad tras 3 intentos.`,
                                    data: { url: 'buzon.html' }
                                }
                            });

                            // WhatsApp directo al agente
                            const telFallido = chatId.replace('@c.us','').replace(/^521?/,'').slice(-10);
                            await alertarAgentePorWhatsApp(
                                greenBaseUrl, GREEN_API_TOKEN,
                                verificacion.nombre_buscado || null,
                                telFallido,
                                'verificacion_fallida'
                            );
                        } else {
                            // Actualizar contador de intentos
                            await supabase.from('ai_poll_pending')
                                .update({ opciones: { ...verificacion, intentos } })
                                .eq('id', pendingMenu.id);
                            const msgReintento = `El dato no coincide con nuestros registros. Por favor intenta de nuevo (intento ${intentos} de 3).\n\nRecuerda que puedes usar cualquiera de estos:\n📅 *Fecha de nacimiento* (DD/MM/AAAA)\n🪪 *RFC*`;
                            await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chatId, message: msgReintento })
                            });
                            await supabase.from('comm_messages').insert({
                                conversation_id, sender_type: 'ai', content: msgReintento
                            });
                        }

                        return new Response(JSON.stringify({ success: true, identity_verified: false }), {
                            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                        });
                    }
                }

                // ────────────────────────────────────────────────────
                // CASO: Selección de póliza por número (menú existente)
                // ────────────────────────────────────────────────────
                const opciones: any[] = Array.isArray(opcionesRaw) ? opcionesRaw : [];
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

            // Buscar mensajes outbound recientes SIEMPRE (antes de identificar cliente)
            let mensajesRecientes: any[] = [];
            if (tel10.length === 10) {
                mensajesRecientes = await obtenerMensajesRecientes(tel10);
            }

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
            let systemInstruction = `Eres el asistente virtual de Segumex, una empresa mexicana de seguros (Auto, GMM, Vida, Casa, Negocio).

════════════════════════════════════
PERSONALIDAD Y TONO — LEE CON ATENCIÓN
════════════════════════════════════
- Eres joven, jovial, cálido y muy profesional. Como un asesor de confianza.
- Usas emojis con moderación (🛡️ 🚗 ✅ 😊), nunca en exceso.
- Hablas en español mexicano natural. Tuteas al cliente.
- JAMÁS uses frases que suenen confusas, acusatorias, retóricas o groseras.
- JAMÁS preguntes cosas como "¿Quedé que?" o "¿A qué te refieres?" de forma brusca.
- Si no entiendes el mensaje, responde siempre con algo amable como: "¡Hola! 😊 ¿En qué te puedo ayudar hoy?"
- Haz UNA sola pregunta por mensaje. No bombardees al cliente con todas las preguntas de golpe.
- Si el cliente ya te dio varios datos en un solo mensaje, extráelos todos y solo pregunta por los que faltan.

════════════════════════════════════
FORMATO DE MENSAJES — MUY IMPORTANTE
════════════════════════════════════
Estás en WhatsApp. Usa SIEMPRE formato visual limpio y profesional:
- Usa *texto* para negritas (títulos, nombres de campos).
- Separa cada idea o dato en su propia línea con \n.
- Cuando presentes una lista de opciones, ponlas numeradas o con viñetas, cada una en su propia línea.
- Cuando pidas varios datos de golpe (como datos de personas o de un vehículo), preséntalos como lista numerada o con bullets, nunca en un párrafo corrido.
- Deja una línea vacía (\n\n) entre la pregunta principal y la lista de datos solicitados.
- NUNCA escribas todo en un solo párrafo largo.

Ejemplo INCORRECTO (no hagas esto):
"Para cotizar el seguro necesito que me proporciones el nombre completo de la persona, su fecha de nacimiento, su género y su código postal."

Ejemplo CORRECTO (así debes hacerlo):
"Para continuar con tu cotización necesito los siguientes datos de la persona a asegurar:\n\n*1. Nombre completo*\n*2. Fecha de nacimiento*\n*3. Género* (Masculino / Femenino)\n*4. Código postal*\n\nPuedes enviarlos todos juntos si gustas. 😊"

REGLA DE ORO — MENSAJES CORTOS DEL CLIENTE:
Si el cliente manda solo "Gracias", "Ok", "Entendido", "Sí", "No", "Bien", "Recibido" u otra confirmación breve:
→ Responde SIEMPRE con algo cálido y corto como: "¡Con mucho gusto! 😊 Cualquier cosa que necesites, aquí estoy." o "¡Para eso estamos! 🛡️ Que tengas excelente día, {nombre}."
→ NUNCA respondas una confirmación con una pregunta o con confusión.

════════════════════════════════════
OBJETIVO
════════════════════════════════════
- Resolver dudas sobre pólizas, coberturas y pagos.
- Cotizar seguros nuevos cuando el cliente muestre interés.
- Recopilar datos específicos según el tipo de seguro usando los flujos definidos abajo.
- Ser puente entre el cliente y su asesor cuando sea necesario.

════════════════════════════════════
FLUJOS DE COTIZACIÓN POR TIPO DE SEGURO
════════════════════════════════════

Cuando el cliente quiera cotizar, PRIMERO pregunta qué tipo de seguro le interesa si no lo ha dicho.
Muestra las opciones así (cada una en su línea):

"¡Con gusto te ayudo a cotizar! 😊 ¿Qué tipo de seguro te interesa?\n\n1️⃣ Gastos Médicos\n2️⃣ Auto\n3️⃣ Casa\n4️⃣ Negocio\n5️⃣ Vida\n6️⃣ Otro\n\nSolo dime el número o el nombre y empezamos."

Luego sigue el flujo correspondiente:

── GASTOS MÉDICOS (GMM) ──────────────────────────────
Paso 1: Pregunta si busca un seguro Individual, Familiar o Colectivo.

Si elige INDIVIDUAL o FAMILIAR:
  Paso 2: Pide los datos de las personas. Formato esperado:
    "Perfecto, para cotizar tu seguro de Gastos Médicos *Individual* necesito los siguientes datos:\n\n*1. Nombre completo*\n*2. Fecha de nacimiento* (o edad)\n*3. Género* (Masculino / Femenino)\n\nPuedes enviarlos todos juntos. 😊"
    Para familiar agrega: "Si son varios integrantes, envíame los datos de cada uno."
  Paso 3: Pide el código postal:
    "¡Gracias! Por último, ¿cuál es tu *código postal*? 📍"
  Paso 4 (opcional): Pregunta póliza anterior:
    "¿Cuentas con una póliza de GMM anterior que puedas compartirme en PDF o imagen? (Si no tienes, no hay problema 😊)"
  Al terminar todos los datos → cotizacion_completa: true

Si elige COLECTIVO:
  Responde:
    "El seguro de *Gastos Médicos Colectivo* es un producto muy específico con varias particularidades.\n\nPara darte la mejor atención, te recomendamos agendar una llamada con nuestro agente especializado. 📞\n\n¿Qué *día y hora* te acomodaría mejor?"
  Paso 2: Captura el día y hora preferidos para la llamada.
  Al tener día y hora → cotizacion_completa: true

── AUTO ──────────────────────────────────────────────
Paso 1: Pregunta si es un vehículo Nacional, Legalizado, o si quiere cotizar una Flotilla.

Si elige NACIONAL o LEGALIZADO:
  Paso 2: Presenta las opciones de cómo proporcionar los datos:
    "Para cotizar tu seguro de *Auto* tienes dos opciones:\n\n📋 *Opción 1 — Datos manuales:*\nEnvíame la siguiente información:\n• *Marca*\n• *Modelo*\n• *Versión*\n• *Año*\n• *Código postal*\n\n📸 *Opción 2 — Más rápido:*\nMándame una foto de tu *tarjeta de circulación* junto con tu *código postal* y con gusto preparamos tu cotización. 🚗"
  Paso 3 (si da datos manualmente): Confirma los datos recibidos y pregunta por los que falten.
  Paso 4: Pregunta póliza anterior:
    "¿Cuentas con una póliza anterior para este vehículo que puedas compartirme en *PDF o imagen*? (No es indispensable 😊)"
  Al terminar todos los datos → cotizacion_completa: true

Si elige FLOTILLA:
  Paso 2: Explica qué necesitas:
    "Para cotizar tu *Flotilla de Vehículos* necesito la siguiente información de *cada unidad*:\n\n• *Marca*\n• *Modelo*\n• *Versión*\n• *Año*\n• *Código postal*\n\nPuedes enviarnos la lista aquí mismo o en un archivo de *Excel* con la relación de vehículos. 📊"
  Paso 3: Pregunta uso:
    "¿Qué tipo de *uso* le darán a los vehículos?\n(Ej: particular, reparto, carga, transporte de personal, etc.)"
  Paso 4: Pregunta póliza anterior:
    "¿Anteriormente han contado con un seguro para la flotilla? Si es así, ¿pueden compartirnos la póliza o una relación en Excel?"
  Al terminar → cotizacion_completa: true

── CASA ──────────────────────────────────────────────
Paso 1: Pide los datos principales juntos en formato lista:
  "Para cotizar tu *Seguro de Casa* necesito los siguientes datos:\n\n🏠 *1. Domicilio completo* (incluyendo código postal)\n🔑 *2. ¿La casa es propia o rentada?*\n🏗️ *3. Número de plantas* (1 o 2)\n📦 *4. Valor aproximado de contenidos* (muebles, electrodomésticos, etc.)\n💰 *5. Valor estimado de la casa*\n📅 *6. Fecha aproximada de construcción* (si no la sabes, no hay problema 😊)\n🧱 *7. Material de construcción* (block, tabique, madera, mixto, etc.)\n\nPuedes enviarme todos los datos o de uno en uno, como prefieras."
Paso 2 (al tener los datos anteriores): Pregunta póliza anterior:
  "¿Has tenido anteriormente un *seguro de casa* que puedas compartirme en PDF o fotografía?"
Al terminar → cotizacion_completa: true

── NEGOCIO ──────────────────────────────────────────
Paso 1: Pide los datos fiscales y generales:
  "Para cotizar tu *Seguro de Negocio* necesito los siguientes datos:\n\n📋 *Datos generales:*\n• *RFC*\n• *Razón Social*\n• *Régimen Fiscal*\n• *Giro del negocio* (tipo de actividad)\n• *Dirección del establecimiento* (incluyendo código postal)"
Paso 2 (al recibir datos anteriores): Pide valores de contenidos:
  "Ahora necesito el *valor estimado de los contenidos* del negocio, separado así:\n\n⚙️ *Maquinaria:* $___\n💻 *Dispositivos electrónicos:* $___\n📦 *Mercancía:* $___\n\n(Puedes dar valores aproximados 😊)"
Paso 3: Pregunta trabajadores y pisos:
  "¿Cuántos *trabajadores* tienen actualmente?\n¿Y cuántos *pisos* tiene el establecimiento?"
Paso 4: Pregunta póliza anterior:
  "¿Cuentan con una póliza anterior para este negocio que puedan compartirnos en *PDF o fotografía*?"
Al terminar → cotizacion_completa: true

── VIDA ──────────────────────────────────────────────
Paso 1: Pide los datos de la persona a asegurar en formato lista:
  "Para cotizar tu *Seguro de Vida* necesito los siguientes datos:\n\n👤 *1. Nombre completo* de la persona a asegurar\n📅 *2. Fecha de nacimiento*\n⚧️ *3. Género* (Masculino / Femenino)\n💰 *4. Presupuesto:* ¿Tienes en mente un monto mensual que te gustaría pagar, o bien una suma asegurada total?\n\nPuedes enviarlos todos juntos. 😊"
Al terminar → cotizacion_completa: true

── OTRO TIPO DE SEGURO ───────────────────────────────
Paso 1: Pregunta qué tipo de seguro están buscando y dales espacio para describir su necesidad.
Al recibir la descripción → cotizacion_completa: true

════════════════════════════════════
MENSAJE DE CIERRE (aplica a TODOS los seguros)
════════════════════════════════════
Cuando cotizacion_completa sea true, cierra SIEMPRE con este mensaje (adaptado naturalmente):
"¡Perfecto! Ya tenemos toda la información. En caso de que necesitemos algún dato adicional, nos pondremos en contacto contigo. 😊🛡️"

════════════════════════════════════
ACCIONES ESPECIALES
════════════════════════════════════
- Lead: Tan pronto el cliente muestre interés en cotizar → "create_lead": true
- PDF: Si el cliente pide su póliza, documentos, o "mándame el pdf" → "send_pdf": true
  ⚠️ IMPORTANTE para send_pdf: Si el usuario NO está identificado por teléfono y pide su póliza,
  PRIMERO pregunta su nombre completo si no lo ha dado. Una vez que lo tengas, entonces marca
  "send_pdf": true e incluye "nombre_buscado" en lead_data. No marques send_pdf: true sin tener el nombre.
- Cotización completa: Cuando ya recopilaste TODOS los datos del flujo → "cotizacion_completa": true
- Escalar a agente: Si el cliente pide hablar con una persona, un asesor, un humano, o expresa
  frustración importante y quiere salir del bot → "escalate_to_agent": true
  Responde algo como: "Por supuesto, con gusto te comunico con uno de nuestros asesores. En breve se pondrá en contacto contigo. 😊🛡️"

FORMATO DE SALIDA (JSON obligatorio, sin markdown):
{
    "reply": "Tu mensaje aquí.",
    "create_lead": true/false,
    "send_pdf": true/false,
    "cotizacion_completa": true/false,
    "escalate_to_agent": true/false,
    "lead_data": {
        "nombre": "si lo mencionó",
        "nombre_buscado": "nombre completo que dio el cliente para buscar su póliza (solo cuando send_pdf: true)",
        "interes": "Auto/GMM/Vida/Casa/Negocio/Otro",
        "subtipo": "individual/familiar/colectivo/nacional/legalizado/flotilla/etc (si aplica)",
        "codigo_postal": "si lo dio",
        "personas_gmm": [{"nombre":"...","edad":"...","genero":"..."}],
        "agenda_llamada": {"dia":"...","hora":"..."},
        "auto_marca": "...", "auto_modelo": "...", "auto_version": "...", "auto_anio": "...",
        "auto_uso": "particular/comercial/etc (para flotilla)",
        "casa_domicilio": "...", "casa_tipo": "propia/rentada", "casa_plantas": "1/2",
        "casa_valor_contenidos": "...", "casa_valor_inmueble": "...",
        "casa_fecha_construccion": "...", "casa_material": "...",
        "negocio_rfc": "...", "negocio_razon_social": "...", "negocio_regimen": "...",
        "negocio_giro": "...", "negocio_domicilio": "...",
        "negocio_valor_maquinaria": "...", "negocio_valor_electronica": "...", "negocio_valor_mercancia": "...",
        "negocio_trabajadores": "...", "negocio_pisos": "...",
        "vida_nombre": "...", "vida_fecha_nacimiento": "...", "vida_genero": "...",
        "vida_presupuesto_mensual": "...", "vida_suma_asegurada": "...",
        "otro_descripcion": "...",
        "tiene_poliza_anterior": true/false
    }
}
Incluye en lead_data SOLO los campos que ya te proporcionó el cliente. Omite los que no apliquen o no se hayan dado aún.
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

            // ── CONTEXTO DE MENSAJES OUTBOUND RECIENTES ──────────────
            // Esto resuelve el problema de continuidad: el cliente responde
            // a un recordatorio de cobranza o bienvenida y la IA lo entiende.
            if (mensajesRecientes.length > 0) {
                const tipoLabels: Record<string, string> = {
                    'bienvenida_cliente_nuevo': 'mensaje de bienvenida por nueva póliza',
                    'bienvenida_cliente_existente': 'mensaje de bienvenida por nueva póliza (cliente recurrente)',
                    'cobranza_7_dias_antes': 'recordatorio de pago (vence en 7 días)',
                    'cobranza_1_dia_antes': 'recordatorio de pago (vence mañana)',
                    'cobranza_2_dias_despues': 'aviso de pago vencido (2 días de retraso)',
                    'cobranza_5_dias_despues': 'aviso de pago vencido (5 días de retraso)',
                    'cobranza_8_dias_despues': 'aviso de pago vencido (8 días de retraso)',
                };
                const ultimo = mensajesRecientes[0];
                const label = tipoLabels[ultimo.tipo_mensaje] || ultimo.tipo_mensaje;
                const fechaEnvio = new Date(ultimo.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'long' });
                systemInstruction += `\n\n════════════════════════════════════`;
                systemInstruction += `\nCONTEXTO IMPORTANTE — CONTINUIDAD DE CONVERSACIÓN`;
                systemInstruction += `\n════════════════════════════════════`;
                systemInstruction += `\nEl ${fechaEnvio} le enviamos a este cliente un "${label}"`;
                if (ultimo.numero_poliza) systemInstruction += ` (póliza ${ultimo.numero_poliza})`;
                if (ultimo.prima) systemInstruction += ` por $${Number(ultimo.prima).toLocaleString('es-MX')}`;
                systemInstruction += `.`;
                systemInstruction += `\nMUY PROBABLE que el cliente esté RESPONDIENDO a ese mensaje.`;
                systemInstruction += `\nContextualiza tu respuesta en consecuencia. Si dice "Gracias" o "Ok", agradece y ofrece ayuda.`;
                systemInstruction += `\nSi pregunta sobre el pago o la fecha, ya tienes esa información arriba.`;
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
                    console.error("Error parsing AI JSON:", rawText.substring(0, 300));
                    // Extraer reply aunque haya saltos de línea escapados
                    const replyMatch = rawText.match(/"reply":\s*"((?:[^"\\]|\\[\s\S])*)"/);
                    textToSend = replyMatch?.[1]?.replace(/\\n/g, '\n').replace(/\\"/g, '"') || rawText;
                    // CRÍTICO: extraer send_pdf, create_lead y cotizacion_completa aunque falle el JSON completo
                    // Sin esto, el menú de pólizas nunca se envía cuando Gemini devuelve JSON mal formateado
                    const sendPdfMatch = rawText.match(/"send_pdf":\s*(true|false)/i);
                    if (sendPdfMatch) aiResponseAction.send_pdf = sendPdfMatch[1].toLowerCase() === 'true';
                    const createLeadMatch = rawText.match(/"create_lead":\s*(true|false)/i);
                    if (createLeadMatch) aiResponseAction.create_lead = createLeadMatch[1].toLowerCase() === 'true';
                    const cotizacionMatch = rawText.match(/"cotizacion_completa":\s*(true|false)/i);
                    if (cotizacionMatch) aiResponseAction.cotizacion_completa = cotizacionMatch[1].toLowerCase() === 'true';
                    const escalateMatch = rawText.match(/"escalate_to_agent":\s*(true|false)/i);
                    if (escalateMatch) aiResponseAction.escalate_to_agent = escalateMatch[1].toLowerCase() === 'true';
                }
            } else if (aiData.error?.code === 429) {
                textToSend = "El sistema de IA está saturado. Por favor intenta en unos minutos.";
            } else {
                console.error("❌ Gemini Error:", JSON.stringify(aiData));
                textToSend = "Disculpa, no entendí eso. Un asesor te contactará.";
            }

            // 9. Crear / actualizar lead
            const phoneNumber = tel10 || conversation.platform_user_id.replace(/\D/g, '');
            const ld = aiResponseAction.lead_data || {};

            // 9a. Crear lead inicial cuando el cliente muestra intención de cotizar
            if (aiResponseAction.create_lead && !conversation.lead_id && !clienteIdentificado) {
                console.log("🎯 Creando lead por intención de compra...");

                const { data: existingLead } = await supabase
                    .from('leads')
                    .select('id')
                    .eq('telefono', phoneNumber)
                    .maybeSingle();

                let leadId = existingLead?.id;

                if (!leadId) {
                    const leadNombre = ld.nombre || 'Prospecto WhatsApp';
                    const leadInteres = ld.interes || 'General';
                    const { data: newLead } = await supabase
                        .from('leads')
                        .insert({
                            nombre: leadNombre,
                            telefono: phoneNumber,
                            origen: 'whatsapp_ai',
                            estado: 'nuevo',
                            interes: leadInteres
                        })
                        .select('id')
                        .single();
                    leadId = newLead?.id;

                    if (leadId) {
                        await supabase.functions.invoke('push-sender', {
                            body: {
                                notify_all: true,
                                title: '🎯 Nuevo Lead',
                                body: `${leadNombre} interesado en ${leadInteres} vía WhatsApp`,
                                data: { url: `leads.html` }
                            }
                        });
                    }
                }

                if (leadId) {
                    await supabase.from('comm_conversations')
                        .update({ lead_id: leadId })
                        .eq('id', conversation_id);
                }
            }

            // 9b. Escalar a agente humano
            if (aiResponseAction.escalate_to_agent) {
                console.log("🙋 Cliente solicita agente humano.");

                // Cambiar conversación a agent_handling
                await supabase.from('comm_conversations')
                    .update({ status: 'agent_handling' })
                    .eq('id', conversation_id);

                // Notificar por WhatsApp al número del agente
                const telCliente = tel10 || conversation.platform_user_id.replace(/\D/g, '').slice(-10);
                const nombreCliente = clienteIdentificado
                    ? `${clienteIdentificado.nombre} ${clienteIdentificado.apellido || ''}`.trim()
                    : (aiResponseAction.lead_data?.nombre || null);

                await alertarAgentePorWhatsApp(greenBaseUrl, GREEN_API_TOKEN, nombreCliente, telCliente, 'escalation');

                // Push notification adicional
                await supabase.functions.invoke('push-sender', {
                    body: {
                        notify_all: true,
                        title: '🙋 Cliente pide hablar con asesor',
                        body: `${nombreCliente || telCliente} quiere atención humana.`,
                        data: { url: 'buzon.html' }
                    }
                });
            }

            // 9c. Actualizar lead con datos completos de cotización
            if (aiResponseAction.cotizacion_completa) {
                console.log("✅ Cotización completa. Guardando datos del lead...");

                // Recuperar lead_id actualizado (puede haberse seteado en 9a)
                const { data: convActualizada } = await supabase
                    .from('comm_conversations')
                    .select('lead_id')
                    .eq('id', conversation_id)
                    .single();

                const leadIdCotizacion = convActualizada?.lead_id;

                if (leadIdCotizacion) {
                    // Campos con columnas propias en la tabla leads
                    const updateCampos: Record<string, any> = {};
                    if (ld.nombre)          updateCampos.nombre         = ld.nombre;
                    if (ld.interes)         updateCampos.interes        = ld.interes;
                    if (ld.codigo_postal)   updateCampos.codigo_postal  = ld.codigo_postal;
                    if (ld.auto_modelo)     updateCampos.auto_modelo    = ld.auto_modelo;
                    if (ld.auto_anio)       updateCampos.auto_anio      = ld.auto_anio;
                    if (ld.auto_version)    updateCampos.auto_version   = ld.auto_version;

                    // Todos los datos de cotización en historial JSONB para referencia del agente
                    updateCampos.historial = [{
                        tipo: 'cotizacion_whatsapp',
                        fecha: new Date().toISOString(),
                        datos: ld
                    }];

                    updateCampos.estado = 'cotizacion_pendiente';

                    await supabase.from('leads')
                        .update(updateCampos)
                        .eq('id', leadIdCotizacion);

                    // Notificar al agente que hay una cotización lista para atender
                    const tipoSeguro = ld.interes || 'Seguro';
                    const subtipo    = ld.subtipo  ? ` (${ld.subtipo})` : '';
                    const nombreLead = ld.nombre   || 'Prospecto';
                    await supabase.functions.invoke('push-sender', {
                        body: {
                            notify_all: true,
                            title: `📋 Cotización lista — ${tipoSeguro}${subtipo}`,
                            body: `${nombreLead} completó el formulario de ${tipoSeguro} por WhatsApp. ¡Revísalo en Leads!`,
                            data: { url: `detalle_lead.html?id=${leadIdCotizacion}` }
                        }
                    });

                    console.log(`✅ Lead ${leadIdCotizacion} actualizado con datos de cotización ${tipoSeguro}`);
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
        // 10. ENVIAR RESPUESTA AL CLIENTE (WhatsApp / Facebook / Instagram)
        // --------------------------------------------------------
        let waData, waRes;

        const channelPlatform = conversation.comm_channels?.platform ?? 'whatsapp';

        if (textToSend && conversation.platform_user_id) {

            if ((channelPlatform === 'facebook' || channelPlatform === 'instagram') && (META_PAGE_ACCESS_TOKEN || META_INSTAGRAM_TOKEN)) {
                // ── Facebook Messenger / Instagram DM ────────────
                const metaToken = channelPlatform === 'instagram'
                    ? (META_INSTAGRAM_TOKEN || META_PAGE_ACCESS_TOKEN)
                    : META_PAGE_ACCESS_TOKEN;
                console.log(`📤 Enviando por Meta (${channelPlatform}) a ${conversation.platform_user_id}`);
                await enviarMensajeMeta(conversation.platform_user_id, textToSend, metaToken);

            } else if (GREEN_INSTANCE_ID && GREEN_API_TOKEN) {
                // ── WhatsApp (Green API) — comportamiento original ─
                waRes = await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId: conversation.platform_user_id, message: textToSend })
                });
                waData = await waRes.json();
                if (!waRes.ok) console.error("Error Green API:", waData);
            }
        }

        // --------------------------------------------------------
        // 11a. VERIFICACIÓN DE IDENTIDAD POR NOMBRE (número desconocido)
        // Si el cliente pide su póliza pero no está identificado por teléfono,
        // buscamos por nombre y pedimos fecha de nacimiento para confirmar.
        // --------------------------------------------------------
        if (aiResponseAction?.send_pdf && !clienteIdentificado && GREEN_INSTANCE_ID && GREEN_API_TOKEN) {
            const nombreBuscado = aiResponseAction.lead_data?.nombre_buscado || aiResponseAction.lead_data?.nombre || '';

            if (nombreBuscado.length > 3) {
                const candidatos = await buscarClientesPorNombre(nombreBuscado);

                if (candidatos.length > 0) {
                    // Tomar el candidato con más coincidencia (el primero de la búsqueda)
                    const candidato = candidatos[0];
                    const polizasCandidato = await obtenerPolizasCliente(candidato.id);

                    // Guardar estado de verificación pendiente
                    await supabase.from('ai_poll_pending').delete().eq('chat_id', chatId);
                    await supabase.from('ai_poll_pending').insert({
                        chat_id: chatId,
                        conversation_id,
                        opciones: {
                            tipo: 'verificacion_identidad',
                            cliente_id: candidato.id,
                            nombre_buscado: nombreBuscado,
                            nacimiento: candidato.nacimiento,
                            rfc: candidato.rfc || '',
                            polizas: polizasCandidato,
                            intentos: 0
                        }
                    });

                    // Reemplazar el mensaje de Gemini con la solicitud de verificación
                    const msgVerificacion = `Para proteger tu información, necesito verificar tu identidad. 🔒\n\nPor favor compárteme uno de los siguientes datos:\n\n📅 *Fecha de nacimiento* (formato DD/MM/AAAA)\n🪪 *RFC*`;

                    // Cancelar el mensaje que ya envió Gemini y mandar el de verificación
                    await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chatId, message: msgVerificacion })
                    });
                    await supabase.from('comm_messages').insert({
                        conversation_id, sender_type: 'ai', content: msgVerificacion
                    });

                    console.log(`🔒 Verificación de identidad iniciada para: ${nombreBuscado} → candidato ID ${candidato.id}`);

                    return new Response(JSON.stringify({ success: true, identity_check_started: true }), {
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });

                } else {
                    // No encontramos a nadie con ese nombre
                    const msgNoEncontrado = `No encontré ningún cliente registrado con el nombre *${nombreBuscado}*.\n\nSi crees que hay un error, comunícate con tu asesor directamente. 🛡️`;
                    await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chatId, message: msgNoEncontrado })
                    });
                    await supabase.from('comm_messages').insert({
                        conversation_id, sender_type: 'ai', content: msgNoEncontrado
                    });
                    return new Response(JSON.stringify({ success: true, client_not_found: true }), {
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
            }
        }

        // --------------------------------------------------------
        // 11b. ENVIAR PÓLIZA(S) — cliente identificado por teléfono
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
