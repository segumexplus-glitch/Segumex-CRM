// Setup: npm i -g supabase
// Deploy: supabase functions deploy welcome-policy --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID');
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Mensajes por defecto (usados si no hay plantilla en DB)
const DEFAULT_NUEVO = `¡Hola *{nombre}*! 👋

*🌟 ¡Bienvenido a la familia Segumex! 🌟*

Gracias por confiar en nosotros para proteger lo que más valoras. Tu póliza de *{ramo}* ya está activa. ✅

📄 *No. de Póliza:* {no_poliza}
🏢 *Aseguradora:* {aseguradora}
🗓️ *Vigencia:* {vigencia}

📆 *Tu Plan de Pagos{forma_pago}:*{pagos}{domiciliada}

Cualquier duda, aquí estamos para apoyarte 24/7. 🤝`;

const DEFAULT_EXISTENTE = `¡Qué gusto saludarte de nuevo, *{nombre}*! 🤩

Gracias por seguir construyendo tu seguridad con nosotros. Tu nueva póliza de *{ramo}* ({no_poliza}) ha sido registrada exitosamente. ✅

🗓️ *Vigencia:* {vigencia}

📆 *Tu Plan de Pagos{forma_pago}:*{pagos}{domiciliada}

¡Seguimos a la orden! 🛡️`;

const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MESES_CORTO_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function fmtFechaMX(str: string | null | undefined): string {
    if (!str) return '---';
    const [y, m, d] = String(str).substring(0, 10).split('-').map(Number);
    if (isNaN(d) || isNaN(m)) return '---';
    return `${d} de ${MESES_ES[m - 1]} de ${y}`;
}

function fmtFechaCortaMX(str: string | null | undefined): string {
    if (!str) return '---';
    const [y, m, d] = String(str).substring(0, 10).split('-').map(Number);
    if (isNaN(d) || isNaN(m)) return '---';
    return `${d} ${MESES_CORTO_ES[m - 1]} ${y}`;
}

function fmtMontoMX(n: number): string {
    const parts = n.toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + parts.join('.');
}

function aplicarPlantilla(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{${key}}`, value || '');
    }
    return result;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

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

        // 1. Cargar plantillas y configuración desde DB
        debugInfo.step = 'fetch_config';
        const { data: configs } = await supabase
            .from('configuracion_mensajes')
            .select('clave, contenido')
            .in('clave', ['bienvenida_cliente_nuevo', 'bienvenida_cliente_existente', 'bienvenida_imagen_url']);

        const cfg: Record<string, string> = {};
        (configs || []).forEach((c: any) => { cfg[c.clave] = c.contenido || ''; });

        const templateNuevo = cfg['bienvenida_cliente_nuevo'] || DEFAULT_NUEVO;
        const templateExistente = cfg['bienvenida_cliente_existente'] || DEFAULT_EXISTENTE;
        const welcomeImageUrl = cfg['bienvenida_imagen_url'] || 'https://mmhdpbygdvdyujiktvqa.supabase.co/storage/v1/object/public/marketing/BIENVENIDA.jpg';

        // 2. Obtener Datos del Cliente
        debugInfo.step = 'fetch_client';
        const { data: cliente, error: errCliente } = await supabase
            .from('clientes')
            .select('*')
            .eq('id', record.cliente_id)
            .single();

        if (errCliente || !cliente) throw new Error("Cliente no encontrado: " + (errCliente?.message || 'null'));
        debugInfo.client_name = cliente.nombre;

        // 3. Verificar si es Cliente Nuevo
        const { count } = await supabase
            .from('polizas')
            .select('*', { count: 'exact', head: true })
            .eq('cliente_id', record.cliente_id);

        const isNewClient = (count === 1);
        debugInfo.is_new_client = isNewClient;
        debugInfo.policy_count = count;
        console.log(`👤 Cliente ${cliente.nombre}: ${count} pólizas. Es nuevo? ${isNewClient}`);

        // 4. Normalizar Teléfono (formato WhatsApp México)
        debugInfo.step = 'format_phone';
        let phone = cliente.telefono?.replace(/\D/g, '');
        if (!phone) throw new Error("El cliente no tiene teléfono registrado.");

        if (phone.length === 10) {
            phone = '521' + phone;  // Green API México: 521XXXXXXXXXX (móviles)
        } else if (phone.length === 12 && phone.startsWith('52') && !phone.startsWith('521')) {
            phone = '521' + phone.substring(2); // agregar el 1 faltante
        } else if (phone.length === 13 && phone.startsWith('521')) {
            // ya correcto
        } else {
            console.warn("Formato de teléfono inusual:", phone);
            debugInfo.phone_warning = `Formato inusual: ${phone}`;
        }

        const chatId = `${phone}@c.us`;
        debugInfo.chatId = chatId;
        console.log(`📞 Teléfono: ${phone} → ChatId: ${chatId}`);

        // 5. Preparar variables del mensaje
        const finanzas = record.finanzas || {};
        const pagosDetalle: any[] = finanzas.pagos_detalle || [];
        const formaPagoNum = String(finanzas.formaPago || '1');
        const formaMap: Record<string, string> = { '1': 'Anual', '2': 'Semestral', '3': 'Trimestral', '4': 'Mensual' };
        const formaLabel = formaMap[formaPagoNum] || '';

        // Construir lista de pagos desde pagos_detalle (fuente real con montos por pago)
        let pagosTexto = '';
        if (pagosDetalle.length > 0) {
            const limite = formaPagoNum === '1' ? 1 : 3;
            pagosDetalle.slice(0, limite).forEach((p: any, idx: number) => {
                const monto = p.total != null ? fmtMontoMX(Number(p.total)) : '';
                pagosTexto += `\n  • Pago ${p.numero || idx + 1}: ${monto} — ${fmtFechaCortaMX(p.fecha)}`;
            });
            if (pagosDetalle.length > 3 && formaPagoNum !== '1') {
                pagosTexto += `\n  _...y ${pagosDetalle.length - 3} pagos más._`;
            }
        } else {
            // Fallback: usar pagos_fechas + prima dividida si no hay pagos_detalle
            const pagosFechas: string[] = record.pagos_fechas || [];
            const numPagos = parseInt(formaPagoNum) || 1;
            const montoPago = record.prima ? fmtMontoMX(Number(record.prima) / numPagos) : '';
            pagosFechas.slice(0, 3).forEach((fecha: string, idx: number) => {
                pagosTexto += `\n  • Pago ${idx + 1}: ${montoPago} — ${fmtFechaCortaMX(fecha)}`;
            });
            if (pagosFechas.length > 3) pagosTexto += `\n  _...y ${pagosFechas.length - 3} pagos más._`;
            if (!pagosFechas.length) pagosTexto = '\n  _Tu asesor te compartirá el calendario de pagos._';
        }

        // Texto de domiciliación
        const esDomiciliada = record.domiciliada === true;
        const domiciliadaTexto = esDomiciliada
            ? '\n\n💳 *Póliza domiciliada:* Tus pagos se cargarán automáticamente a tu tarjeta en cada fecha programada. No tienes que hacer nada. ✅'
            : '\n\n🔔 Recuerda realizar tu pago en cada fecha programada para mantener tu cobertura activa.';

        const inicioVigencia = fmtFechaMX(finanzas.inicio || null);
        const finVigencia = fmtFechaMX(record.vence || null);

        const vars: Record<string, string> = {
            nombre: cliente.nombre || '',
            no_poliza: record.no_poliza || 'S/N',
            ramo: record.ramo || '',
            aseguradora: record.aseguradora || '',
            vigencia: `${inicioVigencia} al ${finVigencia}`,
            forma_pago: formaLabel ? ` (${formaLabel})` : '',
            pagos: pagosTexto,
            domiciliada: domiciliadaTexto
        };

        // 6. Construir mensaje con plantilla
        const template = isNewClient ? templateNuevo : templateExistente;
        const messageText = aplicarPlantilla(template, vars);

        // 7. Enviar a Green API
        debugInfo.step = 'send_to_greenapi';
        let greenBaseUrl = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}`;
        if (GREEN_INSTANCE_ID && GREEN_INSTANCE_ID.startsWith('7107')) {
            greenBaseUrl = `https://7107.api.greenapi.com/waInstance${GREEN_INSTANCE_ID}`;
        }
        debugInfo.green_base_url = greenBaseUrl;

        let imageOutcome = null;

        // Enviar imagen solo para cliente nuevo (si hay URL configurada)
        if (isNewClient && welcomeImageUrl) {
            try {
                debugInfo.step = 'sending_image';
                const resImg = await fetch(`${greenBaseUrl}/sendFileByUrl/${GREEN_API_TOKEN}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId: String(chatId), urlFile: welcomeImageUrl, fileName: 'bienvenida.jpg', caption: '¡Bienvenido a Segumex!' })
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

        // Enviar texto
        debugInfo.step = 'sending_text';
        const payloadText = { chatId: String(chatId), message: String(messageText) };
        debugInfo.payload_text = payloadText;

        const resText = await fetch(`${greenBaseUrl}/sendMessage/${GREEN_API_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadText)
        });

        debugInfo.green_status = resText.status;
        if (!resText.ok) {
            const errorText = await resText.text();
            debugInfo.green_error_body = errorText;
            throw new Error(`Green API HTTP ${resText.status}: ${errorText}`);
        }

        const dataText = await resText.json();
        debugInfo.green_response = dataText;
        console.log("📝 Respuesta Green API:", JSON.stringify(dataText));

        if (dataText?.errorMessage || dataText?.error) {
            throw new Error(`Green API Error: ${dataText.errorMessage || dataText.error}`);
        }

        // 8. Registrar en historial de mensajes
        const tipoMensaje = isNewClient ? 'bienvenida_cliente_nuevo' : 'bienvenida_cliente_existente';
        try {
            await supabase.from('mensajes_cobranza_log').insert({
                poliza_id: record.id || null,
                cliente_nombre: cliente.nombre || '',
                telefono: phone,
                tipo_mensaje: tipoMensaje,
                numero_poliza: record.no_poliza || '',
                fecha_vencimiento: record.vence || null,
                prima: record.prima ? Number(record.prima) : null,
                numero_pago: null,
                status: 'enviado',
                respuesta_api: JSON.stringify(dataText)
            });
            console.log(`📋 Registrado en historial: ${tipoMensaje}`);
        } catch (logErr: any) {
            console.warn('⚠️ No se pudo guardar en historial:', logErr.message);
        }

        return new Response(JSON.stringify({
            success: true,
            is_new_client: isNewClient,
            green_api: dataText,
            image_result: imageOutcome,
            debug: debugInfo
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (err: any) {
        console.error(err);
        debugInfo.error_message = err.message;
        return new Response(JSON.stringify({ error: err.message, debug: debugInfo }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
        });
    }
});
