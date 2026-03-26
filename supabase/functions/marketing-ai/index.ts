// Deploy: supabase functions deploy marketing-ai --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')?.trim() ?? '';
const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID') ?? '';
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function buildGreenBaseUrl(instanceId: string): string {
    if (instanceId.startsWith('7107')) return `https://7107.api.greenapi.com/waInstance${instanceId}`;
    return `https://api.green-api.com/waInstance${instanceId}`;
}

async function callGemini(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function getMarketingImageUrl(path: string): Promise<string | null> {
    // Bucket marketing-images es público → URL directa
    const { data } = supabase.storage.from('marketing-images').getPublicUrl(path);
    return data?.publicUrl ?? null;
}

async function sendWhatsApp(telefono: string, nombre: string, mensaje: string, imagenUrl?: string | null): Promise<boolean> {
    const greenBase = buildGreenBaseUrl(GREEN_INSTANCE_ID);
    const tel = telefono.replace(/\D/g, '');
    const chatId = tel.length === 10 ? `521${tel}@c.us` : `52${tel}@c.us`;
    const texto = mensaje.replace('{nombre}', nombre);

    try {
        if (imagenUrl) {
            const res = await fetch(`${greenBase}/sendFileByUrl/${GREEN_API_TOKEN}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, urlFile: imagenUrl, fileName: 'segumex.jpg', caption: texto })
            });
            if (res.ok) return true;
            // Fallback a solo texto si falla la imagen
        }
        const res = await fetch(`${greenBase}/sendMessage/${GREEN_API_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, message: texto })
        });
        return res.ok;
    } catch {
        return false;
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const body = await req.json();
        const { action } = body;

        // ── SUGERENCIAS IA ─────────────────────────────────────────
        if (action === 'sugerencias') {
            const { data: clientes } = await supabase
                .from('clientes')
                .select('id, nombre, apellido, telefono, nacimiento, created_at')
                .limit(100);

            const { data: polizas } = await supabase
                .from('polizas')
                .select('cliente_id, ramo, estado, vence, prima')
                .in('estado', ['activa', 'vigente']);

            const { data: historialMarketing } = await supabase
                .from('historial_marketing')
                .select('destinatarios')
                .order('created_at', { ascending: false })
                .limit(10);

            const perfiles = (clientes || []).map(c => {
                const polizasC = (polizas || []).filter(p => String(p.cliente_id) === String(c.id));
                const ramos = [...new Set(polizasC.map(p => p.ramo).filter(Boolean))];
                const dias = Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86400000);
                const proximoVence = polizasC
                    .filter(p => p.vence)
                    .sort((a, b) => new Date(a.vence).getTime() - new Date(b.vence).getTime())[0];
                const diasParaVencer = proximoVence
                    ? Math.floor((new Date(proximoVence.vence).getTime() - Date.now()) / 86400000)
                    : null;
                return {
                    id: c.id,
                    nombre: `${c.nombre} ${c.apellido || ''}`.trim(),
                    telefono: c.telefono,
                    diasComoCliente: dias,
                    polizasActuales: ramos,
                    totalPolizas: polizasC.length,
                    diasParaVencer
                };
            });

            const prompt = `Eres un experto en ventas de seguros para Segumex México.
Analiza estos perfiles de clientes y genera EXACTAMENTE 6 sugerencias de acción comercial.
Productos disponibles: Auto, Vida, GMM (Gastos Médicos Mayores), Casa, Negocio.

DATOS DE CLIENTES:
${JSON.stringify(perfiles.slice(0, 60), null, 2)}

CRITERIOS:
- 1 sola póliza → cross-sell prioritario (score alto)
- Sin pólizas → captación urgente
- >365 días como cliente → fidelización
- diasParaVencer < 30 → renovación urgente
- Tiene Auto pero no Vida/GMM → alta oportunidad

Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto extra):
[
  {
    "cliente_nombre": "string",
    "cliente_id": number,
    "cliente_telefono": "string",
    "tipo": "cross_sell"|"fidelizacion"|"renovacion"|"captacion",
    "producto_sugerido": "string",
    "razon": "string máx 20 palabras, menciona datos reales del cliente",
    "prioridad": "alta"|"media"|"baja",
    "mensaje_sugerido": "string WhatsApp personalizado máx 220 chars, usa {nombre}"
  }
]`;

            const raw = await callGemini(prompt);
            let sugerencias = [];
            try {
                const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
                sugerencias = JSON.parse(clean);
            } catch {
                console.error('Error parsing sugerencias:', raw.substring(0, 200));
            }

            return new Response(JSON.stringify({ sugerencias }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // ── OPORTUNIDADES CROSS-SELL ──────────────────────────────
        if (action === 'oportunidades') {
            const { data: clientes } = await supabase
                .from('clientes')
                .select('id, nombre, apellido, telefono, email, created_at')
                .limit(200);

            const { data: polizas } = await supabase
                .from('polizas')
                .select('cliente_id, ramo, estado, vence')
                .in('estado', ['activa', 'vigente']);

            const RAMOS = ['Auto', 'Vida', 'GMM', 'Casa', 'Negocio'];

            const oportunidades = (clientes || []).map(c => {
                const polizasC = (polizas || []).filter(p => String(p.cliente_id) === String(c.id));
                const ramosActuales = polizasC.map(p => (p.ramo || '').toLowerCase());
                const dias = Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86400000);
                const faltantes = RAMOS.filter(r => !ramosActuales.some(ra => ra.includes(r.toLowerCase())));

                let score = 0;
                let oportunidad = '';
                if (polizasC.length === 0) { score = 85; oportunidad = 'Sin pólizas – Captación urgente'; }
                else if (polizasC.length === 1) { score = 75; oportunidad = `Solo ${polizasC[0].ramo} – Alta oportunidad`; }
                else if (polizasC.length === 2) { score = 50; oportunidad = 'Ampliar cobertura'; }
                else { score = 25; oportunidad = 'Cliente completo'; }

                if (dias > 365) score += 10;
                if (dias > 730) score += 10;

                return {
                    id: c.id,
                    nombre: `${c.nombre} ${c.apellido || ''}`.trim(),
                    telefono: c.telefono,
                    email: c.email,
                    polizasActuales: polizasC.map(p => p.ramo).filter(Boolean),
                    faltantes: faltantes.slice(0, 3),
                    sugerencia: faltantes[0] || 'Fidelización',
                    oportunidad,
                    score: Math.min(score, 100),
                    diasComoCliente: dias
                };
            })
                .filter(o => o.score >= 25)
                .sort((a, b) => b.score - a.score)
                .slice(0, 50);

            return new Response(JSON.stringify({ oportunidades }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // ── GENERAR MENSAJE CON IA ─────────────────────────────────
        if (action === 'generar_mensaje') {
            const { tipo_campana, producto, segmento, cliente_nombre } = body;

            const prompt = `Genera un mensaje de WhatsApp para campaña de seguros de Segumex (empresa mexicana).

Tipo: ${tipo_campana}
Producto: ${producto || 'seguros'}
Segmento: ${segmento || 'clientes actuales'}
${cliente_nombre ? `Cliente específico: ${cliente_nombre}` : ''}

Instrucciones:
- Máximo 220 caracteres
- Tono cálido y profesional, estilo mexicano
- Incluir {nombre} al inicio
- Mencionar un beneficio concreto
- Terminar con llamada a la acción breve
- Sin precios ni datos inventados

Responde SOLO con el texto del mensaje, sin comillas ni explicaciones.`;

            const mensaje = await callGemini(prompt);
            return new Response(JSON.stringify({ mensaje: mensaje.trim() }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // ── ENVIAR PRUEBA ─────────────────────────────────────────
        if (action === 'enviar_prueba') {
            const { mensaje, imagen_path, telefono_prueba } = body;
            if (!telefono_prueba) {
                return new Response(JSON.stringify({ error: 'telefono_prueba requerido' }), {
                    status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
            const imagenUrl = imagen_path ? await getMarketingImageUrl(imagen_path) : null;
            const ok = await sendWhatsApp(telefono_prueba, 'Asesor', mensaje, imagenUrl);
            return new Response(JSON.stringify({ success: ok }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // ── ENVIAR CAMPAÑA REAL ───────────────────────────────────
        if (action === 'enviar_campana') {
            const { nombre_campana, tipo, mensaje, imagen_path, destinatarios } = body;
            if (!destinatarios || destinatarios.length === 0) {
                return new Response(JSON.stringify({ error: 'Sin destinatarios' }), {
                    status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            const imagenUrl = imagen_path ? await getMarketingImageUrl(imagen_path) : null;
            let enviados = 0;
            const nombresEnviados: string[] = [];

            for (const dest of destinatarios) {
                if (!dest.telefono) continue;
                const ok = await sendWhatsApp(dest.telefono, dest.nombre || 'Cliente', mensaje, imagenUrl);
                if (ok) { enviados++; nombresEnviados.push(dest.nombre); }
                await new Promise(r => setTimeout(r, 400)); // rate limit
            }

            await supabase.from('historial_marketing').insert([{
                fecha: new Date().toLocaleString('es-MX'),
                tipo: 'WhatsApp',
                nombre: nombre_campana || 'Campaña Marketing',
                mensaje,
                conteo: enviados,
                destinatarios: nombresEnviados,
                imagen: imagen_path || null
            }]);

            return new Response(JSON.stringify({ success: true, enviados, total: destinatarios.length }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // ── PROGRAMAR CAMPAÑA (CALENDARIO) ────────────────────────
        if (action === 'programar') {
            const { nombre, tipo, mensaje, imagen_path, fecha_programada, destinatarios } = body;
            const { data, error } = await supabase
                .from('campanas_programadas')
                .insert([{ nombre, tipo, mensaje, imagen_path, fecha_programada, destinatarios }])
                .select()
                .single();
            if (error) throw error;
            return new Response(JSON.stringify({ success: true, campana: data }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ error: 'Acción desconocida' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
