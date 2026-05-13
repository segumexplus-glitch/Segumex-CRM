-- ============================================================
-- TABLAS REQUERIDAS POR: welcome-policy y payment-reminders
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Configuración de mensajes (plantillas, toggle cobranza_activa, imágenes)
CREATE TABLE IF NOT EXISTS configuracion_mensajes (
    id            BIGSERIAL PRIMARY KEY,
    clave         TEXT UNIQUE NOT NULL,
    titulo        TEXT,
    contenido     TEXT,
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Valores iniciales mínimos para que el sistema arranque
INSERT INTO configuracion_mensajes (clave, titulo, contenido)
VALUES
    ('cobranza_activa',              'Envíos automáticos activos',         'false'),
    ('cobranza_7_dias_antes',        'Recordatorio 7 días antes',          ''),
    ('cobranza_1_dia_antes',         'Recordatorio 1 día antes',           ''),
    ('cobranza_2_dias_despues',      'Recordatorio 2 días después',        ''),
    ('cobranza_5_dias_despues',      'Recordatorio 5 días después',        ''),
    ('cobranza_8_dias_despues',      'Recordatorio 8 días después',        ''),
    ('bienvenida_cliente_nuevo',     'Bienvenida cliente nuevo',           ''),
    ('bienvenida_cliente_existente', 'Bienvenida cliente existente',       ''),
    ('bienvenida_imagen_url',        'URL imagen bienvenida',              '')
ON CONFLICT (clave) DO NOTHING;

-- 2. Log de mensajes enviados (cobranza + bienvenida)
CREATE TABLE IF NOT EXISTS mensajes_cobranza_log (
    id                BIGSERIAL PRIMARY KEY,
    poliza_id         BIGINT,
    cliente_nombre    TEXT,
    telefono          TEXT,
    tipo_mensaje      TEXT,
    numero_poliza     TEXT,
    fecha_vencimiento DATE,
    prima             NUMERIC,
    numero_pago       INT,
    status            TEXT,
    respuesta_api     JSONB,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas frecuentes (evitar duplicados en yaEnviado())
CREATE INDEX IF NOT EXISTS idx_cobranza_log_poliza_tipo_pago
    ON mensajes_cobranza_log (poliza_id, tipo_mensaje, numero_pago);

CREATE INDEX IF NOT EXISTS idx_cobranza_log_created
    ON mensajes_cobranza_log (created_at DESC);

-- 3. Verificar creación
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('configuracion_mensajes', 'mensajes_cobranza_log');
