// Deploy: supabase functions deploy scan-policy-pdf --no-verify-jwt

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { pdf_base64, filename } = await req.json();

        if (!pdf_base64) {
            throw new Error('Se requiere pdf_base64');
        }

        const prompt = `Analiza esta póliza de seguro mexicana y extrae toda la información relevante.

Responde ÚNICAMENTE con un JSON válido, sin bloques de código ni explicaciones adicionales.
Si no encuentras un campo, usa null.

Estructura JSON requerida:
{
  "cliente": {
    "nombre": "primer nombre(s)",
    "apellido": "apellido(s)",
    "rfc": "RFC si aparece",
    "telefono": "solo dígitos, 10 dígitos si es mexicano",
    "email": "email si aparece",
    "direccion": "dirección completa si aparece"
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

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

        const payload = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inline_data: {
                                mime_type: 'application/pdf',
                                data: pdf_base64
                            }
                        },
                        { text: prompt }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json'
            }
        };

        const response = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const aiData = await response.json();

        if (!response.ok || aiData.error) {
            console.error('Gemini error:', JSON.stringify(aiData));
            throw new Error(aiData.error?.message || 'Error al procesar con Gemini');
        }

        const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        // Limpiar y parsear JSON
        let cleanText = rawText
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

        let extracted;
        try {
            extracted = JSON.parse(cleanText);
        } catch {
            // Intentar extraer el JSON del texto
            const match = cleanText.match(/\{[\s\S]*\}/);
            if (match) {
                extracted = JSON.parse(match[0]);
            } else {
                throw new Error('No se pudo parsear la respuesta de Gemini');
            }
        }

        return new Response(JSON.stringify({ success: true, data: extracted }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err) {
        console.error('scan-policy-pdf error:', err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
