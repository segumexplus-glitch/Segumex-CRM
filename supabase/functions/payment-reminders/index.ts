// Deploy: supabase functions deploy payment-reminders --no-verify-jwt
// Schedule: ejecutar diariamente via pg_cron o HTTP trigger manual

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

// ============================================================
// Construye el chatId de Green API desde teléfono de 10 dígitos
// ============================================================
function buildChatId(telefono: string): string {
    const digits = telefono.replace(/\D/g, '');
    const tel10 = digits.length === 12 && digits.startsWith('52') ? digits.slice(2) : digits.slice(-10);
    return `52${tel10}@c.us`;
}

// ============================================================
// URL base de Green API según instancia
// ============================================================
function greenBaseUrl(): string {
    if (GREEN_INSTANCE_ID.startsWith('7107')) {
        return `https://7107.api.greenapi.com/waInstance${GREEN_INSTANCE_ID}`;
    }
    return `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}`;
}

// ============================================================
// Enviar texto por WhatsApp
// ============================================================
async function enviarTexto(chatId: string, message: string): Promise<any> {
    const url = `${greenBaseUrl()}/sendMessage/${GREEN_API_TOKEN}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message })
    });
    return await res.json();
}

// ============================================================
// Enviar imagen con caption por WhatsApp
// ============================================================
async function enviarImagenConCaption(chatId: string, imageUrl: string, caption: string): Promise<any> {
    const url = `${greenBaseUrl()}/sendFileByUrl/${GREEN_API_TOKEN}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, urlFile: imageUrl, fileName: 'cobranza.jpg', caption })
    });
    return await res.json();
}

// ============================================================
// Reemplazar variables en plantilla de mensaje
// ============================================================
function aplicarPlantilla(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{${key}}`, value || '');
    }
    return result;
}

// ============================================================
// Verificar si ya se envió este tipo de mensaje para esta póliza hoy
// ============================================================
async function yaEnviado(polizaId: number, tipoMensaje: string): Promise<boolean> {
    const hoyInicio = new Date();
    hoyInicio.setHours(0, 0, 0, 0);

    const { data } = await supabase
        .from('mensajes_cobranza_log')
        .select('id')
        .eq('poliza_id', polizaId)
        .eq('tipo_mensaje', tipoMensaje)
        .gte('enviado_at', hoyInicio.toISOString())
        .maybeSingle();

    return !!data;
}

// ============================================================
// Registrar envío en log
// ============================================================
async function registrarEnvio(
    polizaId: number,
    clienteNombre: string,
    telefono: string,
    tipoMensaje: string,
    noPoliza: string,
    fechaVencimiento: string,
    prima: number,
    status: string,
    respuestaApi: any
) {
    await supabase.from('mensajes_cobranza_log').insert({
        poliza_id: polizaId,
        cliente_nombre: clienteNombre,
        telefono,
        tipo_mensaje: tipoMensaje,
        numero_poliza: noPoliza,
        fecha_vencimiento: fechaVencimiento,
        prima,
        status,
        respuesta_api: respuestaApi
    });
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const resultados: any[] = [];
    const errores: any[] = [];

    try {
        if (!GREEN_INSTANCE_ID || !GREEN_API_TOKEN) {
            throw new Error('Faltan credenciales de Green API (GREEN_INSTANCE_ID, GREEN_API_TOKEN)');
        }

        // --------------------------------------------------------
        // 0. Verificar si los envíos automáticos están activados
        // --------------------------------------------------------
        const { data: activoConfig } = await supabase
            .from('configuracion_mensajes')
            .select('contenido')
            .eq('clave', 'cobranza_activa')
            .maybeSingle();

        if (activoConfig?.contenido !== 'true') {
            console.log('⏸️ Envíos automáticos desactivados.');
            return new Response(JSON.stringify({
                success: true,
                message: 'Envíos automáticos desactivados. Actívalos en Configuración → Control y Pruebas.',
                enviados: 0,
                errores: 0
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // --------------------------------------------------------
        // 1. Cargar plantillas de mensajes desde configuracion_mensajes
        // --------------------------------------------------------
        const { data: configs } = await supabase
            .from('configuracion_mensajes')
            .select('clave, contenido');

        const plantillas: Record<string, string> = {};
        (configs || []).forEach((c: any) => { plantillas[c.clave] = c.contenido || ''; });

        let imagenUrl = plantillas['cobranza_imagen_url'] || '';

        // Si no hay URL guardada, generar URL firmada directo desde el bucket
        if (!imagenUrl) {
            const { data: signedData } = await supabase.storage
                .from('documentos-polizas')
                .createSignedUrl('cobranza/imagen_cobranza.png', 3600);
            if (signedData?.signedUrl) imagenUrl = signedData.signedUrl;
        }

        // --------------------------------------------------------
        // 2. Calcular fechas objetivo
        // --------------------------------------------------------
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        function fechaOffset(dias: number): string {
            const d = new Date(hoy);
            d.setDate(d.getDate() + dias);
            return d.toISOString().split('T')[0]; // YYYY-MM-DD
        }

        // Mapa: tipo_mensaje → fecha_vencimiento objetivo
        const REGLAS: Array<{ clave: string; fechaVence: string }> = [
            { clave: 'cobranza_7_dias_antes', fechaVence: fechaOffset(7) },
            { clave: 'cobranza_1_dia_antes',  fechaVence: fechaOffset(1) },
            { clave: 'cobranza_2_dias_despues', fechaVence: fechaOffset(-2) },
            { clave: 'cobranza_5_dias_despues', fechaVence: fechaOffset(-5) },
            { clave: 'cobranza_8_dias_despues', fechaVence: fechaOffset(-8) },
        ];

        // --------------------------------------------------------
        // 3. Para cada regla, buscar pólizas y enviar mensajes
        // --------------------------------------------------------
        for (const regla of REGLAS) {
            const template = plantillas[regla.clave];
            if (!template) {
                console.log(`⚠️ Sin plantilla para ${regla.clave}, omitiendo.`);
                continue;
            }

            // Buscar pólizas que venzan en la fecha objetivo, estén activas y NO sean domiciliadas
            const { data: polizas, error: polizasError } = await supabase
                .from('polizas')
                .select(`
                    id,
                    no_poliza,
                    vence,
                    prima,
                    aseguradora,
                    ramo,
                    cliente_id,
                    domiciliada,
                    clientes (
                        nombre,
                        apellido,
                        telefono
                    )
                `)
                .eq('vence', regla.fechaVence)
                .in('estado', ['activa', 'vigente'])
                .or('domiciliada.is.null,domiciliada.eq.false');

            if (polizasError) {
                console.error(`Error consultando pólizas para ${regla.clave}:`, polizasError);
                continue;
            }

            if (!polizas || polizas.length === 0) {
                console.log(`ℹ️ ${regla.clave}: 0 pólizas para ${regla.fechaVence}`);
                continue;
            }

            console.log(`📋 ${regla.clave}: ${polizas.length} póliza(s) para ${regla.fechaVence}`);

            for (const poliza of polizas) {
                const cliente = (poliza as any).clientes;
                if (!cliente || !cliente.telefono) {
                    console.log(`⚠️ Póliza ${poliza.id}: sin teléfono de cliente, omitiendo.`);
                    continue;
                }

                // Verificar si ya se envió hoy
                const enviado = await yaEnviado(poliza.id, regla.clave);
                if (enviado) {
                    console.log(`⏭️ Ya enviado hoy: póliza ${poliza.no_poliza} (${regla.clave})`);
                    continue;
                }

                const chatId = buildChatId(cliente.telefono);
                const nombreCliente = `${cliente.nombre} ${cliente.apellido || ''}`.trim();
                const fechaFormateada = new Date(poliza.vence + 'T12:00:00').toLocaleDateString('es-MX', {
                    day: '2-digit',
                    month: 'long',
                    year: 'numeric'
                });
                const primaFormateada = poliza.prima
                    ? Number(poliza.prima).toLocaleString('es-MX', { minimumFractionDigits: 2 })
                    : '0.00';

                const mensaje = aplicarPlantilla(template, {
                    nombre: cliente.nombre,
                    numero_poliza: poliza.no_poliza || 'S/N',
                    fecha_vencimiento: fechaFormateada,
                    prima: primaFormateada,
                    aseguradora: poliza.aseguradora || ''
                });

                let respuestaApi: any = null;
                let status = 'enviado';

                try {
                    // Enviar con imagen si hay URL configurada, si no solo texto
                    if (imagenUrl) {
                        respuestaApi = await enviarImagenConCaption(chatId, imagenUrl, mensaje);
                    } else {
                        respuestaApi = await enviarTexto(chatId, mensaje);
                    }

                    console.log(`✅ Enviado: ${nombreCliente} (${poliza.no_poliza}) - ${regla.clave}`);
                    resultados.push({
                        poliza: poliza.no_poliza,
                        cliente: nombreCliente,
                        tipo: regla.clave,
                        chatId
                    });

                } catch (sendErr: any) {
                    console.error(`❌ Error enviando a ${chatId}:`, sendErr.message);
                    status = 'error';
                    respuestaApi = { error: sendErr.message };
                    errores.push({ poliza: poliza.no_poliza, error: sendErr.message });
                }

                // Registrar en log (éxito o error)
                await registrarEnvio(
                    poliza.id,
                    nombreCliente,
                    cliente.telefono,
                    regla.clave,
                    poliza.no_poliza || '',
                    poliza.vence,
                    poliza.prima,
                    status,
                    respuestaApi
                );

                // Pequeña pausa entre envíos para no saturar la API
                await new Promise(r => setTimeout(r, 500));
            }
        }

        return new Response(JSON.stringify({
            success: true,
            fecha_proceso: hoy.toISOString().split('T')[0],
            enviados: resultados.length,
            errores: errores.length,
            detalle_enviados: resultados,
            detalle_errores: errores
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        console.error('Error crítico en payment-reminders:', err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
