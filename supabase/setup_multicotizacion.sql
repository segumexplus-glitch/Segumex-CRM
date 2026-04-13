-- ============================================================
-- Módulo Multicotización Auto
-- ============================================================

-- Secuencia de folios comenzando en 1345
CREATE SEQUENCE IF NOT EXISTS multicotizaciones_folio_seq START 1345;

-- Tabla principal
CREATE TABLE IF NOT EXISTS multicotizaciones (
    id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    folio           INTEGER     DEFAULT nextval('multicotizaciones_folio_seq') UNIQUE,
    lead_id         INTEGER     REFERENCES leads(id) ON DELETE SET NULL,
    creado_por      TEXT        CHECK (creado_por IN ('Albert', 'Soto')),

    -- Datos del vehículo
    vehiculo_marca  TEXT,
    vehiculo_modelo TEXT,
    vehiculo_anio   TEXT,
    vehiculo_version TEXT,
    cp              TEXT,
    forma_pago      TEXT        CHECK (forma_pago IN ('mensual','trimestral','semestral','anual')),

    -- Cotizaciones extraídas por IA (array JSON)
    cotizaciones    JSONB       DEFAULT '[]'::jsonb,

    -- HDI descuento
    hdi_descuento           BOOLEAN     DEFAULT FALSE,
    hdi_precio_sin_descuento NUMERIC(10,2),
    hdi_precio_descuento    NUMERIC(10,2),

    -- Documento generado
    pdf_path        TEXT,
    pdf_url         TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para búsquedas por lead
CREATE INDEX IF NOT EXISTS idx_multicotizaciones_lead ON multicotizaciones(lead_id);
CREATE INDEX IF NOT EXISTS idx_multicotizaciones_folio ON multicotizaciones(folio);

-- RLS
ALTER TABLE multicotizaciones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Acceso autenticado" ON multicotizaciones
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
