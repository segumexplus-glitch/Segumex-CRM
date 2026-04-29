// Deploy: supabase functions deploy scan-policy-pdf --no-verify-jwt

import { jsonrepair } from 'npm:jsonrepair@3';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

        const prompt = `Analiza esta póliza de seguro mexicana y extrae toda la información relevante.

Responde ÚNICAMENTE con un JSON válido. Si no encuentras un campo usa null.

Estructura JSON requerida:
{
  "cliente": {
    "nombre": "primer nombre(s)",
    "apellido": "apellido(s)",
    "rfc": "RFC si aparece",
    "telefono": "solo dígitos, 10 dígitos si es mexicano",
    "email": "email si aparece",
    "calle_numero_colonia": "calle, número exterior/interior y colonia (sin CP, municipio ni estado)",
    "cp": "código postal, solo 5 dígitos numéricos",
    "municipio": "ciudad o municipio",
    "estado": "estado de la república"
  },
  "poliza": {
    "numero_poliza": "número o clave de la póliza",
    "aseguradora": "nombre de la aseguradora (GNP, AXA, HDI, Qualitas, Mapfre, Afirme, Banorte, CHUBB, etc.)",
    "tipo_seguro": "auto|gmm|vida|hogar|empresarial|danos|mascotas",
    "fecha_inicio": "YYYY-MM-DD",
    "fecha_fin": "YYYY-MM-DD",
    "prima_neta": 0.00,
    "prima_total": 0.00,
    "forma_pago": 1
  },
  "vehiculo": {
    "marca": "marca del vehículo si es auto",
    "modelo": "modelo",
    "anio": "año como texto",
    "version": "versión o trim",
    "serie": "número de serie VIN",
    "placas": "placas"
  }
}

Notas:
- forma_pago: 1=anual, 2=semestral, 4=trimestral, 12=mensual
- Para prima_neta y prima_total, extrae el valor numérico sin símbolos
- Si no es seguro de auto, el objeto vehiculo puede tener todos sus campos en null
- Fechas siempre en formato YYYY-MM-DD`;

        const models = [
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        ];

        let extracted: any = null;
        let lastError = '';

        for (const modelUrl of models) {
            if (extracted) break;

            for (let intento = 1; intento <= 2; intento++) {
                try {
                    if (intento > 1) await new Promise(r => setTimeout(r, 1500));

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
                            // Sin responseMimeType para evitar respuestas vacías por filtros internos de Gemini
                            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
                        })
                    });

                    const aiData = await response.json();

                    if (!response.ok || aiData.error) {
                        lastError = aiData.error?.message || `HTTP ${response.status}`;
                        console.warn(`[scan-policy] Error HTTP ${response.status}: ${lastError}`);
                        continue;
                    }

                    const candidate = aiData.candidates?.[0];
                    const finishReason = candidate?.finishReason ?? 'UNKNOWN';
                    const rawText = candidate?.content?.parts?.[0]?.text ?? '';

                    console.log(`[scan-policy] model=${modelUrl.split('models/')[1].split(':')[0]}, finish=${finishReason}, len=${rawText.length}`);

                    if (!rawText.trim()) {
                        lastError = `Respuesta vacía (${finishReason})`;
                        continue;
                    }

                    const parsed = parseJson(rawText);
                    if (parsed) {
                        extracted = parsed;
                        console.log(`✅ scan-policy exitoso. Aseguradora: ${parsed.poliza?.aseguradora}`);
                        break;
                    } else {
                        lastError = 'No se pudo parsear JSON';
                        console.warn('[scan-policy] Parse falló. Preview:', rawText.substring(0, 300));
                    }
                } catch (e: any) {
                    lastError = e.message;
                    console.error('[scan-policy] Error inesperado:', e);
                }
            }
        }

        if (!extracted) {
            throw new Error(lastError || 'No se pudo extraer información del PDF');
        }

        return new Response(JSON.stringify({ success: true, data: extracted }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        console.error('scan-policy-pdf error:', err);
        // Siempre HTTP 200 — si devolvemos 500, el cliente Supabase lanza
        // "non-2xx status code" y el frontend no puede leer el mensaje de error real.
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
