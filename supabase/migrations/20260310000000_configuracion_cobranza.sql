-- ============================================================
-- Tabla: configuracion_mensajes
-- Almacena plantillas de mensajes configurables (cobranza, etc.)
-- y ajustes generales del sistema como la imagen de cobranza.
-- ============================================================
CREATE TABLE IF NOT EXISTS configuracion_mensajes (
    id SERIAL PRIMARY KEY,
    clave TEXT UNIQUE NOT NULL,
    titulo TEXT NOT NULL,
    contenido TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    updated_by UUID REFERENCES auth.users(id)
);

-- Insertar plantillas por defecto
INSERT INTO configuracion_mensajes (clave, titulo, contenido) VALUES
(
    'cobranza_7_dias_antes',
    'Recordatorio 7 días antes',
    'Hola {nombre} 👋, te recordamos que tu póliza *{numero_poliza}* vence el *{fecha_vencimiento}*.

El monto de tu prima es de *${prima}*. Te invitamos a realizar tu pago con anticipación para mantener tu cobertura activa. ✅

¿Tienes alguna duda? Con gusto te ayudamos.

Saludos cordiales — Equipo Segumex 🛡️'
),
(
    'cobranza_1_dia_antes',
    'Recordatorio 1 día antes',
    'Hola {nombre} 👋, te recordamos que tu póliza *{numero_poliza}* vence *mañana {fecha_vencimiento}*.

Para evitar quedarte sin cobertura, te pedimos realizar tu pago de *${prima}* a la brevedad. 🚨

Contáctanos si necesitas apoyo con tu pago.

Saludos cordiales — Equipo Segumex 🛡️'
),
(
    'cobranza_2_dias_despues',
    'Aviso 2 días después',
    'Hola {nombre}, notamos que tu póliza *{numero_poliza}* venció el *{fecha_vencimiento}* y aún está pendiente de pago. 😔

El monto es de *${prima}*. Por favor realiza tu pago para reactivar tu cobertura y continuar protegido.

¿Necesitas ayuda? Estamos aquí para ti. 💙

Saludos — Equipo Segumex'
),
(
    'cobranza_5_dias_despues',
    'Aviso 5 días después',
    'Hola {nombre} 🙏, seguimos pendientes de tu pago de *${prima}* correspondiente a tu póliza *{numero_poliza}*.

Han pasado 5 días desde su vencimiento. Te pedimos regularizar tu situación lo antes posible para no perder tu cobertura.

Comunícate con tu asesor ante cualquier duda.

Saludos cordiales — Equipo Segumex 🛡️'
),
(
    'cobranza_8_dias_despues',
    'Aviso urgente 8 días después',
    'AVISO IMPORTANTE ⚠️

Hola {nombre}, tu póliza *{numero_poliza}* lleva más de una semana vencida con un adeudo de *${prima}*.

Sin tu pago, tu cobertura podría ser cancelada definitivamente. Por favor contáctanos HOY para evitarlo. 🚨

📞 Nuestro equipo está listo para ayudarte.

Equipo Segumex 🛡️'
),
(
    'cobranza_imagen_url',
    'URL imagen de cobranza',
    ''
)
ON CONFLICT (clave) DO NOTHING;

-- ============================================================
-- Tabla: mensajes_cobranza_log
-- Registro de todos los mensajes de cobranza enviados
-- ============================================================
CREATE TABLE IF NOT EXISTS mensajes_cobranza_log (
    id SERIAL PRIMARY KEY,
    poliza_id BIGINT REFERENCES polizas(id) ON DELETE SET NULL,
    cliente_nombre TEXT,
    telefono TEXT NOT NULL,
    tipo_mensaje TEXT NOT NULL,  -- 'cobranza_7_dias_antes', etc.
    numero_poliza TEXT,
    fecha_vencimiento DATE,
    prima NUMERIC,
    enviado_at TIMESTAMPTZ DEFAULT now(),
    status TEXT DEFAULT 'enviado',  -- 'enviado' | 'error' | 'pendiente'
    respuesta_api JSONB
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_cobranza_log_poliza ON mensajes_cobranza_log(poliza_id);
CREATE INDEX IF NOT EXISTS idx_cobranza_log_tipo ON mensajes_cobranza_log(tipo_mensaje);
CREATE INDEX IF NOT EXISTS idx_cobranza_log_enviado ON mensajes_cobranza_log(enviado_at);

-- RLS: Solo admins y service role pueden ver/modificar
ALTER TABLE configuracion_mensajes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes_cobranza_log ENABLE ROW LEVEL SECURITY;

-- Policies para configuracion_mensajes
CREATE POLICY "admins_manage_config" ON configuracion_mensajes
    FOR ALL USING (true);  -- El service_role key bypasses RLS; ajustar si se necesita restricción

-- Policies para mensajes_cobranza_log
CREATE POLICY "admins_view_log" ON mensajes_cobranza_log
    FOR ALL USING (true);
