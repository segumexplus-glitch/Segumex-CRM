-- Agregando columna metadata a la tabla de conversaciones
ALTER TABLE public.comm_conversations 
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Recargando el caché del esquema (PostgREST)
NOTIFY pgrst, 'reload config';
