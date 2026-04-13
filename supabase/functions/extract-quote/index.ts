// Deploy: supabase functions deploy extract-quote --no-verify-jwt

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
        const { pdf_base64, mime_type } = await req.json();

        if (!pdf_base64) {
            throw new Error('Se requiere pdf_base64');
        }

        const mimeType = mime_type || 'application/pdf';

        const prompt = `Analiza esta cotización de seguro de auto mexicano y extrae toda la información relevante.

Responde ÚNICAMENTE con un JSON válido, sin bloques de código ni explicaciones.
Si no encuentras un campo usa null. No inventes datos.

Estructura JSON requerida:
{
  "aseguradora": "nombre exacto: HDI, Qualitas, GNP, AXA, Mapfre, Afirme, Chubb, Zurich, Inbursa, Banorte, Atlas, Primero, Ana u otra",
  "vehiculo": {
    "marca": "marca del vehículo",
    "modelo": "modelo",
    "anio": "año como texto de 4 dígitos",
    "version": "versión o trim si aparece",
    "serie": "número de serie VIN si aparece"
  },
  "coberturas": [
    {
      "nombre": "nombre de la cobertura",
      "suma_asegurada": "monto o descripción (ej: '3,000,000', 'Valor comercial', 'Amplia')",
      "deducible": "deducible si aplica (ej: '10%', '5%', 'No aplica')",
      "incluida": true
    }
  ],
  "prima_total": 0.00,
  "prima_fraccionada": 0.00,
  "forma_pago": 1,
  "cp": "código postal si aparece",
  "numero_cotizacion": "folio o número de cotización de la aseguradora si aparece",
  "vigencia_cotizacion": "fecha de vencimiento de la cotización si aparece"
}

Notas importantes:
- forma_pago: 1=anual, 2=semestral, 4=trimestral, 12=mensual
- prima_total: prima total a pagar en el período seleccionado (sin IVA si es posible, o total si no se distingue)
- prima_fraccionada: cuánto se pagaría por período si hay pago fraccionado (mensual/trimestral/etc), null si no aplica
- coberturas: incluye TODAS las coberturas que aparezcan en el documento, tanto incluidas como opcionales
- Para coberturas importantes de auto en México: RC (Responsabilidad Civil), DM (Daños Materiales), RT (Robo Total), GM (Gastos Médicos Ocupantes), AF (Asistencia Vial), RC amplia, etc.
- suma_asegurada: escribe el monto como texto (ej: "3,000,000") o descripción si es valor comercial/amplia`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

        const payload = {
            contents: [{
                role: 'user',
                parts: [
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: pdf_base64
                        }
                    },
                    { text: prompt }
                ]
            }],
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

        let cleanText = rawText
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

        let extracted;
        try {
            extracted = JSON.parse(cleanText);
        } catch {
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

    } catch (err: any) {
        console.error('extract-quote error:', err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
