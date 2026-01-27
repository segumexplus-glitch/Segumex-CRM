// Setup: npm i -g supabase
// Deploy: supabase functions deploy welcome-policy --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID');
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN');

// URL de la imagen de bienvenida (Subida por el usuario)
const WELCOME_IMAGE_URL = "https://mmhdpbygdvdyujiktvqa.supabase.co/storage/v1/object/public/marketing/BIENVENIDA.jpg";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    // DIAGNOSTIC OBJECT
    const debugInfo: any = {
        step: 'init',
        env: {
            has_supabase_url: !!SUPABASE_URL,
            has_green_instance: !!GREEN_INSTANCE_ID,
            has_green_token: !!GREEN_API_TOKEN,
            green_instance_id_masked: GREEN_INSTANCE_ID ? `${GREEN_INSTANCE_ID.substring(0, 4)}...` : 'MISSING'
        }
    };

    try {
        const { record } = await req.json();

        if (!record || !record.cliente_id) {
            throw new Error("No se recibió el registro de la póliza.");
        }
        debugInfo.record_poliza = record.no_poliza;

        console.log("📨 Nueva póliza recibida:", record.no_poliza);

        // 1. Obtener Datos del Cliente
        debugInfo.step = 'fetch_client';
        const { data: cliente, error: errCliente } = await supabase
            .from('clientes')
            .select('*')
            .eq('id', record.cliente_id)
            .single();

        if (errCliente || !cliente) throw new Error("Cliente no encontrado: " + (errCliente?.message || 'null'));
        debugInfo.client_name = cliente.nombre;

        // 2. Verificar si es Cliente Nuevo
        const { count, error: errCount } = await supabase
            .from('polizas')
            .select('*', { count: 'exact', head: true })
            .eq('cliente_id', record.cliente_id);

        const isNewClient = (count === 1);
        debugInfo.is_new_client = isNewClient;
        debugInfo.policy_count = count;

        console.log(`👤 Cliente ${cliente.nombre}: ${count} pólizas. Es nuevo? ${isNewClient}`);

        // 3. Obtener Teléfono (Formato WhatsApp)
        debugInfo.step = 'format_phone';
        let phone = cliente.telefono?.replace(/\D/g, '');

        if (!phone) throw new Error("El cliente no tiene teléfono registrado.");

        // Lógica de normalización para México (CRÍTICO: Usar 521 para móviles)
        // 10 dígitos -> Agregamos 521
        // 12 dígitos (52...) -> Insertamos el 1 -> 521...
        // 13 dígitos (521...) -> Dejamos igual.

        if (phone.length === 10) {
            phone = '521' + phone;
        } else if (phone.length === 12 && phone.startsWith('52')) {
            // Convertir 52XXXXXXXXXX a 521XXXXXXXXXX
            phone = '521' + phone.substring(2);
        } else if (phone.length === 13 && phone.startsWith('521')) {
            // Ya está correcto
        } else {
            console.warn("Formato de teléfono inusual:", phone);
            debugInfo.phone_warning = `Formato inusual: ${phone}`;
        }

        const chatId = `${phone}@c.us`;
        debugInfo.chatId = chatId;
        console.log(`📞 Teléfono normalizado: ${phone} -> ChatId: ${chatId}`);

        // 4. Calcular Fechas de Pago
        const pagos = record.pagos_fechas || [];
        const monto = (record.prima / (pagos.length || 1)).toFixed(2);

        let paymentsListCheck = "";
        pagos.slice(0, 3).forEach((fecha: string, idx: number) => {
            paymentsListCheck += `\n- Pago ${idx + 1}: $${monto} (${new Date(fecha).toLocaleDateString(undefined, { timeZone: 'UTC' })})`;
        });
        if (pagos.length > 3) paymentsListCheck += `\n... y ${pagos.length - 3} pagos más.`;

        // 5. Construir Mensaje
        const inicioVigencia = record.finanzas?.inicio ? new Date(record.finanzas.inicio).toLocaleDateString(undefined, { timeZone: 'UTC' }) : 'N/A';
        const finVigencia = record.vence ? new Date(record.vence).toLocaleDateString(undefined, { timeZone: 'UTC' }) : 'N/A';
        const vigenciaTexto = `${inicioVigencia} al ${finVigencia}`;

        let messageText = "";

        if (isNewClient) {
            messageText = `¡Hola *${cliente.nombre}*! 👋\n\n` +
                `🌟 *¡Bienvenido a la familia Segumex!* 🌟\n\n` +
                `Gracias por confiar en nosotros para proteger lo que más valoras. Tu póliza de *${record.ramo}* ya está activa. ✅\n\n` +
                `📄 *No. de Póliza*: ${record.no_poliza}\n` +
                `🏥 *Aseguradora*: ${record.aseguradora}\n` +
                `🗓️ *Vigencia*: ${vigenciaTexto}\n\n` +
                `📅 *Tu Plan de Pagos:*\n${paymentsListCheck}\n\n` +
                `Cualquier duda, aquí estamos para apoyarte 24/7. 🤝`;
        } else {
            messageText = `¡Qué gusto saludarte de nuevo, *${cliente.nombre}*! 🤩\n\n` +
                `Gracias por seguir construyendo tu seguridad con nosotros. Tu nueva póliza de *${record.ramo}* (${record.no_poliza}) ha sido registrada exitosamente. ✅\n\n` +
                `🗓️ *Vigencia*: ${vigenciaTexto}\n\n` +
                `📅 *Fechas de pago para esta póliza:*\n${paymentsListCheck}\n\n` +
                `¡Seguimos a la orden! 🛡️`;
        }

        // 6. Enviar a Green API con host dinámico
        debugInfo.step = 'send_to_greenapi';
        console.log(`🚀 Enviando mensaje a ${chatId}...`);

        let greenBaseUrl = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}`;

        // Si el Instance ID empieza con 7107, forzamos el subdominio específico
        if (GREEN_INSTANCE_ID && GREEN_INSTANCE_ID.startsWith('7107')) {
            greenBaseUrl = `https://7107.api.greenapi.com/waInstance${GREEN_INSTANCE_ID}`;
        }

        console.log(`🌐 Usando Green API Host: ${greenBaseUrl}`);
        debugInfo.green_base_url = greenBaseUrl;

        let imageOutcome = null;

        // Enviar Imagen
        if (isNewClient) {
            const payloadImage = {
                chatId: String(chatId),
                urlFile: WELCOME_IMAGE_URL,
                fileName: "bienvenida.jpg",
                caption: "¡Bienvenido a Segumex!"
            };
            try {
                debugInfo.step = 'sending_image';
                const resImg = await fetch(`${greenBaseUrl}/sendFileByUrl/${GREEN_API_TOKEN}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payloadImage)
                });
                imageOutcome = await resImg.json();
                debugInfo.image_outcome = imageOutcome;
                console.log("📸 Imagen enviada:", imageOutcome);
            } catch (e) {
                console.error("⚠️ Error enviando imagen:", e);
                imageOutcome = { error: String(e) };
                debugInfo.image_error = String(e);
            }
        }

        // Enviar Texto
        debugInfo.step = 'sending_text';
        const payloadText = {
            chatId: String(chatId),
            message: String(messageText)
        };
        debugInfo.payload_text = payloadText;

        const resText = await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadText)
        });

        debugInfo.green_status = resText.status;
        debugInfo.green_status_text = resText.statusText;

        if (!resText.ok) {
            const errorText = await resText.text();
            debugInfo.green_error_body = errorText;
            throw new Error(`Green API HTTP ${resText.status}: ${errorText}`);
        }

        const dataText = await resText.json();
        debugInfo.green_response = dataText;
        console.log("📝 Respuesta Green API:", JSON.stringify(dataText));

        if (dataText && typeof dataText === 'object' && (dataText.errorMessage || dataText.error)) {
            debugInfo.green_app_error = dataText.errorMessage || dataText.error;
            throw new Error(`Green API Error: ${dataText.errorMessage || dataText.error}`);
        }

        if (!dataText.idMessage && !dataText.savedMessageId) {
            console.warn("⚠️ Green API devolvió 200 pero no hay idMessage:", dataText);
            debugInfo.warning = "No idMessage in response";
        }

        return new Response(JSON.stringify({
            success: true,
            green_api: dataText,
            image_result: imageOutcome,
            debug: debugInfo
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error(err);
        debugInfo.error_message = err.message;
        debugInfo.error_stack = err.stack;

        return new Response(JSON.stringify({
            error: err.message,
            debug: debugInfo
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200 // Always return 200 so UI doesn't crash, but display error
        });
    }
});
