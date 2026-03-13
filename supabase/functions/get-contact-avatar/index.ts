// Deploy: supabase functions deploy get-contact-avatar --no-verify-jwt

const GREEN_INSTANCE_ID = Deno.env.get('GREEN_INSTANCE_ID');
const GREEN_API_TOKEN = Deno.env.get('GREEN_API_TOKEN');

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

        const res = await fetch(`${greenBaseUrl}/getContactInfo/${GREEN_API_TOKEN}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId })
        });

        if (!res.ok) {
            return new Response(JSON.stringify({ avatar: null }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const data = await res.json();

        return new Response(JSON.stringify({
            avatar: data.avatar || null,
            name: data.name || null,
            contactName: data.contactName || null,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (err: any) {
        return new Response(JSON.stringify({ avatar: null, error: err.message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
        });
    }
});
