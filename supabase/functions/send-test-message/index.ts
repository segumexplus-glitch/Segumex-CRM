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

// Datos de ejemplo para reemplazar variables en el mensaje de prueba
const TEST_DATA: Record<string, string> = {
    nombre: 'María García',
    numero_poliza: 'TEST-001',
    fecha_vencimiento: new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' }),
    prima: '1,500.00',
    aseguradora: 'GNP'
};

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

        const { tipo_mensaje, telefono } = await req.json();

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

        // Cargar imagen de cobranza (si existe)
        const { data: imgConfig } = await supabase
            .from('configuracion_mensajes')
            .select('contenido')
            .eq('clave', 'cobranza_imagen_url')
            .maybeSingle();

        const imagenUrl = imgConfig?.contenido || '';

        // Reemplazar variables con datos de prueba
        const mensaje = aplicarPlantilla(config.contenido, TEST_DATA);
        const chatId = `52${digits}@c.us`;

        // Enviar por WhatsApp
        let waResponse: any;
        if (imagenUrl) {
            const url = `${greenBaseUrl()}/sendFileByUrl/${GREEN_API_TOKEN}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, urlFile: imagenUrl, fileName: 'prueba_cobranza.jpg', caption: mensaje })
            });
            waResponse = await res.json();
        } else {
            const url = `${greenBaseUrl()}/sendMessage/${GREEN_API_TOKEN}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, message: mensaje })
            });
            waResponse = await res.json();
        }

        console.log(`✅ Prueba enviada a ${chatId} (${config.titulo})`);

        return new Response(JSON.stringify({
            success: true,
            chatId,
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
