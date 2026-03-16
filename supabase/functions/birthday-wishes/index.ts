// Deploy: supabase functions deploy birthday-wishes --no-verify-jwt
// Schedule: ejecutar diariamente (igual que payment-reminders)

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GREEN_INSTANCE_ID        = Deno.env.get('GREEN_INSTANCE_ID') ?? '';
const GREEN_API_TOKEN          = Deno.env.get('GREEN_API_TOKEN') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================================
// Helpers
// ============================================================
function buildChatId(telefono: string): string {
    const digits = telefono.replace(/\D/g, '');
    const tel10  = digits.slice(-10);
    return `521${tel10}@c.us`;
}

function greenBaseUrl(): string {
    if (GREEN_INSTANCE_ID.startsWith('7107')) {
        return `https://7107.api.greenapi.com/waInstance${GREEN_INSTANCE_ID}`;
    }
    return `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}`;
}

async function enviarTexto(chatId: string, message: string): Promise<any> {
    const res = await fetch(`${greenBaseUrl()}/sendMessage/${GREEN_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message }),
    });
    return await res.json();
}

async function enviarImagenConCaption(chatId: string, imageUrl: string, caption: string): Promise<any> {
    const res = await fetch(`${greenBaseUrl()}/sendFileByUrl/${GREEN_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, urlFile: imageUrl, fileName: 'cumpleanos.jpg', caption }),
    });
    return await res.json();
}

function aplicarPlantilla(template: string, vars: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{${key}}`, value || '');
    }
    return result;
}

// Extrae {dia, mes} del RFC de persona física (AAAA + YYMMDD + homoclave)
function cumpleDesdeRFC(rfc: string): { dia: number; mes: number } | null {
    const m = rfc.toUpperCase().match(/^[A-Z]{4}(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const mm = parseInt(m[2]);
    const dd = parseInt(m[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return { dia: dd, mes: mm };
}

// Verifica si ya se envió felicitación este año a este cliente
async function yaEnviadoEsteanio(clienteId: number, anio: number): Promise<boolean> {
    const desde = `${anio}-01-01`;
    const hasta = `${anio}-12-31`;
    const { data } = await supabase
        .from('mensajes_cobranza_log')
        .select('id')
        .eq('tipo_mensaje', 'cumpleanos')
        .gte('enviado_at', desde)
        .lte('enviado_at', hasta + 'T23:59:59')
        .filter('respuesta_api->>clienteId', 'eq', String(clienteId))
        .maybeSingle();
    return !!data;
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    const resultados: any[] = [];
    const errores:    any[] = [];

    try {
        if (!GREEN_INSTANCE_ID || !GREEN_API_TOKEN) {
            throw new Error('Faltan credenciales de Green API');
        }

        // ── 0. Verificar toggle general de envíos automáticos ──────
        const { data: activoConfig } = await supabase
            .from('configuracion_mensajes')
            .select('contenido')
            .eq('clave', 'cobranza_activa')
            .maybeSingle();

        if (activoConfig?.contenido !== 'true') {
            return new Response(JSON.stringify({
                success: true,
                message: 'Envíos automáticos desactivados.',
                enviados: 0,
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // ── 1. Cargar plantilla e imagen de cumpleaños ─────────────
        const { data: configs } = await supabase
            .from('configuracion_mensajes')
            .select('clave, contenido');

        const cfg: Record<string, string> = {};
        (configs || []).forEach((c: any) => { cfg[c.clave] = c.contenido || ''; });

        const plantilla = cfg['cumpleanos_mensaje'] || DEFAULT_PLANTILLA;
        let imagenUrl = cfg['cumpleanos_imagen_url'] || '';

        // Intentar imagen desde Storage si no hay URL guardada
        if (!imagenUrl) {
            const { data: sd } = await supabase.storage
                .from('documentos-polizas')
                .createSignedUrl('cumpleanos/imagen_cumpleanos.png', 3600);
            if (sd?.signedUrl) imagenUrl = sd.signedUrl;
        }

        // ── 2. Fecha de hoy en zona México ─────────────────────────
        const hoyMX  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
        const diaHoy = hoyMX.getDate();
        const mesHoy = hoyMX.getMonth() + 1;
        const anioHoy = hoyMX.getFullYear();

        console.log(`🎂 birthday-wishes — hoy México: ${diaHoy}/${mesHoy}/${anioHoy}`);

        // ── 3. Obtener todos los clientes con RFC ──────────────────
        const { data: clientes, error: cliErr } = await supabase
            .from('clientes')
            .select('id, nombre, apellido, telefono, rfc')
            .not('rfc', 'is', null)
            .neq('rfc', '');

        if (cliErr) throw new Error('Error cargando clientes: ' + cliErr.message);
        console.log(`👥 Clientes con RFC: ${(clientes || []).length}`);

        // ── 4. Filtrar los que cumplen hoy ─────────────────────────
        for (const cli of (clientes || [])) {
            const cumple = cumpleDesdeRFC(cli.rfc);
            if (!cumple) continue;
            if (cumple.dia !== diaHoy || cumple.mes !== mesHoy) continue;
            if (!cli.telefono) {
                console.log(`⚠️ ${cli.nombre}: sin teléfono, omitiendo.`);
                continue;
            }

            // Evitar duplicado en el mismo año
            const enviado = await yaEnviadoEsteanio(cli.id, anioHoy);
            if (enviado) {
                console.log(`⏭️ ${cli.nombre}: ya enviado este año.`);
                continue;
            }

            const nombreCompleto = `${cli.nombre} ${cli.apellido || ''}`.trim();
            const chatId  = buildChatId(cli.telefono);
            const mensaje = aplicarPlantilla(plantilla, { nombre: cli.nombre });

            let respuestaApi: any = null;
            let status = 'enviado';

            try {
                if (imagenUrl) {
                    const imgCheck = await fetch(imagenUrl, { method: 'HEAD' }).catch(() => null);
                    if (imgCheck?.ok) {
                        respuestaApi = await enviarImagenConCaption(chatId, imagenUrl, mensaje);
                    } else {
                        respuestaApi = await enviarTexto(chatId, mensaje);
                    }
                } else {
                    respuestaApi = await enviarTexto(chatId, mensaje);
                }
                console.log(`✅ Cumpleaños enviado: ${nombreCompleto} (${chatId})`);
                resultados.push({ cliente: nombreCompleto, chatId });
            } catch (sendErr: any) {
                console.error(`❌ Error enviando a ${chatId}:`, sendErr.message);
                status = 'error';
                respuestaApi = { error: sendErr.message };
                errores.push({ cliente: nombreCompleto, error: sendErr.message });
            }

            // Log — incluimos clienteId en respuesta_api para deduplicación anual
            await supabase.from('mensajes_cobranza_log').insert({
                cliente_nombre: nombreCompleto,
                telefono:       cli.telefono,
                tipo_mensaje:   'cumpleanos',
                numero_poliza:  null,
                status,
                respuesta_api:  { ...respuestaApi, clienteId: cli.id },
            });

            await new Promise(r => setTimeout(r, 500));
        }

        // Notificar al agente con resumen del proceso
        if (resultados.length > 0) {
            const nombres = resultados.slice(0, 3).map((r: any) => r.cliente).join(', ');
            const extra = resultados.length > 3 ? ` y ${resultados.length - 3} más` : '';
            await supabase.functions.invoke('push-sender', {
                body: {
                    notify_all: true,
                    title: `🎂 ${resultados.length} felicitación${resultados.length > 1 ? 'es' : ''} de cumpleaños enviada${resultados.length > 1 ? 's' : ''}`,
                    body: `${nombres}${extra}`,
                    data: { url: 'clientes.html' }
                }
            });
        }

        return new Response(JSON.stringify({
            success: true,
            fecha_proceso: `${diaHoy}/${mesHoy}/${anioHoy}`,
            enviados: resultados.length,
            errores:  errores.length,
            detalle:  resultados,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (err: any) {
        console.error('Error crítico birthday-wishes:', err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});

// ============================================================
// Plantilla por defecto
// ============================================================
const DEFAULT_PLANTILLA = `¡Hola, *{nombre}*! 👋🔵

En *SEGUMEX* no queríamos dejar pasar este día tan especial. Te enviamos un afectuoso saludo y nuestros mejores deseos en tu cumpleaños.

¡Que pases un día extraordinario rodeado de tus seres queridos! 🎂🎉

— *Equipo Segumex* 🛡️`;
