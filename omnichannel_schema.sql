-- ALERTA: Ejecuta este script en el "SQL Editor" de tu Dashboard de Supabase.

-- 1. Crear Schema para organizar (opcional, si prefieres todo en public, quita "communications." y usa prefijos)
-- Para simplificar integración con Supabase Client por defecto, usaremos schema PUBLIC pero con nombres claros.

CREATE TABLE IF NOT EXISTS public.comm_channels (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('whatsapp', 'facebook', 'instagram')),
    name TEXT NOT NULL, -- Ej: "WhatsApp Ventas"
    identifier TEXT NOT NULL, -- ID de WhatsApp o Página de FB
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.comm_conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    channel_id UUID REFERENCES public.comm_channels(id),
    platform_user_id TEXT NOT NULL, -- El número de telefono o ID de usuario de FB
    lead_id BIGINT REFERENCES public.leads(id) ON DELETE SET NULL, -- Vinculo con CRM
    status TEXT DEFAULT 'ai_handling' CHECK (status IN ('open', 'closed', 'ai_handling', 'agent_handling')),
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    unread_count INTEGER DEFAULT 0,
    context_data JSONB DEFAULT '{}'::jsonb, -- Para que la IA recuerde cosas breves
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.comm_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES public.comm_conversations(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'ai', 'agent', 'system')),
    content TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, -- Para ID de mensaje de Meta, status, adjuntos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índices para búsqueda rápida (IF NOT EXISTS para evitar errores al re-ejecutar)
CREATE INDEX IF NOT EXISTS idx_comm_conversations_user ON public.comm_conversations(platform_user_id);
CREATE INDEX IF NOT EXISTS idx_comm_messages_conv ON public.comm_messages(conversation_id);

-- POLÍTICAS DE SEGURIDAD (RLS)
-- Habilitar RLS (no da error si ya está habilitado)
ALTER TABLE public.comm_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_messages ENABLE ROW LEVEL SECURITY;

-- Crear políticas de forma segura (borrar si existen para recrear)
DROP POLICY IF EXISTS "Permitir acceso total a autenticados en channels" ON public.comm_channels;
CREATE POLICY "Permitir acceso total a autenticados en channels"
ON public.comm_channels FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "Permitir acceso total a autenticados en conversations" ON public.comm_conversations;
CREATE POLICY "Permitir acceso total a autenticados en conversations"
ON public.comm_conversations FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "Permitir acceso total a autenticados en messages" ON public.comm_messages;
CREATE POLICY "Permitir acceso total a autenticados en messages"
ON public.comm_messages FOR ALL TO authenticated USING (true);

-- Insertar canales por defecto
-- Usamos una consulta para insertar solo si NO existe ese identifier, evitando duplicados
INSERT INTO public.comm_channels (platform, name, identifier)
SELECT 'whatsapp', 'WhatsApp Pruebas', '1008867112303622'
WHERE NOT EXISTS (
    SELECT 1 FROM public.comm_channels WHERE identifier = '1008867112303622'
);
-- Nota: Si cambiaste de número de prueba, asegúrate de que el de arriba sea el NUEVO.
