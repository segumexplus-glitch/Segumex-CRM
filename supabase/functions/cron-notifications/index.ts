
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log("Cron started: Checking for expiring policies...");

    // 1. Obtener pólizas por vencer en 30 días
    const today = new Date();
    const targetDate30 = new Date();
    targetDate30.setDate(today.getDate() + 30);
    const targetStr30 = targetDate30.toISOString().split('T')[0];
    
    // Y 7 días
    const targetDate7 = new Date();
    targetDate7.setDate(today.getDate() + 7);
    const targetStr7 = targetDate7.toISOString().split('T')[0];

    // Consulta simple (podría optimizarse)
    // Buscamos pólizas que venzan exactamente hoy+30 o hoy+7
    const { data: polizas, error } = await supabaseClient
        .from('polizas')
        .select(`
            id, 
            no_poliza, 
            aseguradora, 
            vence,
            cliente:clientes(nombre, apellido),
            agente
        `)
        .or(`vence.eq.${targetStr30},vence.eq.${targetStr7}`)
        .eq('estado', 'activa');

    if (error) throw error;

    console.log(`Found ${polizas?.length || 0} policies expiring.`);

    const results = [];

    // 2. Por cada póliza, encontrar el usuario agente y notificar
    for (const p of (polizas || [])) {
        // Buscar el usuario del agente por nombre (un poco frágil, idealmente usar user_id en polizas)
        // Por ahora, asumimos que el admin recibe todo o buscamos un usuario con metadata nombre = agente
        // Para simplificar MVP: Enviamos al ADMIN (o a todos los suscritos que sean admins)
        
        // Buscamos a quien notificar.
        // Estrategia: Notificar a todos los usuarios suscritos (filtro simple)
        // En producción: Filtrar por owner.
        
        const { data: users } = await supabaseClient.from('push_subscriptions').select('user_id');
        // Unhacky way: notify all registered devices for now (since single agent/admin mostly)
        // TODO: Map agent name to user_id properly in schema v2
        
        const clienteNombre = p.cliente?.nombre + ' ' + (p.cliente?.apellido || '');
        const dias = p.vence === targetStr7 ? '7 días' : '30 días';
        
        const title = `⚠️ Póliza por Vencer (${dias})`;
        const body = `${p.aseguradora} - ${p.no_poliza} de ${clienteNombre}`;

        // Invocar push-sender
        const uniqueUsers = [...new Set(users?.map(u => u.user_id))];
        
        for (const uid of uniqueUsers) {
            await supabaseClient.functions.invoke('push-sender', {
                body: {
                    user_id: uid,
                    title: title,
                    body: body,
                    data: { url: `detalle_poliza.html?id=${p.id}` }
                }
            });
        }
        results.push({ poliza: p.no_poliza, sent: true });
    }

    return new Response(JSON.stringify({ success: true, processed: results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
