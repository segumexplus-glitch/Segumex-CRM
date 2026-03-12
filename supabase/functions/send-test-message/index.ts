// Deploy: supabase functions deploy send-test-message --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID') ?? '';
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Datos de ejemplo para mensajes de cobranza
const TEST_DATA_COBRANZA: Record<string, string> = {
    nombre: 'María García',
    numero_poliza: 'TEST-001',
    fecha_vencimiento: new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }),
    prima: '1,500.00',
    aseguradora: 'GNP'
};

// Datos de ejemplo para mensajes de bienvenida
const TEST_DATA_BIENVENIDA: Record<string, string> = {
    nombre: 'María García',
    no_poliza: 'TEST-001',
    ramo: 'Auto',
    aseguradora: 'GNP',
    vigencia: '01 de enero de 2026 al 01 de enero de 2027',
    forma_pago: ' (Semestral)',
    pagos: '\n  • Pago 1: $1,500.00 — 01 ene 2026\n  • Pago 2: $1,500.00 — 01 jul 2026',
    domiciliada: '\n\n💳 *Póliza domiciliada:* Tus pagos se cargarán automáticamente a tu tarjeta en cada fecha programada. No tienes que hacer nada. ✅'
};

const ES_BIENVENIDA = (tipo: string) =>
    tipo === 'bienvenida_cliente_nuevo' || tipo === 'bienvenida_cliente_existente';

function greenBaseUrl(): string {
    if (GREEN_INSTANCE_ID.startsWith('7107')) {
        return `https://7107.api.greenapi.com/waInstance${GREEN_INSTANCE_ID}`;
    }
    return `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}`;
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

    try {
        if (!GREEN_INSTANCE_ID || !GREEN_API_TOKEN) {
            throw new Error('Faltan credenciales de Green API (GREEN_INSTANCE_ID, GREEN_API_TOKEN)');
        }

        const { tipo_mensaje, telefono, data_real } = await req.json();

        if (!tipo_mensaje || !telefono) {
            throw new Error('Se requieren tipo_mensaje y telefono');
        }

        const digits = telefono.replace(/\D/g, '');
        if (digits.length !== 10) {
            throw new Error('El teléfono debe tener 10 dígitos');
        }

        // Cargar plantilla desde DB
        const { data: config, error: configError } = await supabase
            .from('configuracion_mensajes')
            .select('contenido, titulo')
            .eq('clave', tipo_mensaje)
            .maybeSingle();

        if (configError || !config?.contenido) {
            throw new Error(`Plantilla "${tipo_mensaje}" no encontrada o vacía`);
        }

        // Cargar imagen según el tipo de mensaje
        const esBienvenida = ES_BIENVENIDA(tipo_mensaje);
        const imgClave = esBienvenida ? 'bienvenida_imagen_url' : 'cobranza_imagen_url';
        const { data: imgConfig } = await supabase
            .from('configuracion_mensajes')
            .select('contenido')
            .eq('clave', imgClave)
            .maybeSingle();

        let imagenUrl = imgConfig?.contenido || '';

        // Si no hay URL guardada, intentar generar URL firmada directamente desde el bucket
        if (!imagenUrl && !esBienvenida) {
            const { data: signedData } = await supabase.storage
                .from('documentos-polizas')
                .createSignedUrl('cobranza/imagen_cobranza.png', 3600);
            if (signedData?.signedUrl) {
                imagenUrl = signedData.signedUrl;
                console.log('🔑 URL firmada generada automáticamente para cobranza');
            }
        }

        // Usar data_real si se provee (datos de póliza real), de lo contrario usar datos de ejemplo
        const testData = data_real || (esBienvenida ? TEST_DATA_BIENVENIDA : TEST_DATA_COBRANZA);
        const mensaje = aplicarPlantilla(config.contenido, testData);
        // Green API México usa 521XXXXXXXXXX para móviles (confirmado por chatId del webhook entrante)
        const chatId = `521${digits}@c.us`;

        // Enviar por WhatsApp
        let waRes: Response;
        let waResponse: any;
        let sendMethod = 'sendMessage';
        if (imagenUrl) {
            sendMethod = 'sendFileByUrl';
            console.log(`📸 Enviando con imagen: ${imagenUrl}`);
            // Verificar que la URL de imagen sea accesible antes de enviar
            const imgCheck = await fetch(imagenUrl, { method: 'HEAD' }).catch(() => null);
            if (!imgCheck || !imgCheck.ok) {
                console.warn(`⚠️ Imagen inaccesible (${imgCheck?.status}), enviando solo texto`);
                sendMethod = 'sendMessage (imagen inaccesible, fallback)';
                const url = `${greenBaseUrl()}/sendMessage/${GREEN_API_TOKEN}`;
                waRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId, message: mensaje })
                });
            } else {
                const url = `${greenBaseUrl()}/sendFileByUrl/${GREEN_API_TOKEN}`;
                waRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chatId, urlFile: imagenUrl, fileName: 'prueba.jpg', caption: mensaje })
                });
            }
        } else {
            const url = `${greenBaseUrl()}/sendMessage/${GREEN_API_TOKEN}`;
            waRes = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, message: mensaje })
            });
        }
        console.log(`📤 Método usado: ${sendMethod}`);

        waResponse = await waRes.json();
        console.log(`Green API response [${waRes.status}]:`, JSON.stringify(waResponse));

        if (!waRes.ok) {
            throw new Error(`Green API HTTP ${waRes.status}: ${JSON.stringify(waResponse)}`);
        }
        if (waResponse?.errorMessage || waResponse?.error) {
            throw new Error(`Green API error: ${waResponse.errorMessage || waResponse.error}`);
        }
        if (!waResponse?.idMessage) {
            throw new Error(`Green API no devolvió idMessage. Respuesta: ${JSON.stringify(waResponse)}`);
        }

        console.log(`✅ Prueba enviada a ${chatId} (${config.titulo}), idMessage: ${waResponse.idMessage}`);

        return new Response(JSON.stringify({
            success: true,
            chatId,
            send_method: sendMethod,
            tipo: config.titulo,
            mensaje_preview: mensaje.substring(0, 100) + '...',
            wa_response: waResponse
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (err: any) {
        console.error('Error en send-test-message:', err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
