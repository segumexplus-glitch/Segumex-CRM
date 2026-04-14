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
                responseMimeType: 'application/json',
                maxOutputTokens: 8192
            }
        };

        // Reintentos internos ante errores de Gemini (rate limit, timeout, JSON malformado)
        let extracted: any = null;
        let lastError = '';
        const MAX_INTENTOS = 3;

        for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
            try {
                const response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const aiData = await response.json();

                if (!response.ok || aiData.error) {
                    const msg = aiData.error?.message || `HTTP ${response.status}`;
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS} error: ${msg}`);
                    lastError = msg;
                    if (intento < MAX_INTENTOS) {
                        await new Promise(r => setTimeout(r, 1500 * intento));
                        continue;
                    }
                    throw new Error(`Gemini error después de ${MAX_INTENTOS} intentos: ${lastError}`);
                }

                const rawText = aiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

                if (!rawText.trim()) {
                    lastError = 'Gemini devolvió respuesta vacía';
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS}: respuesta vacía`);
                    if (intento < MAX_INTENTOS) {
                        await new Promise(r => setTimeout(r, 1500 * intento));
                        continue;
                    }
                    throw new Error(lastError);
                }

                // Parseo robusto: intenta múltiples estrategias
                let parseError = '';
                let parsed: any = null;

                // Estrategia 1: parseo directo
                try { parsed = JSON.parse(rawText.trim()); } catch (e1) { parseError = String(e1); }

                // Estrategia 2: limpiar bloques de código markdown
                if (!parsed) {
                    try {
                        const cleaned = rawText
                            .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                        parsed = JSON.parse(cleaned);
                    } catch (e2) { parseError = String(e2); }
                }

                // Estrategia 3: extraer primer objeto JSON del texto
                if (!parsed) {
                    try {
                        const match = rawText.match(/\{[\s\S]*\}/);
                        if (match) parsed = JSON.parse(match[0]);
                    } catch (e3) { parseError = String(e3); }
                }

                if (!parsed) {
                    lastError = `No se pudo parsear JSON: ${parseError}`;
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS}: ${lastError}`);
                    console.warn('rawText preview:', rawText.substring(0, 300));
                    if (intento < MAX_INTENTOS) {
                        await new Promise(r => setTimeout(r, 1500 * intento));
                        continue;
                    }
                    throw new Error(lastError);
                }

                // Validar calidad mínima
                if (!parsed.aseguradora && (!parsed.coberturas || parsed.coberturas.length === 0)) {
                    lastError = 'Gemini no identificó aseguradora ni coberturas';
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS}: ${lastError}`);
                    if (intento < MAX_INTENTOS) {
                        await new Promise(r => setTimeout(r, 2000 * intento));
                        continue;
                    }
                    throw new Error(lastError);
                }

                extracted = parsed;
                console.log(`✅ Extracción exitosa en intento ${intento}. Aseguradora: ${parsed.aseguradora}, coberturas: ${parsed.coberturas?.length || 0}`);
                break; // éxito, salir del loop

            } catch (loopErr: any) {
                if (intento === MAX_INTENTOS) throw loopErr;
            }
        }

        if (!extracted) throw new Error(`No se pudo extraer datos después de ${MAX_INTENTOS} intentos`);

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
