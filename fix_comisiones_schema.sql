-- Agrega la columna faltante para el control de comisiones cobradas
-- Esto es necesario para que el botón "Conciliar" funcione.

ALTER TABLE polizas 
ADD COLUMN IF NOT EXISTS comisiones_cobradas_status boolean[] DEFAULT '{}';

-- Opcional: Si quisieras guardar fechas en el futuro (aunque dijimos que no por ahora)
-- ALTER TABLE polizas ADD COLUMN IF NOT EXISTS comisiones_cobradas_fechas text[] DEFAULT '{}';
