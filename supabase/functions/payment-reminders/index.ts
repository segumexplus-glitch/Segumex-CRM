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
// Construye el chatId de Green API (formato México 521XXXXXXXXXX)
// ============================================================
function buildChatId(telefono: string): string {
    const digits = telefono.replace(/\D/g, '');
    const tel10 = digits.length >= 12 && digits.startsWith('52') ? digits.slice(-10) : digits.slice(-10);
    return `521${tel10}@c.us`;
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
// Verificar si ya se envió este tipo de recordatorio para este
// pago específico (poliza_id + tipo_mensaje + numero_pago)
// ============================================================
async function yaEnviado(polizaId: number, tipoMensaje: string, numeroPago: number): Promise<boolean> {
    const { data } = await supabase
        .from('mensajes_cobranza_log')
        .select('id')
        .eq('poliza_id', polizaId)
        .eq('tipo_mensaje', tipoMensaje)
        .eq('numero_pago', numeroPago)
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
    numeroPago: number,
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
        numero_pago: numeroPago,
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
        // 1. Cargar plantillas de mensajes y imagen
        // --------------------------------------------------------
        const { data: configs } = await supabase
            .from('configuracion_mensajes')
            .select('clave, contenido');

        const plantillas: Record<string, string> = {};
        (configs || []).forEach((c: any) => { plantillas[c.clave] = c.contenido || ''; });

        // Imagen recordatorio (7 y 1 días antes)
        let imagenUrl = plantillas['cobranza_imagen_url'] || '';
        if (!imagenUrl) {
            const { data: signedData } = await supabase.storage
                .from('documentos-polizas')
                .createSignedUrl('cobranza/imagen_cobranza.png', 3600);
            if (signedData?.signedUrl) imagenUrl = signedData.signedUrl;
        }

        // Imagen cobranza vencida (2, 5 y 8 días después)
        let imagenVencidaUrl = plantillas['cobranza_vencida_imagen_url'] || '';
        if (!imagenVencidaUrl) {
            const { data: signedVencida } = await supabase.storage
                .from('documentos-polizas')
                .createSignedUrl('cobranza/imagen_cobranza_vencida.png', 3600);
            if (signedVencida?.signedUrl) imagenVencidaUrl = signedVencida.signedUrl;
        }

        const CLAVES_VENCIDAS = new Set(['cobranza_2_dias_despues', 'cobranza_5_dias_despues', 'cobranza_8_dias_despues']);

        // --------------------------------------------------------
        // 2. Mapa de offsets: días desde fecha de pago → clave plantilla
        //    Negativo = días DESPUÉS del vencimiento (pago atrasado)
        //    Positivo = días ANTES del vencimiento
        // --------------------------------------------------------
        const OFFSET_MAP = new Map<number, string>([
            [ 7, 'cobranza_7_dias_antes'   ],
            [ 1, 'cobranza_1_dia_antes'    ],
            [-2, 'cobranza_2_dias_despues' ],
            [-5, 'cobranza_5_dias_despues' ],
            [-8, 'cobranza_8_dias_despues' ],
        ]);

        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        // --------------------------------------------------------
        // 3. Traer todas las pólizas activas no domiciliadas
        // --------------------------------------------------------
        const { data: todasPolizas, error: polizasError } = await supabase
            .from('polizas')
            .select(`
                id,
                no_poliza,
                vence,
                prima,
                aseguradora,
                ramo,
                domiciliada,
                finanzas,
                pagos_status,
                pagos_fechas,
                clientes (
                    nombre,
                    apellido,
                    telefono
                )
            `)
            .in('estado', ['activa', 'vigente'])
            .or('domiciliada.is.null,domiciliada.eq.false');

        if (polizasError) throw new Error('Error cargando pólizas: ' + polizasError.message);
        console.log(`📋 Total pólizas activas no domiciliadas ni excluidas: ${(todasPolizas || []).length}`);

        // --------------------------------------------------------
        // 4. Por cada póliza, encontrar próximo pago no cubierto
        // --------------------------------------------------------
        for (const poliza of (todasPolizas || [])) {
            const cliente = (poliza as any).clientes;
            if (!cliente?.telefono) {
                console.log(`⚠️ Póliza ${(poliza as any).no_poliza}: sin teléfono, omitiendo.`);
                continue;
            }

            const finanzas = (poliza as any).finanzas || {};
            const pagosDetalle: any[] = finanzas.pagos_detalle || [];
            const pagosStatus: boolean[] = (poliza as any).pagos_status || [];
            const pagasFechas: string[] = (poliza as any).pagos_fechas || [];

            // Construir calendario: prioridad pagos_detalle, fallback pagos_fechas
            let calendario: Array<{ fecha: string; total: number; numero: number }> = [];

            if (pagosDetalle.length > 0) {
                calendario = pagosDetalle.map((p: any, i: number) => ({
                    fecha: String(p.fecha).substring(0, 10),
                    total: Number(p.total) || Number((poliza as any).prima) || 0,
                    numero: Number(p.numero || (i + 1))
                }));
            } else if (pagasFechas.length > 0) {
                calendario = pagasFechas.map((f: string, i: number) => ({
                    fecha: String(f).substring(0, 10),
                    total: Number((poliza as any).prima) || 0,
                    numero: i + 1
                }));
            } else {
                console.log(`⚠️ Póliza ${(poliza as any).no_poliza}: sin calendario de pagos, omitiendo.`);
                continue;
            }

            // Encontrar primer pago no pagado
            let proximoIdx = -1;
            for (let i = 0; i < calendario.length; i++) {
                if (!pagosStatus[i]) {
                    proximoIdx = i;
                    break;
                }
            }

            // Todos los pagos cubiertos — no mandar nada
            if (proximoIdx === -1) {
                console.log(`✅ Póliza ${(poliza as any).no_poliza}: todos los pagos cubiertos.`);
                continue;
            }

            const proximoPago = calendario[proximoIdx];
            const fechaStr = proximoPago.fecha;
            const montoPago = proximoPago.total;
            const numeroPago = proximoPago.numero;

            // Calcular diferencia de días: positivo = faltan días, negativo = días vencido
            const fechaPagoDate = new Date(fechaStr + 'T12:00:00');
            const diffMs = fechaPagoDate.getTime() - hoy.getTime();
            const diffDias = Math.round(diffMs / (1000 * 60 * 60 * 24));

            const claveRegla = OFFSET_MAP.get(diffDias);
            if (!claveRegla) continue; // No coincide con ningún recordatorio hoy

            const template = plantillas[claveRegla];
            if (!template) {
                console.log(`⚠️ Sin plantilla para ${claveRegla}, omitiendo.`);
                continue;
            }

            // Verificar si ya se envió este recordatorio para este pago
            const enviado = await yaEnviado((poliza as any).id, claveRegla, numeroPago);
            if (enviado) {
                console.log(`⏭️ Ya enviado: póliza ${(poliza as any).no_poliza} pago #${numeroPago} (${claveRegla})`);
                continue;
            }

            // Preparar mensaje
            const chatId = buildChatId(cliente.telefono);
            const nombreCliente = `${cliente.nombre} ${cliente.apellido || ''}`.trim();
            const fechaFormateada = new Date(fechaStr + 'T12:00:00').toLocaleDateString('es-MX', {
                day: '2-digit', month: 'long', year: 'numeric'
            });
            const montoFormateado = montoPago.toLocaleString('es-MX', { minimumFractionDigits: 2 });

            const mensaje = aplicarPlantilla(template, {
                nombre: cliente.nombre,
                numero_poliza: (poliza as any).no_poliza || 'S/N',
                fecha_vencimiento: fechaFormateada,
                prima: montoFormateado,
                aseguradora: (poliza as any).aseguradora || ''
            });

            let respuestaApi: any = null;
            let status = 'enviado';

            try {
                // Seleccionar imagen según tipo: vencida (2,5,8 días después) o recordatorio (7,1 días antes)
                const urlImagen = CLAVES_VENCIDAS.has(claveRegla) ? imagenVencidaUrl : imagenUrl;
                if (urlImagen) {
                    const imgCheck = await fetch(urlImagen, { method: 'HEAD' }).catch(() => null);
                    if (imgCheck?.ok) {
                        respuestaApi = await enviarImagenConCaption(chatId, urlImagen, mensaje);
                    } else {
                        console.warn(`⚠️ Imagen inaccesible, enviando solo texto.`);
                        respuestaApi = await enviarTexto(chatId, mensaje);
                    }
                } else {
                    respuestaApi = await enviarTexto(chatId, mensaje);
                }

                console.log(`✅ Enviado: ${nombreCliente} (${(poliza as any).no_poliza}) pago #${numeroPago} — ${claveRegla}`);
                resultados.push({
                    poliza: (poliza as any).no_poliza,
                    cliente: nombreCliente,
                    tipo: claveRegla,
                    numeroPago,
                    fechaPago: fechaStr,
                    chatId
                });

            } catch (sendErr: any) {
                console.error(`❌ Error enviando a ${chatId}:`, sendErr.message);
                status = 'error';
                respuestaApi = { error: sendErr.message };
                errores.push({ poliza: (poliza as any).no_poliza, error: sendErr.message });
            }

            await registrarEnvio(
                (poliza as any).id,
                nombreCliente,
                cliente.telefono,
                claveRegla,
                (poliza as any).no_poliza || '',
                fechaStr,
                montoPago,
                numeroPago,
                status,
                respuestaApi
            );

            // Pausa entre envíos para no saturar la API
            await new Promise(r => setTimeout(r, 500));
        }

        // Notificar al agente con resumen del proceso
        if (resultados.length > 0) {
            const lineas = resultados.slice(0, 3).map((r: any) =>
                `• ${r.cliente} (${r.poliza}) — ${r.tipo.replace('cobranza_', '').replace(/_/g, ' ')}`
            );
            if (resultados.length > 3) lineas.push(`… y ${resultados.length - 3} más`);
            await supabase.functions.invoke('push-sender', {
                body: {
                    notify_all: true,
                    title: `💳 ${resultados.length} recordatorio${resultados.length > 1 ? 's' : ''} de cobranza enviado${resultados.length > 1 ? 's' : ''}`,
                    body: lineas.join('\n'),
                    data: { url: 'cobranza.html' }
                }
            });
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
