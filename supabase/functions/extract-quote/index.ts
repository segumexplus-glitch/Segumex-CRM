// Deploy: supabase functions deploy extract-quote --no-verify-jwt

import { jsonrepair } from 'npm:jsonrepair@3';

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
    "marca": "SOLO el fabricante/armadora. Ejemplos correctos: Nissan, Toyota, Volkswagen, Chevrolet, Ford, Honda, Kia, Hyundai, Audi, BMW, Mercedes-Benz, Mazda, Dodge, RAM, Jeep, SEAT, Suzuki, Mitsubishi, Subaru, Volvo, Renault, Peugeot, Fiat, Porsche, Acura, Infiniti, Cadillac, Buick, GMC. NUNCA pongas el modelo ni la versión en este campo.",
    "modelo": "SOLO el nombre del modelo. Ejemplos: X-Trail, Tiguan, Versa, Jetta, Sentra, CR-V, Civic, Tucson, Compass, Ram 1500, F-150, Aveo, Beat. NUNCA pongas la marca ni la versión aquí.",
    "anio": "año del vehículo como texto de 4 dígitos (ej: '2023')",
    "version": "SOLO el nivel de acabado o trim. Ejemplos: LE, SE, XTE, Advance, Comfortline, Highline, Active, Sport, Exclusive, Limited, Platinum, 4x4, AWD. Si no hay versión usa null.",
    "serie": "número de serie VIN completo si aparece, si no usa null"
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

        // Único modelo disponible en v1beta con esta API key
        const geminiUrl         = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const geminiUrlFallback = geminiUrl; // mismo modelo, prompt simplificado como fallback
        const geminiUrlPro      = geminiUrl;

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
                // NO usamos responseMimeType:'application/json' porque en v1beta puede causar
                // respuestas vacías cuando el contenido del PDF activa filtros internos.
                // Gemini devuelve JSON dentro de texto libre que jsonrepair maneja perfectamente.
                maxOutputTokens: 8192
            }
        };

        // Reintentos internos ante errores de Gemini (rate limit, timeout, JSON malformado)
        let extracted: any = null;
        let lastError = '';
        const MAX_INTENTOS = 3;

        for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
            try {
                // Delay progresivo entre reintentos para evitar rate-limit
                if (intento > 1) {
                    await new Promise(r => setTimeout(r, intento * 1500));
                }

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
                        continue;
                    }
                    throw new Error(`Gemini error después de ${MAX_INTENTOS} intentos: ${lastError}`);
                }

                const candidate = aiData.candidates?.[0];
                const rawText = candidate?.content?.parts?.[0]?.text ?? '';
                const finishReason = candidate?.finishReason ?? 'UNKNOWN';

                if (finishReason === 'MAX_TOKENS') {
                    // Con mismo prompt y mismo límite, reintentar no sirve — ir directo a Plan B
                    console.warn(`[Gemini] Intento ${intento}: respuesta TRUNCADA (MAX_TOKENS) — pasando a Plan B`);
                    lastError = 'Respuesta truncada (PDF demasiado complejo)';
                    break;
                }

                if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
                    console.warn(`[Gemini] Intento ${intento}: bloqueado (${finishReason}) — pasando a fallbacks`);
                    lastError = `Bloqueado por filtros de Gemini (${finishReason})`;
                    break;
                }

                if (!rawText.trim()) {
                    lastError = 'Gemini devolvió respuesta vacía';
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS}: respuesta vacía (finishReason: ${finishReason})`);
                    if (intento < MAX_INTENTOS) continue;
                    break;
                }

                // Parseo robusto: 4 estrategias en cascada
                let parseError = '';
                let parsed: any = null;

                // Limpiar markdown antes de intentar cualquier parseo
                const cleanText = rawText
                    .replace(/```json\s*/gi, '')
                    .replace(/```\s*/g, '')
                    .trim();

                console.log(`[Gemini] Intento ${intento}: rawText length=${rawText.length}, finishReason=${finishReason}`);

                // Estrategia 1: parseo directo del texto limpio
                try { parsed = JSON.parse(cleanText); } catch (e1) { parseError = String(e1); }

                // Estrategia 2: jsonrepair — maneja comillas faltantes, comas extra,
                // valores sin comillas (ej: NO APLICA, AMPARADO, $3,000,000), etc.
                if (!parsed) {
                    try {
                        const repaired = jsonrepair(cleanText);
                        parsed = JSON.parse(repaired);
                        console.log(`[Gemini] JSON reparado con jsonrepair en intento ${intento}`);
                    } catch (e2) { parseError = `jsonrepair: ${e2}`; }
                }

                // Estrategia 3: extraer primer bloque {...} y reparar
                if (!parsed) {
                    try {
                        const match = cleanText.match(/\{[\s\S]*\}/);
                        if (match) {
                            const repaired = jsonrepair(match[0]);
                            parsed = JSON.parse(repaired);
                            console.log(`[Gemini] JSON extraído con regex+jsonrepair en intento ${intento}`);
                        }
                    } catch (e3) { parseError = `regex+repair: ${e3}`; }
                }

                // Estrategia 4: parseo original sin limpiar (último recurso)
                if (!parsed) {
                    try { parsed = JSON.parse(rawText.trim()); } catch (e4) { /* ignore */ }
                }

                if (!parsed) {
                    lastError = `No se pudo parsear JSON: ${parseError}`;
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS}: ${lastError}`);
                    console.warn('rawText preview:', rawText.substring(0, 600));
                    if (intento < MAX_INTENTOS) continue;
                    break; // dejar que Plan B lo intente
                }

                // Validar calidad mínima
                if (!parsed.aseguradora && (!parsed.coberturas || parsed.coberturas.length === 0)) {
                    lastError = 'Gemini no identificó aseguradora ni coberturas';
                    console.warn(`[Gemini] Intento ${intento}/${MAX_INTENTOS}: ${lastError}`);
                    if (intento < MAX_INTENTOS) continue;
                    throw new Error(lastError);
                }

                extracted = parsed;
                console.log(`✅ Extracción exitosa en intento ${intento}. Aseguradora: ${parsed.aseguradora}, coberturas: ${parsed.coberturas?.length || 0}`);
                break; // éxito, salir del loop

            } catch (loopErr: any) {
                if (intento === MAX_INTENTOS) throw loopErr;
            }
        }

        // ── FALLBACKS: Modelos alternativos cuando gemini-2.0-flash falla ──
        // Razón: si 2.0-flash produce JSON malformado, reintentar con el mismo modelo
        // dará el mismo resultado. Usar modelos distintos cambia el comportamiento.
        const fallbackModels = [
            { url: geminiUrlFallback, nombre: 'gemini-1.5-flash' },
            { url: geminiUrlPro,      nombre: 'gemini-1.5-pro'   },
        ];

        const promptSimple = `Lee esta cotización de seguro de auto y extrae los datos en JSON estricto.
Responde ÚNICAMENTE con el JSON, sin texto adicional ni bloques de código markdown.

Estructura:
{"aseguradora":"nombre exacto de la aseguradora","vehiculo":{"marca":"solo marca/fabricante","modelo":"solo nombre del modelo","anio":"4 dígitos","version":"trim/nivel o null","serie":null},"coberturas":[{"nombre":"nombre cobertura","suma_asegurada":"monto o descripción","deducible":"deducible exacto","incluida":true}],"prima_total":0.00,"prima_neta":null,"prima_fraccionada":null,"forma_pago":1,"cp":null,"numero_cotizacion":null,"vigencia_inicio":null,"vigencia_fin":null,"vigencia_cotizacion":null}

REGLAS: Extrae TODAS las coberturas. forma_pago: 1=anual 2=semestral 4=trimestral 12=mensual. No inventes datos.`;

        for (const fallback of fallbackModels) {
            if (extracted) break;
            console.warn(`⚠️ Intentando con modelo alternativo: ${fallback.nombre}...`);

            try {
                await new Promise(r => setTimeout(r, 1000)); // pequeña pausa entre modelos

                const payloadFallback = {
                    contents: [{
                        role: 'user',
                        parts: [
                            { inline_data: { mime_type: mimeType, data: pdf_base64 } },
                            { text: promptSimple }
                        ]
                    }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
                    // Sin responseMimeType para evitar respuestas vacías por filtros internos
                };

                const rFallback = await fetch(fallback.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payloadFallback)
                });
                const dFallback = await rFallback.json();

                if (!rFallback.ok || dFallback.error) {
                    console.warn(`[${fallback.nombre}] HTTP error: ${dFallback.error?.message || rFallback.status}`);
                    continue;
                }

                const candidateFallback = dFallback.candidates?.[0];
                const finishFallback = candidateFallback?.finishReason ?? 'UNKNOWN';
                const textFallback = candidateFallback?.content?.parts?.[0]?.text ?? '';
                console.log(`[${fallback.nombre}] finishReason=${finishFallback}, textLength=${textFallback.length}`);

                if (!textFallback.trim()) {
                    console.warn(`[${fallback.nombre}] Respuesta vacía (finishReason=${finishFallback})`);
                    continue;
                }

                const cleanFallback = textFallback.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                let parsedFallback: any = null;

                try { parsedFallback = JSON.parse(cleanFallback); } catch { /* ignore */ }
                if (!parsedFallback) {
                    try { parsedFallback = JSON.parse(jsonrepair(cleanFallback)); } catch { /* ignore */ }
                }
                if (!parsedFallback) {
                    const m = cleanFallback.match(/\{[\s\S]*\}/);
                    if (m) try { parsedFallback = JSON.parse(jsonrepair(m[0])); } catch { /* ignore */ }
                }

                if (parsedFallback?.aseguradora || parsedFallback?.coberturas?.length > 0) {
                    extracted = parsedFallback;
                    console.log(`✅ Extracción exitosa con ${fallback.nombre}. Aseguradora: ${parsedFallback.aseguradora}, coberturas: ${parsedFallback.coberturas?.length || 0}`);
                } else {
                    console.warn(`[${fallback.nombre}] JSON parseado pero sin aseguradora ni coberturas`);
                }
            } catch (fallbackErr) {
                console.error(`[${fallback.nombre}] Error inesperado:`, fallbackErr);
            }
        }

        if (!extracted) throw new Error(`La IA no pudo leer este PDF. Puede ser un documento escaneado, protegido o con formato no estándar.`);

        return new Response(JSON.stringify({ success: true, data: extracted }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        console.error('extract-quote error:', err);
        // IMPORTANTE: siempre devolver 200 aunque haya error.
        // Si devolvemos 500, el cliente Supabase lanza "non-2xx status code" y
        // el sistema de reintentos del frontend no puede funcionar (data llega null).
        // Con 200 + success:false, el frontend recibe el error real y puede reintentar.
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
