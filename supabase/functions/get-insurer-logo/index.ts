// Deploy: supabase functions deploy get-insurer-logo --no-verify-jwt

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Dominios a intentar por aseguradora (ordenados por probabilidad de éxito)
const INSURER_DOMAINS: Record<string, string[]> = {
    'hdi':      ['hdi.com', 'hdi-seguros.com.mx'],
    'qualitas': ['qualitas.com.mx'],
    'gnp':      ['gnp.com.mx'],
    'axa':      ['axa.com', 'axa.com.mx'],
    'mapfre':   ['mapfre.com', 'mapfre.com.mx'],
    'chubb':    ['chubb.com'],
    'afirme':   ['afirme.com.mx', 'grupoafirme.com'],
    'zurich':   ['zurich.com', 'zurich.com.mx'],
    'inbursa':  ['inbursa.com'],
    'banorte':  ['banorte.com'],
    'atlas':    ['segurosatlas.com.mx'],
    'primero':  ['primero-seguros.com'],
    'ana':      ['ana.com.mx'],
};

function findDomains(aseguradora: string): string[] {
    const n = (aseguradora || '').toLowerCase();
    for (const [key, domains] of Object.entries(INSURER_DOMAINS)) {
        if (n.includes(key)) return domains;
    }
    return [];
}

async function fetchLogoAsBase64(domain: string): Promise<string | null> {
    const url = `https://logo.clearbit.com/${domain}`;
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Segumex/1.0)' }
        });
        if (!res.ok) return null;

        const contentType = res.headers.get('content-type') || 'image/png';
        if (!contentType.startsWith('image/')) return null;

        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        return `data:${contentType};base64,${base64}`;
    } catch {
        return null;
    }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { aseguradora } = await req.json();
        if (!aseguradora) throw new Error('aseguradora requerida');

        const domains = findDomains(aseguradora);
        let logo: string | null = null;

        for (const domain of domains) {
            logo = await fetchLogoAsBase64(domain);
            if (logo) {
                console.log(`✅ Logo obtenido para "${aseguradora}" desde ${domain}`);
                break;
            }
        }

        if (!logo) {
            console.log(`⚠️ Sin logo para "${aseguradora}". Dominios intentados: ${domains.join(', ')}`);
        }

        return new Response(JSON.stringify({ logo, aseguradora }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        console.error('get-insurer-logo error:', err);
        return new Response(JSON.stringify({ logo: null, error: err.message }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
