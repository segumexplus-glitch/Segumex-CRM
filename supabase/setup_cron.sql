-- ============================================================
-- SCHEDULER AUTOMÁTICO: payment-reminders + birthday-wishes
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Habilitar pg_cron (programar jobs en PostgreSQL)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Habilitar pg_net (hacer HTTP desde PostgreSQL — ya incluido en Supabase)
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3. Eliminar jobs anteriores si existen (para evitar duplicados al re-ejecutar)
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('payment-reminders-daily', 'birthday-wishes-daily', 'cron-notifications-daily');

-- 4. Recordatorios de cobranza: diario a las 9:00 AM hora México (UTC-6 → 15:00 UTC)
SELECT cron.schedule(
    'payment-reminders-daily',
    '0 15 * * *',
    $$
    SELECT net.http_post(
        url     := 'https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/payment-reminders',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body    := '{}'::jsonb
    );
    $$
);

-- 5. Felicitaciones de cumpleaños: diario a las 9:00 AM hora México
SELECT cron.schedule(
    'birthday-wishes-daily',
    '0 15 * * *',
    $$
    SELECT net.http_post(
        url     := 'https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/birthday-wishes',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body    := '{}'::jsonb
    );
    $$
);

-- 6. Notificaciones de pólizas por vencer: diario a las 9:00 AM hora México
SELECT cron.schedule(
    'cron-notifications-daily',
    '0 15 * * *',
    $$
    SELECT net.http_post(
        url     := 'https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/cron-notifications',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body    := '{}'::jsonb
    );
    $$
);

-- 7. Verificar que quedaron activos
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname IN ('payment-reminders-daily', 'birthday-wishes-daily', 'cron-notifications-daily');
