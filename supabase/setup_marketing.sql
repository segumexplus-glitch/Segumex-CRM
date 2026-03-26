-- =======================================================
-- SEGUMEX: Setup módulo Marketing IA
-- Ejecutar en Supabase SQL Editor
-- =======================================================

-- 1. Tabla de campañas programadas (calendario)
CREATE TABLE IF NOT EXISTS campanas_programadas (
    id BIGSERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'personalizada',  -- cross_sell | renovacion | fidelizacion | personalizada
    mensaje TEXT,
    imagen_path TEXT,          -- path en bucket marketing-images
    fecha_programada TIMESTAMPTZ,
    destinatarios JSONB DEFAULT '[]',  -- [{ nombre, telefono }]
    estado TEXT DEFAULT 'pendiente',   -- pendiente | enviada | cancelada
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE campanas_programadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "campanas_auth" ON campanas_programadas;
CREATE POLICY "campanas_auth" ON campanas_programadas
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. Crear bucket marketing-images (público para que Green API pueda acceder)
-- Ejecutar vía Supabase Dashboard > Storage > New Bucket:
--   Nombre: marketing-images
--   Public: SI (toggle activado)
-- O ejecutar con el CLI:
--   supabase storage create marketing-images --public

-- 3. Verificar que historial_marketing existe (debería existir ya)
CREATE TABLE IF NOT EXISTS historial_marketing (
    id BIGSERIAL PRIMARY KEY,
    fecha TEXT,
    tipo TEXT,
    nombre TEXT,
    mensaje TEXT,
    conteo INT DEFAULT 0,
    destinatarios JSONB DEFAULT '[]',
    imagen TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE historial_marketing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "historial_marketing_auth" ON historial_marketing;
CREATE POLICY "historial_marketing_auth" ON historial_marketing
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

SELECT 'Setup marketing completado ✅' AS resultado;
