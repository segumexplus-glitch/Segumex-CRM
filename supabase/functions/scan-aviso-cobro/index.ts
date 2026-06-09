// Deploy: supabase functions deploy scan-aviso-cobro --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'
import { jsonrepair } from 'npm:jsonrepair@3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ============================================================
// Reparador y parser de JSON
// ============================================================
function parseJson(text: string): any | null {
    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return JSON.parse(clean); } catch { /* ignore */ }
    try { return JSON.parse(jsonrepair(clean)); } catch { /* ignore */ }
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
        try { return JSON.parse(m[0]); } catch { /* ignore */ }
        try { return JSON.parse(jsonrepair(m[0])); } catch { /* ignore */ }
    }
    return null;
}

// ============================================================
// Obtiene la API Key de Gemini desde DB o Variables de Entorno
// ============================================================
async function getGeminiApiKey(): Promise<string> {
    let key = Deno.env.get('GEMINI_API_KEY')?.trim() ?? '';
    if (!key) {
        try {
            const { data, error } = await supabase
                .from('configuracion_mensajes')
                .select('contenido')
                .eq('clave', 'gemini_api_key')
                .maybeSingle();
            if (data?.contenido) {
                key = data.contenido.trim();
            }
        } catch (err) {
            console.error('[scan-aviso-cobro] Error cargando gemini_api_key de la DB:', err);
        }
    }
    return key;
}

// ============================================================
// Limpia y normaliza el número de póliza para comparaciones
// ============================================================
function normalizarNoPoliza(str: string): string {
    return str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { pdf_base64, mime_type } = await req.json();

        if (!pdf_base64) {
            throw new Error('Se requiere pdf_base64');
        }

        const mimeType = mime_type || 'application/pdf';
        const geminiApiKey = await getGeminiApiKey();

        if (!geminiApiKey) {
            throw new Error('No se configuró la API Key de Gemini');
        }

        const prompt = `Analiza este aviso de cobro (o recibo de pago pendiente) de seguro de una aseguradora mexicana y extrae la información requerida.
        
Responde ÚNICAMENTE con un JSON válido. Si no encuentras un campo, usa null.

Estructura JSON requerida:
{
  "numero_poliza": "Número, clave o serie de la póliza asociada a este cobro (limpio, sin espacios)",
  "aseguradora": "Nombre normalizado de la aseguradora (GNP, AXA, HDI, Qualitas, Mapfre, Afirme, Banorte, CHUBB, etc.)",
  "monto_cobro": 0.00,
  "fecha_vencimiento": "YYYY-MM-DD",
  "nombre_contratante": "Nombre(s) y apellido(s) del contratante o asegurado"
}

Notas:
- Para monto_cobro, extrae el valor numérico total a pagar sin símbolos de moneda ni letras.
- Fechas siempre en formato YYYY-MM-DD. Si solo dice el mes y día, asume el año corriente actual o el más lógico.`;

        const modelUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;

        console.log('[scan-aviso-cobro] Enviando archivo a Gemini 2.5 Flash...');
        const response = await fetch(modelUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { inline_data: { mime_type: mimeType, data: pdf_base64 } },
                        { text: prompt }
                    ]
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
            })
        });

        const aiData = await response.json();

        if (!response.ok || aiData.error) {
            throw new Error(aiData.error?.message || `Error HTTP ${response.status}`);
        }

        const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        console.log('[scan-aviso-cobro] Respuesta raw de Gemini:', rawText);

        const extracted = parseJson(rawText);
        if (!extracted) {
            throw new Error('No se pudo parsear el JSON devuelto por la IA: ' + rawText.substring(0, 300));
        }

        console.log('[scan-aviso-cobro] Datos extraídos exitosamente:', extracted);

        // --------------------------------------------------------
        // Búsqueda de la póliza correspondiente en Supabase
        // --------------------------------------------------------
        let polizaEncontrada: any = null;

        if (extracted.numero_poliza) {
            const cleanNoPoliza = normalizarNoPoliza(extracted.numero_poliza);
            console.log(`[scan-aviso-cobro] Buscando póliza que contenga: "${cleanNoPoliza}"`);

            // Obtenemos todas las pólizas vigentes/activas/renovadas
            const { data: polizas, error: polizasErr } = await supabase
                .from('polizas')
                .select('id, no_poliza, cliente_id, finanzas, pagos_status, pagos_fechas, documentos')
                .in('estado', ['activa', 'vigente', 'activada', 'Activada', 'Vigente', 'renovada']);

            if (!polizasErr && polizas) {
                // Buscamos coincidencia exacta o coincidencia parcial eliminando caracteres no alfanuméricos
                polizaEncontrada = polizas.find(p => {
                    const normPolDb = normalizarNoPoliza(p.no_poliza || '');
                    return normPolDb.includes(cleanNoPoliza) || cleanNoPoliza.includes(normPolDb);
                });
            }
        }

        // Si no se encuentra por póliza, intentar por nombre del cliente
        if (!polizaEncontrada && extracted.nombre_contratante) {
            console.log(`[scan-aviso-cobro] No se encontró póliza por número. Intentando buscar por nombre contratante: "${extracted.nombre_contratante}"`);
            
            // Buscar clientes que tengan nombres similares
            const words = extracted.nombre_contratante.toLowerCase().split(' ').filter((w: string) => w.length > 2);
            if (words.length > 0) {
                const { data: clientes } = await supabase
                    .from('clientes')
                    .select('id, nombre, apellido');
                
                const clienteMatch = clientes?.find(c => {
                    const fullName = `${c.nombre} ${c.apellido || ''}`.toLowerCase();
                    return words.every((word: string) => fullName.includes(word));
                });

                if (clienteMatch) {
                    console.log(`[scan-aviso-cobro] Cliente coincidente encontrado: ${clienteMatch.nombre} ${clienteMatch.apellido}. Buscando sus pólizas activas...`);
                    const { data: polizasCli } = await supabase
                        .from('polizas')
                        .select('id, no_poliza, cliente_id, finanzas, pagos_status, pagos_fechas, documentos')
                        .eq('cliente_id', clienteMatch.id)
                        .in('estado', ['activa', 'vigente', 'activada', 'Activada', 'Vigente']);
                    
                    if (polizasCli && polizasCli.length > 0) {
                        // Si tiene solo una póliza, la asociamos. Si tiene varias, intentamos por la aseguradora.
                        if (polizasCli.length === 1) {
                            polizaEncontrada = polizasCli[0];
                        } else if (extracted.aseguradora) {
                            const cleanAsegIA = extracted.aseguradora.toLowerCase().trim();
                            polizaEncontrada = polizasCli.find(p => 
                                (p.aseguradora || '').toLowerCase().trim().includes(cleanAsegIA) || 
                                cleanAsegIA.includes((p.aseguradora || '').toLowerCase().trim())
                            ) || polizasCli[0];
                        }
                    }
                }
            }
        }

        // Si finalmente se encontró la póliza, determinar cuál es el número de pago
        let numeroPagoAsignado = 1;
        let fechaPagoEnCalendario = '';
        let polizaDetalle: any = null;

        if (polizaEncontrada) {
            const finanzas = polizaEncontrada.finanzas || {};
            const numPagos = parseInt(finanzas.formaPago) || 1;
            const pagosDetalle = finanzas.pagos_detalle || [];
            const pagosFechas = polizaEncontrada.pagos_fechas || [];
            
            // Construir calendario para comparar fechas
            const calendario: Array<{ fecha: string; total: number; numero: number }> = [];
            
            if (pagosDetalle.length > 0) {
                pagosDetalle.forEach((p: any, i: number) => {
                    calendario.push({
                        fecha: String(p.fecha).substring(0, 10),
                        total: Number(p.total) || 0,
                        numero: Number(p.numero || (i + 1))
                    });
                });
            } else if (pagosFechas.length > 0) {
                pagosFechas.forEach((f: string, i: number) => {
                    calendario.push({
                        fecha: String(f).substring(0, 10),
                        total: Number(finanzas.primaTotal || 0) / numPagos,
                        numero: i + 1
                    });
                });
            } else if (finanzas.inicio) {
                // Generar calendario proyectado en memoria
                let refFecha = new Date(finanzas.inicio + 'T12:00:00');
                for (let i = 0; i < numPagos; i++) {
                    calendario.push({
                        fecha: refFecha.toISOString().substring(0, 10),
                        total: Number(finanzas.primaTotal || 0) / numPagos,
                        numero: i + 1
                    });
                    refFecha.setMonth(refFecha.getMonth() + (12 / numPagos));
                }
            }

            console.log(`[scan-aviso-cobro] Calendario de pagos de la póliza:`, calendario);

            if (calendario.length > 0 && extracted.fecha_vencimiento) {
                const targetDate = new Date(extracted.fecha_vencimiento + 'T00:00:00Z');
                let menorDiffDias = Infinity;
                let mejorPago = calendario[0];

                calendario.forEach(pago => {
                    const pagoDate = new Date(pago.fecha + 'T00:00:00Z');
                    const diffMs = Math.abs(pagoDate.getTime() - targetDate.getTime());
                    const diffDias = diffMs / (1000 * 60 * 60 * 24);

                    if (diffDias < menorDiffDias) {
                        menorDiffDias = diffDias;
                        mejorPago = pago;
                    }
                });

                numeroPagoAsignado = mejorPago.numero;
                fechaPagoEnCalendario = mejorPago.fecha;
                console.log(`[scan-aviso-cobro] Pago asignado por cercanía de fecha: Pago #${numeroPagoAsignado} (Fecha calendario: ${fechaPagoEnCalendario}, Diff: ${menorDiffDias.toFixed(1)} días)`);
            }

            // Cargar datos complementarios del cliente para mostrarlos en el frontend
            const { data: clientData } = await supabase
                .from('clientes')
                .select('nombre, apellido')
                .eq('id', polizaEncontrada.cliente_id)
                .single();
            
            polizaDetalle = {
                id: polizaEncontrada.id,
                no_poliza: polizaEncontrada.no_poliza,
                cliente_nombre: clientData ? `${clientData.nombre} ${clientData.apellido || ''}`.trim() : 'Desconocido',
                aseguradora: polizaEncontrada.aseguradora,
                numero_pago: numeroPagoAsignado,
                fecha_calendario: fechaPagoEnCalendario
            };

            // --------------------------------------------------------
            // Subir archivo PDF a Storage
            // --------------------------------------------------------
            const pdfBytes = Uint8Array.from(atob(pdf_base64), c => c.charCodeAt(0));
            const fileName = `${Date.now()}_aviso_pago_${numeroPagoAsignado}.pdf`;
            const filePath = `avisos_cobro/${polizaEncontrada.id}/${fileName}`;

            console.log(`[scan-aviso-cobro] Subiendo archivo a Storage: documentos-polizas / ${filePath}`);
            const { data: storageData, error: storageErr } = await supabase.storage
                .from('documentos-polizas')
                .upload(filePath, pdfBytes, {
                    upsert: true,
                    contentType: 'application/pdf'
                });

            if (storageErr) {
                throw new Error(`Error al subir PDF a Storage: ${storageErr.message}`);
            }

            // --------------------------------------------------------
            // Actualizar documentos en la Póliza en la Base de Datos
            // --------------------------------------------------------
            const documentosActuales = polizaEncontrada.documentos || [];
            
            // Creamos el nuevo objeto de documento
            const nuevoDoc = {
                nombre: `Aviso de Cobro - Pago ${numeroPagoAsignado}`,
                tamano: `${(pdfBytes.length / 1024).toFixed(1)} KB`,
                path: storageData.path,
                tipo: 'aviso_cobro',
                numero_pago: numeroPagoAsignado
            };

            // Remover si ya existía un aviso de cobro previo para el mismo número de pago en esta póliza
            const documentosFiltrados = documentosActuales.filter((d: any) => 
                !(d.tipo === 'aviso_cobro' && d.numero_pago === numeroPagoAsignado)
            );
            
            documentosFiltrados.push(nuevoDoc);

            console.log(`[scan-aviso-cobro] Actualizando array de documentos de la póliza...`);
            const { error: updateErr } = await supabase
                .from('polizas')
                .update({ documentos: documentosFiltrados })
                .eq('id', polizaEncontrada.id);

            if (updateErr) {
                throw new Error(`Error al guardar los documentos en la base de datos: ${updateErr.message}`);
            }

            console.log(`[scan-aviso-cobro] Póliza y aviso de cobro guardados exitosamente.`);
        }

        return new Response(JSON.stringify({
            success: true,
            extracted_data: extracted,
            poliza_encontrada: !!polizaEncontrada,
            poliza_detalle: polizaDetalle
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        console.error('[scan-aviso-cobro] Error procesando aviso de cobro:', err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
