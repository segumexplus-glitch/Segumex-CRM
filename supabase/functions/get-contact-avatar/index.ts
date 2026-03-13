// Deploy: supabase functions deploy get-contact-avatar --no-verify-jwt

const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID');
const GREEN_API_TOKEN   = Deno.env.get('GREEN_API_TOKEN');

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
        const { chatId } = await req.json();
        if (!chatId) throw new Error('chatId requerido');

        if (!GREEN_INSTANCE_ID || !GREEN_API_TOKEN) {
            return new Response(JSON.stringify({ avatar: null, error: 'Green API no configurado' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        let greenBaseUrl = `https://api.green-api.com/waInstance${GREEN_INSTANCE_ID}`;
        if (GREEN_INSTANCE_ID.startsWith('7107')) {
            greenBaseUrl = `https://7107.api.greenapi.com/waInstance${GREEN_INSTANCE_ID}`;
        }

        // 1. Obtener info del contacto (incluye URL de avatar)
        const infoRes = await fetch(`${greenBaseUrl}/getContactInfo/${GREEN_API_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId })
        });

        if (!infoRes.ok) {
            return new Response(JSON.stringify({ avatar: null }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const info = await infoRes.json();
        const avatarUrl = info.avatar || null;
        const name = info.name || info.contactName || null;

        if (!avatarUrl) {
            return new Response(JSON.stringify({ avatar: null, name }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // 2. Descargar la imagen y convertirla a base64 data URL
        // (Las URLs del CDN de WhatsApp no cargan directamente en el browser por CORS)
        try {
            const imgRes = await fetch(avatarUrl, {
                headers: { 'User-Agent': 'WhatsApp/2.23.20.0' }
            });

            if (imgRes.ok) {
                const buffer      = await imgRes.arrayBuffer();
                const bytes       = new Uint8Array(buffer);
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

                // Encode to base64
                let binary = '';
                const chunkSize = 8192;
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
                }
                const base64 = btoa(binary);
                const dataUrl = `data:${contentType};base64,${base64}`;

                return new Response(JSON.stringify({ avatar: dataUrl, name }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        } catch (imgErr) {
            console.warn('No se pudo descargar la imagen:', imgErr);
        }

        // Fallback: devolver la URL directa (puede o no cargar en el browser)
        return new Response(JSON.stringify({ avatar: avatarUrl, name }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        return new Response(JSON.stringify({ avatar: null, error: err.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
        });
    }
});
