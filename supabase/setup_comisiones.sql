-- ============================================================
-- COMISIONES: columnas de distribución + estados de aclaración
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Tabla de columnas de distribución de comisiones
CREATE TABLE IF NOT EXISTS comisiones_columnas (
    id         BIGSERIAL PRIMARY KEY,
    nombre     TEXT        NOT NULL DEFAULT 'Sin nombre',
    porcentaje NUMERIC(6,2) NOT NULL DEFAULT 0,
    activa     BOOLEAN     NOT NULL DEFAULT true,
    orden      INTEGER     NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE comisiones_columnas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Autenticados pueden leer comisiones_columnas"
    ON comisiones_columnas FOR SELECT TO authenticated USING (true);
CREATE POLICY "Autenticados pueden modificar comisiones_columnas"
    ON comisiones_columnas FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. Datos por defecto
INSERT INTO comisiones_columnas (nombre, porcentaje, activa, orden) VALUES
    ('Gilberto',    25, true, 1),
    ('Segumex',     75, true, 2),
    ('Fabián Soto', 25, true, 3),
    ('Soto&Albert', 50, true, 4)
ON CONFLICT DO NOTHING;

-- 3. Nuevas columnas en polizas para estado de aclaración
ALTER TABLE polizas
    ADD COLUMN IF NOT EXISTS comisiones_aclaracion_status  BOOLEAN[]   DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS comisiones_aclaracion_notas   JSONB       DEFAULT '{}';

-- 4. Verificar
SELECT id, nombre, porcentaje, activa, orden FROM comisiones_columnas ORDER BY orden;
