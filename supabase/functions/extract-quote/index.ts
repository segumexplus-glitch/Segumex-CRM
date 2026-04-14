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

        const prompt = `Eres un experto en seguros de auto en México. Analiza EXHAUSTIVAMENTE esta cotización y extrae ABSOLUTAMENTE TODA la información. No omitas ningún detalle, por mínimo que sea.

Responde ÚNICAMENTE con un JSON válido, sin bloques de código ni explicaciones adicionales.
Si no encuentras un campo usa null. No inventes datos.

Estructura JSON requerida:
{
  "aseguradora": "nombre exacto de la compañía aseguradora tal como aparece en el documento (ej: HDI Seguros, Quálitas, GNP Seguros, AXA Seguros, Mapfre, Afirme Seguros, Chubb, Zurich, Inbursa, Banorte Seguros, Seguros Atlas, Primero Seguros, ANA Seguros u otra)",
  "vehiculo": {
    "marca": "marca del vehículo",
    "modelo": "modelo exacto",
    "anio": "año como texto de 4 dígitos",
    "version": "versión, trim o descripción completa del modelo si aparece",
    "serie": "número de serie VIN completo si aparece"
  },
  "coberturas": [
    {
      "nombre": "nombre EXACTO de la cobertura tal como aparece en el documento",
      "suma_asegurada": "monto exacto o descripción (ej: '$3,000,000', 'Valor Comercial', 'Valor Convenido', 'Amplia', 'Limitada', 'Amparado', 'Incluida')",
      "deducible": "deducible exacto si aplica (ej: '10%', '5%', '$5,000', '3 SMDF', 'No aplica', 'N/A')",
      "incluida": true
    }
  ],
  "prima_total": 0.00,
  "prima_neta": 0.00,
  "prima_fraccionada": 0.00,
  "forma_pago": 1,
  "cp": "código postal si aparece",
  "numero_cotizacion": "folio, número o clave de cotización de la aseguradora si aparece",
  "vigencia_inicio": "fecha de inicio de vigencia si aparece",
  "vigencia_fin": "fecha de fin de vigencia si aparece",
  "vigencia_cotizacion": "fecha de vencimiento de la cotización (hasta cuándo es válida) si aparece"
}

INSTRUCCIONES CRÍTICAS para el campo "coberturas" — LEE CON ATENCIÓN:
- Extrae CADA UNA de las coberturas listadas en el documento sin excepción
- Incluye coberturas básicas: Daños Materiales (DM), Robo Total (RT), Responsabilidad Civil (RC), Gastos Médicos Ocupantes (GMO / GM), Asistencia Vial, Defensa Legal
- Incluye coberturas extendidas: RC en EUA y Canadá, Extensión RC, Muerte del Conductor, Pérdida de Uso, Cristales, Equipo Especial, etc.
- Incluye coberturas adicionales u opcionales que aparezcan aunque estén marcadas como "no incluidas" — en ese caso pon incluida: false
- Para cada cobertura anota el deducible EXACTO como aparece (porcentaje, pesos, días de salario mínimo, etc.)
- Si una cobertura dice "AMPARADO", "INCLUIDA", "AMPLIA", "APLICA" = incluida true, suma_asegurada con ese texto
- Si dice "NO APLICA", "EXCLUIDA", "NO INCLUIDA" = incluida false
- NO agrupes coberturas — cada línea de cobertura del documento = un objeto separado en el array
- Los montos de suma asegurada escríbelos CON el símbolo de pesos y comas (ej: "$3,000,000.00")

INSTRUCCIONES para primas:
- prima_total: el total a pagar en el período seleccionado (incluyendo IVA si no se distingue)
- prima_neta: prima sin IVA si aparece desglosada
- prima_fraccionada: monto por período en pagos fraccionados (mensual, trimestral, semestral), null si solo hay pago anual
- forma_pago: 1=anual, 2=semestral, 4=trimestral, 12=mensual — detecta según el tipo de pago de la cotización`;

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
