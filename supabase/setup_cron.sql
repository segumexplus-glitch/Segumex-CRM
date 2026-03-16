-- ============================================================
-- SCHEDULER AUTOMÁTICO: payment-reminders + birthday-wishes
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Habilitar extensión pg_cron (solo si no está habilitada)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Habilitar extensión http (para llamar Edge Functions via HTTP)
CREATE EXTENSION IF NOT EXISTS http;

-- 3. Eliminar jobs anteriores si existen
SELECT cron.unschedule('payment-reminders-daily') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'payment-reminders-daily'
);
SELECT cron.unschedule('birthday-wishes-daily') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'birthday-wishes-daily'
);
SELECT cron.unschedule('cron-notifications-daily') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'cron-notifications-daily'
);

-- 4. Recordatorios de cobranza: todos los días a las 9:00 AM (hora México = UTC-6 → 15:00 UTC)
SELECT cron.schedule(
    'payment-reminders-daily',
    '0 15 * * *',
    $$
    SELECT http_post(
        'https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/payment-reminders',
        '{}',
        'application/json'
    );
    $$
);

-- 5. Felicitaciones de cumpleaños: todos los días a las 9:00 AM (misma hora)
SELECT cron.schedule(
    'birthday-wishes-daily',
    '0 15 * * *',
    $$
    SELECT http_post(
        'https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/birthday-wishes',
        '{}',
        'application/json'
    );
    $$
);

-- 6. Notificaciones de pólizas por vencer: todos los días a las 9:00 AM
SELECT cron.schedule(
    'cron-notifications-daily',
    '0 15 * * *',
    $$
    SELECT http_post(
        'https://mmhdpbygdvdyujiktvqa.supabase.co/functions/v1/cron-notifications',
        '{}',
        'application/json'
    );
    $$
);

-- 7. Verificar que quedaron registrados
SELECT jobname, schedule, active FROM cron.job
WHERE jobname IN ('payment-reminders-daily', 'birthday-wishes-daily', 'cron-notifications-daily');
