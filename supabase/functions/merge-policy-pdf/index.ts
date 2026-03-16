// Deploy: supabase functions deploy merge-policy-pdf --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2'
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1'

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const BUCKET = 'documentos-polizas';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Mapeo ramo → path de portada en Storage
function resolverPathPortada(ramo: string): string | null {
    const r = (ramo || '').toLowerCase().trim();
    if (r === 'auto') return 'portadas/portada_auto.pdf';
    if (r === 'gmm' || r === 'gastos_medicos' || r === 'salud' || r === 'gastos medicos') return 'portadas/portada_gmm.pdf';
    if (r === 'empresarial') return 'portadas/portada_empresarial.pdf';
    return null;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { policy_path, ramo } = await req.json();

        if (!policy_path || !ramo) {
            return new Response(JSON.stringify({ error: 'policy_path y ramo son requeridos' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const portadaPath = resolverPathPortada(ramo);
        if (!portadaPath) {
            console.log(`ℹ️ Ramo "${ramo}" no tiene portada configurada. Sin merge.`);
            return new Response(JSON.stringify({ merged: false, reason: 'ramo_sin_portada' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Descargar portada desde Storage
        const { data: portadaBlob, error: portadaErr } = await supabase.storage
            .from(BUCKET)
            .download(portadaPath);

        if (portadaErr || !portadaBlob) {
            console.log(`⚠️ Portada no encontrada en ${portadaPath}. Sin merge.`);
            return new Response(JSON.stringify({ merged: false, reason: 'portada_no_encontrada' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Descargar PDF de la póliza desde Storage
        const { data: policyBlob, error: policyErr } = await supabase.storage
            .from(BUCKET)
            .download(policy_path);

        if (policyErr || !policyBlob) {
            throw new Error(`No se pudo descargar el PDF de póliza: ${policyErr?.message}`);
        }

        console.log(`🔗 Mergeando ${portadaPath} + ${policy_path}`);

        // Cargar ambos PDFs con pdf-lib
        const portadaBytes  = await portadaBlob.arrayBuffer();
        const policyBytes   = await policyBlob.arrayBuffer();

        const portadaDoc = await PDFDocument.load(portadaBytes);
        const policyDoc  = await PDFDocument.load(policyBytes);
        const mergedDoc  = await PDFDocument.create();

        // 1. Copiar páginas de portada (prepend)
        const portadaPages = await mergedDoc.copyPages(portadaDoc, portadaDoc.getPageIndices());
        portadaPages.forEach(page => mergedDoc.addPage(page));

        // 2. Copiar páginas del PDF original
        const policyPages = await mergedDoc.copyPages(policyDoc, policyDoc.getPageIndices());
        policyPages.forEach(page => mergedDoc.addPage(page));

        const mergedBytes = await mergedDoc.save();

        // Re-subir el PDF merged al mismo path (reemplazar original)
        const { error: uploadErr } = await supabase.storage
            .from(BUCKET)
            .upload(policy_path, mergedBytes, {
                upsert: true,
                contentType: 'application/pdf'
            });

        if (uploadErr) {
            throw new Error(`Error re-subiendo PDF merged: ${uploadErr.message}`);
        }

        console.log(`✅ PDF merged exitosamente: ${portadaDoc.getPageCount()} portada(s) + ${policyDoc.getPageCount()} página(s) originales`);

        return new Response(JSON.stringify({
            merged: true,
            portada_pages: portadaDoc.getPageCount(),
            policy_pages: policyDoc.getPageCount(),
            total_pages: mergedDoc.getPageCount()
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (err: any) {
        console.error('Error en merge-policy-pdf:', err.message);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});
