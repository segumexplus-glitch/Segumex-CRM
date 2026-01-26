// Setup: npm i -g supabase
// Deploy: supabase functions deploy welcome-policy --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID');
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN');

// URL de la imagen de bienvenida (Subida por el usuario)
// Nota: Usamos una URL pública si es posible, o la del bucket si habilitamos acceso público.
// Por ahora usaremos un placeholder de Segumex o la URL directa si el usuario la provee.
// Como el usuario subió la imagen al chat, no tengo URL pública directa. 
// Usaremos una URL genérica de placeholder o instruiremos al usuario poner la URL real.
const WELCOME_IMAGE_URL = "https://i.imgur.com/example-segumex-welcome.jpg"; // TODO: Reemplazar con URL real

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

    try {
        const { record } = await req.json();

        if (!record || !record.cliente_id) {
            throw new Error("No se recibió el registro de la póliza.");
        }

        console.log("📨 Nueva póliza recibida:", record.no_poliza);

        // 1. Obtener Datos del Cliente
        const { data: cliente, error: errCliente } = await supabase
            .from('clientes')
            .select('*')
            .eq('id', record.cliente_id)
            .single();

        if (errCliente || !cliente) throw new Error("Cliente no encontrado");

        // 2. Verificar si es Cliente Nuevo (¿Cuántas pólizas tiene?)
        // Contamos todas. Si es 1, es la que acabamos de insertar (o la primera).
        // Si hay más de 1, es recurrente.
        const { count, error: errCount } = await supabase
            .from('polizas')
            .select('*', { count: 'exact', head: true })
            .eq('cliente_id', record.cliente_id);

        const isNewClient = (count === 1);
        console.log(`👤 Cliente ${cliente.nombre}: ${count} pólizas. Es nuevo? ${isNewClient}`);

        // 3. Obtener Teléfono (Formato WhatsApp)
        // Asumimos que cliente.telefono tiene formato 10 digitos o con codigo.
        // Green API necesita codigo pais. Asumimos MX (52) si no lo tiene.
        let phone = cliente.telefono?.replace(/\D/g, ''); // Solo numeros
        if (!phone) throw new Error("Cliente sin teléfono");
        if (phone.length === 10) phone = '52' + phone; // Default Mexico

        const chatId = `${phone}@c.us`;

        // 4. Calcular Fechas de Pago para el Mensaje
        const pagos = record.pagos_fechas || [];
        const monto = (record.prima / (pagos.length || 1)).toFixed(2);

        // Construir lista de pagos legible
        let paymentsListCheck = "";
        pagos.slice(0, 3).forEach((fecha, idx) => {
            paymentsListCheck += `\n- Pago ${idx + 1}: $${monto} (${new Date(fecha).toLocaleDateString()})`;
        });
        if (pagos.length > 3) paymentsListCheck += `\n... y ${pagos.length - 3} pagos más.`;

        // 5. Construir Mensaje
        const inicioVigencia = record.finanzas?.inicio ? new Date(record.finanzas.inicio).toLocaleDateString() : 'N/A';
        const finVigencia = record.vence ? new Date(record.vence).toLocaleDateString() : 'N/A';
        const vigenciaTexto = `${inicioVigencia} al ${finVigencia}`;

        let messageText = "";

        if (isNewClient) {
            // MENSAJE A: NUEVO CLIENTE
            messageText = `¡Hola *${cliente.nombre}*! 👋\n\n` +
                `🌟 *¡Bienvenido a la familia Segumex!* 🌟\n\n` +
                `Gracias por confiar en nosotros para proteger lo que más valoras. Tu póliza de *${record.ramo}* ya está activa. ✅\n\n` +
                `📄 *No. de Póliza*: ${record.no_poliza}\n` +
                `🏥 *Aseguradora*: ${record.aseguradora}\n` +
                `🗓️ *Vigencia*: ${vigenciaTexto}\n\n` +
                `📅 *Tu Plan de Pagos:*\n${paymentsListCheck}\n\n` +
                `Cualquier duda, aquí estamos para apoyarte 24/7. 🤝`;
        } else {
            // MENSAJE B: CLIENTE RECURRENTE
            messageText = `¡Qué gusto saludarte de nuevo, *${cliente.nombre}*! 🤩\n\n` +
                `Gracias por seguir construyendo tu seguridad con nosotros. Tu nueva póliza de *${record.ramo}* (${record.no_poliza}) ha sido registrada exitosamente. ✅\n\n` +
                `🗓️ *Vigencia*: ${vigenciaTexto}\n\n` +
                `📅 *Fechas de pago para esta póliza:*\n${paymentsListCheck}\n\n` +
                `¡Seguimos a la orden! 🛡️`;
        }

        // 6. Enviar a Green API (Imagen primero si es nuevo, luego texto)
        const greenUrlFile = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}/sendFileByUrl/${GREEN_API_TOKEN}`;
        const greenUrlText = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}/sendMessage/${GREEN_API_TOKEN}`;

        // Enviar Imagen (Solo si es nuevo, o si decidimos enviarla siempre)
        if (isNewClient) {
            const payloadImage = {
                chatId: chatId,
                urlFile: WELCOME_IMAGE_URL,
                fileName: "bienvenida.jpg",
                caption: "¡Bienvenido a Segumex!" // Opcional
            };
            await fetch(greenUrlFile, { method: 'POST', body: JSON.stringify(payloadImage) });
        }

        // Enviar Texto
        const resText = await fetch(greenUrlText, {
            method: 'POST',
            body: JSON.stringify({ chatId, message: messageText })
        });

        const dataText = await resText.json();

        return new Response(JSON.stringify({ success: true, green_api: dataText }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: err.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200 // Always return 200 so UI doesn't crash, but log error
        });
    }
});
