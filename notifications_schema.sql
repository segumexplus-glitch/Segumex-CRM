-- Tabla para guardar las suscripciones Web Push de los usuarios/dispositivos
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, -- Vinculado al usuario logueado
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(endpoint) -- Evitar duplicados del mismo dispositivo
);

-- Tabla para historial de notificaciones enviadas (Inbox interno)
CREATE TABLE IF NOT EXISTS public.notifications_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}'::jsonb,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Políticas RLS (Seguridad)
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications_history ENABLE ROW LEVEL SECURITY;

-- Permitir al usuario ver y crear sus propias suscripciones
CREATE POLICY "Users can manage their own subscriptions" 
ON public.push_subscriptions
FOR ALL USING (auth.uid() = user_id);

-- Permitir al usuario ver sus propias notificaciones
CREATE POLICY "Users can view their own notifications" 
ON public.notifications_history
FOR SELECT USING (auth.uid() = user_id);

-- Permitir a las Edge Functions (Service Role) insertar notificaciones
CREATE POLICY "Service Role can insert notifications" 
ON public.notifications_history
FOR INSERT WITH CHECK (true); -- Supabase Service Role se salta RLS, pero esto es explicito si fuera necesario
