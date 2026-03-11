-- ============================================================
-- Programar ejecución diaria de payment-reminders con pg_cron
-- Ejecutar en: Supabase → SQL Editor
-- ============================================================

-- 1. Habilitar extensión pg_cron (si no está habilitada)
-- Ir a: Database → Extensions → buscar "pg_cron" → Enable

-- 2. Crear el job diario a las 9:00 AM hora UTC (= 3:00 AM México / 4:00 AM con horario de verano)
-- Ajusta la hora según tu zona horaria. México Centro = UTC-6 (UTC-5 en verano)
-- Para 9:00 AM México (UTC-6): usar 15:00 UTC
-- Para 8:00 AM México: usar 14:00 UTC

SELECT cron.schedule(
    'payment-reminders-daily',         -- nombre único del job
    '0 14 * * *',                      -- Cada día a las 14:00 UTC (= 8 AM México hora de verano)
    $$
    SELECT
        net.http_post(
            url := current_setting('app.supabase_url') || '/functions/v1/payment-reminders',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key')
            ),
            body := '{}'::jsonb
        )
    $$
);

-- ============================================================
-- ALTERNATIVA MÁS SIMPLE: Si pg_net no está disponible,
-- usar esta versión que llama a la función directamente
-- ============================================================

-- Ver jobs activos:
-- SELECT * FROM cron.job;

-- Eliminar un job:
-- SELECT cron.unschedule('payment-reminders-daily');

-- Ver historial de ejecuciones:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- ============================================================
-- CONFIGURACIÓN REQUERIDA EN SUPABASE
-- Agregar estas variables en: Settings → Edge Functions → Secrets
-- ============================================================
-- GREEN_INSTANCE_ID = tu_instancia_green_api
-- GREEN_API_TOKEN   = tu_token_green_api
-- SUPABASE_URL      = (ya existe automáticamente)
-- SUPABASE_SERVICE_ROLE_KEY = (ya existe automáticamente)
